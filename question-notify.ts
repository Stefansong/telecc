#!/usr/bin/env node

/**
 * Question Notify — Called by Claude Code's PreToolUse hook (matcher: AskUserQuestion).
 *
 * BLOCKING mode (v2.0): Sends Telegram notification with option buttons, polls for
 * user selection, then outputs `updatedInput` via stdout so Claude Code receives
 * the answer directly — no keystroke injection needed!
 *
 * Free-text questions (no options): the pending prompt is marked `awaitingText` with the
 * Telegram message id; the bot writes `{ textAnswer }` when the user replies.
 *
 * This works with ANY terminal (tmux, Ghostty, bare terminal).
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name }
 * tool_input.questions: [{ question, header, options: [{ label, description }], multiSelect }]
 *
 * Stdout: { hookSpecificOutput: { updatedInput: { questions: [...] }, permissionDecision: "allow" } }
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
  detectSessionName, telegramConfigured,
} from './src/utils/hook-utils';
import type { AskUserQuestionItem, InlineKeyboardButton } from './src/types';

const TAG = 'question-notify';

/** Output format for Claude Code's PreToolUse hook with updatedInput.
 *
 * For AskUserQuestion, the hook must:
 * 1. Include hookEventName: "PreToolUse"
 * 2. Echo back the original `questions` array unchanged
 * 3. Provide a separate `answers` object mapping question text → answer label
 *    (multi-select: join labels with commas)
 * 4. Set permissionDecision: "allow"
 */
interface QuestionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    updatedInput: {
      questions: AskUserQuestionItem[];
      answers: Record<string, string>;
    };
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  routeConsoleToStderr();
  installPromptCleanup(TAG);
  // ONE deadline shared by every question in this tool call
  const deadline = hookDeadline('question-notify.js');

  const raw = await readStdin();
  // Telegram off / not configured — no output, Claude Code shows its native UI
  if (!telegramConfigured()) return;
  const payload = parsePayload(raw);
  if (!payload) return;

  // Key everything on the project root (stable when Claude cd's into a subdirectory)
  const dir = hookProjectDir(payload.cwd as string);

  // User is working in this session at the terminal and the turn didn't come from
  // Telegram — let Claude Code show its native UI. Telegram-driven questions must go
  // back to Telegram.
  if (shouldDeferToTerminal(dir)) {
    return;
  }

  const toolInput = (payload.tool_input || {}) as Record<string, unknown>;
  const workspace = extractWorkspaceName(dir) || 'unknown';

  // Extract questions from tool_input
  const questions = (toolInput.questions || []) as AskUserQuestionItem[];
  if (!Array.isArray(questions) || questions.length === 0) {
    return;
  }

  // Detect session name (for session map, even though we don't inject keystrokes)
  const tmuxSession = await detectSessionName(extractWorkspaceName(dir));

  // Collect answers: map of question text → selected label(s)
  // Multi-select: join labels with commas (Claude Code format).
  const answers: Record<string, string> = {};

  // The previous question's prompt stays until the next one is written, so a free-text
  // reply never finds "no open question" in between. All are removed on exit.
  let prevPromptId: string | null = null;
  try {
    // Process each question (usually just one)
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const promptId = generatePromptId(); // Unique ID per question
      const questionText = q.question || 'Question';
      const options = Array.isArray(q.options) ? q.options : [];
      const isLast = qi === questions.length - 1;
      const isMultiSelect = q.multiSelect || false;
      const isFreeText = options.length === 0;
      const counter = questions.length > 1 ? ` (${qi + 1}/${questions.length})` : '';

      const head = `❓ <b>Question${counter}</b> — ${escapeHtml(truncateText(workspace, 100))}`;
      let keyboard: InlineKeyboardButton[][] | null = null;
      let messageText: string;

      if (!isFreeText) {
        // Build inline keyboard with numbered options
        const prefix = isMultiSelect ? '☐ ' : '';
        const buttons: InlineKeyboardButton[] = options.map((opt, idx) => ({
          text: truncateText(`${prefix}${idx + 1}. ${opt.label}`, 60),
          callback_data: `opt:${promptId}:${idx + 1}`,
        }));

        // Arrange buttons in rows (max 2 per row for readability)
        keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) {
          keyboard.push(buttons.slice(i, i + 2));
        }
        // Add Submit button for multi-select questions
        if (isMultiSelect) {
          keyboard.push([{ text: '✅ Submit', callback_data: `opt-submit:${promptId}` }]);
        }

        messageText = fitHtml(budget => {
          let html = `${head}\n\n${escapeHtml(truncateText(questionText, budget))}`;
          // Add option descriptions to the message
          const optionLines = options.map((opt, idx) =>
            `<b>${idx + 1}.</b> ${escapeHtml(truncateText(opt.label || '', 200))}`
            + (opt.description ? ` — <i>${escapeHtml(truncateText(opt.description, Math.max(40, Math.floor(budget / 4))))}</i>` : '')
          );
          html += '\n\n' + optionLines.join('\n');
          if (isMultiSelect) html += '\n\n<i>Select one or more, then tap Submit.</i>';
          return html;
        }, 2500);

        // Write pending file so bot callback handler can write response
        openPrompt(promptId, {
          type: 'question',
          workspace,
          tmuxSession,
          questionText,
          options: options.map(o => o.label),
          multiSelect: isMultiSelect,
          selectedOptions: isMultiSelect ? options.map(() => false) : undefined,
          isLast,
        });
      } else {
        // No options — free text question, answered by replying in Telegram
        messageText = fitHtml(budget =>
          `${head}\n\n${escapeHtml(truncateText(questionText, budget))}\n\n`
          + '<i>Reply to this message with your answer (or just send it as a message if this is the only open question).</i>',
        3000);

        // awaitingText from the start: a reply that arrives before messageId is
        // recorded must still be routable to this prompt
        openPrompt(promptId, {
          type: 'question-freetext',
          workspace,
          tmuxSession,
          questionText,
          isLast,
          awaitingText: true,
        });
      }
      if (prevPromptId) closePrompt(prevPromptId);
      prevPromptId = promptId;

      // Send Telegram message (HTML, plain-text retry on failure)
      try {
        const result = await sendHtmlWithFallback(messageText, {
          tag: TAG,
          replyMarkup: keyboard
            ? { inline_keyboard: keyboard }
            : { force_reply: true, input_field_placeholder: truncateText(questionText, 64) },
          deadlineMs: deadline,
        });
        const messageId = result?.message_id;
        // Record the message id first (reply-to routing) — trackNotificationMessage
        // can wait on a file lock
        if (messageId) updatePending(promptId, { messageId });
        stopTypingSignal();
        if (messageId) trackNotificationMessage(messageId, workspace, isFreeText ? 'question-freetext' : 'question');
      } catch (err: unknown) {
        logErr(TAG, `Telegram send failed: ${(err as Error).message}`);
        return; // Can't notify — exit without output (Claude Code shows its native UI)
      }

      // Poll for response until the shared deadline
      const response = await pollForResponse(promptId, deadline);
      if (!response) {
        // Timed out — exit without output (Claude Code shows its native UI)
        logErr(TAG, 'Timed out waiting for response');
        return;
      }

      if (typeof response.textAnswer === 'string') {
        answers[questionText] = response.textAnswer;
      } else if (isMultiSelect) {
        // Multi-select: response.selectedLabels is string[] — join with commas
        const selectedLabels = (response.selectedLabels as string[]) || [];
        answers[questionText] = selectedLabels.join(',');
      } else {
        // Single-select: response.selectedLabel is string
        answers[questionText] = (response.selectedLabel as string) || '';
      }
    }
  } finally {
    closeAllPrompts();
  }

  // Output updatedInput to stdout so Claude Code receives the answers directly.
  // Format: echo back original questions + separate `answers` object.
  if (Object.keys(answers).length > 0) {
    const output: QuestionHookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions,
          answers,
        },
      },
    };
    emitJson(output);
  }
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logErr(TAG, `Fatal: ${err.message}`);
});
