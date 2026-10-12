import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecc-shared-'));
  process.env.CCGRAM_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CCGRAM_DATA_DIR;
  vi.useRealTimers();
});

describe('atomic-json', () => {
  it('round-trips and leaves no temp files', async () => {
    const { writeJsonAtomic, readJsonSafe } = await import('../src/utils/atomic-json.js');
    const f = path.join(dataDir, 'a.json');
    writeJsonAtomic(f, { x: 1 });
    expect(readJsonSafe(f, {})).toEqual({ x: 1 });
    expect(fs.readdirSync(dataDir)).toEqual(['a.json']);
  });

  it('returns fallback for a missing file', async () => {
    const { readJsonSafe } = await import('../src/utils/atomic-json.js');
    expect(readJsonSafe(path.join(dataDir, 'missing.json'), { d: true })).toEqual({ d: true });
  });

  it('moves a corrupt file aside instead of reusing it', async () => {
    const { readJsonSafe } = await import('../src/utils/atomic-json.js');
    const f = path.join(dataDir, 'bad.json');
    fs.writeFileSync(f, '{"half":');
    expect(readJsonSafe(f, {})).toEqual({});
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.readdirSync(dataDir).some(n => n.startsWith('bad.json.corrupt-'))).toBe(true);
  });
});

describe('file lock', () => {
  it('updateJsonLocked merges into current state and releases the lock', async () => {
    const { updateJsonLocked, readJsonSafe } = await import('../src/utils/atomic-json.js');
    const f = path.join(dataDir, 'm.json');
    updateJsonLocked(f, {}, m => { m.a = 1; });
    updateJsonLocked(f, {}, m => { m.b = 2; });
    expect(readJsonSafe(f, {})).toEqual({ a: 1, b: 2 });
    expect(fs.existsSync(`${f}.lock`)).toBe(false);
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const { withFileLock } = await import('../src/utils/atomic-json.js');
    const f = path.join(dataDir, 's.json');
    fs.mkdirSync(`${f}.lock`);
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(`${f}.lock`, old, old);
    const start = Date.now();
    expect(withFileLock(f, () => 'ran')).toBe('ran');
    expect(Date.now() - start).toBeLessThan(1000);
    expect(fs.existsSync(`${f}.lock`)).toBe(false);
  });
});

describe('remote-state', () => {
  it('is per-cwd', async () => {
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', 'hello');
    expect(rs.isRemoteDriven('/proj/a')).toBe(true);
    expect(rs.isRemoteDriven('/proj/b')).toBe(false);
  });

  it('keeps the flag for the injected prompt and clears it on a local prompt', async () => {
    vi.useFakeTimers();
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', 'fix  the\nbug');
    expect(rs.classifyPrompt('/proj/a', 'fix the bug')).toBe('remote');
    expect(rs.isRemoteDriven('/proj/a')).toBe(true);
    expect(rs.isLocallyActive('/proj/a')).toBe(false);

    vi.advanceTimersByTime(60 * 1000);
    expect(rs.classifyPrompt('/proj/a', 'something typed locally')).toBe('local');
    expect(rs.isRemoteDriven('/proj/a')).toBe(false);
    expect(rs.isLocallyActive('/proj/a')).toBe(true);
    expect(rs.isLocallyActive('/proj/b')).toBe(false);
  });

  it('ignores harness-generated prompts (task notifications)', async () => {
    vi.useFakeTimers();
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', 'do it');
    vi.advanceTimersByTime(60 * 1000);
    expect(rs.classifyPrompt('/proj/a', '<task-notification>\n<task-id>x</task-id>')).toBe('remote');
    expect(rs.isRemoteDriven('/proj/a')).toBe(true);
    expect(rs.isLocallyActive('/proj/a')).toBe(false);
  });

  it('endRemoteTurn ends the active turn', async () => {
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', 'x');
    expect(rs.classifyPrompt('/proj/a', 'x')).toBe('remote');
    rs.endRemoteTurn('/proj/a');
    expect(rs.isRemoteDriven('/proj/a')).toBe(false);
  });

  it('a follow-up queued during a remote turn survives that turn\'s Stop', async () => {
    vi.useFakeTimers();
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', 'first');
    expect(rs.classifyPrompt('/proj/a', 'first')).toBe('remote');
    vi.advanceTimersByTime(30 * 1000);
    rs.markRemoteInjected('/proj/a', 'second');   // sent while Claude is busy
    vi.advanceTimersByTime(60 * 1000);
    rs.endRemoteTurn('/proj/a');                  // Stop of turn 1
    expect(rs.isRemoteDriven('/proj/a')).toBe(true);
    expect(rs.classifyPrompt('/proj/a', 'second')).toBe('remote');
    rs.endRemoteTurn('/proj/a');
    expect(rs.isRemoteDriven('/proj/a')).toBe(false);
  });

  it('an injection Claude never submitted stops routing a local session to Telegram', async () => {
    vi.useFakeTimers();
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', '/stats');      // built-in: no UserPromptSubmit
    vi.advanceTimersByTime(20 * 1000);
    expect(rs.classifyPrompt('/proj/a', 'typed locally')).toBe('local');
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(rs.isRemoteDriven('/proj/a')).toBe(false);
  });

  it('unmarkRemoteInjected forgets a failed injection', async () => {
    const rs = await import('../src/utils/remote-state.js');
    rs.markRemoteInjected('/proj/a', 'x');
    rs.unmarkRemoteInjected('/proj/a', 'x');
    expect(rs.isRemoteDriven('/proj/a')).toBe(false);
  });

  it('hookProjectDir prefers CLAUDE_PROJECT_DIR over the shell cwd', async () => {
    const rs = await import('../src/utils/remote-state.js');
    process.env.CLAUDE_PROJECT_DIR = '/proj/root';
    try {
      expect(rs.hookProjectDir('/proj/root/frontend')).toBe('/proj/root');
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(rs.hookProjectDir('/proj/root/frontend')).toBe('/proj/root/frontend');
  });
});

describe('tmux targets', () => {
  it('uses exact session targets and validated pane ids', async () => {
    const t = await import('../src/utils/tmux.js');
    expect(t.sessionTarget('api')).toBe('=api');
    expect(t.paneTarget('api')).toBe('=api:');
    expect(t.paneTarget('api', '%12')).toBe('%12');
    expect(t.paneTarget('api', 'bogus; rm')).toBe('=api:');
    expect(t.isShellCommand('zsh')).toBe(true);
    expect(t.isShellCommand('claude')).toBe(false);
    expect(t.isShellCommand(null)).toBe(false);
  });
});

describe('claudeProjectDirs', () => {
  it('encodes every non-alphanumeric char', async () => {
    const { claudeProjectDirs } = await import('../src/utils/paths.js');
    const dirs = claudeProjectDirs('/Users/s/Desktop/中文 项目_x').map(d => path.basename(d));
    expect(dirs).toContain('-Users-s-Desktop-------x');
  });
});
