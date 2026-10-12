/**
 * Ghostty Session Manager — controls Ghostty terminal sessions via AppleScript.
 *
 * Ghostty 1.3.0+ supports native AppleScript for controlling terminal windows,
 * tabs, and splits. This backend is used when TERM_PROGRAM=ghostty and no
 * tmux session is available.
 *
 * Session identity: CWD-based. Stores Map<sessionName, cwd> as handles. If more than
 * one Ghostty terminal sits in the same cwd the target is ambiguous and every
 * operation fails (returns false/null) instead of typing into a guessed terminal.
 * Text injection: input text "..." to terminal (paste-style, handles ANSI).
 * Key sequences: arrow keys via ANSI (send key "down" is broken in 1.3.0).
 * Modifier keys (C-c, C-u): use "send key KEY modifiers MOD to term" (no "with").
 */

import os from 'os';
import fs from 'fs';
import { execFile, execFileSync } from 'child_process';

// Key name → macOS key code (sent via System Events after focus, bypasses bracketed paste)
// send key "down" is unsupported in Ghostty AppleScript; input text ANSI is wrapped in
// bracketed paste which Claude Code's TUI doesn't recognise as navigation.
const KEY_CODES: Record<string, number> = {
  'Down':  125,
  'Up':    126,
  'Space': 49,
};

// Keys sent via "send key NAME to term" (no modifiers)
const SEND_KEYS: Record<string, string> = {
  'Enter': 'enter',
  'C-m':   'enter',
};

// Keys using "send key KEY modifiers MOD to term" (no "with" — plain param per Ghostty sdef)
const MODIFIER_KEYS: Record<string, { key: string; modifiers: string }> = {
  'C-c': { key: 'c', modifiers: 'control' },
  'C-u': { key: 'u', modifiers: 'control' },
};

/** Printable ASCII that can sit verbatim inside an AppleScript string literal. */
function isPlainAscii(code: number): boolean {
  return code >= 32 && code < 127;
}

/** Escape `\` and `"` for the inside of an AppleScript "..." literal. */
function escapeAppleScriptLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class GhosttySessionManager {
  /** Map from session name to registered CWD. */
  private handles: Map<string, string> = new Map();

  /** Message of the most recent failed operation (e.g. the "ambiguous: ..." error), for callers to surface. */
  lastError: string | null = null;

  /**
   * Whether Ghostty is available and running on this machine.
   * Re-checked each call (fast) so the bot handles Ghostty launching after startup.
   */
  isAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      const result = execFileSync('osascript', ['-e', 'application "Ghostty" is running'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 2000,
      }).trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  /** Whether a handle is registered for this session name. */
  has(name: string): boolean {
    return this.handles.has(name);
  }

  /** Register (or update) a session handle with its CWD. */
  register(name: string, cwd: string): void {
    this.handles.set(name, cwd);
  }

  /** Remove a session handle. */
  unregister(name: string): void {
    this.handles.delete(name);
  }

  /**
   * Execute an AppleScript via osascript stdin pipe (execFile, no shell).
   * Using stdin pipe avoids all quoting issues and supports multi-line scripts.
   */
  private runScript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('osascript', ['-'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || '').trim();
          reject(new Error(detail || err.message));
        } else {
          resolve(String(stdout).trim());
        }
      });
      // osascript missing / killed early → EPIPE on stdin; the exec callback reports the failure
      child.stdin?.on('error', () => {});
      child.stdin?.write(script);
      child.stdin?.end();
    });
  }

  /**
   * Run a script that ends with `return "ok"`; true only when it ran to completion.
   * Any osascript failure (no terminal, ambiguous cwd, Ghostty not running, timeout)
   * is logged, remembered in `lastError`, and reported as false.
   */
  private async runAction(label: string, name: string, script: string): Promise<boolean> {
    try {
      const out = await this.runScript(`${script}\nreturn "ok"`);
      if (out !== 'ok') throw new Error(`unexpected osascript output: ${out || '(empty)'}`);
      this.lastError = null;
      return true;
    } catch (err: unknown) {
      this.lastError = (err as Error).message;
      process.stderr.write(`[ghostty-session-manager] ${label} failed for ${name}: ${this.lastError}\n`);
      return false;
    }
  }

  /**
   * Build an AppleScript string literal expression for the given value
   * (`\` and `"` escaped; other characters, including CJK, kept verbatim).
   */
  private buildAppleScriptString(str: string): string {
    return `"${escapeAppleScriptLiteral(str)}"`;
  }

  /**
   * Build an AppleScript expression that produces the given text when evaluated.
   * Printable ASCII goes into escaped string literals; every other character
   * (control chars, ESC sequences, CJK, emoji) is emitted by Unicode *code point*
   * via (character id N) / (string id {...}). Iterating code points — not UTF-16
   * units — matters: an emoji's lone surrogate halves (character id 55357) make
   * osascript fail with -1728.
   */
  private buildAppleScriptText(text: string): string {
    const parts: string[] = [];
    let literal = '';
    let ids: number[] = [];

    const flushLiteral = () => {
      if (literal) { parts.push(`"${escapeAppleScriptLiteral(literal)}"`); literal = ''; }
    };
    const flushIds = () => {
      if (ids.length === 1) parts.push(`(character id ${ids[0]})`);
      else if (ids.length > 1) parts.push(`(string id {${ids.join(', ')}})`);
      ids = [];
    };

    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (isPlainAscii(code)) {
        flushIds();
        literal += ch;
      } else {
        flushLiteral();
        ids.push(code);
      }
    }
    flushLiteral();
    flushIds();

    if (parts.length === 0) return '""';
    return parts.join(' & ');
  }

  /**
   * Build the AppleScript fragment that finds the terminal for a registered CWD.
   * Iterates all windows and tabs and counts terminals whose working directory
   * matches: none → error, more than one → "ambiguous" error (never guess which
   * split/tab the user meant).
   */
  private findTermScript(cwd: string): string {
    const cwdExpr = this.buildAppleScriptString(cwd);
    return `set targetCwd to ${cwdExpr}
set foundTerm to missing value
set matchCount to 0
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if working directory of term is targetCwd then
          set matchCount to matchCount + 1
          if foundTerm is missing value then set foundTerm to term
        end if
      end repeat
    end repeat
  end repeat
  if foundTerm is missing value then error "No Ghostty terminal found for cwd: " & targetCwd
  if matchCount > 1 then error "ambiguous: " & matchCount & " Ghostty terminals in " & targetCwd
end tell`;
  }

  /**
   * Is the registered session still backed by exactly one open Ghostty terminal?
   * Cheap (one osascript round trip); a closed tab reports false, as does an
   * ambiguous cwd (see `lastError`).
   */
  async hasTerminal(name: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;
    if (process.platform !== 'darwin') return false;
    return this.runAction('hasTerminal', name, this.findTermScript(cwd));
  }

  /**
   * Write raw text to a Ghostty terminal (paste-style).
   * Handles printable ASCII, control characters (e.g. \r for Enter),
   * and ANSI escape sequences (e.g. \x1B[B for Down arrow).
   */
  async write(name: string, text: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;

    const textExpr = this.buildAppleScriptText(text);
    const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  input text ${textExpr} to foundTerm
end tell`;
    return this.runAction('write', name, script);
  }

  /**
   * Write text then immediately press Return — all in one AppleScript execution.
   * Avoids a second CWD lookup between write and Enter, which can miss the terminal.
   */
  async writeLine(name: string, text: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;

    const textExpr = this.buildAppleScriptText(text);
    const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
  input text ${textExpr} to foundTerm
  delay 0.1
  send key "enter" to foundTerm
end tell`;
    return this.runAction('writeLine', name, script);
  }

  /**
   * Send a named key to a session.
   * C-c and C-u use "send key ... with modifiers" (required by Ghostty AppleScript).
   * Down, Up, Enter, Space use ANSI sequences via input text
   * (send key "down" is broken in Ghostty 1.3.0).
   */
  async sendKey(name: string, key: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;

    const modKey = MODIFIER_KEYS[key];
    if (modKey) {
      const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
  send key "${modKey.key}" modifiers "${modKey.modifiers}" to foundTerm
end tell`;
      return this.runAction(`sendKey(${key})`, name, script);
    }

    const sendKeyName = SEND_KEYS[key];
    if (sendKeyName) {
      const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
  send key "${sendKeyName}" to foundTerm
end tell`;
      return this.runAction(`sendKey(${key})`, name, script);
    }

    const keyCode = KEY_CODES[key];
    if (keyCode !== undefined) {
      const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
end tell
tell application "System Events"
  tell process "Ghostty"
    key code ${keyCode}
  end tell
end tell`;
      return this.runAction(`sendKey(${key})`, name, script);
    }

    // Unknown key — pass through as text
    return this.write(name, key);
  }

  /** Send Ctrl+C interrupt to the terminal. */
  async interrupt(name: string): Promise<boolean> {
    return this.sendKey(name, 'C-c');
  }

  /**
   * Capture terminal scrollback by triggering write_scrollback_file.
   * Finds the new file in the OS temp directory and reads its content.
   * Returns null if unavailable or no file produced within 1s.
   */
  async capture(name: string): Promise<string | null> {
    const cwd = this.handles.get(name);
    if (!cwd) return null;

    const tmpDir = os.tmpdir();

    // 1. Note existing Ghostty temp files and their mtimes
    const existingFiles = new Map<string, number>();
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        const fl = f.toLowerCase();
        if (fl.startsWith('ghostty') || fl.startsWith('com.mitchellh.ghostty')) {
          try {
            const mtime = fs.statSync(`${tmpDir}/${f}`).mtimeMs;
            existingFiles.set(f, mtime);
          } catch {}
        }
      }
    } catch {}

    // 2. Trigger write_scrollback_file
    const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  perform action "write_scrollback_file" on foundTerm
end tell`;
    if (!await this.runAction('capture trigger', name, script)) return null;

    // 3. Wait up to 1s for a new (or updated) file to appear
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
          const fl = f.toLowerCase();
          if (fl.startsWith('ghostty') || fl.startsWith('com.mitchellh.ghostty')) {
            const filePath = `${tmpDir}/${f}`;
            try {
              const mtime = fs.statSync(filePath).mtimeMs;
              const prevMtime = existingFiles.get(f);
              if (prevMtime === undefined || mtime > prevMtime) {
                return fs.readFileSync(filePath, 'utf8');
              }
            } catch {}
          }
        }
      } catch {}
      await new Promise<void>(r => setTimeout(r, 100));
    }

    return null;
  }

  /**
   * Open a new tab in the front Ghostty window and run a command.
   * Uses AppleScript's quoted form of for safe shell quoting of the cwd.
   */
  async openNewTab(cwd: string, command: string): Promise<boolean> {
    // Build AppleScript expression for cwd (used with quoted form of)
    const cwdExpr = this.buildAppleScriptString(cwd);
    // Build AppleScript expression for the command (plain text)
    const cmdExpr = this.buildAppleScriptText(command);
    const script = `tell application "Ghostty"
  if (count of windows) is 0 then error "No Ghostty windows open"
  set w to front window
  perform action "new_tab" on w
  delay 0.5
  set term to focused terminal of selected tab of w
  focus term
  input text "cd " & quoted form of ${cwdExpr} & " && " & ${cmdExpr} to term
  delay 0.1
  send key "enter" to term
end tell`;
    return this.runAction('openNewTab', cwd, script);
  }
}

export const ghosttySessionManager = new GhosttySessionManager();
