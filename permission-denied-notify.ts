#!/usr/bin/env node

/**
 * Permission Denied Notify — Called by Claude Code's PermissionDenied hook.
 *
 * Notifies user when auto mode blocks a tool. Optionally allows retry.
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, reason }
 * Stdout: { hookSpecificOutput: { retry: true } } — to retry the tool
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId } from './prompt-bridge';
import { shouldDeferToTerminal, hookProjectDir } from './src/utils/active-check';
import {
  routeConsoleToStderr, readStdin, parsePayload, emitJson, logErr,
  escapeHtml, truncateText, fitHtml, formatToolDescriptionHtml, sendHtmlWithFallback,
  stopTypingSignal, hookDeadline, openPrompt, closePrompt, installPromptCleanup, pollForResponse,
  telegramConfigured,
} from './src/utils/hook-utils';
import type { InlineKeyboardButton } from './src/types';

const TAG = 'permission-denied-notify';

/** Output format for retry. `hookEventName` is required — missing it causes
 * Claude Code to silently ignore the retry signal. */
interface PermissionDeniedOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionDenied';
    retry: boolean;
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  routeConsoleToStderr();
  installPromptCleanup(TAG);
  const deadline = hookDeadline('permission-denied-notify.js');

  const raw = await readStdin();
  // Telegram off / not configured — no output
  if (!telegramConfigured()) return;
  const payload = parsePayload(raw);
  if (!payload) return;

  // Key everything on the project root (stable when Claude cd's into a subdirectory)
  const dir = hookProjectDir(payload.cwd as string);

  // User is working in this session at the terminal and the turn didn't come from
  // Telegram — they can see the denial locally.
  if (shouldDeferToTerminal(dir)) {
    return;
  }

  const toolName = (payload.tool_name as string) || 'Unknown tool';
  const toolInput = (payload.tool_input || {}) as Record<string, unknown>;
  const reason = (payload.reason as string) || 'No reason provided';
  const workspace = extractWorkspaceName(dir) || 'unknown';

  const promptId = generatePromptId();

  const messageText = fitHtml(budget => {
    let html = `\u{1F6AB} <b>Permission Denied</b> — ${escapeHtml(truncateText(workspace, 100))}\n\n`;
    html += `<b>Tool:</b> <code>${escapeHtml(truncateText(toolName, 100))}</code>\n`;
    html += `<b>Reason:</b> ${escapeHtml(truncateText(reason, 1000))}`;
    const description = formatToolDescriptionHtml(toolName, toolInput, budget);
    if (description) html += `\n${description}`;
    return html;
  }, 2000);

  // Build inline keyboard with Retry/Dismiss buttons
  const keyboard: InlineKeyboardButton[][] = [
    [
      { text: '\u{1F504} Retry', callback_data: `perm-denied:${promptId}:retry` },
      { text: '❌ Dismiss', callback_data: `perm-denied:${promptId}:dismiss` },
    ],
  ];

  // Write pending file
  openPrompt(promptId, {
    type: 'permission-denied',
    workspace,
    toolName,
    reason,
  });

  try {
    // Send Telegram message (HTML, plain-text retry on failure)
    try {
      const result = await sendHtmlWithFallback(messageText, { tag: TAG, replyMarkup: { inline_keyboard: keyboard }, deadlineMs: deadline });
      stopTypingSignal();
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, 'permission-denied');
      }
    } catch (err: unknown) {
      logErr(TAG, `Telegram send failed: ${(err as Error).message}`);
      return;
    }

    // Poll for response until the hook's deadline
    const response = await pollForResponse(promptId, deadline);
    if (!response) logErr(TAG, 'Timed out waiting for response');

    if (response && response.action === 'retry') {
      const output: PermissionDeniedOutput = {
        hookSpecificOutput: {
          hookEventName: 'PermissionDenied',
          retry: true,
        },
      };
      emitJson(output);
    }
    // If dismiss or timeout, no output — tool stays blocked
  } finally {
    closePrompt(promptId);
  }
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logErr(TAG, `Fatal: ${err.message}`);
});
