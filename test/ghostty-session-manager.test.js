import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GhosttySessionManager } from '../src/utils/ghostty-session-manager.js';

// Mock child_process so tests don't require a live Ghostty installation
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: vi.fn(),
    execFile: vi.fn(),
  };
});

import { execFileSync, execFile } from 'child_process';

/**
 * Make the mocked execFile behave like `osascript -` : capture the script written
 * to stdin and complete with the given result when stdin is closed.
 */
function mockOsascript({ stdout = 'ok\n', error = null, stderr = '' } = {}) {
  const scripts = [];
  execFile.mockImplementation((file, args, opts, cb) => {
    let script = '';
    return {
      stdin: {
        on: vi.fn(),
        write: vi.fn((chunk) => { script += chunk; }),
        end: vi.fn(() => { scripts.push({ file, args, script }); cb(error, stdout, stderr); }),
      },
    };
  });
  return scripts;
}

describe('GhosttySessionManager', () => {
  let manager;
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = process.platform;
    vi.clearAllMocks();
    manager = new GhosttySessionManager();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  describe('isAvailable()', () => {
    it('returns false on non-darwin platform', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      expect(manager.isAvailable()).toBe(false);
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('returns false on win32 platform', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(manager.isAvailable()).toBe(false);
    });

    it('returns true when osascript reports Ghostty is running', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execFileSync.mockReturnValue('true\n');
      expect(manager.isAvailable()).toBe(true);
      // argv, no shell string
      expect(execFileSync).toHaveBeenCalledWith('osascript', ['-e', 'application "Ghostty" is running'], expect.any(Object));
    });

    it('returns false when osascript reports Ghostty is not running', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execFileSync.mockReturnValue('false\n');
      expect(manager.isAvailable()).toBe(false);
    });

    it('returns false when osascript throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execFileSync.mockImplementation(() => { throw new Error('osascript failed'); });
      expect(manager.isAvailable()).toBe(false);
    });
  });

  describe('has()', () => {
    it('returns false before register()', () => {
      expect(manager.has('myproject')).toBe(false);
    });

    it('returns true after register()', () => {
      manager.register('myproject', '/Users/test/myproject');
      expect(manager.has('myproject')).toBe(true);
    });

    it('returns false after unregister()', () => {
      manager.register('myproject', '/Users/test/myproject');
      manager.unregister('myproject');
      expect(manager.has('myproject')).toBe(false);
    });
  });

  describe('register() and unregister()', () => {
    it('register() stores handle and allows retrieval via has()', () => {
      manager.register('proj-a', '/Users/test/proj-a');
      manager.register('proj-b', '/Users/test/proj-b');
      expect(manager.has('proj-a')).toBe(true);
      expect(manager.has('proj-b')).toBe(true);
      expect(manager.has('proj-c')).toBe(false);
    });

    it('register() updates existing handle with new cwd', () => {
      manager.register('proj', '/old/path');
      manager.register('proj', '/new/path');
      expect(manager.has('proj')).toBe(true);
      // Has should still return true after update
    });

    it('unregister() on unknown name does not throw', () => {
      expect(() => manager.unregister('nonexistent')).not.toThrow();
    });

    it('unregister() removes only the specified handle', () => {
      manager.register('proj-a', '/Users/test/proj-a');
      manager.register('proj-b', '/Users/test/proj-b');
      manager.unregister('proj-a');
      expect(manager.has('proj-a')).toBe(false);
      expect(manager.has('proj-b')).toBe(true);
    });
  });

  describe('sendKey() when manager unavailable', () => {
    it('returns false gracefully when no handle registered', async () => {
      const result = await manager.sendKey('unregistered-session', 'Down');
      expect(result).toBe(false);
    });

    it('returns false gracefully for interrupt when no handle registered', async () => {
      const result = await manager.interrupt('unregistered-session');
      expect(result).toBe(false);
    });
  });

  describe('write() when no handle registered', () => {
    it('returns false when session not registered', async () => {
      const result = await manager.write('unregistered', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('capture() when no handle registered', () => {
    it('returns null when session not registered', async () => {
      const result = await manager.capture('unregistered');
      expect(result).toBeNull();
    });
  });

  describe('AppleScript text escaping', () => {
    it('emits emoji by code point, never as lone UTF-16 surrogates', () => {
      const expr = manager.buildAppleScriptText('hi 😀');
      expect(expr).toContain('(character id 128512)');
      expect(expr).not.toMatch(/character id 5\d{4}\b/); // 55357 / 56832 surrogate halves
      expect(expr).toBe('"hi " & (character id 128512)');
    });

    it('groups runs of non-ASCII (CJK, emoji sequences) into one string id list', () => {
      expect(manager.buildAppleScriptText('中文')).toBe('(string id {20013, 25991})');
      expect(manager.buildAppleScriptText('👍🏽')).toBe('(string id {128077, 127997})');
    });

    it('escapes backslashes and double quotes inside literals', () => {
      expect(manager.buildAppleScriptText('a\\b')).toBe('"a\\\\b"');
      expect(manager.buildAppleScriptText('say "hi"')).toBe('"say \\"hi\\""');
      expect(manager.buildAppleScriptText('end\\')).toBe('"end\\\\"');
    });

    it('emits control characters (Enter, ESC sequences) by id', () => {
      expect(manager.buildAppleScriptText('\x1b[B\r')).toBe('(character id 27) & "[B" & (character id 13)');
    });

    it('returns an empty literal for empty text', () => {
      expect(manager.buildAppleScriptText('')).toBe('""');
    });

    it('escapes backslashes and quotes in cwd literals', () => {
      expect(manager.buildAppleScriptString('/Users/x/a\\b "c"')).toBe('"/Users/x/a\\\\b \\"c\\""');
      expect(manager.buildAppleScriptString('/Users/x/项目')).toBe('"/Users/x/项目"');
    });
  });

  describe('osascript-backed actions', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      manager.register('proj', '/Users/test/proj');
    });

    it('writeLine runs osascript via execFile + stdin and returns true on "ok"', async () => {
      const scripts = mockOsascript();
      expect(await manager.writeLine('proj', 'hello 😀')).toBe(true);
      expect(scripts).toHaveLength(1);
      expect(scripts[0].file).toBe('osascript');
      expect(scripts[0].args).toEqual(['-']);
      expect(scripts[0].script).toContain('input text "hello " & (character id 128512) to foundTerm');
      expect(scripts[0].script.trim().endsWith('return "ok"')).toBe(true);
    });

    it('selects the terminal by cwd and refuses an ambiguous match', async () => {
      const scripts = mockOsascript();
      await manager.write('proj', 'x');
      expect(scripts[0].script).toContain('set targetCwd to "/Users/test/proj"');
      expect(scripts[0].script).toContain('if matchCount > 1 then error "ambiguous: " & matchCount & " Ghostty terminals in " & targetCwd');
    });

    it('writeLine/sendKey/write return false (not true) when osascript fails', async () => {
      const err = new Error('Command failed: osascript -');
      mockOsascript({ error: err, stdout: '', stderr: 'execution error: ambiguous: 2 Ghostty terminals in /Users/test/proj (-2700)' });
      expect(await manager.writeLine('proj', 'hello')).toBe(false);
      expect(manager.lastError).toContain('ambiguous: 2 Ghostty terminals in /Users/test/proj');
      expect(await manager.sendKey('proj', 'C-u')).toBe(false);
      expect(await manager.sendKey('proj', 'Enter')).toBe(false);
      expect(await manager.sendKey('proj', 'Down')).toBe(false);
      expect(await manager.write('proj', 'x')).toBe(false);
      expect(await manager.interrupt('proj')).toBe(false);
    });

    it('returns false when osascript exits 0 without completing the script', async () => {
      mockOsascript({ stdout: '' });
      expect(await manager.writeLine('proj', 'hello')).toBe(false);
      expect(await manager.sendKey('proj', 'C-c')).toBe(false);
    });

    it('hasTerminal reports a closed tab (no matching terminal) as not alive', async () => {
      mockOsascript({ error: new Error('failed'), stdout: '', stderr: 'execution error: No Ghostty terminal found for cwd: /Users/test/proj (-2700)' });
      expect(await manager.hasTerminal('proj')).toBe(false);
      mockOsascript();
      expect(await manager.hasTerminal('proj')).toBe(true);
      expect(await manager.hasTerminal('unregistered')).toBe(false);
    });

    it('openNewTab escapes the cwd and returns false on failure', async () => {
      const scripts = mockOsascript();
      expect(await manager.openNewTab('/Users/x/a\\b', 'claude')).toBe(true);
      expect(scripts[0].script).toContain('quoted form of "/Users/x/a\\\\b"');
      mockOsascript({ error: new Error('failed'), stdout: '' });
      expect(await manager.openNewTab('/Users/x/a', 'claude')).toBe(false);
    });
  });
});
