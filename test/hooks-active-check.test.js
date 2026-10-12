import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir;
let ac;
let rs;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-active-check-'));
  process.env.CCGRAM_DATA_DIR = dataDir;
  delete process.env.ACTIVE_THRESHOLD_SECONDS;
  vi.resetModules();
  rs = await import('../src/utils/remote-state.js');
  ac = await import('../src/utils/active-check.js');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CCGRAM_DATA_DIR;
});

describe('shouldDeferToTerminal (per-session routing)', () => {
  it('routes to Telegram when the session has no local activity', () => {
    expect(ac.shouldDeferToTerminal('/proj/a')).toBe(false);
  });

  it('defers to the terminal after a locally typed prompt in THAT session only', () => {
    expect(rs.classifyPrompt('/proj/a', 'typed locally')).toBe('local');
    expect(ac.shouldDeferToTerminal('/proj/a')).toBe(true);
    expect(ac.shouldDeferToTerminal('/proj/b')).toBe(false);
  });

  it('a Telegram-driven session always routes to Telegram, even with recent local activity', () => {
    rs.classifyPrompt('/proj/a', 'earlier local prompt');
    rs.markRemoteInjected('/proj/a', 'from telegram');
    expect(rs.classifyPrompt('/proj/a', 'from telegram')).toBe('remote');
    expect(ac.shouldDeferToTerminal('/proj/a')).toBe(false);
  });

  it('remote state in one session does not affect another', () => {
    rs.markRemoteInjected('/proj/a', 'x');
    rs.classifyPrompt('/proj/b', 'local in b');
    expect(ac.shouldDeferToTerminal('/proj/b')).toBe(true);
  });

  it('ending the remote turn hands control back to the terminal', () => {
    rs.classifyPrompt('/proj/a', 'local');
    rs.markRemoteInjected('/proj/a', 'x');
    expect(ac.shouldDeferToTerminal('/proj/a')).toBe(false);
    expect(rs.classifyPrompt('/proj/a', 'x')).toBe('remote');
    rs.endRemoteTurn('/proj/a');
    expect(ac.shouldDeferToTerminal('/proj/a')).toBe(true);
  });

  it('respects an explicit threshold', () => {
    rs.classifyPrompt('/proj/a', 'local');
    expect(ac.shouldDeferToTerminal('/proj/a', 0)).toBe(false);
  });

  it('ignores the global typing-active file entirely', () => {
    const typing = path.join(dataDir, 'typing-active');
    fs.writeFileSync(typing, String(Date.now()));
    rs.classifyPrompt('/proj/a', 'local');
    expect(ac.shouldDeferToTerminal('/proj/a')).toBe(true);
  });
});

describe('project-root keying (hookProjectDir)', () => {
  let savedProjectDir;
  beforeEach(() => { savedProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  });

  it('prefers CLAUDE_PROJECT_DIR over the payload cwd', () => {
    process.env.CLAUDE_PROJECT_DIR = '/proj/a';
    expect(ac.hookProjectDir('/proj/a/src/deep')).toBe('/proj/a');
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(ac.hookProjectDir('/proj/a/src/deep')).toBe('/proj/a/src/deep');
  });

  it('a cd into a subdirectory keeps the session Telegram-driven', () => {
    process.env.CLAUDE_PROJECT_DIR = '/proj/a';
    // bot injects; UserPromptSubmit arrives while Claude is at the root
    rs.markRemoteInjected('/proj/a', 'go');
    expect(rs.classifyPrompt(ac.hookProjectDir('/proj/a'), 'go')).toBe('remote');
    // a later hook fires after Claude cd'd into src/ — still remote
    expect(ac.isRemoteDriven(ac.hookProjectDir('/proj/a/src'))).toBe(true);
    expect(ac.shouldDeferToTerminal(ac.hookProjectDir('/proj/a/src'))).toBe(false);
  });

  it('local activity recorded from a subdirectory applies to the whole session', () => {
    process.env.CLAUDE_PROJECT_DIR = '/proj/a';
    expect(rs.classifyPrompt(ac.hookProjectDir('/proj/a/src'), 'typed')).toBe('local');
    expect(ac.shouldDeferToTerminal(ac.hookProjectDir('/proj/a'))).toBe(true);
    expect(ac.shouldDeferToTerminal(ac.hookProjectDir('/proj/a/test'))).toBe(true);
  });
});
