import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Project root directory — walks up from __dirname to find package.json.
 * Works from any depth in dist/ after TypeScript compilation.
 */
export const PROJECT_ROOT: string = (() => {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

/**
 * Persistent install directory for telecc.
 * `telecc init` copies the package here so hook paths survive npx cleanup.
 */
export const CCGRAM_HOME: string = path.join(os.homedir(), '.telecc');

/**
 * Candidate ~/.claude/projects/<dir> names for a cwd. Claude Code replaces every
 * non-alphanumeric character (/, _, spaces, CJK, ...) with '-'; older builds kept
 * '.', so both spellings are tried. Never encode with just `/` → `-`.
 */
export function claudeProjectDirs(cwd: string): string[] {
  const home = process.env.HOME || os.homedir();
  const names = [cwd.replace(/[^a-zA-Z0-9]/g, '-'), cwd.replace(/[^a-zA-Z0-9.]/g, '-')];
  return [...new Set(names)].map(n => path.join(home, '.claude', 'projects', n));
}
