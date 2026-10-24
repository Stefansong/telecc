/**
 * Environment for processes the daemon starts (tmux servers, PTY Claude sessions).
 *
 * The daemon loads `~/.telecc/.env` into its own process.env. Children must not
 * inherit those values: a Claude Code Telegram plugin running inside a bot-started
 * tmux session picked up TELEGRAM_BOT_TOKEN, polled getUpdates with *our* token and
 * fought the daemon for every message ("Conflict: terminated by other getUpdates
 * request"). Hooks don't need the inherited values either — each one loads the .env
 * file itself.
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './paths';

/** Always dropped, even when the .env file can't be read. */
const BASELINE = /^(TELEGRAM_|LINE_|SMTP_|IMAP_|EMAIL_|CCGRAM_|TELECC_|PROMPTS_DIR$|SESSION_MAP_PATH$|HEALTH_PORT$)/;

let ownKeys: Set<string> | null = null;

function loadOwnKeys(): Set<string> {
  if (ownKeys) return ownKeys;
  ownKeys = new Set<string>();
  try {
    const parsed = require('dotenv').parse(fs.readFileSync(path.join(PROJECT_ROOT, '.env'))) as Record<string, string>;
    for (const key of Object.keys(parsed)) ownKeys.add(key);
  } catch {
    // no .env (tests, fresh install) — baseline still applies
  }
  return ownKeys;
}

/** Is `key` part of the daemon's own configuration (and so must not leak to children)? */
export function isOwnConfigKey(key: string): boolean {
  return BASELINE.test(key) || loadOwnKeys().has(key);
}

/** `base` (default process.env) without the daemon's own configuration keys. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isOwnConfigKey(key)) out[key] = value;
  }
  return out;
}
