/**
 * Shared helpers for the Claude Code hook scripts (permission-hook, question-notify,
 * elicitation-notify, permission-denied-notify, pre-compact-notify, enhanced-hook-notify).
 *
 * Hook contract these helpers enforce:
 *  - stdout carries ONLY the final JSON decision — all logging goes to stderr;
 *  - Telegram messages are HTML with every piece of user/tool text escaped, truncated on
 *    the RAW text before escaping/wrapping (so tags always close), ≤ 4096 chars, and a
 *    failed HTML send is retried once as plain text;
 *  - one overall deadline per hook process, ending before Claude Code's hook timeout;
 *  - every pending prompt file is removed on every exit path (success, timeout, send
 *    failure, SIGTERM/SIGINT/SIGHUP).
 *
 * No side effects on import.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { PROJECT_ROOT } from './paths';
import { tmux } from './tmux';
import { hookTimeoutSeconds } from './hook-definitions';
import { writePending, readResponse, cleanPrompt } from '../../prompt-bridge';
import type { InlineKeyboardMarkup, TelegramMessage } from '../types';

// ── Logging / stdio ─────────────────────────────────────────────

/** Write a log line to stderr (never stdout — Claude Code parses hook stdout). */
export function logErr(tag: string, msg: string): void {
  try { process.stderr.write(`[${tag}] ${msg}\n`); } catch {}
}

/**
 * Redirect console.log/info/debug to stderr so no imported module can pollute the
 * hook's stdout. The final decision must be written with process.stdout.write.
 */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => { console.error(...args); };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/** Read all of stdin (Claude Code writes the hook payload then closes it). */
export function readStdin(timeoutMs: number = 1000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => {
      try { process.stdin.destroy(); } catch {}
      finish();
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Parse the hook payload; null when it isn't a JSON object. */
export function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Write the hook's final JSON decision to stdout. */
export function emitJson(output: unknown): void {
  process.stdout.write(JSON.stringify(output) + '\n');
}

// ── Text / HTML ─────────────────────────────────────────────────

export const TELEGRAM_MAX_TEXT = 4096;

export function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode HTML entities in a single pass (so `&amp;lt;` → `&lt;`, not `<`). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match: string, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const cp = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return match;
      try { return String.fromCodePoint(cp); } catch { return match; }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Telegram HTML → plain text: strip tags, then decode entities. */
export function htmlToPlain(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''));
}

/** Truncate raw text to `max` chars (ellipsis included), never splitting a surrogate pair. */
export function truncateText(text: string, max: number, ellipsis: string = '…'): string {
  const s = String(text);
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= ellipsis.length) return s.slice(0, max);
  let cut = max - ellipsis.length;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + ellipsis;
}

/** `<pre>` block of raw text, truncated before escaping so the tag always closes. */
export function preBlock(text: string, max: number): string {
  return `<pre>${escapeHtml(truncateText(text, max))}</pre>`;
}

/** Inline `<code>` of raw text, truncated before escaping. */
export function inlineCode(text: string, max: number = 300): string {
  return `<code>${escapeHtml(truncateText(text, max))}</code>`;
}

/**
 * Build a message that fits Telegram's limit. `render(budget)` must build complete,
 * well-formed HTML whose variable content is truncated (raw, before escaping) to
 * `budget` chars. The budget shrinks until the HTML is ≤ maxLen. Measuring the HTML
 * (not the parsed text) is conservative: entities and tags only make it longer.
 */
export function fitHtml(render: (budget: number) => string, initialBudget: number, maxLen: number = TELEGRAM_MAX_TEXT): string {
  let budget = Math.max(0, Math.floor(initialBudget));
  let html = render(budget);
  for (let i = 0; i < 16 && html.length > maxLen && budget > 0; i++) {
    budget = Math.max(0, budget - (html.length - maxLen) - 32);
    html = render(budget);
  }
  if (html.length <= maxLen) return html;
  // Even the fixed parts are too long — degrade to escaped plain text (always well-formed).
  let plain = truncateText(htmlToPlain(html), maxLen);
  let escaped = escapeHtml(plain);
  while (escaped.length > maxLen && plain.length > 0) {
    plain = truncateText(plain, plain.length - (escaped.length - maxLen) - 1);
    escaped = escapeHtml(plain);
  }
  return escaped;
}

/**
 * Minimal Markdown → Telegram HTML. Escapes first, then only emits balanced,
 * properly nested tags (pre/code are leaves; b/i never span other tags).
 */
export function markdownToHtml(text: string): string {
  let html = escapeHtml(String(text).replace(/\x00/g, ''));
  const placeholders: string[] = [];
  const hold = (s: string): string => {
    placeholders.push(s);
    return `\x00P${placeholders.length - 1}\x00`;
  };

  // Protect code blocks / inline code from the bold/italic regexes
  html = html.replace(/```[^\n`]*\n([\s\S]*?)```/g, (_: string, code: string) => hold(`<pre>${code.replace(/\s+$/, '')}</pre>`));
  html = html.replace(/`([^`\n]+)`/g, (_: string, code: string) => hold(`<code>${code}</code>`));

  html = html.replace(/^[-*]\s+/gm, '• ');
  html = html.replace(/^#{1,6}\s+/gm, '');
  html = html.replace(/\*\*([^*<>\n]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/\*([^*<>\n]+)\*/g, '<i>$1</i>');

  return html.replace(/\x00P(\d+)\x00/g, (_: string, idx: string) => placeholders[parseInt(idx, 10)]);
}

/** HTML description of a tool call for permission prompts. `budget` caps the main content. */
export function formatToolDescriptionHtml(toolName: string, toolInput: Record<string, unknown>, budget: number = 2500): string {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const filePath = str(toolInput.file_path) ?? str(toolInput.notebook_path);

  if (toolName === 'Bash' && str(toolInput.command) !== null) {
    const desc = str(toolInput.description);
    return (desc ? `<i>${escapeHtml(truncateText(desc, 300))}</i>\n` : '')
      + `<b>Command:</b>\n${preBlock(toolInput.command as string, budget)}`;
  }
  if (toolName === 'Edit' && filePath) {
    const oldS = str(toolInput.old_string);
    const newS = str(toolInput.new_string);
    if (oldS !== null && newS !== null) {
      const maxLines = 12;
      const side = (s: string, prefix: string): string[] => {
        const lines = s.split('\n');
        const shown = lines.slice(0, maxLines).map(l => `${prefix}${l}`);
        if (lines.length > maxLines) shown.push(`  … (${lines.length - maxLines} more lines)`);
        return shown;
      };
      const diff = [...side(oldS, '- '), ...side(newS, '+ ')].join('\n');
      return `<b>File:</b> ${inlineCode(filePath)}\n${preBlock(diff, budget)}`;
    }
    return `<b>File:</b> ${inlineCode(filePath)}`;
  }
  if (filePath && (toolName === 'Write' || toolName === 'Read' || toolName === 'NotebookEdit' || toolName === 'MultiEdit')) {
    return `<b>File:</b> ${inlineCode(filePath)}`;
  }
  if (Object.keys(toolInput).length > 0) {
    let json: string;
    try { json = JSON.stringify(toolInput, null, 2); } catch { json = String(toolInput); }
    return preBlock(json, Math.min(budget, 1500));
  }
  return '';
}

// ── Telegram ────────────────────────────────────────────────────

export interface ForceReplyMarkup {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}

export type ReplyMarkup = InlineKeyboardMarkup | ForceReplyMarkup;

/**
 * Telegram is enabled and fully configured. Blocking hooks must exit without output
 * (Claude Code then shows its own UI) when this is false.
 */
export function telegramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEGRAM_ENABLED === 'true' && !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID;
}

/** sendMessage to the configured chat. Rejects on non-2xx, network error or timeout. */
export function telegramSendMessage(
  text: string,
  opts: { parseMode?: 'HTML'; replyMarkup?: ReplyMarkup; timeoutMs?: number } = {},
): Promise<TelegramMessage | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return Promise.reject(new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured'));
  }
  return new Promise((resolve, reject) => {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.parseMode) payload.parse_mode = opts.parseMode;
    if (opts.replyMarkup) payload.reply_markup = opts.replyMarkup;
    const body = JSON.stringify(payload);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: opts.timeoutMs ?? 5000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode! >= 200 && res.statusCode! < 300) {
          try {
            resolve(JSON.parse(data).result || null);
          } catch {
            resolve(null);
          }
        } else {
          reject(new Error(`Telegram API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Send an HTML message; if Telegram rejects it (or the request fails), retry once as
 * plain text with the same keyboard. Rejects only if both attempts fail. Each attempt's
 * timeout is bounded by `deadlineMs` when given.
 */
export async function sendHtmlWithFallback(
  html: string,
  opts: { tag: string; replyMarkup?: ReplyMarkup; deadlineMs?: number },
): Promise<TelegramMessage | null> {
  const attemptTimeout = (): number =>
    opts.deadlineMs === undefined ? 5000 : Math.min(5000, remainingMs(opts.deadlineMs));
  const first = attemptTimeout();
  if (first < 300) throw new Error('No time left to send the Telegram message');
  try {
    return await telegramSendMessage(html, { parseMode: 'HTML', replyMarkup: opts.replyMarkup, timeoutMs: first });
  } catch (err: unknown) {
    logErr(opts.tag, `HTML send failed (${(err as Error).message}) — retrying as plain text`);
  }
  const second = attemptTimeout();
  if (second < 300) throw new Error('No time left to retry the Telegram message as plain text');
  return telegramSendMessage(htmlToPlain(html), { replyMarkup: opts.replyMarkup, timeoutMs: second });
}

/** The bot's typing-indicator signal file. It carries no routing meaning. */
export const TYPING_SIGNAL_PATH = path.join(PROJECT_ROOT, 'src/data', 'typing-active');

/** Stop the bot's "typing…" indicator — call only after a message was actually sent. */
export function stopTypingSignal(): void {
  try { fs.unlinkSync(TYPING_SIGNAL_PATH); } catch {}
}

// ── Deadline ────────────────────────────────────────────────────

export const MAX_SAFETY_MARGIN_MS = 10_000;

/** ~10 s before Claude Code's kill, less for short hooks (25 % of the timeout). */
export function safetyMarginMs(hookTimeoutMs: number): number {
  return Math.min(MAX_SAFETY_MARGIN_MS, Math.floor(hookTimeoutMs / 4));
}

/** Absolute time (ms) by which the hook must have finished all waiting. */
export function computeDeadline(hookTimeoutMs: number, startedAtMs: number, safetyMs: number = safetyMarginMs(hookTimeoutMs)): number {
  return startedAtMs + hookTimeoutMs - safetyMs;
}

/** When this process started (Claude Code's timeout clock starts at spawn). */
export function processStartedAt(now: number = Date.now()): number {
  return now - Math.round(process.uptime() * 1000);
}

/** One overall deadline for this hook process, from its installed timeout. */
export function hookDeadline(script: string, args?: string): number {
  return computeDeadline(hookTimeoutSeconds(script, args) * 1000, processStartedAt());
}

export function remainingMs(deadlineMs: number, now: number = Date.now()): number {
  return Math.max(0, deadlineMs - now);
}

// ── Pending prompts ─────────────────────────────────────────────

const outstandingPrompts = new Set<string>();
let cleanupInstalled = false;

/** writePending + remember the id so it's cleaned up on any exit. */
export function openPrompt(id: string, data: Record<string, unknown>): void {
  outstandingPrompts.add(id);
  writePending(id, data);
}

/** Remove the prompt's pending/response files and forget it. */
export function closePrompt(id: string): void {
  outstandingPrompts.delete(id);
  cleanPrompt(id);
}

export function closeAllPrompts(): void {
  for (const id of Array.from(outstandingPrompts)) closePrompt(id);
}

export function outstandingPromptIds(): string[] {
  return Array.from(outstandingPrompts);
}

/**
 * Clean up outstanding prompts on process exit and on SIGTERM/SIGINT/SIGHUP (Claude
 * Code killing the hook at its timeout, Esc, session exit).
 */
export function installPromptCleanup(tag: string): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', closeAllPrompts);
  const signals: Array<[NodeJS.Signals, number]> = [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]];
  for (const [sig, num] of signals) {
    process.on(sig, () => {
      logErr(tag, `${sig} received — cleaning up pending prompts`);
      closeAllPrompts();
      process.exit(128 + num);
    });
  }
}

/** Poll for the bot's response file until `deadlineMs`. Null on timeout. */
export function pollForResponse(promptId: string, deadlineMs: number, intervalMs: number = 250): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const check = (): void => {
      const response = readResponse(promptId);
      if (response) { resolve(response); return; }
      const left = remainingMs(deadlineMs);
      if (left <= 0) { resolve(null); return; }
      setTimeout(check, Math.min(intervalMs, left));
    };
    check();
  });
}

// ── Session name ────────────────────────────────────────────────

/** Same sanitization /new uses for session names (dots, colons, spaces → hyphens). */
export function sanitizeSessionName(raw: string): string {
  return raw.replace(/[.:\s]/g, '-');
}

/** tmux session of the pane Claude runs in (exact pane via $TMUX_PANE), else derived from the workspace. */
export async function detectSessionName(workspace: string | null): Promise<string | null> {
  if (process.env.TMUX) {
    try {
      const args = ['display-message', '-p'];
      const pane = process.env.TMUX_PANE;
      if (pane && /^%\d+$/.test(pane)) args.push('-t', pane);
      args.push('#{session_name}');
      const name = (await tmux(args, 2000)).trim();
      if (name) return name;
    } catch {}
  }
  return workspace ? sanitizeSessionName(workspace) : null;
}

// ── Elicitation (MCP form fields) ───────────────────────────────

/** A property of an MCP elicitation `requested_schema` (primitive types only, per MCP spec). */
export interface ElicitationProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
  anyOf?: Array<{ const?: unknown; title?: string }>;
  items?: {
    type?: string;
    enum?: unknown[];
    enumNames?: string[];
    oneOf?: Array<{ const?: unknown; title?: string }>;
    anyOf?: Array<{ const?: unknown; title?: string }>;
  };
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  default?: unknown;
}

export interface ElicitationChoice { value: unknown; label: string }

export type CoerceResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'skip' }
  | { kind: 'invalid'; error: string };

/** Reply that skips an optional field. */
export const ELICITATION_SKIP = '-';

function choicesFrom(src: {
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
  anyOf?: Array<{ const?: unknown; title?: string }>;
}): ElicitationChoice[] | null {
  if (Array.isArray(src.enum) && src.enum.length > 0) {
    return src.enum.map((v, i) => ({
      value: v,
      label: src.enumNames && src.enumNames[i] ? String(src.enumNames[i]) : String(v),
    }));
  }
  const list = Array.isArray(src.oneOf) ? src.oneOf : Array.isArray(src.anyOf) ? src.anyOf : null;
  if (list) {
    const choices = list
      .filter(o => o && o.const !== undefined)
      .map(o => ({ value: o.const, label: o.title ? String(o.title) : String(o.const) }));
    if (choices.length > 0) return choices;
  }
  return null;
}

/** Allowed values of an enum / titled-enum / multi-select property; null when free-form. */
export function elicitationChoices(prop: ElicitationProperty): ElicitationChoice[] | null {
  if (prop.type === 'array') return prop.items ? choicesFrom(prop.items) : null;
  return choicesFrom(prop);
}

/** Match a reply to a choice: exact value, then value/label ignoring case, then 1-based index. */
export function matchChoice(answer: string, choices: ElicitationChoice[]): ElicitationChoice | null {
  const a = answer.trim();
  const lower = a.toLowerCase();
  const exact = choices.find(c => String(c.value) === a);
  if (exact) return exact;
  const loose = choices.find(c => String(c.value).toLowerCase() === lower || c.label.toLowerCase() === lower);
  if (loose) return loose;
  if (/^\d+$/.test(a)) {
    const idx = parseInt(a, 10);
    if (idx >= 1 && idx <= choices.length) return choices[idx - 1];
  }
  return null;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 'ok', '是', '对', '好']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', '否', '不', '不是']);

function formatChoiceList(choices: ElicitationChoice[]): string {
  return choices.map((c, i) => `${i + 1}. ${c.label}`).join(', ');
}

/**
 * Convert a Telegram text reply into the JSON type the elicitation schema asks for.
 * Optional fields accept "-" (or "/skip") to omit the value.
 */
export function coerceElicitationAnswer(raw: string, prop: ElicitationProperty, required: boolean): CoerceResult {
  const text = String(raw ?? '').trim();
  if (!required && (text === ELICITATION_SKIP || text.toLowerCase() === '/skip' || text === '')) {
    return { kind: 'skip' };
  }
  if (text === '') return { kind: 'invalid', error: 'An answer is required.' };

  const choices = elicitationChoices(prop);
  const type = prop.type || 'string';

  if (type === 'boolean') {
    const lower = text.toLowerCase();
    if (TRUE_WORDS.has(lower)) return { kind: 'value', value: true };
    if (FALSE_WORDS.has(lower)) return { kind: 'value', value: false };
    return { kind: 'invalid', error: 'Expected yes or no.' };
  }

  if (type === 'number' || type === 'integer') {
    const n = Number(text);
    if (!Number.isFinite(n)) return { kind: 'invalid', error: `"${truncateText(text, 40)}" is not a number.` };
    if (type === 'integer' && !Number.isInteger(n)) return { kind: 'invalid', error: 'Expected a whole number.' };
    if (typeof prop.minimum === 'number' && n < prop.minimum) return { kind: 'invalid', error: `Must be ≥ ${prop.minimum}.` };
    if (typeof prop.maximum === 'number' && n > prop.maximum) return { kind: 'invalid', error: `Must be ≤ ${prop.maximum}.` };
    return { kind: 'value', value: n };
  }

  if (type === 'array') {
    const parts = text.split(/[,，;\n]/).map(s => s.trim()).filter(Boolean);
    let values: unknown[];
    if (choices) {
      values = [];
      for (const part of parts) {
        const c = matchChoice(part, choices);
        if (!c) return { kind: 'invalid', error: `Unknown option "${truncateText(part, 40)}". Choose from: ${formatChoiceList(choices)}` };
        if (!values.includes(c.value)) values.push(c.value);
      }
    } else {
      values = parts;
    }
    if (typeof prop.minItems === 'number' && values.length < prop.minItems) return { kind: 'invalid', error: `Pick at least ${prop.minItems}.` };
    if (typeof prop.maxItems === 'number' && values.length > prop.maxItems) return { kind: 'invalid', error: `Pick at most ${prop.maxItems}.` };
    return { kind: 'value', value: values };
  }

  // string (plain, enum, or titled enum)
  if (choices) {
    const c = matchChoice(text, choices);
    return c ? { kind: 'value', value: c.value } : { kind: 'invalid', error: `Must be one of: ${formatChoiceList(choices)}` };
  }
  if (typeof prop.minLength === 'number' && text.length < prop.minLength) return { kind: 'invalid', error: `Must be at least ${prop.minLength} characters.` };
  if (typeof prop.maxLength === 'number' && text.length > prop.maxLength) return { kind: 'invalid', error: `Must be at most ${prop.maxLength} characters.` };
  switch (prop.format) {
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { kind: 'invalid', error: 'Expected an email address.' };
      break;
    case 'uri':
      try { new URL(text); } catch { return { kind: 'invalid', error: 'Expected a URL.' }; }
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || isNaN(Date.parse(text))) return { kind: 'invalid', error: 'Expected a date (YYYY-MM-DD).' };
      break;
    case 'date-time':
      if (isNaN(Date.parse(text))) return { kind: 'invalid', error: 'Expected a date-time (ISO 8601).' };
      break;
  }
  return { kind: 'value', value: text };
}

/** Plain-text hint lines describing what a field accepts (escape before sending as HTML). */
export function describeElicitationField(prop: ElicitationProperty, required: boolean): string[] {
  const lines: string[] = [];
  const type = prop.type || 'string';
  const choices = elicitationChoices(prop);
  if (choices) {
    lines.push(`Options: ${formatChoiceList(choices)}`);
    lines.push(type === 'array'
      ? 'Reply with one or more options (number or name), separated by commas.'
      : 'Reply with the option number or name.');
  } else if (type === 'boolean') {
    lines.push('Reply yes or no.');
  } else if (type === 'number' || type === 'integer') {
    const bounds: string[] = [];
    if (typeof prop.minimum === 'number') bounds.push(`≥ ${prop.minimum}`);
    if (typeof prop.maximum === 'number') bounds.push(`≤ ${prop.maximum}`);
    lines.push(`Expects ${type === 'integer' ? 'a whole number' : 'a number'}${bounds.length ? ` (${bounds.join(', ')})` : ''}.`);
  } else if (prop.format) {
    lines.push(`Format: ${prop.format}`);
  }
  if (prop.default !== undefined) lines.push(`Default: ${String(prop.default)}`);
  if (!required) lines.push(`Optional — reply "${ELICITATION_SKIP}" to skip.`);
  return lines;
}
