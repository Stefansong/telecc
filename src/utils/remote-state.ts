/**
 * Per-session "driven from Telegram" state, keyed by the session's project root.
 *
 * Replaces the old global `src/data/typing-active` semantics, which had two bugs:
 *  - it was global, so a Telegram-driven session A made local session B's prompts go
 *    to Telegram (and B's events cleared A's flag);
 *  - any notification (SubagentStop, InstructionsLoaded, ...) deleted it mid-task, after
 *    which the injected prompt's own UserPromptSubmit timestamp made the user look
 *    "active at the terminal" and the final result was never sent to Telegram.
 *
 * Keying: hooks must pass `hookProjectDir(payload.cwd)` (CLAUDE_PROJECT_DIR, stable
 * when Claude `cd`s into a subdirectory) — the same value they record as the session's
 * cwd in the session map, which is what the bot passes back in.
 *
 * Lifecycle per session:
 *  - bot: markRemoteInjected(dir, text) right before typing → queued in `pending`
 *    (a follow-up sent while Claude is busy stays queued until Claude submits it);
 *    unmarkRemoteInjected(dir, text) if the injection failed
 *  - UserPromptSubmit: classifyPrompt(dir, prompt) — an injected prompt is moved from
 *    `pending` to `active`; a prompt typed locally ends the remote turn and records
 *    local activity
 *  - hooks: isRemoteDriven(dir) → route prompts/results to Telegram
 *  - Stop / SessionEnd / StopFailure: endRemoteTurn(dir) — only the *active* turn ends;
 *    queued follow-ups survive
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
 * A queued injection makes the session count as remote-driven only this long. It is
 * submitted right after the current turn's Stop (or immediately when idle); after that
 * it is still matched by text in classifyPrompt, but must not keep routing a *local*
 * session's prompts to Telegram (e.g. text that landed in a picker and never submitted).
 */
const PENDING_ROUTING_MS = 2 * 60 * 1000;
/** If the text doesn't match exactly (paste mangling), accept the oldest injection this recent. */
const INJECT_MATCH_WINDOW_MS = 15 * 1000;
const DEFAULT_ACTIVE_THRESHOLD_S = 300;

interface PendingInjection { at: number; prompt: string }
interface RemoteEntry {
  /** Injected by the bot, not yet submitted by Claude (oldest first) */
  pending: PendingInjection[];
  /** Unix ms when the current Telegram-driven turn started; absent when none */
  activeAt?: number;
}
type RemoteMap = Record<string, RemoteEntry>;
type LocalMap = Record<string, number>; // dir → unix seconds

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

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Drop expired parts; returns null when nothing meaningful is left. */
function prune(entry: RemoteEntry | undefined, now: number): RemoteEntry | null {
  if (!entry) return null;
  const pending = (Array.isArray(entry.pending) ? entry.pending : []).filter(p => now - p.at < PENDING_MAX_AGE_MS);
  const activeAt = entry.activeAt && now - entry.activeAt < ACTIVE_MAX_AGE_MS ? entry.activeAt : undefined;
  if (!pending.length && !activeAt) return null;
  return { pending, ...(activeAt ? { activeAt } : {}) };
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

/** Hooks: is the session rooted at `dir` working on (or about to receive) a Telegram prompt? */
export function isRemoteDriven(dir: string): boolean {
  const now = Date.now();
  const entry = prune(readRemote()[key(dir)], now);
  if (!entry) return false;
  return !!entry.activeAt || entry.pending.some(p => now - p.at < PENDING_ROUTING_MS);
}

/** Stop / SessionEnd / StopFailure: the current remote turn is over. Queued follow-ups stay. */
export function endRemoteTurn(dir: string): void {
  if (!(key(dir) in readRemote())) return;
  updateEntry(dir, (entry) => ({ pending: entry.pending }));
}

/** @deprecated use endRemoteTurn — kept for callers of the first version of this module. */
export const clearRemote = endRemoteTurn;

/**
 * UserPromptSubmit: decide whether `prompt` is one the bot injected.
 * Returns 'remote' (keep routing to Telegram) or 'local' (user typed at the
 * terminal — ends the remote turn and records local activity).
 */
export function classifyPrompt(dir: string, prompt: string): 'remote' | 'local' {
  // UserPromptSubmit also fires for harness-generated input (background task
  // notifications, scheduled tasks, cross-session messages), which arrives as
  // tag-wrapped text. That isn't the user at the terminal: leave both state files alone.
  if (/^\s*<[a-zA-Z][\w-]*[\s>]/.test(prompt)) {
    return isRemoteDriven(dir) ? 'remote' : 'local';
  }

  const k = key(dir);
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
      if (idx !== -1) {
        matched = true;
        next = { pending: entry.pending.filter((_, i) => i !== idx), activeAt: now };
      } else {
        // Typed locally: the remote turn (if any) is over; queued injections stay
        next = { pending: entry.pending };
      }
    }
    const cleaned = prune(next ?? undefined, now);
    if (cleaned) map[k] = cleaned;
    else delete map[k];
    writeJsonAtomic(REMOTE_FILE, map);
    return matched;
  });
  if (isRemote) return 'remote';
  updateJsonLocked<LocalMap>(LOCAL_FILE, {}, (local) => { local[k] = Math.floor(Date.now() / 1000); });
  return 'local';
}

/** Did the user type a prompt into the session rooted at `dir` within the threshold? */
export function isLocallyActive(
  dir: string,
  thresholdSeconds: number = parseInt(process.env.ACTIVE_THRESHOLD_SECONDS || '', 10) || DEFAULT_ACTIVE_THRESHOLD_S,
): boolean {
  const last = readJsonSafe<LocalMap>(LOCAL_FILE, {})[key(dir)];
  if (!last) return false;
  return Math.floor(Date.now() / 1000) - last < thresholdSeconds;
}
