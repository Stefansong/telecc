/**
 * Per-session "driven from Telegram" state.
 *
 * Replaces the old global `src/data/typing-active` semantics, which had two bugs:
 *  - it was global, so a Telegram-driven session A made local session B's prompts go
 *    to Telegram (and B's events cleared A's flag);
 *  - any notification (SubagentStop, InstructionsLoaded, ...) deleted it mid-task, after
 *    which the injected prompt's own UserPromptSubmit timestamp made the user look
 *    "active at the terminal" and the final result was never sent to Telegram.
 *
 * Keying: entries live under the session's project root — hooks pass
 * `hookProjectDir(payload.cwd)` (CLAUDE_PROJECT_DIR, stable when Claude `cd`s into a
 * subdirectory), the same value they record as the session's cwd in the session map.
 * Within a directory, the *active* turn and *local activity* are tracked per Claude
 * `session_id`: the desktop-app session and the tmux session the bot started for the
 * same project must not end each other's turns or hide each other's Telegram replies.
 *
 * Lifecycle per directory:
 *  - bot: markRemoteInjected(dir, text) right before typing → queued in `pending`
 *    (the bot doesn't know which Claude session will pick it up);
 *    unmarkRemoteInjected(dir, text) if the injection failed
 *  - UserPromptSubmit: classifyPrompt(dir, prompt, sessionId) — an injected prompt is
 *    moved from `pending` to `active[sessionId]`; a prompt typed locally ends that
 *    session's remote turn and records local activity for that session
 *  - hooks: isRemoteDriven(dir, sessionId) → route prompts/results to Telegram
 *  - Stop / SessionEnd / StopFailure: endRemoteTurn(dir, sessionId) — only that session's
 *    active turn ends; queued follow-ups survive
 *
 * `src/data/typing-active` is still used, but only as the bot's typing-indicator signal.
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './paths';
import { readJsonSafe, updateJsonLocked, withFileLock, writeJsonAtomic } from './atomic-json';

const DATA_DIR = process.env.CCGRAM_DATA_DIR || path.join(PROJECT_ROOT, 'src/data');
const REMOTE_FILE = path.join(DATA_DIR, 'remote-active.json');
const LOCAL_FILE = path.join(DATA_DIR, 'local-activity.json');

/** An active remote turn older than this is considered abandoned. */
const ACTIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * A queued injection that Claude never submitted (failed paste, or a built-in command
 * like /model that produces no UserPromptSubmit) stops counting after this long.
 * Long enough for a follow-up queued behind a long-running turn.
 */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * A queued injection makes the directory count as remote-driven only this long. It is
 * submitted right after the current turn's Stop (or immediately when idle); after that
 * it is still matched by text in classifyPrompt, but must not keep routing a *local*
 * session's prompts to Telegram (e.g. text that landed in a picker and never submitted).
 */
const PENDING_ROUTING_MS = 2 * 60 * 1000;
/** If the text doesn't match exactly (paste mangling), accept the oldest injection this recent. */
const INJECT_MATCH_WINDOW_MS = 15 * 1000;
const DEFAULT_ACTIVE_THRESHOLD_S = 300;
/** Key for a session whose hook didn't report a session_id. */
const UNKNOWN_SESSION = '_';

interface PendingInjection { at: number; prompt: string }
interface RemoteEntry {
  /** Injected by the bot, not yet submitted by any Claude session (oldest first) */
  pending: PendingInjection[];
  /** Telegram-driven turns in progress: Claude session_id → unix ms when it started */
  active?: Record<string, number>;
  /** @deprecated pre-session format; migrated into active[UNKNOWN_SESSION] on read */
  activeAt?: number;
}
type RemoteMap = Record<string, RemoteEntry>;
type LocalMap = Record<string, number>; // dir or dir::sessionId → unix seconds

/** The directory hooks should key session state on: the project root, not the shell's cwd. */
export function hookProjectDir(payloadCwd?: string | null): string {
  return process.env.CLAUDE_PROJECT_DIR || payloadCwd || process.cwd();
}

function key(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sessionKey(sessionId?: string | null): string {
  return sessionId || UNKNOWN_SESSION;
}

function localKey(dir: string, sessionId?: string | null): string {
  return sessionId ? `${key(dir)}::${sessionId}` : key(dir);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Drop expired parts (and migrate the old single activeAt); null when nothing meaningful is left. */
function prune(entry: RemoteEntry | undefined, now: number): RemoteEntry | null {
  if (!entry) return null;
  const pending = (Array.isArray(entry.pending) ? entry.pending : []).filter(p => now - p.at < PENDING_MAX_AGE_MS);
  const active: Record<string, number> = {};
  const raw: Record<string, number> = { ...(entry.active || {}) };
  if (entry.activeAt && !(UNKNOWN_SESSION in raw)) raw[UNKNOWN_SESSION] = entry.activeAt;
  for (const [sid, at] of Object.entries(raw)) {
    if (typeof at === 'number' && now - at < ACTIVE_MAX_AGE_MS) active[sid] = at;
  }
  if (!pending.length && !Object.keys(active).length) return null;
  return { pending, ...(Object.keys(active).length ? { active } : {}) };
}

function readRemote(): RemoteMap {
  return readJsonSafe<RemoteMap>(REMOTE_FILE, {});
}

function updateEntry(dir: string, fn: (entry: RemoteEntry, now: number) => RemoteEntry | null): void {
  const k = key(dir);
  updateJsonLocked<RemoteMap>(REMOTE_FILE, {}, (map) => {
    const now = Date.now();
    const next = fn(prune(map[k], now) || { pending: [] }, now);
    const cleaned = prune(next ?? undefined, now);
    if (cleaned) map[k] = cleaned;
    else delete map[k];
  });
}

/** Bot: a prompt is about to be injected into the session rooted at `dir`. */
export function markRemoteInjected(dir: string, prompt: string): void {
  updateEntry(dir, (entry, now) => ({ ...entry, pending: [...entry.pending, { at: now, prompt: normalize(prompt) }] }));
}

/** Bot: the injection of `prompt` failed — forget it. */
export function unmarkRemoteInjected(dir: string, prompt: string): void {
  const p = normalize(prompt);
  updateEntry(dir, (entry) => {
    const idx = entry.pending.map(x => x.prompt).lastIndexOf(p);
    if (idx === -1) return entry;
    return { ...entry, pending: entry.pending.filter((_, i) => i !== idx) };
  });
}

/**
 * Hooks: is this Claude session working on (or about to receive) a Telegram prompt?
 * A fresh queued injection counts for every session in the directory (the bot can't
 * know which one will type it); an active turn counts only for its own session.
 * Without a sessionId, any active turn in the directory counts.
 */
export function isRemoteDriven(dir: string, sessionId?: string | null): boolean {
  const now = Date.now();
  const entry = prune(readRemote()[key(dir)], now);
  if (!entry) return false;
  if (entry.pending.some(p => now - p.at < PENDING_ROUTING_MS)) return true;
  const active = entry.active || {};
  if (!sessionId) return Object.keys(active).length > 0;
  return sessionId in active || UNKNOWN_SESSION in active;
}

/** Stop / SessionEnd / StopFailure: this session's remote turn is over. Queued follow-ups stay. */
export function endRemoteTurn(dir: string, sessionId?: string | null): void {
  if (!(key(dir) in readRemote())) return;
  updateEntry(dir, (entry) => {
    if (!sessionId) return { pending: entry.pending };
    const active = { ...(entry.active || {}) };
    delete active[sessionId];
    delete active[UNKNOWN_SESSION];
    return { pending: entry.pending, active };
  });
}

/** @deprecated use endRemoteTurn — kept for callers of the first version of this module. */
export const clearRemote = endRemoteTurn;

/**
 * UserPromptSubmit: decide whether `prompt` is one the bot injected.
 * Returns 'remote' (keep routing to Telegram) or 'local' (user typed at the
 * terminal — ends this session's remote turn and records its local activity).
 */
export function classifyPrompt(dir: string, prompt: string, sessionId?: string | null): 'remote' | 'local' {
  // UserPromptSubmit also fires for harness-generated input (background task
  // notifications, scheduled tasks, cross-session messages), which arrives as
  // tag-wrapped text. That isn't the user at the terminal: leave both state files alone.
  if (/^\s*<[a-zA-Z][\w-]*[\s>]/.test(prompt)) {
    return isRemoteDriven(dir, sessionId) ? 'remote' : 'local';
  }

  const k = key(dir);
  const sk = sessionKey(sessionId);
  const p = normalize(prompt);
  const isRemote = withFileLock(REMOTE_FILE, () => {
    const map = readRemote();
    const now = Date.now();
    const entry = prune(map[k], now);
    let matched = false;
    let next: RemoteEntry | null = entry;
    if (entry) {
      let idx = entry.pending.findIndex(x => x.prompt === p);
      if (idx === -1 && entry.pending.length && now - entry.pending[0].at < INJECT_MATCH_WINDOW_MS) idx = 0;
      const active = { ...(entry.active || {}) };
      if (idx !== -1) {
        matched = true;
        active[sk] = now;
        next = { pending: entry.pending.filter((_, i) => i !== idx), active };
      } else {
        // Typed locally in THIS session: its remote turn (if any) is over; other
        // sessions' turns and queued injections stay
        delete active[sk];
        if (sessionId) delete active[UNKNOWN_SESSION];
        next = { pending: entry.pending, active };
      }
    }
    const cleaned = prune(next ?? undefined, now);
    if (cleaned) map[k] = cleaned;
    else delete map[k];
    writeJsonAtomic(REMOTE_FILE, map);
    return matched;
  });
  if (isRemote) return 'remote';
  const nowS = Math.floor(Date.now() / 1000);
  updateJsonLocked<LocalMap>(LOCAL_FILE, {}, (local) => {
    local[localKey(dir)] = nowS;                       // directory-level (callers without a session id)
    if (sessionId) local[localKey(dir, sessionId)] = nowS;
  });
  return 'local';
}

/**
 * Did the user type a prompt into this session within the threshold? With a sessionId,
 * only that session's own typing counts — a user working in the desktop app must not
 * silence the Telegram replies of the tmux session next to it.
 */
export function isLocallyActive(
  dir: string,
  sessionIdOrThreshold?: string | number | null,
  thresholdSeconds?: number,
): boolean {
  // Back-compat: isLocallyActive(dir, thresholdSeconds)
  const sessionId = typeof sessionIdOrThreshold === 'string' ? sessionIdOrThreshold : undefined;
  const threshold = typeof sessionIdOrThreshold === 'number'
    ? sessionIdOrThreshold
    : (thresholdSeconds ?? (parseInt(process.env.ACTIVE_THRESHOLD_SECONDS || '', 10) || DEFAULT_ACTIVE_THRESHOLD_S));
  const last = readJsonSafe<LocalMap>(LOCAL_FILE, {})[localKey(dir, sessionId)];
  if (!last) return false;
  return Math.floor(Date.now() / 1000) - last < threshold;
}
