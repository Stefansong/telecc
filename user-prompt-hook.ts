#!/usr/bin/env node

/**
 * UserPromptSubmit hook — called by Claude Code whenever a prompt is submitted.
 *
 * Reads { prompt, cwd } from stdin and classifies the prompt for THIS session (keyed on
 * hookProjectDir(cwd) — CLAUDE_PROJECT_DIR, the project root):
 *  - 'remote': the prompt the bot just injected from Telegram → the session stays
 *    Telegram-driven (results/prompts keep going to Telegram)
 *  - 'local': typed at the terminal → clears the session's remote flag and records local
 *    activity (per-cwd), so hooks leave prompts to the terminal UI
 *
 * For 'local' prompts it also still writes /tmp/claude_last_msg_time (legacy, global)
 * for backwards compatibility.
 *
 * Must be fast — registered with timeout: 2 in settings.json.
 * No stdout output. No Telegram calls.
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';
import { classifyPrompt, hookProjectDir } from './src/utils/remote-state';
import { readStdin, parsePayload, logErr } from './src/utils/hook-utils';

const LAST_MSG_FILE = '/tmp/claude_last_msg_time';

function writeLegacyTimestamp(): void {
  try {
    fs.writeFileSync(LAST_MSG_FILE, String(Math.floor(Date.now() / 1000)));
  } catch {
    // Non-fatal — active-check will just assume user is inactive
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin(1000));
  if (!payload) {
    // Unparseable input — keep the legacy behaviour, leave per-session state alone
    writeLegacyTimestamp();
    return;
  }

  // Key on the project root (stable when Claude cd's into a subdirectory)
  const dir = hookProjectDir(payload.cwd as string);
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';

  let kind: 'remote' | 'local' = 'local';
  try {
    kind = classifyPrompt(dir, prompt, payload.session_id as string | undefined);
  } catch (err: unknown) {
    logErr('user-prompt-hook', `classifyPrompt failed: ${(err as Error).message}`);
  }
  if (kind === 'local') writeLegacyTimestamp();
}

main().catch((err: Error) => {
  logErr('user-prompt-hook', `Fatal: ${err.message}`);
});
