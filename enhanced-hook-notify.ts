#!/usr/bin/env node

/**
 * Enhanced Hook Notifier — called by Claude Code hooks.
 *
 * Handles: Stop (completed), Notification (waiting), SessionStart,
 *          SessionEnd, SubagentStop (subagent-done), StopFailure (stop-failure),
 *          PostCompact (post-compact), TaskCreated (task-created),
 *          CwdChanged (cwd-changed), InstructionsLoaded (instructions-loaded).
 *
 * Usage (in ~/.claude/settings.json hooks):
 *   node /path/to/telecc/dist/enhanced-hook-notify.js completed
 *   node /path/to/telecc/dist/enhanced-hook-notify.js waiting
 *   node /path/to/telecc/dist/enhanced-hook-notify.js session-start
 *   node /path/to/telecc/dist/enhanced-hook-notify.js session-end
 *   node /path/to/telecc/dist/enhanced-hook-notify.js subagent-done
 *   node /path/to/telecc/dist/enhanced-hook-notify.js stop-failure
 *   node /path/to/telecc/dist/enhanced-hook-notify.js post-compact
 *   node /path/to/telecc/dist/enhanced-hook-notify.js task-created
 *   node /path/to/telecc/dist/enhanced-hook-notify.js cwd-changed
 *   node /path/to/telecc/dist/enhanced-hook-notify.js instructions-loaded
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import Logger from './src/core/logger';
import { upsertSession, extractWorkspaceName, trackNotificationMessage, updateSessionRateLimit, markSessionEnded } from './workspace-router';
import type { RateLimitInfo } from './src/types';
import { hasPendingForWorkspace } from './prompt-bridge';
import { isRemoteDriven, isLocallyActive } from './src/utils/active-check';
import { endRemoteTurn, hookProjectDir } from './src/utils/remote-state';
import {
  routeConsoleToStderr, readStdin, escapeHtml, truncateText, fitHtml, markdownToHtml, htmlToPlain,
  telegramSendMessage, stopTypingSignal, hookDeadline, remainingMs, detectSessionName,
} from './src/utils/hook-utils';

const logger = new Logger('hook:enhanced');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';

const STATUS_ARG = process.argv[2] || 'completed';

/** Events that end a Telegram-driven turn — the only ones that call endRemoteTurn. */
const ENDS_REMOTE_TURN = new Set(['completed', 'session-end', 'stop-failure']);
/** Events after which the bot's "typing…" indicator should stop (once we've messaged). */
const STOPS_TYPING = new Set(['completed', 'waiting', 'session-end', 'stop-failure']);
/** SessionEnd reasons where the Claude process keeps running in the same pane. */
const SESSION_END_STILL_RUNNING = new Set(['clear', 'resume']);

// ── Status configuration ─────────────────────────────────────────

interface StatusConfig {
  icon: string;
  label: string;
  /** When true, notification fires even if user is active at terminal */
  alwaysNotify: boolean;
  /** When true, register/update the session map entry */
  upsertSession: boolean;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  'completed':     { icon: '\u2705', label: 'Task completed',       alwaysNotify: false, upsertSession: true  },
  'waiting':       { icon: '\u23f3', label: 'Waiting for input',    alwaysNotify: false, upsertSession: true  },
  'session-start': { icon: '\u{1F7E2}', label: 'Session started',   alwaysNotify: false, upsertSession: true  },
  'session-end':   { icon: '\u{1F534}', label: 'Session ended',     alwaysNotify: false, upsertSession: false },
  'subagent-done': { icon: '\u{1F916}', label: 'Subagent finished', alwaysNotify: false, upsertSession: true  },
  // Phase 2 hook events
  'stop-failure':        { icon: '\u26A0\uFE0F', label: 'API error',           alwaysNotify: true,  upsertSession: true  },
  'post-compact':        { icon: '\u{1F4E6}', label: 'Context compacted',      alwaysNotify: false, upsertSession: true  },
  'task-created':        { icon: '\u{1F4CB}', label: 'Task created',           alwaysNotify: false, upsertSession: true  },
  'cwd-changed':         { icon: '\u{1F4C2}', label: 'Directory changed',      alwaysNotify: false, upsertSession: true  },
  'instructions-loaded': { icon: '\u{1F4D6}', label: 'Instructions loaded',    alwaysNotify: false, upsertSession: false },
};

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  routeConsoleToStderr();
  const deadline = hookDeadline('enhanced-hook-notify.js', STATUS_ARG);

  let payload: Record<string, unknown>;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  // Key everything on the project root, not the shell's cwd: a `cd` into a
  // subdirectory must not look like a new workspace/session or lose remote routing.
  const dir = hookProjectDir((payload.cwd as string) || process.env.CLAUDE_CWD);
  const workspace = extractWorkspaceName(dir)!;
  const sessionTitle = (payload.session_title as string) || null; // v2.1.94+
  const tmuxSession = await detectSessionName(extractWorkspaceName(dir));
  const sessionId = (payload.session_id as string) || null;

  const config = STATUS_CONFIG[STATUS_ARG] ?? STATUS_CONFIG['waiting'];

  // /clear and interactive /resume fire SessionEnd too, but Claude keeps running in the
  // pane — that is not the end of the session for routing/injection purposes.
  const claudeStillRunning = STATUS_ARG === 'session-end' && SESSION_END_STILL_RUNNING.has(payload.reason as string);

  // Was the current turn of THIS session injected from Telegram? Read before clearing.
  let remote = false;
  try { remote = isRemoteDriven(dir, sessionId); } catch {}
  if (ENDS_REMOTE_TURN.has(STATUS_ARG) && !claudeStillRunning) {
    try { endRemoteTurn(dir, sessionId); } catch (err: unknown) {
      logger.error(`Failed to end remote turn: ${(err as Error).message}`);
    }
  }

  // Claude exited — the bot must never inject into this session again. The next
  // SessionStart upsert (with tmuxPane) clears endedAt if Claude is started again.
  if (STATUS_ARG === 'session-end' && !claudeStillRunning) {
    try {
      // Only the session that exited — another Claude may run in the same directory
      markSessionEnded(dir, { sessionId, tmuxPane: process.env.TMUX_PANE });
    } catch (err: unknown) {
      logger.error(`Failed to mark session ended: ${(err as Error).message}`);
    }
  }

  // Extract rate limit info from payload (Claude Code v2.1.80+)
  const rateLimit = extractRateLimitInfo(payload);

  // Update session map (skip for session-end — session is over)
  if (config.upsertSession) {
    try {
      const sessionType: 'tmux' | 'ghostty' | 'external' =
        process.env.TMUX ? 'tmux'
        : process.env.TERM_PROGRAM === 'ghostty' ? 'ghostty'
        : 'external';
      upsertSession({
        cwd: dir,
        // External terminals get their own key so they never share (and flip-flop)
        // a map entry with the tmux session the bot may start for the same project.
        tmuxSession: sessionType === 'external'
          ? `external-${tmuxSession || workspace}`
          : (tmuxSession || `claude-${workspace}`),
        tmuxPane: process.env.TMUX ? process.env.TMUX_PANE : undefined,
        status: STATUS_ARG,
        sessionId,
        sessionType,
        rateLimit,
      });
    } catch (err: unknown) {
      logger.error(`Failed to update session map: ${(err as Error).message}`);
    }
  } else if (rateLimit) {
    // Even for session-end, update rate limit if present
    try {
      updateSessionRateLimit(workspace, rateLimit);
    } catch {}
  }

  // Suppress if the user is working in THIS session at the terminal, unless the turn
  // was injected from Telegram (then the result must go back to Telegram).
  if (!config.alwaysNotify && !remote && isLocallyActive(dir, sessionId ?? undefined)) {
    return;
  }

  // Send Telegram notification
  if (TELEGRAM_ENABLED && BOT_TOKEN && CHAT_ID) {
    // Dedup: if a richer prompt (permission/question) is already pending for this
    // workspace, skip the basic "Waiting for input" notification
    if (STATUS_ARG === 'waiting' && hasPendingForWorkspace(workspace)) {
      return;
    }

    // Include session title if available (v2.1.94+)
    const titleSuffix = sessionTitle ? ` (${escapeHtml(truncateText(sessionTitle, 100))})` : '';
    let message = `${config.icon} ${config.label} in <b>${escapeHtml(truncateText(workspace, 100))}</b>${titleSuffix}`;

    // Status-specific message additions
    if (STATUS_ARG === 'stop-failure') {
      // Include error details from StopFailure hook
      const errorType = payload.error_type as string | undefined;
      const errorMessage = payload.error_message as string | undefined;
      if (errorType || errorMessage) {
        message += `\n\n<b>Error:</b> ${escapeHtml(truncateText(errorType || 'Unknown', 200))}`;
        if (errorMessage) {
          message += `\n${escapeHtml(truncateText(errorMessage, 1000))}`;
        }
      }
    } else if (STATUS_ARG === 'post-compact') {
      // Include compaction stats if available
      const beforeTokens = payload.tokens_before as number | undefined;
      const afterTokens = payload.tokens_after as number | undefined;
      if (beforeTokens && afterTokens) {
        const saved = beforeTokens - afterTokens;
        const percent = Math.round((saved / beforeTokens) * 100);
        message += `\n\n<i>${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens (${percent}% saved)</i>`;
      }
    } else if (STATUS_ARG === 'task-created') {
      // Include task description
      const taskDescription = payload.task_description as string | undefined;
      const taskId = payload.task_id as string | undefined;
      if (taskDescription) {
        message += `\n\n${escapeHtml(truncateText(taskDescription, 1000))}`;
      }
      if (taskId) {
        message += `\n<i>ID: ${escapeHtml(truncateText(taskId, 100))}</i>`;
      }
    } else if (STATUS_ARG === 'cwd-changed') {
      // Include old and new directory
      const oldCwd = payload.old_cwd as string | undefined;
      const newCwd = payload.new_cwd as string | undefined;
      if (oldCwd && newCwd) {
        const oldWorkspace = extractWorkspaceName(oldCwd);
        const newWorkspace = extractWorkspaceName(newCwd);
        message += `\n\n<i>${escapeHtml(truncateText(oldWorkspace || oldCwd, 300))} → ${escapeHtml(truncateText(newWorkspace || newCwd, 300))}</i>`;
      }
    } else if (STATUS_ARG === 'instructions-loaded') {
      // Include instructions file path
      const instructionsPath = payload.instructions_path as string | undefined;
      if (instructionsPath) {
        message += `\n\n<i>${escapeHtml(truncateText(instructionsPath, 300))}</i>`;
      }
    }

    // Append Claude's last response text (skip for session-start and simple notifications)
    const skipResponseText = ['session-start', 'post-compact', 'task-created', 'cwd-changed', 'instructions-loaded'];
    const responseText = skipResponseText.includes(STATUS_ARG) ? null : getResponseText(payload);
    const head = message;
    // Truncate the RAW response before converting, shrinking until the message fits 4096
    message = fitHtml(
      budget => responseText ? `${head}\n\n${markdownToHtml(truncateText(responseText, budget))}` : head,
      3500,
    );

    const timeoutFor = (): number => Math.min(5000, remainingMs(deadline));
    let sent = false;
    try {
      const result = await telegramSendMessage(message, { parseMode: 'HTML', timeoutMs: Math.max(300, timeoutFor()) });
      sent = true;
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
      }
    } catch (err: unknown) {
      logger.error(`HTML send failed (${(err as Error).message}) — retrying as plain text`);
      // HTML failed — send as plain text (tags stripped, entities decoded)
      try {
        const result = await telegramSendMessage(htmlToPlain(message), { timeoutMs: Math.max(300, timeoutFor()) });
        sent = true;
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
        }
      } catch (err2: unknown) {
        logger.error(`Telegram send failed: ${(err2 as Error).message}`);
      }
    }

    // typing-active is only the bot's typing indicator: stop it once the turn's result
    // (or a request for input) has actually been delivered.
    if (sent && STOPS_TYPING.has(STATUS_ARG)) stopTypingSignal();
  }
}

// ── Response text extraction ─────────────────────────────────────

/**
 * Get Claude's last response text from the hook payload.
 * Prefers last_assistant_message (v2.1.47+), falls back to transcript parsing.
 * For SubagentStop, also tries agent_transcript_path.
 */
function getResponseText(payload: Record<string, unknown>): string | null {
  // Direct field — available in Claude Code v2.1.47+
  const direct = payload.last_assistant_message as string | undefined;
  if (direct) return direct;

  // Transcript fallback for older Claude Code versions
  const agentTranscript = payload.agent_transcript_path as string | undefined;
  if (agentTranscript) {
    try { return extractLastResponse(agentTranscript); } catch {}
  }
  const transcript = payload.transcript_path as string | undefined;
  if (transcript) {
    try { return extractLastResponse(transcript); } catch {}
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract rate limit info from hook payload (Claude Code v2.1.80+).
 * Rate limits may appear in statusline data or direct payload fields.
 */
function extractRateLimitInfo(payload: Record<string, unknown>): RateLimitInfo | undefined {
  // Try direct rate_limits field
  const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
  if (rateLimits) {
    return {
      remaining: rateLimits.remaining as number | undefined,
      limit: rateLimits.limit as number | undefined,
      resetsAt: rateLimits.resets_at as number | undefined,
      updatedAt: Date.now(),
    };
  }

  // Try statusline object (may contain rate limit info)
  const statusline = payload.statusline as Record<string, unknown> | undefined;
  if (statusline?.rate_limits) {
    const sl = statusline.rate_limits as Record<string, unknown>;
    return {
      remaining: sl.remaining as number | undefined,
      limit: sl.limit as number | undefined,
      resetsAt: sl.resets_at as number | undefined,
      updatedAt: Date.now(),
    };
  }

  return undefined;
}

function extractLastResponse(transcriptPath: string): string | null {
  const data = fs.readFileSync(transcriptPath, 'utf8').trimEnd();
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.content) {
        const texts = entry.message.content
          .filter((c: Record<string, unknown>) => c.type === 'text')
          .map((c: Record<string, unknown>) => c.text);
        if (texts.length > 0) return texts.join('\n\n');
      }
    } catch {}
  }
  return null;
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
