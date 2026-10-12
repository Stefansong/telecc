#!/usr/bin/env node

/**
 * Prompt Bridge — File-based IPC for Claude Code interactive prompts.
 *
 * Manages /tmp/claude-prompts/ directory with pending/response files
 * so that hooks (permission-hook.js, question-notify.js) can communicate
 * with the Telegram bot's callback query handler.
 *
 * File format:
 *   pending-<id>.json   — written by hook, read by bot callback handler
 *   response-<id>.json  — written by bot callback handler, read by hook
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeJsonAtomic } from './src/utils/atomic-json';

const PROMPTS_DIR = process.env.PROMPTS_DIR || '/tmp/claude-prompts';
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/** Ensure the prompts directory exists. */
function ensureDir(): void {
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  }
}

/** Generate a unique 8-char prompt ID. */
function generatePromptId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Write a pending prompt file. Records the writing hook's pid so the bot can tell
 * whether anyone is still waiting for the answer (see isPromptAlive).
 */
function writePending(id: string, data: Record<string, unknown>): void {
  ensureDir();
  cleanExpired();
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  writeJsonAtomic(filePath, { pid: process.pid, ...data, createdAt: Date.now() });
}

/**
 * Write a response file (from bot callback).
 */
function writeResponse(id: string, data: Record<string, unknown>): void {
  ensureDir();
  const filePath = path.join(PROMPTS_DIR, `response-${id}.json`);
  writeJsonAtomic(filePath, { ...data, respondedAt: Date.now() });
}

/**
 * Read a response file if it exists.
 */
function readResponse(id: string): Record<string, unknown> | null {
  const filePath = path.join(PROMPTS_DIR, `response-${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read a pending prompt file.
 */
function readPending(id: string): Record<string, unknown> | null {
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check if there's a pending prompt for a given workspace.
 * Used by enhanced-hook-notify.js for deduplication.
 */
function hasPendingForWorkspace(workspace: string): boolean {
  ensureDir();
  try {
    const files = fs.readdirSync(PROMPTS_DIR);
    for (const file of files) {
      if (!file.startsWith('pending-')) continue;
      try {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
        const data = JSON.parse(raw);
        // Only count non-expired pending files
        if (data.workspace === workspace) {
          // Only count prompts a live hook is still waiting on (not expired, not
          // answered, hook process not killed by its timeout)
          const id = file.replace('pending-', '').replace('.json', '');
          if (isPromptAlive(id)) {
            return true;
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Directory read failed
  }
  return false;
}

/**
 * Remove pending and response files older than EXPIRY_MS.
 */
function cleanExpired(): void {
  try {
    if (!fs.existsSync(PROMPTS_DIR)) return;
    const files = fs.readdirSync(PROMPTS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(PROMPTS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > EXPIRY_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Skip if file was already removed
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

/**
 * Remove pending and response files for a given prompt ID.
 */
function cleanPrompt(id: string): void {
  const pending = path.join(PROMPTS_DIR, `pending-${id}.json`);
  const response = path.join(PROMPTS_DIR, `response-${id}.json`);
  try { fs.unlinkSync(pending); } catch {}
  try { fs.unlinkSync(response); } catch {}
}

/**
 * Update fields on an existing pending prompt file.
 */
function updatePending(id: string, updates: Record<string, unknown>): void {
  const existing = readPending(id);
  if (!existing) return;
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  writeJsonAtomic(filePath, { ...existing, ...updates });
}

/**
 * Is a hook still waiting on this prompt? False when the pending file is gone or
 * expired, a response was already written, or the hook process that wrote it has
 * exited (killed by Claude Code's hook timeout, Esc, session exit...). Buttons on a
 * dead prompt must not report "Allowed"/"Answered".
 */
function isPromptAlive(id: string): boolean {
  const pending = readPending(id);
  if (!pending) return false;
  if (Date.now() - ((pending.createdAt as number) || 0) >= EXPIRY_MS) return false;
  if (readResponse(id)) return false;
  const pid = pending.pid as number | undefined;
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      // EPERM = exists but not ours; ESRCH = gone
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    }
  }
  return true;
}

/**
 * Find a live prompt waiting for a free-text answer (pending has `awaitingText: true`).
 * With `replyToMessageId`, only the prompt whose Telegram `messageId` matches.
 * Without it, returns the prompt only when exactly one is waiting (unambiguous).
 */
function findAwaitingTextPrompt(replyToMessageId?: number | null): string | null {
  ensureDir();
  const candidates: Array<{ id: string; messageId?: number }> = [];
  try {
    for (const file of fs.readdirSync(PROMPTS_DIR)) {
      if (!file.startsWith('pending-') || !file.endsWith('.json')) continue;
      const id = file.slice('pending-'.length, -'.json'.length);
      const data = readPending(id);
      if (!data || data.awaitingText !== true || !isPromptAlive(id)) continue;
      candidates.push({ id, messageId: data.messageId as number | undefined });
    }
  } catch {
    return null;
  }
  if (replyToMessageId) {
    return candidates.find(c => c.messageId === replyToMessageId)?.id ?? null;
  }
  return candidates.length === 1 ? candidates[0].id : null;
}

export {
  generatePromptId,
  writePending,
  updatePending,
  writeResponse,
  readResponse,
  readPending,
  isPromptAlive,
  findAwaitingTextPrompt,
  hasPendingForWorkspace,
  cleanExpired,
  cleanPrompt,
  PROMPTS_DIR,
};
