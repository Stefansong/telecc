/**
 * Crash- and race-safe JSON state files.
 *
 * The bot daemon and many short-lived hook processes read-modify-write the same
 * files. A plain writeFileSync truncates first, so a concurrent reader can see an
 * empty/partial file; if it then treats that as "{}" and writes back, every other
 * entry is lost. Writing to a temp file and renaming is atomic on the same volume,
 * and readers retry briefly instead of silently starting from an empty object.
 */

import fs from 'fs';
import path from 'path';

/** Write JSON atomically (temp file in the same dir + rename). */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a JSON file. Missing file → `fallback`. A file that fails to parse is
 * retried a few times (it may be mid-write by a non-atomic writer); if it is still
 * corrupt it is moved aside to `<file>.corrupt-<ts>` and `fallback` is returned,
 * so the next atomic write starts clean instead of looping on bad data.
 */
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  for (let attempt = 0; attempt < 5; attempt++) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return fallback;
      }
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      sleepSync(20);
    }
  }
  try { fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
  return fallback;
}

const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 3 * 1000;

/**
 * Run `fn` while holding a cross-process lock on `filePath` (a `<file>.lock` dir;
 * mkdir is atomic). Use around read-modify-write so two processes can't both read
 * the old state and have the second write drop the first one's update. A lock left
 * by a crashed process is broken after LOCK_STALE_MS; if the lock can't be taken
 * within LOCK_WAIT_MS, `fn` runs anyway (better a rare lost update than a hung hook).
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockDir = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let locked = false;
  while (!locked) {
    try {
      fs.mkdirSync(lockDir);
      locked = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) break;
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (locked) { try { fs.rmdirSync(lockDir); } catch {} }
  }
}

/** Locked read-modify-write of a JSON file. `mutate` may modify in place or return a new value. */
export function updateJsonLocked<T>(filePath: string, fallback: T, mutate: (current: T) => T | void): T {
  return withFileLock(filePath, () => {
    const current = readJsonSafe<T>(filePath, fallback);
    const next = mutate(current);
    const result = next === undefined ? current : next;
    writeJsonAtomic(filePath, result);
    return result;
  });
}
