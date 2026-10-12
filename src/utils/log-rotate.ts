/**
 * Size-based rotation for the daemon's log files.
 *
 * launchd (StandardOutPath/StandardErrorPath) and systemd (`append:`) open the logs
 * with O_APPEND and keep the descriptor for the process lifetime, so the file can't
 * be renamed away. Instead: copy to `<file>.1` (older copies shift to `.2`, ...)
 * and truncate in place — with O_APPEND the next write lands at the new end.
 */

import fs from 'fs';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 2;

/** Rotate `file` if it is larger than `maxBytes`. Returns true when rotated. */
export function rotateIfLarge(file: string, maxBytes: number = DEFAULT_MAX_BYTES, keep: number = DEFAULT_KEEP): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes || keep < 1) return false;

  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
  }
  fs.copyFileSync(file, `${file}.1`);
  fs.truncateSync(file, 0);
  return true;
}

/** Rotate each file now and then every `intervalMs`. Returns the timer (unref'd). */
export function startLogRotation(
  files: string[],
  intervalMs: number = 60 * 60 * 1000,
  maxBytes: number = DEFAULT_MAX_BYTES,
): NodeJS.Timeout {
  const run = (): void => {
    for (const f of files) {
      try { rotateIfLarge(f, maxBytes); } catch { /* never let log housekeeping crash the bot */ }
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
