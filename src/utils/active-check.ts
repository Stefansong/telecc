/**
 * active-check.ts — Decides whether a hook should leave a prompt/notification to the
 * terminal (user is there) or route it to Telegram.
 *
 * Per-session via remote-state, keyed by the session's PROJECT ROOT — pass
 * `hookProjectDir(payload.cwd)`, never the raw payload cwd (it changes when Claude
 * `cd`s into a subdirectory):
 *  - isRemoteDriven(dir, sessionId): this session's turn was injected from Telegram → always Telegram
 *  - isLocallyActive(dir, sessionId): the user typed into THIS session within the threshold
 *    (default 300 s, ACTIVE_THRESHOLD_SECONDS) → the terminal handles it
 *
 * `src/data/typing-active` carries no routing meaning any more — it is only the bot's
 * typing-indicator signal.
 */

import fs from 'fs';
import { isRemoteDriven, isLocallyActive, hookProjectDir } from './remote-state';

export { isRemoteDriven, isLocallyActive, hookProjectDir };

/**
 * True when Claude Code's own terminal UI should handle the prompt for the session
 * rooted at `dir` (= hookProjectDir(payload.cwd)): the user is working in that session
 * locally and the current turn did not come from Telegram. Otherwise the hook routes
 * it to Telegram.
 */
export function shouldDeferToTerminal(
  dir: string,
  opts?: { sessionId?: string | null; thresholdSeconds?: number } | number,
): boolean {
  const o = typeof opts === 'number' ? { thresholdSeconds: opts } : (opts || {});
  return !isRemoteDriven(dir, o.sessionId) && isLocallyActive(dir, o.sessionId ?? undefined, o.thresholdSeconds);
}

const LAST_MSG_FILE = '/tmp/claude_last_msg_time';
const DEFAULT_THRESHOLD = 300; // 5 minutes

/**
 * @deprecated Global (not per-session) — use shouldDeferToTerminal(cwd) / isLocallyActive(cwd).
 * Reads /tmp/claude_last_msg_time, which user-prompt-hook still writes for locally typed
 * prompts for backwards compatibility.
 * @param thresholdSeconds - seconds since last message to consider user "active" (default 300)
 */
export function isUserActiveAtTerminal(
  thresholdSeconds: number = parseInt(process.env.ACTIVE_THRESHOLD_SECONDS || '', 10) || DEFAULT_THRESHOLD
): boolean {
  try {
    const raw = fs.readFileSync(LAST_MSG_FILE, 'utf8').trim();
    const lastMsg = parseInt(raw, 10);
    if (!lastMsg || isNaN(lastMsg)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return (nowSeconds - lastMsg) < thresholdSeconds;
  } catch {
    // File doesn't exist — no session info, assume not active
    return false;
  }
}
