import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rotateIfLarge } from '../src/utils/log-rotate.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecc-logrot-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('rotateIfLarge', () => {
  it('leaves small files alone', () => {
    const f = path.join(dir, 'a.log');
    fs.writeFileSync(f, 'x'.repeat(10));
    expect(rotateIfLarge(f, 100)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['a.log']);
  });

  it('copies to .1, shifts older copies, and truncates in place for an O_APPEND writer', () => {
    const f = path.join(dir, 'a.log');
    const fd = fs.openSync(f, 'a'); // like launchd's StandardErrorPath
    fs.writeSync(fd, 'first'.repeat(50));
    expect(rotateIfLarge(f, 100)).toBe(true);
    fs.writeSync(fd, 'second'.repeat(50));
    expect(rotateIfLarge(f, 100)).toBe(true);
    fs.writeSync(fd, 'new');
    fs.closeSync(fd);

    expect(fs.readFileSync(f, 'utf8')).toBe('new'); // no sparse hole before it
    expect(fs.readFileSync(`${f}.1`, 'utf8')).toBe('second'.repeat(50));
    expect(fs.readFileSync(`${f}.2`, 'utf8')).toBe('first'.repeat(50));
  });

  it('ignores missing files', () => {
    expect(rotateIfLarge(path.join(dir, 'nope.log'), 1)).toBe(false);
  });
});
