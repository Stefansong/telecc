#!/usr/bin/env node

/**
 * Pre-Compact Notify — Called by Claude Code's PreCompact hook.
 *
 * BLOCKING mode: Notifies user before context compaction, allows them to
 * block it if they want to preserve context.
 *
 * Stdin JSON: { cwd, session_id, trigger, custom_instructions, ... }
 * Stdout: { decision: "block", reason } — to prevent compaction
 *         (or exit silently to allow compaction)
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId } from './prompt-bridge';
import { shouldDeferToTerminal, hookProjectDir } from './src/utils/active-check';
import {
  routeConsoleToStderr, readStdin, parsePayload, emitJson, logErr,
  escapeHtml, truncateText, fitHtml, sendHtmlWithFallback, stopTypingSignal,
  hookDeadline, openPrompt, closePrompt, installPromptCleanup, pollForResponse,
  telegramConfigured,
} from './src/utils/hook-utils';
import type { InlineKeyboardButton } from './src/types';

const TAG = 'pre-compact-notify';

/** Output format for blocking compaction.
 *
 * PreCompact uses TOP-LEVEL `decision` (not nested in hookSpecificOutput).
 * `hookSpecificOutput` only carries `hookEventName` for identification.
 */
interface PreCompactOutput {
  decision: 'block';
  reason: string;
  hookSpecificOutput: {
    hookEventName: 'PreCompact';
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  routeConsoleToStderr();
  installPromptCleanup(TAG);
  const deadline = hookDeadline('pre-compact-notify.js');

  const raw = await readStdin();
  // Telegram off / not configured — no output
  if (!telegramConfigured()) return;
  const payload = parsePayload(raw);
  if (!payload) return;

  // Key everything on the project root (stable when Claude cd's into a subdirectory)
  const dir = hookProjectDir(payload.cwd as string);

  // User is working in this session at the terminal and the turn didn't come from
  // Telegram — let compaction proceed automatically.
  if (shouldDeferToTerminal(dir, { sessionId: payload.session_id as string | undefined })) {
    return;
  }

  const workspace = extractWorkspaceName(dir) || 'unknown';
  const tokensCurrent = payload.tokens_current as number | undefined;
  const trigger = typeof payload.trigger === 'string' ? payload.trigger : null;
  const customInstructions = typeof payload.custom_instructions === 'string' ? payload.custom_instructions : '';

  const promptId = generatePromptId();

  const messageText = fitHtml(budget => {
    let html = `\u{1F4E6} <b>Context Compaction</b> — ${escapeHtml(truncateText(workspace, 100))}\n\n`;
    html += trigger === 'manual'
      ? 'A manual /compact was requested.'
      : 'Context is getting large and will be compacted.';
    if (customInstructions) {
      html += `\n\n<b>Instructions:</b> ${escapeHtml(truncateText(customInstructions, budget))}`;
    }
    if (typeof tokensCurrent === 'number') {
      html += `\n\n<i>Current tokens: ${tokensCurrent.toLocaleString()}</i>`;
    }
    return html;
  }, 1000);

  // Build inline keyboard with Proceed/Block buttons
  const keyboard: InlineKeyboardButton[][] = [
    [
      { text: '✅ Proceed', callback_data: `pre-compact:${promptId}:proceed` },
      { text: '\u{1F6D1} Block', callback_data: `pre-compact:${promptId}:block` },
    ],
  ];

  // Write pending file
  openPrompt(promptId, {
    type: 'pre-compact',
    workspace,
    tokensCurrent,
  });

  try {
    // Send Telegram message (HTML, plain-text retry on failure)
    try {
      const result = await sendHtmlWithFallback(messageText, { tag: TAG, replyMarkup: { inline_keyboard: keyboard }, deadlineMs: deadline });
      stopTypingSignal();
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, 'pre-compact');
      }
    } catch (err: unknown) {
      logErr(TAG, `Telegram send failed: ${(err as Error).message}`);
      return; // Let compaction proceed on send failure
    }

    // Poll for response until the hook's deadline
    const response = await pollForResponse(promptId, deadline);
    if (!response) logErr(TAG, 'Timed out — allowing compaction');

    if (response && response.action === 'block') {
      const output: PreCompactOutput = {
        decision: 'block',
        reason: 'User blocked compaction via Telegram to preserve context',
        hookSpecificOutput: {
          hookEventName: 'PreCompact',
        },
      };
      emitJson(output);
    }
    // If proceed or timeout, exit silently — compaction proceeds
  } finally {
    closePrompt(promptId);
  }
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logErr(TAG, `Fatal: ${err.message}`);
});
