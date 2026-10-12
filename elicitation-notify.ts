#!/usr/bin/env node

/**
 * Elicitation Notify — Called by Claude Code's Elicitation hook.
 *
 * BLOCKING mode: Forwards MCP server input requests to Telegram, polls for
 * user responses (one per form field), then outputs the answer via stdout.
 *
 * Each field's pending prompt is written with `awaitingText: true` (its Telegram message
 * id is added right after sending); the bot writes `{ textAnswer }` when the user
 * replies. The next field's prompt is written before the previous one is removed, so a
 * reply never finds "no open question" in between.
 *
 * No output (Claude Code shows its own dialog) when Telegram is disabled/unconfigured,
 * the send fails, the session is driven locally, or the elicitation is URL-mode. Answers are coerced to the
 * JSON type the schema asks for (number/integer/boolean/enum/array); an invalid answer
 * is re-asked once, then the elicitation is declined.
 *
 * Stdin JSON: { mcp_server_name, message, mode?, url?, requested_schema, cwd, session_id, ... }
 *   requested_schema: JSON Schema object with `properties` describing form fields
 *
 * Stdout: {
 *   hookSpecificOutput: {
 *     hookEventName: "Elicitation",
 *     action: "accept" | "decline" | "cancel",
 *     content: { <fieldName>: <value> }   // required when action === "accept"
 *   }
 * }
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId, updatePending } from './prompt-bridge';
import { shouldDeferToTerminal, hookProjectDir } from './src/utils/active-check';
import {
  routeConsoleToStderr, readStdin, parsePayload, emitJson, logErr,
  escapeHtml, truncateText, fitHtml, sendHtmlWithFallback, stopTypingSignal,
  hookDeadline, openPrompt, closePrompt, closeAllPrompts, installPromptCleanup, pollForResponse,
  coerceElicitationAnswer, describeElicitationField, telegramConfigured,
} from './src/utils/hook-utils';
import type { ElicitationProperty } from './src/utils/hook-utils';

const TAG = 'elicitation-notify';

/** Output format for elicitation response. */
interface ElicitationOutput {
  hookSpecificOutput: {
    hookEventName: 'Elicitation';
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  };
}

type FieldOutcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'skip' }
  | { kind: 'invalid'; error: string }
  | { kind: 'timeout' }
  | { kind: 'send-failed' };

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  routeConsoleToStderr();
  installPromptCleanup(TAG);
  // ONE deadline shared by every field (and re-ask) of this elicitation
  const deadline = hookDeadline('elicitation-notify.js');

  const raw = await readStdin();
  // Telegram off / not configured — no output, Claude Code shows its own dialog
  if (!telegramConfigured()) return;
  const payload = parsePayload(raw);
  if (!payload) return;

  // Key everything on the project root (stable when Claude cd's into a subdirectory)
  const dir = hookProjectDir(payload.cwd as string);

  // User is working in this session at the terminal and the turn didn't come from
  // Telegram — let Claude Code show its own dialog.
  if (shouldDeferToTerminal(dir)) {
    return;
  }

  // URL-mode elicitation (browser auth) can't be answered with text — leave it to
  // Claude Code's own dialog instead of declining it.
  if (payload.mode === 'url') {
    logErr(TAG, 'URL-mode elicitation — leaving it to Claude Code\'s dialog');
    return;
  }

  // Payload uses `mcp_server_name` (newer) — fall back to `mcp_server` for safety
  const mcpServer = (payload.mcp_server_name as string) || (payload.mcp_server as string) || 'Unknown MCP';
  const serverMessage = typeof payload.message === 'string' ? payload.message : '';
  const schema = (payload.requested_schema as Record<string, unknown>) || {};
  const properties = (schema.properties as Record<string, ElicitationProperty>) || {};
  const requiredFields = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fieldNames = Object.keys(properties);
  const workspace = extractWorkspaceName(dir) || 'unknown';

  // If the schema has no fields, decline — we can't build a meaningful response.
  if (fieldNames.length === 0) {
    emit('decline');
    return;
  }

  // Prompt the user one field at a time. A field that gets no answer before the
  // deadline cancels the whole elicitation.
  const content: Record<string, unknown> = {};

  try {
    for (let i = 0; i < fieldNames.length; i++) {
      const fieldName = fieldNames[i];
      const prop = properties[fieldName] || {};
      const required = requiredFields.has(fieldName);

      let outcome: FieldOutcome = { kind: 'timeout' };
      // First ask + at most one re-ask on invalid input
      for (let attempt = 0; attempt < 2; attempt++) {
        const retryError = attempt > 0 && outcome.kind === 'invalid' ? outcome.error : null;
        const messageText = buildFieldMessage({
          workspace, mcpServer, serverMessage, fieldName, prop, required,
          index: i, total: fieldNames.length, retryError,
        });
        outcome = await askField(messageText, { workspace, mcpServer, fieldName, prop, required, deadline });
        if (outcome.kind !== 'invalid') break;
      }

      if (outcome.kind === 'value') {
        content[fieldName] = outcome.value;
      } else if (outcome.kind === 'skip') {
        // Optional field left empty
      } else if (outcome.kind === 'invalid') {
        logErr(TAG, `Invalid answer for "${fieldName}" twice — declining`);
        await notify(`⚠️ <b>MCP input declined</b> — ${escapeHtml(truncateText(workspace, 100))}\n\n`
          + `Invalid value for <code>${escapeHtml(truncateText(fieldName, 100))}</code>: ${escapeHtml(truncateText(outcome.error, 500))}`, deadline);
        emit('decline');
        return;
      } else if (outcome.kind === 'send-failed') {
        // Telegram unreachable — no output, Claude Code shows its own dialog
        return;
      } else {
        // No answer before the deadline — cancel the whole elicitation
        emit('cancel');
        return;
      }
    }
  } finally {
    closeAllPrompts();
  }

  const output: ElicitationOutput = {
    hookSpecificOutput: {
      hookEventName: 'Elicitation',
      action: 'accept',
      content,
    },
  };
  emitJson(output);
}

function buildFieldMessage(o: {
  workspace: string; mcpServer: string; serverMessage: string; fieldName: string;
  prop: ElicitationProperty; required: boolean; index: number; total: number; retryError: string | null;
}): string {
  return fitHtml(budget => {
    let html = `\u{1F50C} <b>MCP Input Required</b> — ${escapeHtml(truncateText(o.workspace, 100))}\n\n`;
    html += `<b>Server:</b> <code>${escapeHtml(truncateText(o.mcpServer, 100))}</code>\n`;
    if (o.serverMessage) {
      html += `${escapeHtml(truncateText(o.serverMessage, budget))}\n`;
    }
    const label = o.prop.title && o.prop.title !== o.fieldName ? `${o.prop.title} (${o.fieldName})` : o.fieldName;
    html += o.total > 1
      ? `\n<b>Field ${o.index + 1} of ${o.total}:</b> <code>${escapeHtml(truncateText(label, 200))}</code>\n`
      : `\n<b>Field:</b> <code>${escapeHtml(truncateText(label, 200))}</code>\n`;
    if (o.prop.description) {
      html += `${escapeHtml(truncateText(o.prop.description, Math.max(100, Math.floor(budget / 2))))}\n`;
    }
    const hints = describeElicitationField(o.prop, o.required);
    if (hints.length > 0) {
      html += `\n<i>${escapeHtml(truncateText(hints.join('\n'), Math.max(200, budget)))}</i>\n`;
    }
    if (o.retryError) {
      html += `\n⚠️ <b>Invalid answer:</b> ${escapeHtml(truncateText(o.retryError, 500))} Please try again.\n`;
    }
    html += '\n<i>Reply to this message with your answer (or just send it as a message if this is the only open question).</i>';
    return html;
  }, 2000);
}

/** The open field prompt — replaced (not first removed) by the next field's prompt. */
let currentPromptId: string | null = null;

/** Send one field prompt, wait for the reply (shared deadline), and coerce it. */
async function askField(
  messageText: string,
  o: { workspace: string; mcpServer: string; fieldName: string; prop: ElicitationProperty; required: boolean; deadline: number },
): Promise<FieldOutcome> {
  // awaitingText from the start: a reply that arrives before messageId is recorded
  // must still be routable to this prompt. Write it BEFORE removing the previous
  // field's prompt so there is no window with no open question.
  const promptId = generatePromptId();
  openPrompt(promptId, {
    type: 'elicitation',
    workspace: o.workspace,
    mcpServer: o.mcpServer,
    fieldName: o.fieldName,
    awaitingText: true,
  });
  if (currentPromptId) closePrompt(currentPromptId);
  currentPromptId = promptId;

  try {
    const result = await sendHtmlWithFallback(messageText, {
      tag: TAG,
      replyMarkup: { force_reply: true, input_field_placeholder: truncateText(o.prop.title || o.fieldName, 64) },
      deadlineMs: o.deadline,
    });
    const messageId = result?.message_id;
    // Record the message id first (reply-to routing) — trackNotificationMessage can
    // wait on a file lock
    if (messageId) updatePending(promptId, { messageId });
    stopTypingSignal();
    if (messageId) trackNotificationMessage(messageId, o.workspace, 'elicitation');
  } catch (err: unknown) {
    logErr(TAG, `Telegram send failed: ${(err as Error).message}`);
    return { kind: 'send-failed' };
  }

  // The prompt stays open until the next field's prompt replaces it (or the hook exits)
  const response = await pollForResponse(promptId, o.deadline);
  if (!response || typeof response.textAnswer !== 'string') {
    logErr(TAG, 'Timed out waiting for response');
    return { kind: 'timeout' };
  }
  return coerceElicitationAnswer(response.textAnswer, o.prop, o.required);
}

/** Best-effort informational message (no prompt). */
async function notify(html: string, deadline: number): Promise<void> {
  try {
    await sendHtmlWithFallback(html, { tag: TAG, deadlineMs: deadline });
  } catch (err: unknown) {
    logErr(TAG, `Telegram send failed: ${(err as Error).message}`);
  }
}

function emit(action: 'decline' | 'cancel'): void {
  const output: ElicitationOutput = {
    hookSpecificOutput: {
      hookEventName: 'Elicitation',
      action,
    },
  };
  emitJson(output);
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logErr(TAG, `Fatal: ${err.message}`);
});
