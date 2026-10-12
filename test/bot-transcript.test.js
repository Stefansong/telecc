import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let home;
let origHome;
let reader;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-transcript-test-'));
  origHome = process.env.HOME;
  process.env.HOME = home;
  vi.resetModules();
  reader = await import('../src/utils/transcript-reader.js');
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeTranscript(dirName, sessionId, lines) {
  const dir = path.join(home, '.claude', 'projects', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('transcript lookup for non-ASCII / underscore paths', () => {
  const cwd = '/Users/me/我的_project.v2';

  it('finds transcripts under Claude Code\'s encoding (every non-alnum → "-")', () => {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    writeTranscript(encoded, 'sess-1', [
      { type: 'assistant', cwd, message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10 } } },
    ]);
    const status = reader.readTranscriptStatus(cwd, undefined);
    expect(status).not.toBeNull();
    expect(status.sessionId).toBe('sess-1');
    expect(status.lastAssistantMessage).toBe('hi');
    expect(reader.readTranscriptStatus(cwd, 'sess-1')?.model).toBe('claude-opus-4-6');
  });

  it('also finds the legacy spelling that kept "."', () => {
    const legacy = cwd.replace(/[^a-zA-Z0-9.]/g, '-');
    writeTranscript(legacy, 'sess-old', [
      { type: 'assistant', message: { content: 'old' } },
    ]);
    expect(reader.findLatestTranscript(cwd)?.sessionId).toBe('sess-old');
    expect(reader.getTranscriptPath(cwd, 'sess-old')).toContain(legacy);
  });

  it('returns null when nothing exists', () => {
    expect(reader.findLatestTranscript(cwd)).toBeNull();
    expect(reader.readTranscriptStatus(cwd, undefined)).toBeNull();
  });
});
