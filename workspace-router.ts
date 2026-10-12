#!/usr/bin/env node

/**
 * Workspace Router - Maps workspace names to Claude Code sessions.
 *
 * Reads the session map and resolves human-friendly project names
 * (e.g. "wp-super-ai") to active tmux sessions so commands can be
 * routed without memorising tokens.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { PROJECT_ROOT, claudeProjectDirs } from './src/utils/paths';
import { readJsonSafe, writeJsonAtomic, withFileLock } from './src/utils/atomic-json';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
import Logger from './src/core/logger';
import type {
  SessionEntry,
  SessionMap,
  ResolveResult,
  MessageWorkspaceEntry,
  MessageWorkspaceMap,
  ProjectHistoryMap,
  SessionHistoryEntry,
  RateLimitInfo,
} from './src/types';

const logger = new Logger('router');

const DATA_DIR = process.env.CCGRAM_DATA_DIR || path.join(PROJECT_ROOT, 'src/data');
const SESSION_MAP_PATH = process.env.SESSION_MAP_PATH
  || path.join(DATA_DIR, 'session-map.json');
const SESSION_TIMEOUT_HOURS = parseInt(process.env.SESSION_TIMEOUT || '', 10) || 24;

/**
 * Extract a short project name from a cwd path.
 * "/home/user/projects/my-project" -> "my-project"
 */
function extractWorkspaceName(cwd: string | null): string | null {
  if (!cwd) return null;
  return path.basename(cwd);
}

/** Coerce a parsed JSON value to a plain object map (anything else counts as empty). */
function asObjectMap<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {};
}

/**
 * Read the session map for a read-modify-write. Throws on I/O errors other than a
 * missing file, so a transient failure can never be "fixed" by writing back an empty map.
 * A file that stays unparseable is moved aside by readJsonSafe (data preserved).
 */
function readSessionMapForWrite(): SessionMap {
  return asObjectMap<SessionEntry>(readJsonSafe<unknown>(SESSION_MAP_PATH, {}));
}

/** Read the session map from disk (read-only callers: errors are logged, never thrown). */
function readSessionMap(): SessionMap {
  try {
    return readSessionMapForWrite();
  } catch (err: unknown) {
    logger.error(`Failed to read session map: ${(err as Error).message}`);
    return {};
  }
}

/** Write the session map to disk atomically (temp file + rename). */
function writeSessionMap(map: SessionMap): void {
  writeJsonAtomic(SESSION_MAP_PATH, map);
}

/** True once a SessionEnd hook marked this entry ended — never an injection target. */
function isEnded(session: SessionEntry | Record<string, unknown>): boolean {
  return !!(session as SessionEntry).endedAt;
}

function isTmuxEntry(session: SessionEntry): boolean {
  return session.type === 'tmux' || session.sessionType === 'tmux';
}

/**
 * Names of live tmux sessions, or null when liveness can't be determined (tmux hung /
 * timed out) — callers then skip the liveness filter rather than dropping everything.
 * No tmux binary or no server running → empty set (every tmux entry is dead).
 */
function liveTmuxSessions(): Set<string> | null {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { signal?: string };
    if (e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')) return null;
    return new Set();
  }
}

/**
 * Lazily-evaluated tmux liveness check: only shells out to tmux when the map
 * actually contains a tmux entry.
 */
function tmuxLivenessFilter(): (session: SessionEntry) => boolean {
  let live: Set<string> | null | undefined;
  return (session: SessionEntry) => {
    if (!isTmuxEntry(session) || !session.tmuxSession) return true;
    if (live === undefined) live = liveTmuxSessions();
    return live === null || live.has(session.tmuxSession);
  };
}

/** Check whether a session has expired. */
function isExpired(session: SessionEntry | Record<string, unknown>): boolean {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = (session as SessionEntry).expiresAt;
  return !!(expiresAt && expiresAt < now);
}

/**
 * Find the most recent non-expired session whose workspace name matches.
 * Returns { token, session } or null.
 */
function findSessionByWorkspace(workspaceName: string): { token: string; session: SessionEntry } | null {
  const map = readSessionMap();
  let best: { token: string; session: SessionEntry } | null = null;

  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session) || isEnded(session)) continue;

    const name = extractWorkspaceName(session.cwd);
    if (name && name.toLowerCase() === workspaceName.toLowerCase()) {
      if (!best || session.createdAt > best.session.createdAt) {
        best = { token, session };
      }
    }
  }

  return best;
}

/**
 * List all active (non-expired) sessions grouped by workspace.
 * Returns an array of { workspace, token, session, age }.
 */
function listActiveSessions(): Array<{ workspace: string; token: string; session: SessionEntry; age: string }> {
  const map = readSessionMap();
  const now = Math.floor(Date.now() / 1000);
  const results: Array<{ workspace: string; token: string; session: SessionEntry; age: string }> = [];

  // Fork patch: ask the tmux server which sessions still exist, so we can drop
  // entries pointing at panes the user has since closed. Without this, /sessions
  // reports zombies that silently fail when /<workspace> tries to send_keys.
  const isLive = tmuxLivenessFilter();

  // Keep only the most recent session per workspace
  const byWorkspace = new Map<string, { token: string; session: SessionEntry }>();

  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session) || isEnded(session)) continue;
    // Fork patch: drop dead tmux entries
    if (!isLive(session)) continue;
    const workspace = extractWorkspaceName(session.cwd) || 'unknown';

    const existing = byWorkspace.get(workspace);
    if (!existing || session.createdAt > existing.session.createdAt) {
      byWorkspace.set(workspace, { token, session });
    }
  }

  for (const [workspace, { token, session }] of byWorkspace) {
    const ageSec = now - session.createdAt;
    results.push({
      workspace,
      token,
      session,
      age: formatAge(ageSec),
    });
  }

  // Sort newest first
  results.sort((a, b) => b.session.createdAt - a.session.createdAt);
  return results;
}

/**
 * Register or update a session in the map.
 * Called by the hook notifier when Claude starts/stops.
 */
function upsertSessionUnlocked({ cwd, tmuxSession, status, sessionId, sessionType, rateLimit, tmuxPane }: {
  cwd: string;
  tmuxSession: string;
  status: string;
  sessionId?: string | null;
  sessionType?: 'tmux' | 'pty' | 'ghostty';
  rateLimit?: RateLimitInfo;
  tmuxPane?: string;
}): { token: string; workspace: string | null } {
  const map = readSessionMapForWrite();
  const workspace = extractWorkspaceName(cwd);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TIMEOUT_HOURS * 3600;
  const resolvedCwd = path.resolve(cwd);

  // Try to find an existing session for this workspace + tmux combo
  let existingToken: string | null = null;
  for (const [token, sess] of Object.entries(map)) {
    if (sess.cwd && path.resolve(sess.cwd) === resolvedCwd && sess.tmuxSession === tmuxSession && !isExpired(sess)) {
      existingToken = token;
      break;
    }
  }

  const token = existingToken || generateToken();
  const existing = existingToken ? map[existingToken] : undefined;

  // Preserve existing sessionType if a new one isn't explicitly provided
  const resolvedSessionType = sessionType ?? existing?.sessionType;
  // Preserve existing rateLimit if a new one isn't provided
  const resolvedRateLimit = rateLimit ?? existing?.rateLimit;
  // Preserve the recorded pane if the caller doesn't know it (e.g. not running in tmux)
  const resolvedPane = tmuxPane || existing?.tmuxPane;

  // Built fresh (no spread of `existing`), so a previous endedAt is cleared:
  // a hook firing for this cwd means the session is alive again.
  map[token] = {
    type: resolvedSessionType || 'tmux',
    ...(resolvedSessionType !== undefined ? { sessionType: resolvedSessionType } : {}),
    createdAt: existing ? existing.createdAt : now,
    expiresAt,
    cwd,
    sessionId: sessionId || existing?.sessionId || null,
    tmuxSession: tmuxSession || `claude-${workspace}`,
    ...(resolvedPane ? { tmuxPane: resolvedPane } : {}),
    description: `${status} - ${workspace}`,
    ...(resolvedRateLimit ? { rateLimit: resolvedRateLimit } : {}),
  };

  writeSessionMap(map);
  recordProjectUsage(workspace!, cwd, sessionId ?? undefined);
  return { token, workspace };
}

/**
 * Mark the session that exited in `cwd` as ended (SessionEnd hook). Ended entries stay
 * in the map (history, /clear) but are skipped by every routing lookup until an
 * upsertSession for the same cwd revives them.
 */
function markSessionEndedUnlocked(cwd: string, opts: { sessionId?: string | null; tmuxPane?: string | null } = {}): void {
  if (!cwd) return;
  const map = readSessionMapForWrite();
  const resolvedCwd = path.resolve(cwd);
  const now = Math.floor(Date.now() / 1000);
  const sameCwd = Object.values(map).filter(s => s.cwd && path.resolve(s.cwd) === resolvedCwd && !s.endedAt);
  // Only end the session that actually exited: another Claude may be running in the
  // same directory. Narrow by tmux pane, then by Claude session id; if neither
  // identifies an entry, fall back to cwd only when it's unambiguous.
  let targets = opts.tmuxPane ? sameCwd.filter(s => s.tmuxPane === opts.tmuxPane) : [];
  if (!targets.length && opts.sessionId) targets = sameCwd.filter(s => s.sessionId === opts.sessionId);
  if (!targets.length && sameCwd.length === 1) targets = sameCwd;
  for (const session of targets) session.endedAt = now;
  if (targets.length) writeSessionMap(map);
}

/**
 * Update rate limit info for a session by workspace name.
 * Returns true if session was found and updated.
 */
function updateSessionRateLimitUnlocked(workspace: string, rateLimit: RateLimitInfo): boolean {
  const map = readSessionMapForWrite();
  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session)) continue;
    const sessionWorkspace = extractWorkspaceName(session.cwd);
    if (sessionWorkspace === workspace) {
      map[token].rateLimit = rateLimit;
      writeSessionMap(map);
      return true;
    }
  }
  return false;
}

/**
 * Get rate limit info for a session by workspace name.
 */
function getSessionRateLimit(workspace: string): RateLimitInfo | undefined {
  const map = readSessionMap();
  for (const session of Object.values(map)) {
    if (isExpired(session)) continue;
    const sessionWorkspace = extractWorkspaceName(session.cwd);
    if (sessionWorkspace === workspace) {
      return session.rateLimit;
    }
  }
  return undefined;
}

/**
 * Find the newest live (non-expired, non-ended) session with exactly this tmuxSession name.
 * Used by callback handlers that only have the session name from pending files.
 */
function findSessionByTmuxName(tmuxName: string): SessionEntry | undefined {
  if (!tmuxName) return undefined;
  const map = readSessionMap();
  let best: SessionEntry | undefined;
  for (const session of Object.values(map)) {
    if (isExpired(session) || isEnded(session)) continue;
    // Exact match only — never prefix (tmux's own `-t name` would prefix-match).
    if (session.tmuxSession === tmuxName) {
      if (!best || session.createdAt > best.createdAt) best = session;
    }
  }
  return best;
}

/** Remove expired sessions from the map. */
function pruneExpiredUnlocked(): number {
  let map: SessionMap;
  try {
    map = readSessionMapForWrite();
  } catch (err: unknown) {
    logger.error(`Failed to read session map for pruning: ${(err as Error).message}`);
    return 0;
  }
  let pruned = 0;
  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session)) {
      delete map[token];
      pruned++;
    }
  }
  if (pruned > 0) {
    writeSessionMap(map);
  }
  return pruned;
}

// ── Helpers ──────────────────────────────────────────────────────

function generateToken(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ── Prefix / Fuzzy Workspace Resolution ─────────────────────────

const DEFAULT_WORKSPACE_PATH = process.env.DEFAULT_WORKSPACE_PATH || path.join(DATA_DIR, 'default-workspace.json');
const MESSAGE_WORKSPACE_MAP_PATH = process.env.MESSAGE_WORKSPACE_MAP_PATH || path.join(DATA_DIR, 'message-workspace-map.json');

/**
 * Resolve a workspace name by exact match, then (unless `allowPrefix: false`) prefix match.
 * Callers acting on a name the user didn't type in full (e.g. a stored name) should
 * pass `allowPrefix: false` so "api" can never silently resolve to "api-server".
 */
function resolveWorkspace(name: string, opts: { allowPrefix?: boolean } = {}): ResolveResult {
  const allowPrefix = opts.allowPrefix !== false;
  const map = readSessionMap();
  const lower = name.toLowerCase();

  // Fork patch: same tmux liveness check as listActiveSessions, so we don't route
  // /<workspace> commands to a pane the user already closed.
  const isLive = tmuxLivenessFilter();

  // Build deduplicated workspace → { token, session } map (newest wins)
  const byWorkspace = new Map<string, { workspace: string; token: string; session: SessionEntry }>();
  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session) || isEnded(session)) continue;
    // Fork patch: drop dead tmux entries
    if (!isLive(session)) continue;
    const ws = extractWorkspaceName(session.cwd);
    if (!ws) continue;
    const existing = byWorkspace.get(ws.toLowerCase());
    if (!existing || session.createdAt > existing.session.createdAt) {
      byWorkspace.set(ws.toLowerCase(), { workspace: ws, token, session });
    }
  }

  // Exact match (case-insensitive)
  const exact = byWorkspace.get(lower);
  if (exact) {
    return { type: 'exact', match: { token: exact.token, session: exact.session }, workspace: exact.workspace };
  }

  if (!allowPrefix || !lower) return { type: 'none' };

  // Prefix match
  const prefixMatches: Array<{ workspace: string; token: string; session: SessionEntry }> = [];
  for (const [wsLower, entry] of byWorkspace) {
    if (wsLower.startsWith(lower)) {
      prefixMatches.push(entry);
    }
  }

  if (prefixMatches.length === 1) {
    const m = prefixMatches[0];
    return { type: 'prefix', match: { token: m.token, session: m.session }, workspace: m.workspace };
  }

  if (prefixMatches.length > 1) {
    return {
      type: 'ambiguous',
      matches: prefixMatches.map(m => ({ workspace: m.workspace, token: m.token, session: m.session })),
    };
  }

  return { type: 'none' };
}

// ── Default Workspace ───────────────────────────────────────────

function getDefaultWorkspace(): string | null {
  try {
    const data = readJsonSafe<{ workspace?: unknown } | null>(DEFAULT_WORKSPACE_PATH, null);
    return data && typeof data.workspace === 'string' && data.workspace ? data.workspace : null;
  } catch {
    return null;
  }
}

function setDefaultWorkspace(name: string | null): void {
  if (name) {
    writeJsonAtomic(DEFAULT_WORKSPACE_PATH, { workspace: name });
  } else {
    // Clear default
    try { fs.unlinkSync(DEFAULT_WORKSPACE_PATH); } catch {}
  }
}

// ── Message-to-Workspace Tracking (for reply-to routing) ────────

const MESSAGE_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Read the message map; throws on I/O errors (see readSessionMapForWrite). */
function readMessageMap(): MessageWorkspaceMap {
  return asObjectMap<MessageWorkspaceEntry>(readJsonSafe<unknown>(MESSAGE_WORKSPACE_MAP_PATH, {}));
}

function writeMessageMap(map: MessageWorkspaceMap): void {
  writeJsonAtomic(MESSAGE_WORKSPACE_MAP_PATH, map);
}

/**
 * Track which Telegram message_id belongs to which workspace.
 * Prunes entries older than 24 hours on each write.
 */
function trackNotificationMessageUnlocked(messageId: number | string, workspace: string, type: string): void {
  if (!messageId || !workspace) return;
  let map: MessageWorkspaceMap;
  try {
    map = readMessageMap();
  } catch (err: unknown) {
    // Best-effort tracking: skip rather than overwrite the file with a near-empty map
    logger.error(`Failed to read message map: ${(err as Error).message}`);
    return;
  }
  const now = Date.now();

  // Prune old entries
  for (const [id, entry] of Object.entries(map)) {
    if (now - entry.timestamp > MESSAGE_MAP_MAX_AGE_MS) {
      delete map[id];
    }
  }

  map[String(messageId)] = { workspace, type, timestamp: now };
  writeMessageMap(map);
}

/**
 * Look up which workspace a Telegram message belongs to.
 * Returns the workspace name or null.
 */
function getWorkspaceForMessage(messageId: number | string | null | undefined): string | null {
  if (!messageId) return null;
  let map: MessageWorkspaceMap;
  try { map = readMessageMap(); } catch { return null; }
  const entry = map[String(messageId)];
  if (!entry || typeof entry.timestamp !== 'number') return null;
  if (Date.now() - entry.timestamp > MESSAGE_MAP_MAX_AGE_MS) return null;
  return entry.workspace;
}

// ── Project History (persists across session expiry/pruning) ─────

const PROJECT_HISTORY_PATH = process.env.PROJECT_HISTORY_PATH || path.join(DATA_DIR, 'project-history.json');

/** Read project history; throws on I/O errors (see readSessionMapForWrite). */
function readProjectHistoryForWrite(): ProjectHistoryMap {
  return asObjectMap<ProjectHistoryMap[string]>(readJsonSafe<unknown>(PROJECT_HISTORY_PATH, {}));
}

function readProjectHistory(): ProjectHistoryMap {
  try {
    return readProjectHistoryForWrite();
  } catch (err: unknown) {
    logger.error(`Failed to read project history: ${(err as Error).message}`);
    return {};
  }
}

const MAX_SESSION_HISTORY = 5;

function recordProjectUsageUnlocked(name: string, projectPath: string, sessionId?: string | null): void {
  let history: ProjectHistoryMap;
  try {
    history = readProjectHistoryForWrite();
  } catch (err: unknown) {
    // Best-effort: never replace the history file with a near-empty map on a read error
    logger.error(`Failed to read project history: ${(err as Error).message}`);
    return;
  }
  const existing = history[name];
  const existingSessions: SessionHistoryEntry[] = existing?.sessions || [];

  let sessions: SessionHistoryEntry[];
  if (sessionId) {
    // Deduplicate, prepend new entry, cap at MAX_SESSION_HISTORY
    const filtered = existingSessions.filter(s => s.id !== sessionId);
    filtered.unshift({ id: sessionId, startedAt: Date.now() });
    sessions = filtered.slice(0, MAX_SESSION_HISTORY);
  } else {
    sessions = existingSessions;
  }

  history[name] = { path: projectPath, lastUsed: Date.now(), sessions };
  const entries = Object.entries(history).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  const trimmed = Object.fromEntries(entries.slice(0, 50));
  writeJsonAtomic(PROJECT_HISTORY_PATH, trimmed);
}

const PINNED_PROJECTS = ['assistant', 'telecc'];

function getRecentProjects(limit: number = 50): Array<{ name: string; path: string }> {
  const home = process.env.HOME || require('os').homedir();
  const history = readProjectHistory();

  // 1. Scan project directories and get modification times
  const projects = new Map<string, { path: string; lastActive: number }>();

  const scanDirs = process.env.PROJECT_DIRS
    ? process.env.PROJECT_DIRS.split(',').map(d => d.trim()).filter(Boolean)
    : [path.join(home, 'projects'), path.join(home, 'tools')];

  for (const base of scanDirs) {
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const fullPath = path.join(base, e.name);
        try {
          const mtime = fs.statSync(fullPath).mtimeMs;
          const existing = projects.get(e.name);
          if (!existing || mtime > existing.lastActive) {
            projects.set(e.name, { path: fullPath, lastActive: mtime });
          }
        } catch {}
      }
    } catch {}
  }

  // Also check ~/assistant directly (not under ~/projects/ or ~/tools/)
  try {
    const assistantPath = path.join(home, 'assistant');
    const mtime = fs.statSync(assistantPath).mtimeMs;
    const existing = projects.get('assistant');
    if (!existing || mtime > existing.lastActive) {
      projects.set('assistant', { path: assistantPath, lastActive: mtime });
    }
  } catch {}

  // 2. Merge with project history (use whichever timestamp is more recent)
  for (const [name, data] of Object.entries(history)) {
    const existing = projects.get(name);
    if (existing) {
      existing.lastActive = Math.max(existing.lastActive, data.lastUsed);
    } else {
      // History entry for a directory not in scan dirs — only include if path still exists
      try {
        if (fs.statSync(data.path).isDirectory()) {
          projects.set(name, { path: data.path, lastActive: data.lastUsed });
        }
      } catch {}
    }
  }

  // 3. Separate pinned from unpinned
  const pinned: Array<{ name: string; path: string }> = [];
  const unpinned: Array<{ name: string; path: string; lastActive: number }> = [];
  for (const [name, data] of projects) {
    if (PINNED_PROJECTS.includes(name)) {
      pinned.push({ name, path: data.path });
    } else {
      unpinned.push({ name, path: data.path, lastActive: data.lastActive });
    }
  }

  // 4. Sort pinned in defined order, unpinned by lastActive descending
  pinned.sort((a, b) => PINNED_PROJECTS.indexOf(a.name) - PINNED_PROJECTS.indexOf(b.name));
  unpinned.sort((a, b) => b.lastActive - a.lastActive);

  // 5. Combine: pinned first, then unpinned, limited to N
  const result = [...pinned, ...unpinned].slice(0, limit);
  return result.map(({ name, path: p }) => ({ name, path: p }));
}

/**
 * Return projects that have at least one stored Claude Code session ID.
 * Used by /resume to list resumeable conversations.
 */
function getResumeableProjects(limit: number = 10): Array<{ name: string; path: string; sessions: SessionHistoryEntry[] }> {
  const history = readProjectHistory();
  return Object.entries(history)
    .filter(([, d]) => d.sessions && d.sessions.length > 0)
    .filter(([, d]) => {
      try { return fs.statSync(d.path).isDirectory(); } catch { return false; }
    })
    .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    .slice(0, limit)
    .map(([name, d]) => ({ name, path: d.path, sessions: d.sessions! }));
}

/**
 * Read Claude Code's session storage for a project directory and return
 * the most recent sessions, sorted by file mtime (last activity).
 *
 * Claude Code stores sessions in ~/.claude/projects/<encoded-path>/<uuid>.jsonl
 * where the path encoding replaces every "/" with "-" (including the leading slash).
 */
function getClaudeSessionsForProject(
  projectPath: string,
  limit: number = 5,
): Array<{ id: string; lastActivity: number; snippet: string | null }> {
  // Claude Code encodes project paths by replacing every non-alphanumeric char
  // (including unicode like Chinese characters, underscores and — in current
  // builds — dots) with a dash. claudeProjectDirs() returns both spellings.
  const files: string[] = [];
  for (const sessionDir of claudeProjectDirs(projectPath)) {
    try {
      const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(sessionDir, e.name));
      }
    } catch { /* directory doesn't exist for this spelling */ }
  }
  if (files.length === 0) return [];

  const withMtime = files
    .map(f => {
      try {
        return { f, mtime: fs.statSync(f).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; mtime: number } => x !== null);

  withMtime.sort((a, b) => b.mtime - a.mtime);

  // Extract snippets and filter out empty stubs (no user messages)
  const results: Array<{ id: string; lastActivity: number; snippet: string | null }> = [];
  for (const { f, mtime } of withMtime) {
    if (results.length >= limit) break;

    const id = path.basename(f, '.jsonl');
    let snippet: string | null = null;

    try {
      const content = fs.readFileSync(f, 'utf8');
      const lines = content.split('\n').slice(0, 30);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' && obj.message?.role === 'user') {
            const c = obj.message.content;
            if (typeof c === 'string') {
              snippet = c.trim().slice(0, 35);
            } else if (Array.isArray(c)) {
              const textItem = c.find((x: { type: string }) => x.type === 'text') as { type: string; text?: string } | undefined;
              if (textItem?.text) snippet = textItem.text.trim().slice(0, 35);
            }
            if (snippet) break;
          }
        } catch { /* malformed line, skip */ }
      }
    } catch { /* unreadable file, skip */ }

    // Skip empty stub sessions (no user message found)
    if (!snippet) continue;

    results.push({ id, lastActivity: mtime, snippet });
  }

  return results;
}

// ── Locked read-modify-write wrappers ───────────────────────────
// The bot and several concurrent hook processes all update these files; the lock
// keeps one process from overwriting another's update with stale data.

function upsertSession(args: Parameters<typeof upsertSessionUnlocked>[0]): ReturnType<typeof upsertSessionUnlocked> {
  return withFileLock(SESSION_MAP_PATH, () => upsertSessionUnlocked(args));
}

function markSessionEnded(cwd: string, opts: { sessionId?: string | null; tmuxPane?: string | null } = {}): void {
  withFileLock(SESSION_MAP_PATH, () => markSessionEndedUnlocked(cwd, opts));
}

function updateSessionRateLimit(workspace: string, rateLimit: RateLimitInfo): boolean {
  return withFileLock(SESSION_MAP_PATH, () => updateSessionRateLimitUnlocked(workspace, rateLimit));
}

function pruneExpired(): number {
  return withFileLock(SESSION_MAP_PATH, () => pruneExpiredUnlocked());
}

/** Locked read-modify-write of the whole session map (mutate in place or return a new map). */
function updateSessionMap(mutate: (map: SessionMap) => SessionMap | void): SessionMap {
  return withFileLock(SESSION_MAP_PATH, () => {
    const map = readSessionMapForWrite();
    const next = mutate(map) || map;
    writeSessionMap(next);
    return next;
  });
}

function trackNotificationMessage(messageId: number | string, workspace: string, type: string): void {
  withFileLock(MESSAGE_WORKSPACE_MAP_PATH, () => trackNotificationMessageUnlocked(messageId, workspace, type));
}

function recordProjectUsage(name: string, projectPath: string, sessionId?: string | null): void {
  withFileLock(PROJECT_HISTORY_PATH, () => recordProjectUsageUnlocked(name, projectPath, sessionId));
}

export {
  extractWorkspaceName,
  readSessionMap,
  writeSessionMap,
  updateSessionMap,
  findSessionByWorkspace,
  findSessionByTmuxName,
  resolveWorkspace,
  listActiveSessions,
  upsertSession,
  markSessionEnded,
  pruneExpired,
  isExpired,
  isEnded,
  getDefaultWorkspace,
  setDefaultWorkspace,
  trackNotificationMessage,
  getWorkspaceForMessage,
  recordProjectUsage,
  getRecentProjects,
  getResumeableProjects,
  getClaudeSessionsForProject,
  updateSessionRateLimit,
  getSessionRateLimit,
  SESSION_MAP_PATH,
};
