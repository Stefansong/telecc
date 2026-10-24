#!/usr/bin/env node

/**
 * Permission Hook — Called by Claude Code's PermissionRequest hook.
 *
 * Blocking approach:
 *   1. Sends a Telegram message with inline keyboard buttons
 *   2. Polls for a response file written by the bot's callback handler
 *   3. Outputs the permission decision via stdout
 *   4. Exits cleanly
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name, permission_suggestions? }
 * Stdout JSON: { hookSpecificOutput: { hookEventName, decision: { behavior, updatedPermissions?, message?, interrupt? } } }
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';
import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId } from './prompt-bridge';
import { shouldDeferToTerminal, hookProjectDir } from './src/utils/active-check';
import { capturePane, resolvePaneTarget } from './src/utils/tmux';
import {
  routeConsoleToStderr, readStdin, parsePayload, emitJson, logErr,
  escapeHtml, truncateText, fitHtml, markdownToHtml, formatToolDescriptionHtml,
  sendHtmlWithFallback, stopTypingSignal, hookDeadline, openPrompt, closePrompt,
  installPromptCleanup, pollForResponse, detectSessionName, telegramConfigured,
} from './src/utils/hook-utils';
import type { InlineKeyboardMarkup, PermissionHookOutput, PermissionUpdateEntry } from './src/types';

const TAG = 'permission-hook';

// Debug logging to file (since stdout is for Claude Code)
const LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'permission-hook-debug.log');
function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
  } catch {}
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  routeConsoleToStderr();
  installPromptCleanup(TAG);
  const deadline = hookDeadline('permission-hook.js');

  const raw = await readStdin();
  // Telegram off / not configured — no decision, Claude Code shows its own UI
  if (!telegramConfigured()) return;
  const payload = parsePayload(raw);
  if (!payload) return; // Can't parse — exit without decision

  const toolName = (payload.tool_name as string) || 'Unknown';

  // AskUserQuestion: exit silently so Claude Code shows the interactive
  // question/permission UI in the terminal. The question-notify.js PreToolUse
  // hook sends the Telegram notification.
  if (toolName === 'AskUserQuestion') {
    return;
  }

  // Key everything on the project root (stable when Claude cd's into a subdirectory)
  const dir = hookProjectDir(payload.cwd as string);

  // User is working in THIS session at the terminal and the turn didn't come from
  // Telegram → exit without a decision so Claude Code shows its own permission UI.
  // Otherwise (remote-driven, or user away > threshold) Telegram handles it so Claude
  // isn't left stuck waiting with no way to respond.
  if (shouldDeferToTerminal(dir, { sessionId: payload.session_id as string | undefined })) {
    debugLog(`[skip] User is active in this session at the terminal — deferring to Claude Code's own permission UI`);
    return;
  }

  const toolInput = (payload.tool_input || {}) as Record<string, unknown>;
  const workspace = extractWorkspaceName(dir) || 'unknown';
  const sessionTitle = (payload.session_title as string) || null; // v2.1.94+
  const promptId = generatePromptId();
  const tmuxSession = await detectSessionName(extractWorkspaceName(dir));
  const suggestions = validSuggestions(payload.permission_suggestions);

  const isPlan = toolName === 'ExitPlanMode';
  const titleSuffix = sessionTitle ? ` (${escapeHtml(truncateText(sessionTitle, 100))})` : '';
  const header = (icon: string, label: string): string =>
    `${icon} <b>${label}</b> — ${escapeHtml(truncateText(workspace, 100))}${titleSuffix}`;

  // Build Telegram message and keyboard
  let messageText: string;
  let keyboard: InlineKeyboardMarkup;

  if (isPlan) {
    // Plan approval — Claude Code injects the plan into tool_input.plan; only fall back
    // to capturing the pane when it's missing (older Claude Code).
    let planContent = typeof toolInput.plan === 'string' ? toolInput.plan.trim() : '';
    if (!planContent && tmuxSession && process.env.TMUX) {
      try {
        const target = await resolvePaneTarget(tmuxSession, process.env.TMUX_PANE);
        planContent = cleanPlanOutput(await capturePane(target, 50));
      } catch {}
    }

    messageText = fitHtml(budget => {
      let html = header('\u{1F4CB}', 'Plan Approval');
      if (planContent) html += `\n\n${markdownToHtml(truncateText(planContent, budget))}`;
      return html;
    }, 3500);

    keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `perm:${promptId}:allow` },
          { text: '❌ Reject', callback_data: `perm:${promptId}:deny` },
        ],
      ],
    };
  } else {
    // Tool permission request
    messageText = fitHtml(budget => {
      let html = `${header('\u{1F510}', 'Permission')}\n\n<b>Tool:</b> <code>${escapeHtml(truncateText(toolName, 100))}</code>`;
      const description = formatToolDescriptionHtml(toolName, toolInput, budget);
      if (description) html += `\n${description}`;
      return html;
    }, 3000);

    keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Allow', callback_data: `perm:${promptId}:allow` },
          { text: '❌ Deny', callback_data: `perm:${promptId}:deny` },
          { text: '\u{1F513} Always', callback_data: `perm:${promptId}:always` },
        ],
        [
          { text: '⏸ Defer', callback_data: `perm:${promptId}:defer` },
        ],
      ],
    };
  }

  // Write pending file so bot callback handler can write the response
  openPrompt(promptId, {
    type: isPlan ? 'plan' : 'permission',
    workspace,
    toolName,
    toolInput,
    tmuxSession,
  });

  try {
    // Send Telegram message with inline keyboard (HTML, plain-text retry on failure)
    debugLog(`[${promptId}] Sending Telegram message for ${toolName}...`);
    try {
      const result = await sendHtmlWithFallback(messageText, { tag: TAG, replyMarkup: keyboard, deadlineMs: deadline });
      debugLog(`[${promptId}] Telegram message sent`);
      stopTypingSignal();
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, 'permission');
      }
    } catch (err: unknown) {
      debugLog(`[${promptId}] Telegram send failed: ${(err as Error).message}`);
      logErr(TAG, `Telegram send failed: ${(err as Error).message}`);
      return; // Can't notify — exit without decision (Claude Code shows its own UI)
    }

    // Poll for response until the hook's overall deadline
    debugLog(`[${promptId}] Starting to poll for response...`);
    const response = await pollForResponse(promptId, deadline);

    if (!response) {
      debugLog(`[${promptId}] No response received before the hook deadline`);
      logErr(TAG, 'Timed out waiting for response');
      return;
    }

    const action = (response.action as string) || 'allow';
    debugLog(`[${promptId}] Got response: action=${action}`);
    const output = buildDecision(action, isPlan, suggestions);
    const outputStr = JSON.stringify(output);
    debugLog(`[${promptId}] Writing to stdout: ${outputStr}`);
    emitJson(output);
  } finally {
    closePrompt(promptId);
    debugLog(`[${promptId}] Cleaned up`);
  }
}

// ── Decision ────────────────────────────────────────────────────

/** Keep only well-formed permission update entries from the hook input. */
function validSuggestions(raw: unknown): PermissionUpdateEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is PermissionUpdateEntry =>
    !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).type === 'string'
      && typeof (e as Record<string, unknown>).destination === 'string');
}

function buildDecision(action: string, isPlan: boolean, suggestions: PermissionUpdateEntry[]): PermissionHookOutput {
  const out = (decision: PermissionHookOutput['hookSpecificOutput']['decision'], systemMessage: string): PermissionHookOutput => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
    systemMessage,
  });

  if (action === 'defer') {
    // Stop Claude (interrupt) rather than letting it carry on after a plain deny.
    return out({
      behavior: 'deny',
      message: 'The user paused this session remotely from Telegram (Defer). Do not retry or work around this; stop and wait for the user\'s next instruction.',
      interrupt: true,
    }, 'Paused via Telegram (Defer) — Claude was stopped. Send a new message to continue.');
  }

  if (action === 'deny') {
    return out({
      behavior: 'deny',
      message: isPlan
        ? 'The user rejected this plan via Telegram.'
        : 'The user denied this tool call via Telegram.',
    }, isPlan ? 'Plan rejected via Telegram' : 'Decision received via Telegram: user denied');
  }

  if (action === 'always' && !isPlan) {
    if (suggestions.length > 0) {
      // Echo Claude Code's own suggested permission updates so the rule is persisted
      // exactly like the terminal's "Yes, and don't ask again" option.
      return out({ behavior: 'allow', updatedPermissions: suggestions },
        'Decision received via Telegram: always allow (permission rule saved)');
    }
    return out({ behavior: 'allow' },
      'Decision received via Telegram: allowed once (Claude Code offered no permission rule to save for this call)');
  }

  return out({ behavior: 'allow' }, isPlan ? 'Plan approved via Telegram' : 'Decision received via Telegram: user allowed');
}

// ── Helpers ──────────────────────────────────────────────────────

function cleanPlanOutput(raw: string): string {
  let lines = raw.split('\n');
  lines = lines.map(l => l
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
  );
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  lines = lines.filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return false;
    if (/^(Clauding|Working|Waiting|Processing)/i.test(t)) return false;
    if (/^.+\|.+\|.+\|.+\$/.test(t)) return false;
    return true;
  });
  return lines.join('\n').trim();
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logErr(TAG, `Fatal: ${err.message}`);
});
