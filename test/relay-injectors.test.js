import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every tmux/osascript/open call goes through execFile — mock it so nothing real runs.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(() => { throw new Error('spawn must not be called in tests'); }),
    exec: vi.fn(() => { throw new Error('exec (shell) must not be called'); }),
  };
});

import { execFile } from 'child_process';
import TmuxInjector from '../src/relay/tmux-injector.ts';
import SmartInjector from '../src/relay/smart-injector.ts';

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
let tmpDir;
let calls;

/**
 * Fake execFile. `handler(file, args)` returns { stdout } or throws to simulate failure.
 */
function fakeExecFile(handler) {
  calls = [];
  execFile.mockImplementation((file, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; }
    calls.push({ file, args });
    let result;
    try {
      result = handler(file, args) || {};
    } catch (err) {
      queueMicrotask(() => cb(err, '', err.message));
      return {};
    }
    queueMicrotask(() => cb(null, result.stdout || '', ''));
    return {};
  });
}

/** Build an injector without its constructor (which creates dirs inside the repo). */
function makeTmuxInjector(sessionName, paneId = null) {
  const inj = Object.create(TmuxInjector.prototype);
  inj.log = quiet;
  inj.sessionName = sessionName;
  inj.paneId = paneId;
  inj.logFile = path.join(tmpDir, 'tmux-injection.log');
  return inj;
}

function makeSmartInjector() {
  const si = Object.create(SmartInjector.prototype);
  si.log = quiet;
  si.tempDir = tmpDir;
  si.copyToClipboard = vi.fn(async () => {}); // never touch the real clipboard
  return si;
}

async function runWithTimers(promise) {
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-injectors-test-'));
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TmuxInjector', () => {
  it('fails (and creates nothing) when the target session is gone', async () => {
    fakeExecFile((file, args) => {
      if (args[0] === 'has-session') throw new Error("can't find session");
      return { stdout: 'tmux 3.4' };
    });
    const inj = makeTmuxInjector('claude-proj');
    const result = await runWithTimers(inj.injectCommandFull('TOKEN', 'hello'));
    expect(result.success).toBe(false);
    expect(result.error).toBe('session_not_found');
    expect(calls.some(c => c.args[0] === 'new-session')).toBe(false);
    expect(calls.some(c => c.args[0] === 'send-keys')).toBe(false);
    // exact target, never prefix
    expect(calls.find(c => c.args[0] === 'has-session').args).toEqual(['has-session', '-t', '=claude-proj']);
  });

  it('sends the command as literal argv text (no shell, no key-name parsing)', async () => {
    fakeExecFile((file, args) => {
      if (args[0] === 'capture-pane') return { stdout: '> \n' };
      return {};
    });
    const evil = `'; rm -rf ~ #"$(id)" Enter`;
    const inj = makeTmuxInjector('claude-proj');
    const result = await runWithTimers(inj.injectCommand(evil));
    expect(result.success).toBe(true);

    const sendKeys = calls.filter(c => c.file === 'tmux' && c.args[0] === 'send-keys').map(c => c.args);
    expect(sendKeys).toEqual([
      ['send-keys', '-t', '=claude-proj:', 'C-u'],
      ['send-keys', '-t', '=claude-proj:', '-l', '--', evil],
      ['send-keys', '-t', '=claude-proj:', 'C-m'],
    ]);
    expect(calls.every(c => c.file === 'tmux')).toBe(true);
  });

  it('targets the recorded pane when it still belongs to the session', async () => {
    fakeExecFile((file, args) => {
      if (args[0] === 'display-message') return { stdout: 'claude-proj\n' };
      return {};
    });
    const inj = makeTmuxInjector('claude-proj', '%7');
    await runWithTimers(inj.injectCommand('hi'));
    const literal = calls.find(c => c.args.includes('-l'));
    expect(literal.args).toEqual(['send-keys', '-t', '%7', '-l', '--', 'hi']);
  });

  it('never answers confirmation prompts (no "don\'t ask again", no y/Enter)', async () => {
    const screen = [
      'Bash command: rm -rf build',
      'Do you want to proceed?',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again for this command",
      '  3. No, and tell Claude what to do differently (esc)',
      'Continue? (y/n)',
      'Press Enter to continue',
    ].join('\n');
    fakeExecFile((file, args) => (args[0] === 'capture-pane' ? { stdout: screen } : {}));
    const inj = makeTmuxInjector('claude-proj');
    const pending = await runWithTimers(inj.handleConfirmations());
    expect(pending).toBe(true);
    expect(calls.some(c => c.args[0] === 'send-keys')).toBe(false);
  });

  it('does not flag prompts that only appear in old scrollback', async () => {
    const screen = ['Continue? (y/n)', ...Array.from({ length: 20 }, (_, i) => `output line ${i}`), '> '].join('\n');
    fakeExecFile((file, args) => (args[0] === 'capture-pane' ? { stdout: screen } : {}));
    const inj = makeTmuxInjector('claude-proj');
    expect(await runWithTimers(inj.handleConfirmations())).toBe(false);
  });

  it('creates sessions without --dangerously-skip-permissions and via argv', async () => {
    fakeExecFile(() => ({}));
    const inj = makeTmuxInjector('claude-proj');
    await runWithTimers(inj.createClaudeSession('/tmp/some dir; rm -rf ~'));
    const create = calls.find(c => c.args[0] === 'new-session');
    expect(create.args).toEqual(['new-session', '-d', '-s', 'claude-proj', '-c', '/tmp/some dir; rm -rf ~', 'clauderun']);
    expect(calls.flatMap(c => c.args).join(' ')).not.toContain('dangerously');
    const src = fs.readFileSync(path.join(__dirname, '../src/relay/tmux-injector.ts'), 'utf8');
    expect(src).not.toContain('--dangerously-skip-permissions');
  });

  it('escapes the success notification for AppleScript and passes it as argv', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      fakeExecFile(() => ({}));
      const inj = makeTmuxInjector('claude-proj');
      await inj.sendSuccessNotification(`a"b\\c' & (do shell script "id")`);
      await vi.runAllTimersAsync();
      const osa = calls.find(c => c.file === 'osascript');
      expect(osa.args[0]).toBe('-e');
      expect(osa.args[1]).toContain('subtitle "a\\"b\\\\c\' & (do shell script \\"id\\"..."');
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('SmartInjector', () => {
  const original = process.platform;
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }));
  afterEach(() => Object.defineProperty(process, 'platform', { value: original, configurable: true }));

  it('refuses to paste when the frontmost app is not a terminal', async () => {
    fakeExecFile(() => ({ stdout: 'not_terminal:Safari\n' }));
    const si = makeSmartInjector();
    const result = await si.tryAppleScriptInjection('T1', 'hello');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Safari');
    // The frontmost check and the paste happen in one script, guarded by the allow-list
    const script = calls[0].args[1];
    expect(script).toContain('set activeApp to name of first application process whose frontmost is true');
    expect(script).toContain('if activeApp is not in {"Terminal", "iTerm2"');
    expect(script).not.toContain('set frontmost of');
  });

  it('reports success only when the paste script ran in a terminal', async () => {
    fakeExecFile(() => ({ stdout: 'success\n' }));
    const si = makeSmartInjector();
    expect((await si.tryAppleScriptInjection('T1', 'hello')).success).toBe(true);
  });

  it('file-drop never reports success (nothing was injected)', async () => {
    fakeExecFile(() => ({}));
    const si = makeSmartInjector();
    const result = await si.tryFileDropInjection('T1', 'hello');
    expect(result.success).toBe(false);
    expect(result.manual).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'taskping-command-T1.txt'), 'utf8')).toBe('hello');
  });

  it('injectCommand returns false when only a manual hand-off happened', async () => {
    fakeExecFile((file, args) => (file === 'osascript' && args[1].includes('keystroke') ? { stdout: 'not_terminal:Notion\n' } : {}));
    const si = makeSmartInjector();
    expect(await si.injectCommand('T1', 'hello')).toBe(false);
    // stopped after the first hand-off: no persistent-notification / emergency spam
    expect(calls.filter(c => c.file === 'osascript')).toHaveLength(2);
  });

  it('emergency clipboard no longer writes an executable .command file', async () => {
    fakeExecFile(() => ({}));
    const si = makeSmartInjector();
    const result = await si.tryUrgentClipboard('T1', '"; rm -rf ~; echo "');
    expect(result.success).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '../src/relay/smart-injector.ts'), 'utf8');
    expect(src).not.toMatch(/\.command`/);
    expect(src).not.toContain('chmodSync');
  });

  it('notifications escape quotes and backslashes and never use a shell', async () => {
    fakeExecFile(() => ({}));
    const si = makeSmartInjector();
    await si.notify('x" & (do shell script "id") & "\\', 'T', 's', 'Glass');
    const osa = calls.find(c => c.file === 'osascript');
    expect(osa.args[1]).toContain('display notification "x\\" & (do shell script \\"id\\") & \\"\\\\"');
  });
});
