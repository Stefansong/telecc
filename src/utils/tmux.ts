/**
 * Safe tmux helpers. Always use these instead of building `tmux ...` shell strings.
 *
 *  - execFile with an argv array: session names / paths / user text never pass
 *    through a shell, so quotes, `$()`, `&`, `;` and spaces are inert.
 *  - Exact targets: a bare `-t name` falls back to *prefix* matching in tmux
 *    (`-t api` hits `api-server`); `=name` forces an exact session match.
 *  - Literal text: `send-keys -l --` so text starting with `-` isn't parsed as flags,
 *    a trailing `;` isn't eaten as a command separator, and a message that happens to
 *    be a key name ("Enter", "Escape", "C-c") is typed rather than pressed.
 */

import { execFile } from 'child_process';
import { childEnv, isOwnConfigKey } from './child-env';

const DEFAULT_TIMEOUT_MS = 5000;

/** Run tmux with the given argv; resolves stdout, rejects on non-zero exit/timeout. */
export function tmux(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    // Scrubbed env: when this call starts the tmux server, its global environment
    // (inherited by every pane) must not contain the daemon's secrets
    execFile('tmux', args, { encoding: 'utf8', timeout: timeoutMs, env: childEnv() }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Start a detached session for the bot. A server started before env scrubbing existed
 * may still carry the daemon's keys in its global environment — unset them first so
 * the new pane's shell (and the Claude + plugins it runs) can't inherit them.
 */
export async function newSession(name: string, cwd: string): Promise<void> {
  for (const key of Object.keys(process.env).filter(isOwnConfigKey)) {
    try { await tmux(['set-environment', '-gu', key]); } catch { /* no server yet */ }
  }
  await tmux(['new-session', '-d', '-s', name, '-c', cwd]);
}

/** Exact session target (no prefix fallback). */
export function sessionTarget(sessionName: string): string {
  return `=${sessionName}`;
}

/**
 * Pane target: a recorded pane id (`%12`) when known, else the active pane of the
 * exactly-matched session (`=name:`).
 */
export function paneTarget(sessionName: string, paneId?: string | null): string {
  if (paneId && /^%\d+$/.test(paneId)) return paneId;
  return `=${sessionName}:`;
}

export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', sessionTarget(sessionName)]);
    return true;
  } catch {
    return false;
  }
}

/** Does `paneId` still exist and belong to `sessionName`? */
export async function paneBelongsTo(paneId: string, sessionName: string): Promise<boolean> {
  try {
    const out = await tmux(['display-message', '-p', '-t', paneId, '#{session_name}']);
    return out.trim() === sessionName;
  } catch {
    return false;
  }
}

/** Resolve the best pane target for a session, verifying a recorded pane id is still valid. */
export async function resolvePaneTarget(sessionName: string, paneId?: string | null): Promise<string> {
  if (paneId && /^%\d+$/.test(paneId) && await paneBelongsTo(paneId, sessionName)) return paneId;
  return paneTarget(sessionName);
}

/** Type `text` literally into the target pane (no Enter). */
export async function sendLiteral(target: string, text: string): Promise<void> {
  await tmux(['send-keys', '-t', target, '-l', '--', text]);
}

/** Press named keys (e.g. 'C-u', 'Enter', 'Down') in the target pane. Only pass trusted key names. */
export async function sendKeys(target: string, ...keys: string[]): Promise<void> {
  await tmux(['send-keys', '-t', target, ...keys]);
}

/** Capture the visible pane (plus `historyLines` of scrollback) as plain text. */
export async function capturePane(target: string, historyLines: number = 0): Promise<string> {
  const args = ['capture-pane', '-p', '-t', target];
  if (historyLines > 0) args.push('-S', `-${historyLines}`);
  return tmux(args);
}

/** Foreground command of a pane, e.g. 'claude', 'node', 'zsh'. Null if unknown. */
export async function paneCurrentCommand(target: string): Promise<string | null> {
  try {
    const out = await tmux(['display-message', '-p', '-t', target, '#{pane_current_command}']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'dash', 'ksh', 'tcsh', 'csh', 'login']);

/** True when the pane is sitting at a bare shell prompt (Claude has exited). */
export function isShellCommand(cmd: string | null): boolean {
  return !!cmd && SHELLS.has(cmd);
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * True when the pane is idle at a shell prompt (Claude has exited / never started).
 * Looks at the terminal's foreground process group rather than the command name:
 *  - idle shell (also a nested `bash` inside zsh): the group is exactly one shell process
 *  - wrapper script running `claude` without `exec`: shows up as `bash`, but its job's
 *    group also contains claude → not idle
 *  - native installs report the version (e.g. `2.1.283`) as the command → not a shell
 * Returns false when it can't tell (don't block injection on a failed probe).
 */
export async function isPaneAtShellPrompt(target: string): Promise<boolean> {
  let pid: number;
  let cmd: string;
  try {
    // tmux rewrites control chars like \t in format output, so use '|'
    const out = (await tmux(['display-message', '-p', '-t', target, '#{pane_pid}|#{pane_current_command}'])).trim();
    const sep = out.indexOf('|');
    pid = parseInt(out.slice(0, sep), 10);
    cmd = out.slice(sep + 1);
  } catch {
    return false;
  }
  if (!isShellCommand(cmd) || isNaN(pid)) return false;

  const tpgidOut = await run('ps', ['-o', 'tpgid=', '-p', String(pid)]);
  const tpgid = parseInt((tpgidOut || '').trim(), 10);
  if (isNaN(tpgid) || tpgid <= 0) return false;
  if (tpgid === pid) return true; // the pane's own shell owns the terminal

  const listing = await run('ps', ['-ax', '-o', 'pid=,pgid=,comm=']);
  if (!listing) return false;
  const group = listing.split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && parseInt(m[2], 10) === tpgid)
    .map(m => m[3].split('/').pop() || '');
  return group.length === 1 && isShellCommand(group[0]);
}

/** Names of all live tmux sessions (empty set if no server). */
export async function listSessions(): Promise<Set<string>> {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}
