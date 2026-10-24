#!/usr/bin/env node

// Node.js version check — must run before anything else
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
    console.error(`telecc requires Node.js >= 18.0.0 (you have ${process.version}).`);
    console.error('Upgrade: https://nodejs.org/ or use nvm: nvm install 18');
    process.exit(1);
}

/**
 * Workspace Telegram Bot — long-polling bot for remote Claude Code control.
 *
 * Commands:
 *   /<workspace> <command>   Route a command to the Claude session in that workspace
 *   /sessions                List all active sessions with workspace names
 *   /cmd <TOKEN> <command>   Token-based fallback for direct session access
 *   /help                    Show available commands
 *   /status [workspace]      Show tmux pane output for a workspace
 *   /stop [workspace]       Interrupt running prompt (Ctrl+C)
 *   /compact [workspace]     Compact context in a workspace session
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import {
  resolveWorkspace,
  listActiveSessions,
  isTmuxEntry,
  isGhosttyEntry,
  isExternalEntry,
  readSessionMap,
  updateSessionMap,
  pruneExpired,
  extractWorkspaceName,
  isExpired,
  getDefaultWorkspace,
  setDefaultWorkspace,
  trackNotificationMessage,
  getWorkspaceForMessage,
  upsertSession,
  recordProjectUsage,
  getRecentProjects,
  getResumeableProjects,
  getClaudeSessionsForProject,
  findSessionByTmuxName,
  getSessionRateLimit,
} from './workspace-router';
import {
  writeResponse,
  readResponse,
  readPending,
  updatePending,
  isPromptAlive,
  findAwaitingTextPrompt,
  PROMPTS_DIR,
} from './prompt-bridge';
import { parseCallbackData } from './src/utils/callback-parser';
import { ptySessionManager } from './src/utils/pty-session-manager';
import { ghosttySessionManager } from './src/utils/ghostty-session-manager';
import { generateDeepLink, canGenerateDeepLink } from './src/utils/deep-link';
import { readTranscriptStatus, type TranscriptStatus } from './src/utils/transcript-reader';
import {
  tmux,
  paneTarget,
  resolvePaneTarget,
  hasSession,
  sendLiteral,
  sendKeys,
  capturePane,
  isPaneAtShellPrompt,
} from './src/utils/tmux';
import { markRemoteInjected, unmarkRemoteInjected } from './src/utils/remote-state';
import { readJsonSafe, writeJsonAtomic } from './src/utils/atomic-json';
import { claudeProjectDirs } from './src/utils/paths';
import { startLogRotation } from './src/utils/log-rotate';
import Logger from './src/core/logger';
import type {
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramUpdate,
  InlineKeyboardMarkup,
  SessionEntry,
  ResolveResult,
  ParsedCallback,
} from './src/types';

const logger = new Logger('bot');

const INJECTION_MODE: string = process.env.INJECTION_MODE || 'tmux';

const TMUX_AVAILABLE: boolean = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
})();

/**
 * Determine the active injection backend.
 * Respects INJECTION_MODE env var, falls back in order: ghostty → pty → tmux.
 */
function getEffectiveMode(): 'tmux' | 'ghostty' | 'pty' {
  if (INJECTION_MODE === 'ghostty' && ghosttySessionManager.isAvailable()) return 'ghostty';
  if (INJECTION_MODE === 'pty' && ptySessionManager.isAvailable()) return 'pty';
  if (TMUX_AVAILABLE && INJECTION_MODE !== 'pty' && INJECTION_MODE !== 'ghostty') return 'tmux';
  if (ghosttySessionManager.isAvailable()) return 'ghostty';
  if (ptySessionManager.isAvailable()) return 'pty';
  return 'tmux';
}

const BOT_TOKEN: string | undefined = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID: string | undefined = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  logger.error('TELEGRAM_BOT_TOKEN not configured in .env');
  logger.error('  Get your token from @BotFather: https://t.me/BotFather');
  process.exit(1);
}

if (!CHAT_ID || CHAT_ID === 'YOUR_CHAT_ID_HERE') {
  logger.error('TELEGRAM_CHAT_ID not configured in .env');
  logger.error('  Get your chat ID from @userinfobot: https://t.me/userinfobot');
  process.exit(1);
}

let lastUpdateId: number = 0;
let lastUpdateAt: number = 0;             // when lastUpdateId was last advanced (ms)
let lastPollTime: number | null = null;   // timestamp of last successful getUpdates call
const startTime: number = Date.now();
const activeTypingIntervals: Map<string, { intervalId: NodeJS.Timeout; timeoutId: NodeJS.Timeout }> = new Map(); // workspace → intervalId

/** Telegram's hard limit on message text length (characters after entity parsing). */
const TELEGRAM_MAX_TEXT = 4096;
const LONG_POLL_TIMEOUT_S = 30;

// ── Telegram API helpers ────────────────────────────────────────

const TRANSIENT_NET_ERROR = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|socket hang up|socket disconnected|timed out|deadline|closed before|aborted|Too Many Requests|Bad Gateway|Gateway Timeout|Service Unavailable/i;
const SEND_RETRY_DELAYS_MS = [1500, 4000, 8000];

/**
 * Telegram call with retries for transient network failures. A reply goes out over a
 * fresh TLS connection, which fails for a few seconds after sleep/wake or a VPN flap
 * while the already-established long-poll connection keeps receiving — without
 * retries the bot "hears" the user but its answers vanish. getUpdates is not retried
 * here; the poll loop has its own backoff.
 */
async function telegramAPI(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (method === 'getUpdates') return telegramRequest(method, body);
  let attempt = 0;
  for (;;) {
    try {
      const result = await telegramRequest(method, body);
      if (method === 'sendMessage') {
        logger.info(`Sent: ${String(body.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);
      }
      return result;
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (!TRANSIENT_NET_ERROR.test(msg) || attempt >= SEND_RETRY_DELAYS_MS.length) {
        logger.error(`Telegram ${method} failed${attempt ? ` after ${attempt + 1} attempts` : ''}: ${msg}`);
        throw err;
      }
      const delay = SEND_RETRY_DELAYS_MS[attempt++];
      logger.warn(`Telegram ${method} failed (${msg}) — retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

function telegramRequest(method: string, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload: string = JSON.stringify(body);
    const isLongPoll = method === 'getUpdates';
    // Socket idle timeout, plus an overall deadline so a response that trickles or
    // stalls mid-body can never hang the caller (and with it the polling loop).
    const idleTimeoutMs = isLongPoll ? (LONG_POLL_TIMEOUT_S + 5) * 1000 : 10000;
    const deadlineMs = isLongPoll ? (LONG_POLL_TIMEOUT_S + 15) * 1000 : 30000;
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: idleTimeoutMs,
    };

    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (err) reject(err);
      else resolve(result);
    };

    const req = https.request(options, (res) => {
      let data = '';
      let ended = false;
      res.setEncoding('utf8'); // don't split multi-byte (CJK) chars across chunks
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        ended = true;
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            finish(new Error(`Telegram API error: ${parsed.description || data}`));
          } else {
            finish(null, parsed.result);
          }
        } catch {
          finish(new Error(`Invalid JSON from Telegram: ${data.slice(0, 200)}`));
        }
      });
      res.on('aborted', () => finish(new Error(`Telegram ${method} response aborted`)));
      res.on('error', (err: Error) => finish(err));
      res.on('close', () => {
        if (!ended) finish(new Error(`Telegram ${method} connection closed before response completed`));
      });
    });

    req.on('error', (err: Error) => finish(err));
    req.on('timeout', () => {
      req.destroy();
      finish(new Error(`Telegram ${method} request timed out`));
    });
    deadline = setTimeout(() => {
      req.destroy();
      finish(new Error(`Telegram ${method} exceeded ${deadlineMs / 1000}s deadline`));
    }, deadlineMs);

    req.write(payload);
    req.end();
  });
}

function sendMessage(text: string): Promise<unknown> {
  return telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
  });
}

function sendHtmlMessage(text: string): Promise<unknown> {
  return telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
}

/**
 * Fork patch: maintain a single pinned message in the chat that always shows
 * the current default workspace. Edits an existing pin in place if possible;
 * sends + pins a new one only if the prior message was deleted by the user.
 * Fire-and-forget — never blocks the calling handler.
 */
const PIN_FILE: string = path.join(os.homedir(), '.telecc/src/data/pinned-message.json');
async function updatePinnedWorkspace(): Promise<void> {
  try {
    const ws = getDefaultWorkspace();
    const text = ws
      ? `📌 Current: *${escapeMarkdown(ws)}*`
      : `📌 _No default workspace_ — use \`/use <name>\``;
    let pinId: number | null = null;
    try {
      pinId = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')).message_id;
    } catch { /* file may not exist */ }
    if (pinId) {
      try {
        await telegramAPI('editMessageText', {
          chat_id: CHAT_ID,
          message_id: pinId,
          text,
          parse_mode: 'Markdown',
        });
        return;
      } catch { /* deleted or otherwise unavailable — fall through */ }
    }
    const msg = await telegramAPI('sendMessage', {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_notification: true,
    }) as { message_id: number };
    try {
      await telegramAPI('pinChatMessage', {
        chat_id: CHAT_ID,
        message_id: msg.message_id,
        disable_notification: true,
      });
    } catch { /* permission or rate limit — pin will fail gracefully */ }
    try {
      fs.mkdirSync(path.dirname(PIN_FILE), { recursive: true });
    } catch { /* swallow */ }
    fs.writeFileSync(PIN_FILE, JSON.stringify({ message_id: msg.message_id }));
  } catch (e) {
    logger.error(`updatePinnedWorkspace failed: ${(e as Error).message}`);
  }
}

const TYPING_SIGNAL_PATH: string = path.join(PROJECT_ROOT, 'src/data', 'typing-active');

function startTypingIndicator(): void {
  stopTypingIndicator();
  try { fs.writeFileSync(TYPING_SIGNAL_PATH, String(Date.now())); } catch {}
  const tick = (): void => {
    if (!fs.existsSync(TYPING_SIGNAL_PATH)) {
      stopTypingIndicator();
      return;
    }
    telegramAPI('sendChatAction', { chat_id: CHAT_ID, action: 'typing' }).catch(() => {});
  };
  tick();
  const intervalId: NodeJS.Timeout = setInterval(tick, 4500);
  const timeoutId: NodeJS.Timeout = setTimeout(() => stopTypingIndicator(), 5 * 60 * 1000);
  activeTypingIntervals.set('_active', { intervalId, timeoutId });
}

function stopTypingIndicator(): void {
  const entry = activeTypingIntervals.get('_active');
  if (entry) {
    clearInterval(entry.intervalId);
    clearTimeout(entry.timeoutId);
    activeTypingIntervals.delete('_active');
  }
  try { fs.unlinkSync(TYPING_SIGNAL_PATH); } catch {}
}

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'new',      description: 'Start Claude in a project directory' },
  { command: 'resume',   description: 'Resume a past Claude conversation' },
  { command: 'link',     description: 'Generate deep link to open Claude' },
  { command: 'sessions', description: 'List all active Claude sessions' },
  { command: 'clear', description: 'Remove dead/completed sessions (use "/clear all" to wipe)' },
  { command: 'use',      description: 'Set or show default workspace' },
  { command: 'status',   description: 'Show current session output' },
  { command: 'stop',     description: 'Interrupt the running prompt' },
  { command: 'compact',  description: 'Compact context in the current session' },
  { command: 'effort',   description: 'Set thinking effort (low/medium/high)' },
  { command: 'model',    description: 'Switch Claude model (sonnet/opus/haiku)' },
  { command: 'help',     description: 'Show available commands' },
];

/** The bot's own commands (plus unlisted ones) \u2014 never forwarded to Claude. */
const BOT_COMMAND_NAMES: Set<string> = new Set([...BOT_COMMANDS.map(c => c.command), 'start', 'cmd']);

async function registerBotCommands(attempt = 1): Promise<void> {
  const commands = BOT_COMMANDS;
  try {
    // Set for both scopes: all_private_chats takes priority over default in private chats.
    // If all_private_chats was ever set (e.g. via BotFather), default scope is blocked.
    await telegramAPI('setMyCommands', { commands, scope: { type: 'all_private_chats' } });
    await telegramAPI('setMyCommands', { commands, scope: { type: 'default' } });
    logger.info('Bot commands registered with Telegram');
    // Fork patch: refresh the pinned-workspace message on every startup
    updatePinnedWorkspace().catch(() => {});
  } catch (err: unknown) {
    // Startup often races the network (login/wake before Wi-Fi is up) — retry in the
    // background with backoff instead of leaving the "/" menu and pinned message stale.
    const delayMs = Math.min(5000 * 2 ** (attempt - 1), 5 * 60 * 1000);
    logger.error(`Failed to register bot commands (attempt ${attempt}, retrying in ${delayMs / 1000}s): ${(err as Error).message}`);
    setTimeout(() => { registerBotCommands(attempt + 1).catch(() => {}); }, delayMs);
  }
}

/**
 * Fire-and-forget: the toast is cosmetic, and Telegram rejects answers to queries
 * older than ~15 s ("query is too old") — that must never cancel the action itself.
 */
function answerCallbackQuery(callbackQueryId: string, text?: string): void {
  telegramAPI('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '',
  }).catch((err: unknown) => {
    logger.warn(`answerCallbackQuery failed: ${(err as Error).message}`);
  });
}

function editMessageHtml(chatId: string, messageId: number, html: string, replyMarkup?: InlineKeyboardMarkup): Promise<unknown> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramAPI('editMessageText', body);
}

/** Replace only the inline keyboard — the message text and its formatting stay untouched. */
function editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup: InlineKeyboardMarkup): Promise<unknown> {
  return telegramAPI('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

// ── Message-edit helpers (pure) ─────────────────────────────────

/** Subset of Telegram's MessageEntity used to rebuild formatting. Offsets are UTF-16 units. */
export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

const SIMPLE_ENTITY_TAGS: Record<string, [string, string]> = {
  bold: ['<b>', '</b>'],
  italic: ['<i>', '</i>'],
  underline: ['<u>', '</u>'],
  strikethrough: ['<s>', '</s>'],
  spoiler: ['<tg-spoiler>', '</tg-spoiler>'],
  code: ['<code>', '</code>'],
  blockquote: ['<blockquote>', '</blockquote>'],
};

function entityTags(e: MessageEntity): [string, string] | null {
  if (e.type === 'pre') {
    return e.language
      ? [`<pre><code class="language-${escapeHtmlAttr(e.language)}">`, '</code></pre>']
      : ['<pre>', '</pre>'];
  }
  if (e.type === 'text_link' && e.url) return [`<a href="${escapeHtmlAttr(e.url)}">`, '</a>'];
  return SIMPLE_ENTITY_TAGS[e.type] ?? null;
}

/**
 * Convert a received message's plain `text` + `entities` back into Telegram HTML.
 * `query.message.text` has its Markdown already stripped, so re-sending it with
 * parse_mode Markdown mangles it (or fails on a stray `_`/`*`). Entity types without
 * an HTML form (url, mention, hashtag, ...) are auto-detected and emitted as text.
 */
export function entitiesToHtml(text: string, entities: MessageEntity[] = []): string {
  const opens = new Map<number, string[]>();
  const closes = new Map<number, string[]>();
  const usable = entities
    .filter(e => e.length > 0 && e.offset >= 0 && e.offset + e.length <= text.length)
    .map(e => ({ e, tags: entityTags(e) }))
    .filter((x): x is { e: MessageEntity; tags: [string, string] } => x.tags !== null)
    // Outer entities first: earlier start, then longer span
    .sort((a, b) => a.e.offset - b.e.offset || b.e.length - a.e.length);
  for (const { e, tags } of usable) {
    const end = e.offset + e.length;
    if (!opens.has(e.offset)) opens.set(e.offset, []);
    if (!closes.has(end)) closes.set(end, []);
    opens.get(e.offset)!.push(tags[0]);
    closes.get(end)!.unshift(tags[1]); // inner entities close first
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    const c = closes.get(i);
    if (c) out += c.join('');
    if (i === text.length) break;
    const o = opens.get(i);
    if (o) out += o.join('');
    out += escapeHtml(text[i]);
  }
  return out;
}

/** Number of characters Telegram counts for an HTML string (tags removed, entities decoded). */
export function htmlVisibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|amp|quot|#39);/g, '_').length;
}

/**
 * HTML for editing a clicked message: the original text with its formatting restored,
 * followed by `suffixHtml`. The original is truncated (with "…") so the result stays
 * within Telegram's 4096-character limit.
 */
export function buildEditHtml(
  text: string,
  entities: MessageEntity[] | undefined,
  suffixHtml: string,
  maxLen: number = TELEGRAM_MAX_TEXT,
): string {
  let body = text;
  let ents = entities ?? [];
  const budget = maxLen - htmlVisibleLength(suffixHtml);
  if (body.length > budget) {
    let cut = Math.max(0, budget - 1);
    const code = body.charCodeAt(cut - 1);
    if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut--; // don't split a surrogate pair
    body = body.slice(0, cut) + '\u2026';
    ents = ents
      .filter(e => e.offset < cut)
      .map(e => ({ ...e, length: Math.min(e.length, cut - e.offset) }));
  }
  return entitiesToHtml(body, ents) + suffixHtml;
}

/** Strip tags and decode the entities escapeHtml produces — for plain-text fallbacks. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Keep the last `maxChars` of `text`, preferring to cut at a line boundary. */
export function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return '\u2026';
  let tail = text.slice(text.length - (maxChars - 1));
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < tail.length - 1 && nl < maxChars / 2) tail = tail.slice(nl + 1);
  return '\u2026' + tail;
}

// ── Short callback keys for menu buttons ────────────────────────
//
// Telegram rejects a whole message if any button's callback_data exceeds 64 bytes,
// which `new:<name>` / `rs:<name>:<idx>` hit easily with long (or CJK, 3 bytes/char)
// project names. Menu buttons now carry a fixed-size key that maps to the full
// payload; the map is cached in memory and persisted so buttons survive restarts.

export type MenuKind = 'new' | 'rp' | 'rs' | 'rc' | 'rpall';

export interface MenuPayload {
  name: string;
  path?: string;
  sessionId?: string;
}

interface MenuKeyEntry extends MenuPayload {
  at: number;
}

const MENU_KEYS_PATH: string = path.join(PROJECT_ROOT, 'src/data', 'menu-keys.json');
const MENU_KEYS_MAX = 1000;
const MENU_EXPIRED = 'Menu expired \u2014 run the command again';
let menuKeys: Record<string, MenuKeyEntry> | null = null;

/** Deterministic 10-hex-char key for a payload (same item → same key). */
export function menuKeyFor(payload: MenuPayload): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([payload.name, payload.path ?? '', payload.sessionId ?? '']))
    .digest('hex')
    .slice(0, 10);
}

/** `<kind>:#<key>` — at most 15 bytes regardless of the project name. */
export function encodeMenuCallback(kind: MenuKind, key: string): string {
  return `${kind}:#${key}`;
}

export function parseMenuCallback(data: string): { kind: MenuKind; key: string } | null {
  const m = /^(new|rp|rs|rc|rpall):#([0-9a-f]{10})$/.exec(data);
  return m ? { kind: m[1] as MenuKind, key: m[2] } : null;
}

function loadMenuKeys(): Record<string, MenuKeyEntry> {
  if (!menuKeys) {
    try { menuKeys = readJsonSafe<Record<string, MenuKeyEntry>>(MENU_KEYS_PATH, {}); }
    catch { menuKeys = {}; }
  }
  return menuKeys;
}

/** Store payloads and return their keys (one disk write per menu). */
function registerMenuPayloads(payloads: MenuPayload[]): string[] {
  const store = loadMenuKeys();
  const now = Date.now();
  const keys = payloads.map((p) => {
    const key = menuKeyFor(p);
    store[key] = { ...p, at: now };
    return key;
  });
  const entries = Object.entries(store);
  if (entries.length > MENU_KEYS_MAX) {
    entries.sort((a, b) => b[1].at - a[1].at);
    menuKeys = Object.fromEntries(entries.slice(0, MENU_KEYS_MAX));
  }
  try { writeJsonAtomic(MENU_KEYS_PATH, menuKeys); }
  catch (err: unknown) { logger.warn(`Failed to persist menu keys: ${(err as Error).message}`); }
  return keys;
}

function menuButton(kind: MenuKind, text: string, payload: MenuPayload): { text: string; callback_data: string } {
  const [key] = registerMenuPayloads([payload]);
  return { text, callback_data: encodeMenuCallback(kind, key) };
}

function menuButtons(kind: MenuKind, items: Array<{ text: string; payload: MenuPayload }>): Array<{ text: string; callback_data: string }> {
  const keys = registerMenuPayloads(items.map(i => i.payload));
  return items.map((item, i) => ({ text: item.text, callback_data: encodeMenuCallback(kind, keys[i]) }));
}

function lookupMenuKey(key: string): MenuKeyEntry | null {
  return loadMenuKeys()[key] ?? null;
}

// ── Command handlers ────────────────────────────────────────────

/**
 * Helper to resolve workspace from arg or default.
 * Returns the resolved result with workspace and session.
 * The stored default is a full name — never prefix-match it (if that workspace is
 * gone, `api` must not silently route to `api-server`).
 */
function resolveDefaultWorkspace(): ResolveResult {
  const defaultWs = getDefaultWorkspace();
  if (!defaultWs) {
    return { type: 'none' };
  }
  return resolveWorkspace(defaultWs, { allowPrefix: false });
}

/**
 * Resolve a workspace for a command: an explicit name typed by the user may
 * prefix-match; without one, use the default workspace (exact only).
 */
function resolveArgOrDefault(workspaceArg: string | null): ResolveResult {
  return workspaceArg ? resolveWorkspace(workspaceArg) : resolveDefaultWorkspace();
}

async function handleHelp(): Promise<void> {
  const defaultWs: string | null = getDefaultWorkspace();
  const msg: string = [
    '*Claude Remote Control*',
    '',
    '`/<workspace> <command>` — Send command to workspace',
    '`/use <workspace>` — Set default workspace',
    '`/use` — Show current default',
    '`/use clear` — Clear default',
    '`/compact [workspace]` — Compact context in workspace',
    '`/new [project]` — Start Claude in a project (shows recent if no arg)',
    '`/resume [project]` — Switch conversation (current project; tap *Other projects* to switch project)',
    '`/link <prompt>` — Generate deep link to open Claude',
    '`/effort [workspace] low|medium|high` — Set thinking effort',
    '`/model [workspace] <model>` — Switch Claude model',
    '`/sessions` — List sessions (\u{1F4BB} = Claude desktop app / plain terminal: read-only here, /resume to continue)',
    '`/status [workspace]` — Show tmux output',
    '`/stop [workspace]` — Interrupt running prompt',
    '`/cmd <TOKEN> <command>` — Token-based fallback',
    '`/help` — This message',
    '',
    '_Prefix matching:_ `/ass hello` matches `assistant`',
    '_Reply-to:_ Reply to any notification to route to that workspace',
    defaultWs ? `_Default:_ plain text routes to *${escapeMarkdown(defaultWs)}*` : '_Tip:_ Use `/use <workspace>` to send plain text without a prefix',
  ].join('\n');

  await sendMessage(msg);
}

async function handleLink(prompt: string): Promise<void> {
  if (!prompt) {
    await sendMessage('Usage: `/link <prompt>`\n\nGenerates a clickable link that opens Claude Code with your prompt.');
    return;
  }

  if (!canGenerateDeepLink(prompt)) {
    await sendMessage('\u26a0\ufe0f Prompt too long for deep link (max ~4500 characters).');
    return;
  }

  const deepLink = generateDeepLink(prompt);
  if (!deepLink) {
    await sendMessage('\u26a0\ufe0f Failed to generate deep link.');
    return;
  }

  // Send the deep link as a clickable button
  const keyboard = {
    inline_keyboard: [[
      { text: '\ud83d\udcbb Open in Claude Code', url: deepLink },
    ]],
  };

  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: `*Deep Link Generated*\n\n_Tap the button to open Claude Code with:_\n\`${escapeMarkdown(prompt.slice(0, 100))}${prompt.length > 100 ? '...' : ''}\``,
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

/**
 * /effort [workspace] low|medium|high — Set Claude's thinking effort level
 */
async function handleEffort(args: string): Promise<void> {
  const validLevels = ['low', 'medium', 'high'];

  if (!args) {
    await sendMessage('Usage: `/effort [workspace] low|medium|high`\n\nSet Claude\'s thinking effort level.');
    return;
  }

  const parts = args.split(/\s+/);
  let workspaceArg: string | null = null;
  let level: string;

  // Check if first arg is a valid level or a workspace
  if (validLevels.includes(parts[0].toLowerCase())) {
    level = parts[0].toLowerCase();
  } else if (parts.length >= 2 && validLevels.includes(parts[1].toLowerCase())) {
    workspaceArg = parts[0];
    level = parts[1].toLowerCase();
  } else {
    await sendMessage(`Invalid effort level. Use: \`low\`, \`medium\`, or \`high\``);
    return;
  }

  // Resolve workspace
  const resolved = workspaceArg ? resolveWorkspace(workspaceArg) : resolveDefaultWorkspace();
  if (resolved.type === 'none') {
    await sendMessage(workspaceArg
      ? `No session found for workspace \`${escapeMarkdown(workspaceArg)}\``
      : 'No default workspace set. Use `/use <workspace>` first.');
    return;
  }
  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const session = resolved.match!.session;
  const workspace = resolved.workspace;
  const slashCommand = `/effort ${level}`;

  const injected = await injectAndRespond(session, slashCommand, workspace, { markRemote: false });
  if (injected) {
    startTypingIndicator();
    await sendMessage(`\u2699\ufe0f Effort set to *${level}* in *${escapeMarkdown(workspace)}*`);
  }
}

/**
 * /model [workspace] <model> — Switch Claude model
 */
async function handleModel(args: string): Promise<void> {
  if (!args) {
    await sendMessage('Usage: `/model [workspace] <model>`\n\nSwitch Claude model (e.g., `sonnet`, `opus`, `haiku`).');
    return;
  }

  const parts = args.split(/\s+/);
  let workspaceArg: string | null = null;
  let model: string;

  // If 2+ parts, first might be workspace
  if (parts.length >= 2) {
    // Try to resolve first part as workspace
    const maybeWs = resolveWorkspace(parts[0]);
    if (maybeWs.type === 'exact' || maybeWs.type === 'prefix') {
      workspaceArg = parts[0];
      model = parts.slice(1).join(' ');
    } else {
      model = parts.join(' ');
    }
  } else {
    model = parts[0];
  }

  // Resolve workspace
  const resolved = workspaceArg ? resolveWorkspace(workspaceArg) : resolveDefaultWorkspace();
  if (resolved.type === 'none') {
    await sendMessage(workspaceArg
      ? `No session found for workspace \`${escapeMarkdown(workspaceArg)}\``
      : 'No default workspace set. Use `/use <workspace>` first.');
    return;
  }
  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const session = resolved.match!.session;
  const workspace = resolved.workspace;
  const slashCommand = `/model ${model}`;

  const injected = await injectAndRespond(session, slashCommand, workspace, { markRemote: false });
  if (injected) {
    startTypingIndicator();
    await sendMessage(`\ud83e\udde0 Model switched to *${escapeMarkdown(model)}* in *${escapeMarkdown(workspace)}*`);
  }
}

/**
 * Fork patch: /clear command — prune dead session-map entries.
 * - tmuxDead: tmux session listed in map but `tmux ls` doesn't show it
 * - ghosttyDead: ghostty session in map but no Ghostty tab has that cwd
 * - completedAndDead: status starts with "completed" AND no live pane backs it
 *   (completed alone is NOT a removal signal — a finished prompt in a still
 *   attached pane is a healthy idle session)
 * - ended: a SessionEnd hook recorded that Claude exited (endedAt)
 * If tmux or Ghostty can't be queried, entries of that kind are kept.
 * `/clear all` removes every entry regardless.
 */
async function handleClear(removeAll: boolean): Promise<void> {
  // Liveness queries first (async, with timeouts). A null set means "couldn't tell" —
  // sessions of that kind are then kept rather than all being treated as dead.
  const liveTmux: Set<string> | null = await queryLiveTmuxSessions();
  const liveGhosttyCwds: Set<string> | null = await queryLiveGhosttyCwds();

  const removed: string[] = [];
  const remaining = updateSessionMap((map) => {
    const kept: typeof map = {};
    for (const [token, s] of Object.entries(map)) {
      const isTmux = isTmuxEntry(s);
      const isGhostty = isGhosttyEntry(s);
      // External (desktop app) sessions have no liveness probe: only prune them once ended
      const isExternal = isExternalEntry(s);
      const tmuxDead = isTmux && !!s.tmuxSession && liveTmux !== null && !liveTmux.has(s.tmuxSession);
      const ghosttyDead = isGhostty && !!s.cwd && liveGhosttyCwds !== null && !liveGhosttyCwds.has(normalizeDir(s.cwd));
      const completedAndDead =
        !isExternal &&
        (s.description || '').startsWith('completed') &&
        (!isTmux || tmuxDead) &&
        (!isGhostty || ghosttyDead);
      const ended = !!s.endedAt;
      const shouldRemove = removeAll || tmuxDead || ghosttyDead || completedAndDead || ended;
      if (shouldRemove) {
        const ws = s.cwd ? path.basename(s.cwd) : 'unknown';
        const reason = tmuxDead
          ? 'dead tmux'
          : ghosttyDead
          ? 'dead ghostty tab'
          : completedAndDead
          ? 'completed+dead'
          : ended
          ? 'ended'
          : 'forced';
        removed.push(`<b>${escapeHtml(ws)}</b> (${reason})`);
      } else {
        kept[token] = s;
      }
    }
    return kept;
  });
  const notes: string[] = [];
  if (liveTmux === null) notes.push('tmux');
  if (liveGhosttyCwds === null) notes.push('Ghostty');
  const note = notes.length && !removeAll
    ? `\n\n<i>Could not query ${notes.join(' / ')} \u2014 those sessions were kept.</i>`
    : '';
  const msg = removed.length
    ? `Removed ${removed.length} session(s):\n${removed.map(r => `  • ${r}`).join('\n')}\n\nRemaining: ${Object.keys(remaining).length}${note}`
    : `No sessions to clear.${note}`;
  await sendHtmlMessage(msg);
}

function normalizeDir(p: string): string {
  return path.resolve(p.trim());
}

/** execFile with a timeout, resolving stdout. Never goes through a shell. */
function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || '').trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** Live tmux session names; empty when no server is running; null when tmux couldn't be queried. */
async function queryLiveTmuxSessions(): Promise<Set<string> | null> {
  if (!TMUX_AVAILABLE) return null;
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (/no server running|error connecting to|no sessions/i.test(msg)) return new Set();
    logger.warn(`tmux list-sessions failed: ${msg}`);
    return null;
  }
}

/**
 * Working directories of all Ghostty terminals; empty when Ghostty isn't running;
 * null when the AppleScript query failed (timeout, automation permission denied...).
 */
async function queryLiveGhosttyCwds(): Promise<Set<string> | null> {
  if (process.platform !== 'darwin') return new Set();
  try {
    const running = (await execFileText('osascript', ['-e', 'application "Ghostty" is running'], 5000)).trim();
    if (running !== 'true') return new Set();
    // One path per line — paths may legitimately contain commas.
    const script = [
      'tell application "Ghostty"',
      '  set out to ""',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with term in terminals of t',
      '        set out to out & (working directory of term) & linefeed',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      '  return out',
      'end tell',
    ].join('\n');
    const out = await execFileText('osascript', ['-e', script], 10000);
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean).map(normalizeDir));
  } catch (err: unknown) {
    logger.warn(`Ghostty cwd query failed: ${(err as Error).message}`);
    return null;
  }
}

async function handleSessions(): Promise<void> {
  pruneExpired();
  const sessions = listActiveSessions();

  if (sessions.length === 0) {
    await sendMessage('No active sessions.');
    return;
  }

  const lines: string[] = sessions.map((s) => {
    const icon: string = sessionIcon(s);
    return `${icon} *${escapeMarkdown(s.workspace)}* (${s.age})`;
  });

  let footer = '';
  if (sessions.some(s => isExternalEntry(s.session))) {
    footer += '\n\n\u{1F4BB} _= Claude desktop app / plain terminal: Telegram can\'t type into it. Use /resume to continue it here._';
  }
  const defaultWs: string | null = getDefaultWorkspace();
  if (defaultWs) {
    footer += `\n\n_Default workspace:_ *${escapeMarkdown(defaultWs)}*`;
  }

  await sendMessage(`*Active Sessions*\n\n${lines.join('\n')}${footer}`);
}

async function handleStatus(workspaceArg: string | null): Promise<void> {
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs: string | null = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/status <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved: ResolveResult = resolveArgOrDefault(workspaceArg);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const match = resolved.match;
  const resolvedName: string = resolved.workspace;
  const tmuxName: string = match.session.tmuxSession;
  const session = match.session;

  // Read transcript status (model, context, branch, last message, ...).
  // Available for any terminal type — Ghostty, tmux, PTY, bare.
  const transcript: TranscriptStatus | null = readTranscriptStatus(session.cwd, session.sessionId ?? undefined);

  // For tmux/PTY, capture the pane output as before.
  // For Ghostty (where scrollback capture doesn't work via AppleScript),
  // skip the pane capture and rely on the transcript's last assistant message.
  const useGhostty = (isGhosttySession(session) || ghosttySessionManager.has(tmuxName));
  let paneOutput: string | null = null;
  if (!useGhostty && !isExternalEntry(session)) {
    try {
      const raw = await sessionCaptureOutput(tmuxName, session);
      paneOutput = raw.trim().split('\n').slice(-20).join('\n');
    } catch (err: unknown) {
      paneOutput = `(capture failed: ${(err as Error).message})`;
    }
  }

  const htmlMsg = buildStatusMessage(resolvedName, session, transcript, paneOutput);
  try {
    await sendHtmlMessage(htmlMsg);
  } catch {
    // Fallback: strip HTML tags, decode entities and send as plain text.
    const plain = htmlToPlain(htmlMsg).slice(0, TELEGRAM_MAX_TEXT);
    await telegramAPI('sendMessage', { chat_id: CHAT_ID, text: plain });
  }
}

/** Format the rich /status message as HTML for Telegram (≤ 4096 visible chars). */
function buildStatusMessage(
  workspace: string,
  session: SessionEntry,
  transcript: TranscriptStatus | null,
  paneOutput: string | null
): string {
  const lines: string[] = [];
  lines.push(`\u{1F4CA} <b>${escapeHtml(workspace)}</b>`);
  if (isExternalEntry(session)) {
    lines.push('\u{1F4BB} <i>Runs in the Claude desktop app / a plain terminal \u2014 read-only from Telegram. Use /resume to continue it here.</i>');
  }

  // Model + version
  if (transcript?.model) {
    const versionStr = transcript.version ? ` <i>(cc ${escapeHtml(transcript.version)})</i>` : '';
    lines.push(`\u{1F916} <b>Model:</b> <code>${escapeHtml(transcript.model)}</code>${versionStr}`);
  }

  // Working directory
  const cwd = transcript?.cwd || session.cwd;
  if (cwd) lines.push(`\u{1F4C1} <b>Path:</b> <code>${escapeHtml(cwd)}</code>`);

  // Git branch
  if (transcript?.gitBranch) {
    lines.push(`\u{1F33F} <b>Branch:</b> <code>${escapeHtml(transcript.gitBranch)}</code>`);
  }

  // Session
  if (transcript?.sessionId || session.sessionId) {
    const sid = (transcript?.sessionId || session.sessionId)!;
    const slugStr = transcript?.slug ? ` <i>(${escapeHtml(transcript.slug)})</i>` : '';
    lines.push(`\u{1F194} <b>Session:</b> <code>${escapeHtml(sid.slice(0, 8))}</code>${slugStr}`);
  }

  // Context window usage
  if (transcript?.contextTokens !== undefined) {
    const tokensStr = transcript.contextTokens.toLocaleString();
    if (transcript.contextLimit && transcript.contextPct !== undefined) {
      const limitStr = transcript.contextLimit.toLocaleString();
      lines.push(`\u{1F4C8} <b>Context:</b> ${tokensStr} / ${limitStr} (${transcript.contextPct}%)`);
    } else {
      lines.push(`\u{1F4C8} <b>Context:</b> ${tokensStr} tokens`);
    }
  }

  // Last activity
  if (transcript?.lastAssistantTimestamp) {
    const ago = formatRelativeTime(new Date(transcript.lastAssistantTimestamp));
    if (ago) lines.push(`\u23F1 <b>Last activity:</b> ${ago}`);
  }

  // Rate limit
  const rateLimit = getSessionRateLimit(workspace);
  if (rateLimit && rateLimit.remaining !== undefined) {
    const pct = rateLimit.limit ? Math.round((rateLimit.remaining / rateLimit.limit) * 100) : null;
    const pctStr = pct !== null ? ` (${pct}%)` : '';
    let resetStr = '';
    if (rateLimit.resetsAt) {
      const resetMs = rateLimit.resetsAt * 1000 - Date.now();
      if (resetMs > 0) {
        const mins = Math.ceil(resetMs / 60000);
        resetStr = mins > 60 ? ` \u2022 resets in ${Math.round(mins / 60)}h` : ` \u2022 resets in ${mins}m`;
      }
    }
    lines.push(`\u{1F4E1} <b>Rate limit:</b> ${rateLimit.remaining}/${rateLimit.limit || '?'}${pctStr}${resetStr}`);
  }

  // Last assistant message (Ghostty only — for tmux/PTY we show pane output instead)
  if (paneOutput === null && transcript?.lastAssistantMessage) {
    lines.push('');
    lines.push('\u{1F4AC} <b>Last message:</b>');
    lines.push(`<pre>${escapeHtml(transcript.lastAssistantMessage)}</pre>`);
  }

  // Pane output for tmux/PTY — gets whatever room is left under the 4096 limit
  if (paneOutput !== null) {
    lines.push('');
    lines.push('\u{1F4DD} <b>Recent output:</b>');
    const used = htmlVisibleLength(lines.join('\n')) + 1; // + newline before <pre>
    const room = Math.max(0, TELEGRAM_MAX_TEXT - used - 16);
    lines.push(`<pre>${escapeHtml(tailText(paneOutput, room) || ' ')}</pre>`);
  }

  // Fallback when we have nothing
  if (!transcript && paneOutput === null) {
    lines.push('');
    lines.push('<i>No transcript or pane output available.</i>');
  }

  return lines.join('\n');
}

/** Format a Date as "Xs ago" / "Xm ago" / "Xh ago" relative to now. */
function formatRelativeTime(d: Date): string | null {
  const ms = Date.now() - d.getTime();
  if (ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

async function handleStop(workspaceArg: string | null): Promise<void> {
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs: string | null = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/stop <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved: ResolveResult = resolveArgOrDefault(workspaceArg);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const resolvedName: string = resolved.workspace;
  const tmuxName: string = resolved.match.session.tmuxSession;

  if (isExternalEntry(resolved.match.session)) {
    await sendExternalSessionNotice(resolvedName, resolved.match.session);
    return;
  }

  if (!await sessionExists(tmuxName, resolved.match.session)) {
    await sendMessage(`Session *${escapeMarkdown(tmuxName)}* not found.`);
    return;
  }

  try {
    await sessionInterrupt(tmuxName, resolved.match.session);
    await sendMessage(`\u26d4 Sent interrupt to *${escapeMarkdown(resolvedName)}*`);
  } catch (err: unknown) {
    await sendMessage(`\u274c Failed to interrupt: ${(err as Error).message}`);
  }
}

async function handleCmd(token: string, command: string): Promise<void> {
  const map = readSessionMap();
  const session: SessionEntry | undefined = map[token];

  if (!session) {
    await sendMessage(`No session found for token \`${token}\`.`);
    return;
  }

  if (isExpired(session)) {
    await sendMessage(`Session \`${token}\` has expired.`);
    return;
  }

  await injectAndRespond(session, command, extractWorkspaceName(session.cwd) as string);
}

/**
 * Route `command` to `workspace`. `allowPrefix` only when the user typed the name
 * themselves (`/name text`); default-workspace and reply-to routing must be exact.
 */
async function handleWorkspaceCommand(workspace: string, command: string, allowPrefix: boolean = true): Promise<void> {
  const resolved: ResolveResult = resolveWorkspace(workspace, { allowPrefix });

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  logger.info(`Routing to ${resolved.workspace} [${resolved.match.session.sessionType ?? 'legacy'}:${resolved.match.session.tmuxSession}]`);
  await injectAndRespond(resolved.match.session, command, resolved.workspace);
}

async function handleUse(arg: string | null): Promise<void> {
  // /use — show current default
  if (!arg) {
    const current: string | null = getDefaultWorkspace();
    if (current) {
      await sendMessage(`Default workspace: *${escapeMarkdown(current)}*\n\nPlain text messages will route here. Use \`/use clear\` to unset.`);
    } else {
      await sendMessage('No default workspace set. Use `/use <workspace>` to set one.');
    }
    return;
  }

  // /use clear | /use none — clear default
  if (arg === 'clear' || arg === 'none') {
    setDefaultWorkspace(null); updatePinnedWorkspace().catch(() => {});
    await sendMessage('Default workspace cleared.');
    return;
  }

  // /use <workspace> — resolve and set
  const resolved: ResolveResult = resolveWorkspace(arg);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(arg)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const fullName: string = resolved.workspace;
  setDefaultWorkspace(fullName); updatePinnedWorkspace().catch(() => {});
  await sendMessage(`Default workspace set to *${escapeMarkdown(fullName)}*. Plain text messages will route here.`);
}

async function handleCompact(workspaceArg: string | null): Promise<void> {
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs: string | null = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/compact <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved: ResolveResult = resolveArgOrDefault(workspaceArg);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const tmuxName: string = resolved.match.session.tmuxSession;
  const compactSession = resolved.match.session;

  // Inject /compact into tmux
  const injected: boolean = await injectAndRespond(resolved.match.session, '/compact', resolved.workspace, { markRemote: false });
  if (!injected) return;

  // Watching for completion takes up to ~70 s — run it detached so later messages
  // aren't queued behind it.
  watchCompact(resolved.workspace, tmuxName, compactSession).catch((err: unknown) => {
    logger.error(`watchCompact failed: ${(err as Error).message}`);
  });
}

async function watchCompact(workspace: string, tmuxName: string, compactSession: SessionEntry): Promise<void> {
  const report = async (header: string, output: string, tailLines: number): Promise<void> => {
    const lines: string = output.trim().split('\n').slice(-tailLines).join('\n');
    await sendHtmlMessage(`${header}\n<pre>${escapeHtml(tailText(lines, 3500) || ' ')}</pre>`);
  };
  const ws = `<b>${escapeHtml(workspace)}</b>`;

  // Two-phase polling to detect compact completion:
  // Phase 1: Wait for "Compacting" to appear (command started processing)
  // Phase 2: Wait for "Compacting" to disappear (command finished)

  let started = false;

  // Phase 1: Wait up to 10s for compact to start
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    try {
      const output: string = await sessionCaptureOutput(tmuxName, compactSession);
      if (output.includes('Compacting')) {
        started = true;
        break;
      }
    } catch {
      break;
    }
  }

  if (!started) {
    // Command may have finished very quickly or failed to start
    try {
      const output: string = await sessionCaptureOutput(tmuxName, compactSession);
      if (output.includes('Compacted')) {
        await report(`\u2705 ${ws} compact done:`, output, 10);
      }
    } catch {
      // ignore
    }
    return;
  }

  // Phase 2: Wait up to 60s for "Compacting" to disappear (compact finished)
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const output: string = await sessionCaptureOutput(tmuxName, compactSession);
      if (!output.includes('Compacting')) {
        await report(`\u2705 ${ws} compact done:`, output, 10);
        return;
      }
    } catch {
      break;
    }
  }

  // Timeout — show current session state
  try {
    const output: string = await sessionCaptureOutput(tmuxName, compactSession);
    await report(`\u23f3 ${ws} compact may still be running:`, output, 5);
  } catch {
    // ignore
  }
}

async function handleNew(nameArg: string | null): Promise<void> {
  if (!nameArg) {
    const recent = getRecentProjects(50);
    if (recent.length === 0) {
      const home: string = process.env.HOME as string;
      const dirs = process.env.PROJECT_DIRS
        ? process.env.PROJECT_DIRS.split(',').map(d => d.trim().replace(home, '~')).join(', ')
        : '~/projects, ~/tools';
      await sendMessage(`No project history yet.\n\nUse \`/new <project-name>\` to start.\nSearches: ${dirs}, ~/`);
      return;
    }
    const buttons = menuButtons('new', recent.map(p => ({ text: p.name, payload: { name: p.name, path: p.path } })));
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
    }
    await telegramAPI('sendMessage', {
      chat_id: CHAT_ID,
      text: '*Start Claude Session*\n\nSelect a project or use `/new <name>`:',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }
  await startProject(nameArg);
}

/**
 * Start Claude in a project. `knownDir` comes from a menu button that already
 * resolved the directory; otherwise `name` is looked up in the configured dirs.
 */
async function startProject(name: string, knownDir?: string): Promise<void> {
  const home: string = process.env.HOME as string;

  // 1. Find project directory — exact match first
  const configuredDirs = process.env.PROJECT_DIRS
    ? process.env.PROJECT_DIRS.split(',').map(d => d.trim()).filter(Boolean)
    : [path.join(home, 'projects'), path.join(home, 'tools')];
  const candidates: string[] = [
    ...(knownDir ? [knownDir] : []),
    ...configuredDirs.map(d => path.join(d, name)),
    path.join(home, name),
  ];
  let projectDir: string | null = null;
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) { projectDir = dir; break; } }
    catch {}
  }

  // 2. If no exact match, prefix match against configured dirs ONLY
  //    (skip ~/ to avoid matching Desktop, Documents, Downloads, Library, etc.)
  if (!projectDir) {
    const searchDirs: string[] = configuredDirs;
    const matches: Array<{ name: string; path: string }> = [];
    for (const base of searchDirs) {
      try {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && e.name.toLowerCase().startsWith(name.toLowerCase())) {
            matches.push({ name: e.name, path: path.join(base, e.name) });
          }
        }
      } catch {}
    }
    // Deduplicate by name (prefer ~/projects/ over ~/tools/)
    const unique = [...new Map(matches.map(m => [m.name, m])).values()];

    if (unique.length === 1) {
      projectDir = unique[0].path;
      name = unique[0].name;
    } else if (unique.length > 1) {
      // Show matches as inline buttons (max 10)
      const limited = unique.slice(0, 10);
      const buttons = menuButtons('new', limited.map(m => ({ text: m.name, payload: { name: m.name, path: m.path } })));
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
      await telegramAPI('sendMessage', {
        chat_id: CHAT_ID,
        text: `Multiple matches for *${escapeMarkdown(name)}*:`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }
  }

  if (!projectDir) {
    const searchedPaths = configuredDirs.map(d => d.replace(home, '~')).join(', ') + ', ~/';
    await sendMessage(`Project \`${escapeMarkdown(name)}\` not found.\n\nSearched: ${searchedPaths}`);
    return;
  }

  // 3. Sanitize tmux session name (dots, colons, spaces are invalid in tmux)
  const tmuxName: string = name.replace(/[.:\s]/g, '-');

  // 4. Check existing session (PTY, Ghostty, or tmux)
  const existingEntry = findTrackedSession(tmuxName);
  const alreadyRunning = existingEntry
    ? await sessionExists(tmuxName, existingEntry)
    : await sessionExists(tmuxName);
  if (alreadyRunning) {
    // The terminal is there, but Claude may have exited back to the shell
    let state: ClaudeTerminalState;
    try {
      state = await claudeTerminalState(tmuxName, existingEntry);
      if (state === 'shell') await launchInExistingTerminal(tmuxName, existingEntry, 'claude');
    } catch (err: unknown) {
      await sendMessage(`Failed to start Claude in \`${escapeMarkdown(tmuxName)}\`: ${escapeMarkdown((err as Error).message)}`);
      return;
    }
    if (state === 'busy') {
      await sendMessage(busyTerminalMessage(name));
      return;
    }
    // Only now is the session live again — upsert clears a recorded endedAt
    upsertSession({
      cwd: projectDir, tmuxSession: tmuxName, status: state === 'shell' ? 'starting' : 'waiting', sessionId: null,
      sessionType: existingEntry?.sessionType ?? (isPtySession(tmuxName) ? 'pty' : 'tmux'),
    });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});
    await sendMessage(state === 'shell'
      ? `Started Claude in the existing session \`${escapeMarkdown(tmuxName)}\`.\nSet as default — send messages directly.`
      : `Session \`${escapeMarkdown(tmuxName)}\` already running.\nSet as default — send messages directly.`);
    return;
  }

  // 5. Create session — Ghostty, PTY, or tmux
  const mode = getEffectiveMode();

  if (mode === 'tmux') {
    // tmux path: a login shell runs `claude`, so the user's PATH/rc apply and the
    // pane falls back to a shell (needed for the /resume switch) when Claude exits.
    try {
      await tmux(['new-session', '-d', '-s', tmuxName, '-c', projectDir]);
      await sleep(300);
      const target = paneTarget(tmuxName);
      await sendLiteral(target, 'claude');
      await sendKeys(target, 'Enter');
    } catch (err: unknown) {
      await sendMessage(`Failed to start session: ${(err as Error).message}`);
      return;
    }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null, sessionType: 'tmux' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Started Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'new-session');
    }
  } else if (mode === 'ghostty') {
    // Ghostty path — opens a new tab in the front Ghostty window
    const ok = await ghosttySessionManager.openNewTab(projectDir, 'claude');
    if (!ok) { await sendMessage('Failed to open Ghostty tab.'); return; }

    ghosttySessionManager.register(tmuxName, projectDir);
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null, sessionType: 'ghostty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Started Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Ghostty tab — visible in your Ghostty window._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'new-session');
    }
  } else if (mode === 'pty') {
    // PTY path — spawns 'claude' directly (no separate send-keys step)
    const ok = ptySessionManager.spawn(tmuxName, projectDir);
    if (!ok) { await sendMessage('Failed to spawn PTY session.'); return; }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null, sessionType: 'pty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Started Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Headless PTY mode — full Telegram control. Not attachable from terminal._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'new-session');
    }
  } else {
    await sendMessage(
      '\u26a0\ufe0f No injection backend available.\n' +
      'Install tmux, run Ghostty, or run: `npm install node-pty` in ~/.telecc/'
    );
  }
}

// ── Resume feature ───────────────────────────────────────────────

/** Format a Unix ms timestamp as a human-readable age (e.g. "2h ago"). */
function formatSessionAge(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 60000); // minutes
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

async function handleResume(nameArg: string | null): Promise<void> {
  if (nameArg) {
    await resumeProject(nameArg);
    return;
  }

  // Fork patch: when a default workspace is set, scope /resume to it.
  // Original behavior listed all projects with history, which mixed unrelated
  // projects together and made /resume after /new return wrong results.
  // To see all projects: /use clear, then /resume.
  const defaultWs = getDefaultWorkspace();
  if (defaultWs) {
    await resumeProject(defaultWs);
    return;
  }

  await showAllProjectsPicker();
}

/** `/resume` across every project with history: pick a project, then a conversation. */
async function showAllProjectsPicker(): Promise<void> {
  const allProjects = getRecentProjects(50);
  const projects = allProjects
    .map(p => ({ ...p, sessions: getClaudeSessionsForProject(p.path, 1) }))
    .filter(p => p.sessions.length > 0);

  if (projects.length === 0) {
    await sendMessage(
      'No sessions to resume.\n\nUse `/new` to start one — session IDs are saved automatically.'
    );
    return;
  }

  const buttons = menuButtons('rp', projects.map(p => ({
    text: `${p.name} \u2022 ${formatSessionAge(p.sessions[0].lastActivity)}`,
    payload: { name: p.name, path: p.path },
  })));
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }

  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: '*Resume Session*\n\nSelect a project:',
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Show the conversation picker for a project. `knownPath` comes from a menu button;
 * otherwise the project is looked up by name in the recent-projects list.
 */
async function resumeProject(projectName: string, knownPath?: string): Promise<void> {
  const project = knownPath
    ? { name: projectName, path: knownPath }
    : getRecentProjects(50).find(p => p.name === projectName);

  if (!project) {
    await sendMessage(
      `No project found for \`${escapeMarkdown(projectName)}\`.\n\nTry /resume to see available projects.`
    );
    return;
  }

  const sessions = getClaudeSessionsForProject(project.path, 5);

  if (sessions.length === 0) {
    await telegramAPI('sendMessage', {
      chat_id: CHAT_ID,
      text: `No conversations found for \`${escapeMarkdown(projectName)}\`.\n\nUse /new to start one, or pick another project:`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[otherProjectsButton()]] },
    });
    return;
  }

  // Always show picker — one session per row (full width for snippet).
  // Buttons carry the conversation's ID (via a short key), not its list position,
  // so a list that shifted since it was shown can't resume the wrong conversation.
  const buttons = menuButtons('rs', sessions.map(s => ({
    text: `${formatSessionAge(s.lastActivity)}${s.snippet ? ' \u2022 ' + s.snippet : ''}`,
    payload: { name: project.name, path: project.path, sessionId: s.id },
  })));
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = buttons.map(b => [b]);
  // The picker is scoped to one project — one tap to switch project instead of /use clear
  keyboard.push([otherProjectsButton()]);

  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: `*Resume: ${escapeMarkdown(projectName)}*\n\nChoose a conversation:`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}

function otherProjectsButton(): { text: string; callback_data: string } {
  return menuButton('rpall', '\u{1F4C2} Other projects', { name: '*' });
}

/**
 * The session lives in a terminal the bot can't type into (Claude desktop app, plain
 * Terminal.app, VS Code...). Explain, and offer to continue the same conversation in a
 * tmux session the bot owns.
 */
async function sendExternalSessionNotice(workspace: string, session: SessionEntry): Promise<void> {
  const name = path.basename(session.cwd) || workspace;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (session.sessionId && isValidSessionId(session.sessionId)) {
    rows.push([menuButton('rs', '\u25b6\ufe0f Continue this conversation here', { name, path: session.cwd, sessionId: session.sessionId })]);
  }
  rows.push([menuButton('rp', '\u{1F4C2} Pick another conversation', { name, path: session.cwd })]);
  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: `\u{1F4BB} *${escapeMarkdown(workspace)}* is running in the Claude desktop app (or a plain terminal), which Telegram can't type into.\n\n` +
      `To keep working from your phone, continue the conversation in a background session managed by the bot.\n\n` +
      `_Your desktop window won't show messages sent from here \u2014 don't type in both at once._`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

/** Claude Code session IDs are UUIDs; anything else must never be typed into a shell. */
function isValidSessionId(id: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/.test(id);
}

/** mtime (ms) of a conversation's transcript, or null if it no longer exists. */
function transcriptMtime(projectPath: string, sessionId: string): number | null {
  for (const dir of claudeProjectDirs(projectPath)) {
    try { return fs.statSync(path.join(dir, `${sessionId}.jsonl`)).mtimeMs; } catch {}
  }
  return null;
}

async function resumeSession(projectName: string, projectPath: string, sessionId: string, force: boolean = false): Promise<void> {
  if (!isValidSessionId(sessionId)) {
    await sendMessage('Session not found. Try /resume again.');
    return;
  }
  const lastActivity = transcriptMtime(projectPath, sessionId);
  if (lastActivity === null) {
    await sendMessage('That conversation no longer exists. Try /resume again.');
    return;
  }
  const project = { name: projectName, path: projectPath };
  const confirmButton = () => menuButton('rc', '\u25b6\ufe0f Resume anyway', { name: projectName, path: projectPath, sessionId });

  const tmuxName = projectName.replace(/[.:\s]/g, '-');

  // Look up the bot's tracked session BEFORE checking sessionExists
  const currentEntry = findTrackedSession(tmuxName);
  const running = currentEntry
    ? await sessionExists(tmuxName, currentEntry)
    : (isPtySession(tmuxName) || (TMUX_AVAILABLE && await sessionExists(tmuxName)));
  const botOwnsThisSession = currentEntry?.sessionId === sessionId;

  // Is Claude actually up in that terminal, or did it exit back to the shell?
  let state: ClaudeTerminalState | null = null;
  if (running) {
    try {
      state = await claudeTerminalState(tmuxName, currentEntry);
    } catch (err: unknown) {
      await sendMessage(`Failed to inspect \`${escapeMarkdown(tmuxName)}\`: ${escapeMarkdown((err as Error).message)}`);
      return;
    }
  }
  if (state === 'busy') {
    await sendMessage(busyTerminalMessage(projectName));
    return;
  }

  // If the bot already has this exact session running, just re-route to it
  if (state === 'claude' && botOwnsThisSession) {
    upsertSession({ cwd: project.path, tmuxSession: tmuxName, status: 'waiting', sessionId });
    recordProjectUsage(projectName, project.path);
    setDefaultWorkspace(projectName); updatePinnedWorkspace().catch(() => {});
    await sendMessage(`Session \`${escapeMarkdown(tmuxName)}\` already running.\nSet as default — send messages directly.`);
    return;
  }

  // Check if the JSONL file was written to very recently — the session may be
  // active in a direct terminal (not managed by the bot). Warn before creating
  // a second Claude instance on the same conversation.
  if (!force && !botOwnsThisSession) {
    const activeThresholdMs = 5 * 60 * 1000; // 5 minutes
    const age = Date.now() - lastActivity;
    if (age < activeThresholdMs) {
      await telegramAPI('sendMessage', {
        chat_id: CHAT_ID,
        text: `\u26a0\ufe0f This conversation was *active ${formatSessionAge(lastActivity)}* \u2014 probably open in the Claude desktop app or a terminal.\n\n` +
          `Resuming here starts a second Claude on the same conversation; the other window won't see messages sent from here.\n\n` +
          `_If you're done there, it's safe to continue here._`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            confirmButton(),
          ]],
        },
      });
      return;
    }
  }

  // Claude exited but its terminal is still open at a shell: resume right there
  // (nothing to interrupt, and a second Ghostty tab would make the cwd ambiguous)
  if (state === 'shell') {
    try {
      await launchInExistingTerminal(tmuxName, currentEntry, `claude --resume ${sessionId}`);
    } catch (err: unknown) {
      await sendMessage(`Failed to resume in \`${escapeMarkdown(tmuxName)}\`: ${escapeMarkdown((err as Error).message)}`);
      return;
    }
    upsertSession({
      cwd: project.path, tmuxSession: tmuxName, status: 'starting', sessionId,
      sessionType: currentEntry?.sessionType ?? 'tmux',
    });
    recordProjectUsage(projectName, project.path);
    setDefaultWorkspace(projectName); updatePinnedWorkspace().catch(() => {});
    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(projectName)}*\n\n` +
      `*Session:* \`${escapeMarkdown(tmuxName)}\`\n` +
      `*Resumed:* \`${sessionId.slice(0, 8)}...\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, projectName, 'resume-session');
    }
    return;
  }

  // Handle bot-managed session that needs switching
  if (running && !botOwnsThisSession) {
    if (isPtySession(tmuxName)) {
      // PTY: headless, not reattachable — warn before killing
      if (!force) {
        await telegramAPI('sendMessage', {
          chat_id: CHAT_ID,
          text: `\u26a0\ufe0f *${escapeMarkdown(projectName)}* has an active PTY session\n\n` +
            `Resuming a different conversation will terminate it.\n\n` +
            `_PTY sessions cannot be reattached from a terminal. ` +
            `You will need to use /resume again if you want to return to the current conversation._`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              confirmButton(),
            ]],
          },
        });
        return;
      }
      // Confirmed — kill the PTY so startProjectResume can respawn
      ptySessionManager.kill(tmuxName);
      await sleep(300);
    } else if (currentEntry && isGhosttySession(currentEntry)) {
      // Ghostty: old tab stays open idle — warn before opening a new tab
      if (!force) {
        await telegramAPI('sendMessage', {
          chat_id: CHAT_ID,
          text: `\u26a0\ufe0f *${escapeMarkdown(projectName)}* has an active Ghostty session\n\n` +
            `Resuming will open a new tab. The existing tab will stay open but idle.\n\n` +
            `_You can close the old tab manually._`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              confirmButton(),
            ]],
          },
        });
        return;
      }
      // Confirmed — unregister handle so startProjectResume opens a fresh tab
      ghosttySessionManager.unregister(tmuxName);
    }
    // tmux: no warning needed — startProjectResume switches inline
  }

  await startProjectResume(projectName, project.path, sessionId);
}

async function startProjectResume(name: string, projectDir: string, sessionId: string): Promise<void> {
  const tmuxName: string = name.replace(/[.:\s]/g, '-');
  const shortId: string = sessionId.slice(0, 8);

  // Look up the current session entry BEFORE checking sessionExists
  const currentEntry = findTrackedSession(tmuxName);
  const running = currentEntry
    ? await sessionExists(tmuxName, currentEntry)
    : (isPtySession(tmuxName) || (TMUX_AVAILABLE && await sessionExists(tmuxName)));

  // If a tmux session is already running (and not PTY/Ghostty), switch Claude inline
  // (exit + resume) instead of killing the tmux session. This keeps the terminal attached.
  if (!isPtySession(tmuxName) && !(currentEntry && isGhosttySession(currentEntry)) && running) {
    try {
      const target = await resolvePaneTarget(tmuxName, currentEntry?.tmuxPane);
      // Double Ctrl+C: first interrupts any running Claude task,
      // second clears the input line if Claude returned to its prompt
      await sendKeys(target, 'C-c');
      await sleep(500);
      await sendKeys(target, 'C-c');
      await sleep(500);
      // Exit Claude (unless the pane is already at a shell prompt), then wait for the
      // shell — typing `claude --resume` while Claude is still up would send it as a prompt.
      if (!await isPaneAtShellPrompt(target)) {
        await sendLiteral(target, '/exit');
        await sendKeys(target, 'Enter');
        let atShell = false;
        for (let i = 0; i < 40 && !atShell; i++) {
          await sleep(250);
          atShell = await isPaneAtShellPrompt(target);
        }
        if (!atShell) {
          await sendMessage(`\u26a0\ufe0f Claude in *${escapeMarkdown(name)}* did not exit \u2014 not switching. Try /stop, then /resume again.`);
          return;
        }
      }
      await sendLiteral(target, `claude --resume ${sessionId}`);
      await sendKeys(target, 'Enter');
    } catch (err: unknown) {
      await sendMessage(`Failed to switch session: ${(err as Error).message}`);
      return;
    }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'tmux' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Switched Claude session in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
    return;
  }

  // No session running (or was PTY/Ghostty that's been killed) — create a new one
  const mode = getEffectiveMode();

  if (mode === 'tmux') {
    try {
      await tmux(['new-session', '-d', '-s', tmuxName, '-c', projectDir]);
      await sleep(300);
      const target = paneTarget(tmuxName);
      await sendLiteral(target, `claude --resume ${sessionId}`);
      await sendKeys(target, 'Enter');
    } catch (err: unknown) {
      await sendMessage(`Failed to start session: ${(err as Error).message}`);
      return;
    }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'tmux' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
  } else if (mode === 'ghostty') {
    const ok = await ghosttySessionManager.openNewTab(projectDir, `claude --resume ${sessionId}`);
    if (!ok) { await sendMessage('Failed to open Ghostty tab.'); return; }

    ghosttySessionManager.register(tmuxName, projectDir);
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'ghostty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Ghostty tab — visible in your Ghostty window._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
  } else if (mode === 'pty') {
    const ok = ptySessionManager.spawn(tmuxName, projectDir, ['--resume', sessionId]);
    if (!ok) { await sendMessage('Failed to spawn PTY session.'); return; }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'pty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name); updatePinnedWorkspace().catch(() => {});

    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Headless PTY mode — full Telegram control. Not attachable from terminal._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
  } else {
    await sendMessage(
      '\u26a0\ufe0f No injection backend available.\n' +
      'Install tmux, run Ghostty, or run: `npm install node-pty` in ~/.telecc/'
    );
  }
}

/**
 * The bot's entry for a terminal session name: prefer a live (not ended) entry,
 * then the newest. Ended entries are kept so /new and /resume can relaunch there.
 */
function findTrackedSession(tmuxName: string): SessionEntry | undefined {
  return Object.values(readSessionMap())
    .filter(s => s.tmuxSession === tmuxName && !isExpired(s))
    .sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt) || b.createdAt - a.createdAt)[0];
}

/**
 * What an existing terminal is doing:
 *  - 'claude': Claude is (or may be) running — leave it alone
 *  - 'shell':  Claude exited and the terminal is back at its shell — safe to type `claude`
 *  - 'busy':   Claude exited, but something else owns the terminal — don't type into it
 */
export type ClaudeTerminalState = 'claude' | 'shell' | 'busy';

/**
 * Pure decision behind claudeTerminalState. `atShellPrompt` is only known for tmux
 * panes; Ghostty has no foreground-process check, so SessionEnd is its only signal.
 */
export function decideTerminalState(t: {
  backend: 'pty' | 'ghostty' | 'tmux';
  ended: boolean;
  atShellPrompt?: boolean;
}): ClaudeTerminalState {
  if (t.backend === 'pty') return 'claude'; // the PTY *is* the claude process
  if (t.backend === 'ghostty') return t.ended ? 'shell' : 'claude';
  if (t.atShellPrompt) return 'shell';
  return t.ended ? 'busy' : 'claude';
}

async function claudeTerminalState(tmuxName: string, entry: SessionEntry | undefined): Promise<ClaudeTerminalState> {
  const ended = !!entry?.endedAt;
  if (isPtySession(tmuxName)) return decideTerminalState({ backend: 'pty', ended });
  if (entry && isGhosttySession(entry)) return decideTerminalState({ backend: 'ghostty', ended });
  const target = await resolvePaneTarget(tmuxName, entry?.tmuxPane);
  return decideTerminalState({ backend: 'tmux', ended, atShellPrompt: await isPaneAtShellPrompt(target) });
}

/** Type a launch command (`claude`, `claude --resume <id>`) at the terminal's shell prompt. */
async function launchInExistingTerminal(tmuxName: string, entry: SessionEntry | undefined, launchCmd: string): Promise<void> {
  if (entry && isGhosttySession(entry)) {
    ghosttySessionManager.register(tmuxName, entry.cwd);
    if (!await ghosttySessionManager.writeLine(tmuxName, launchCmd)) {
      throw new Error(`Ghostty did not accept input${ghosttyDetail()}`);
    }
    return;
  }
  const target = await resolvePaneTarget(tmuxName, entry?.tmuxPane);
  await sendKeys(target, 'C-u');
  await sendLiteral(target, launchCmd);
  await sendKeys(target, 'Enter');
}

function busyTerminalMessage(name: string): string {
  return `\u26a0\ufe0f Claude has exited in *${escapeMarkdown(name)}*, but another program is running in its terminal \u2014 ` +
    `not typing into it. Quit that program (or close the terminal), then try again.`;
}

/**
 * Claude Code built-in commands that run locally: they never produce a
 * UserPromptSubmit/Stop pair, so they must not be marked as a pending remote prompt
 * (the flag would linger and misroute later local activity). Prompt-based slash
 * commands (/review, /init, custom commands) are not listed and are marked as usual.
 */
const LOCAL_CLAUDE_COMMANDS: Set<string> = new Set([
  'add-dir', 'agents', 'bashes', 'clear', 'compact', 'config', 'context', 'cost', 'doctor',
  'effort', 'exit', 'export', 'fast', 'help', 'hooks', 'ide', 'keybindings', 'login', 'logout',
  'mcp', 'memory', 'model', 'output-style', 'permissions', 'plugin', 'privacy-settings', 'quit',
  'release-notes', 'reset', 'resume', 'rewind', 'sandbox', 'status', 'statusline', 'tasks',
  'terminal-setup', 'theme', 'todos', 'upgrade', 'usage', 'vim',
]);

/** Is `text` a Claude Code built-in local command (e.g. `/model opus`, `/cost`)? */
export function isLocalClaudeCommand(text: string): boolean {
  const m = /^\/([A-Za-z][\w-]*)(?:\s|$)/.exec(text.trim());
  return !!m && LOCAL_CLAUDE_COMMANDS.has(m[1].toLowerCase());
}

/**
 * Type `command` into the Claude session and press Enter.
 * `markRemote: false` for text that never produces a UserPromptSubmit/Stop (built-in
 * local commands are also detected automatically).
 */
async function injectAndRespond(
  session: SessionEntry,
  command: string,
  workspace: string,
  opts: { markRemote?: boolean } = {},
): Promise<boolean> {
  const tmuxName: string = session.tmuxSession;
  const ws = escapeMarkdown(workspace);
  const shouldMark = opts.markRemote !== false && !isLocalClaudeCommand(command);
  let marked = false;
  const mark = (): void => {
    if (!shouldMark) return;
    marked = markRemote(session.cwd, command);
  };

  // Claude exited (SessionEnd). Covers Ghostty too, where there is no shell check:
  // typed text would run in the tab's shell.
  if (session.endedAt) {
    await sendMessage(`\u26a0\ufe0f Claude has exited in *${ws}*. Use /new or /resume to start it again.`);
    return false;
  }

  // Claude desktop app / plain terminal: nothing to type into — offer to continue in tmux
  if (isExternalEntry(session)) {
    await sendExternalSessionNotice(workspace, session);
    return false;
  }

  if (!await sessionExists(tmuxName, session)) {
    const ghosttyErr = isGhosttySession(session) ? ghosttySessionManager.lastError : null;
    await sendMessage(ghosttyErr && /ambiguous/i.test(ghosttyErr)
      ? `\u26a0\ufe0f Can't tell which Ghostty tab is *${ws}*: ${escapeMarkdown(ghosttyErr)}. Close the extra tab(s) in that directory.`
      : `\u26a0\ufe0f Session not found. Start Claude via /new for full remote control, or use tmux.`);
    return false;
  }

  try {
    if (isPtySession(tmuxName)) {
      // PTY: write raw bytes directly — no shell quoting needed
      mark();
      if (!ptySessionManager.write(tmuxName, '\x15')) throw new Error('PTY write failed (Ctrl+U)'); // clear line
      await sleep(150);
      if (!ptySessionManager.write(tmuxName, command)) throw new Error('PTY write failed (text)');
      await sleep(150);
      if (!ptySessionManager.write(tmuxName, '\r')) throw new Error('PTY write failed (Enter)');
    } else if (isGhosttySession(session)) {
      // Ghostty: inject via AppleScript input text. Every step reports success —
      // a closed tab or AppleScript error must not be reported as "sent".
      ghosttySessionManager.register(tmuxName, session.cwd);
      mark();
      if (!await ghosttySessionManager.sendKey(tmuxName, 'C-u')) { // Ctrl+U: clear line
        throw new Error(`Ghostty did not accept input${ghosttyDetail()}`);
      }
      await sleep(150);
      if (!await ghosttySessionManager.writeLine(tmuxName, command)) { // text + Return atomically
        throw new Error(`Ghostty did not accept the message${ghosttyDetail()}`);
      }
    } else {
      // tmux: argv (no shell), exact pane target, literal text
      const target = await resolvePaneTarget(tmuxName, session.tmuxPane);
      if (await isPaneAtShellPrompt(target)) {
        await sendMessage(
          `\u26a0\ufe0f Claude is not running in *${ws}* \u2014 the pane is at a shell prompt, ` +
          `so your message was not typed into the shell.\nUse /new or /resume to start Claude.`
        );
        return false;
      }
      mark();
      await sendKeys(target, 'C-u');
      await sleep(150);
      await sendLiteral(target, command);
      await sleep(150);
      await sendKeys(target, 'Enter');
    }
    logger.info(`Injected into ${workspace} [${session.sessionType ?? 'tmux'}:${tmuxName}]`);
    startTypingIndicator();
    return true;
  } catch (err: unknown) {
    // The prompt never reached Claude — don't leave it queued as a pending remote turn
    if (marked) {
      try { unmarkRemoteInjected(session.cwd, command); }
      catch (e: unknown) { logger.warn(`unmarkRemoteInjected failed: ${(e as Error).message}`); }
    }
    await sendMessage(`\u274c Failed: ${escapeMarkdown((err as Error).message)}`);
    return false;
  }
}

/** Record that `cwd`'s session is now driven from Telegram (hooks route its output here). */
function markRemote(cwd: string, command: string): boolean {
  try {
    markRemoteInjected(cwd, command);
    return true;
  } catch (err: unknown) {
    logger.warn(`markRemoteInjected failed: ${(err as Error).message}`);
    return false;
  }
}

function ghosttyDetail(): string {
  const e = ghosttySessionManager.lastError;
  return e ? `: ${e}` : ' (is the tab still open?)';
}

// ── PTY / tmux / Ghostty dispatch helpers ────────────────────────

/** Is this session managed as a live PTY handle by this bot process? */
function isPtySession(sessionName: string): boolean {
  return ptySessionManager.has(sessionName);
}

/** Is this session a Ghostty session (by stored sessionType)? */
function isGhosttySession(session: SessionEntry): boolean {
  return session.sessionType === 'ghostty';
}

/** Check session exists (PTY handle, Ghostty terminal, OR tmux session — exact name). */
async function sessionExists(name: string, session?: SessionEntry): Promise<boolean> {
  if (ptySessionManager.has(name)) return true;
  if (session && isGhosttySession(session)) {
    ghosttySessionManager.register(name, session.cwd);
    // App running is not enough — a closed tab must count as gone
    return ghosttySessionManager.isAvailable() && await ghosttySessionManager.hasTerminal(name);
  }
  if (TMUX_AVAILABLE) return hasSession(name);
  return false;
}

/**
 * Send a named key (Down, Up, Enter, C-m, C-c, C-u, Space) to a session.
 * For PTY: translates to escape sequence via ptySessionManager.sendKey.
 * For Ghostty: translates via ghosttySessionManager.sendKey (ANSI or modifiers).
 * For tmux: passes key name directly to tmux send-keys.
 * Throws if the backend didn't accept the key.
 */
async function sessionSendKey(name: string, key: string, session?: SessionEntry): Promise<void> {
  if (isPtySession(name)) {
    if (!ptySessionManager.sendKey(name, key)) throw new Error(`PTY sendKey ${key} failed`);
  } else if ((session && isGhosttySession(session)) || ghosttySessionManager.has(name)) {
    if (session) ghosttySessionManager.register(name, session.cwd);
    if (!await ghosttySessionManager.sendKey(name, key)) throw new Error(`Ghostty sendKey ${key} failed${ghosttyDetail()}`);
  } else {
    await sendKeys(await resolvePaneTarget(name, session?.tmuxPane), key);
  }
  await sleep(100);
}

/** Capture session output. */
async function sessionCaptureOutput(name: string, session?: SessionEntry): Promise<string> {
  if (isPtySession(name)) return ptySessionManager.capture(name, 20) ?? '';
  if ((session && isGhosttySession(session)) || ghosttySessionManager.has(name)) {
    if (session) ghosttySessionManager.register(name, session.cwd);
    return await ghosttySessionManager.capture(name) ?? '(Ghostty scrollback capture unavailable)';
  }
  return capturePane(await resolvePaneTarget(name, session?.tmuxPane));
}

/** Send Ctrl+C interrupt to a session. Throws if the backend didn't accept it. */
async function sessionInterrupt(name: string, session?: SessionEntry): Promise<void> {
  if (isPtySession(name)) {
    if (!ptySessionManager.interrupt(name)) throw new Error('PTY write failed');
  } else if ((session && isGhosttySession(session)) || ghosttySessionManager.has(name)) {
    if (session) ghosttySessionManager.register(name, session.cwd);
    if (!await ghosttySessionManager.interrupt(name)) throw new Error(`Ghostty did not accept Ctrl+C${ghosttyDetail()}`);
  } else {
    await sendKeys(await resolvePaneTarget(name, session?.tmuxPane), 'C-c');
  }
}

/** Icon for /sessions listing based on session type and live status. */
function sessionIcon(s: { workspace: string; token: string; session: SessionEntry; age: string }): string {
  if (isExternalEntry(s.session)) return '\u{1F4BB}'; // 💻 desktop app / plain terminal
  if (s.session.sessionType === 'ghostty') return '\u{1F47B}'; // 👻
  if (s.session.sessionType === 'pty') {
    return ptySessionManager.has(s.session.tmuxSession) ? '\u{1F916}' : '\u{1F4A4}'; // 🤖 or 💤
  }
  return s.session.description?.startsWith('waiting') ? '\u23f3' : '\u2705'; // ⏳ or ✅
}

// ── Callback query handler ───────────────────────────────────────

async function processCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const chatId: string = String(query.message?.chat?.id);
  if (chatId !== String(CHAT_ID)) {
    logger.warn(`Ignoring callback from unauthorized chat: ${chatId}`);
    return;
  }

  const data: string = query.data || '';
  const message = query.message as (TelegramMessage & { entities?: MessageEntity[] }) | undefined;
  const messageId: number | undefined = message?.message_id;

  logger.info(`Callback: ${data}`);

  /**
   * Edit the clicked message: its original text (formatting rebuilt from entities,
   * truncated to fit) plus `statusHtml`. Omitting reply_markup removes the buttons.
   */
  const appendStatus = async (statusHtml: string): Promise<void> => {
    if (!message || !messageId) return;
    try {
      await editMessageHtml(chatId, messageId, buildEditHtml(message.text || '', message.entities, `\n\n${statusHtml}`));
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }
  };

  // Menu buttons from /new and /resume carry a short key for the stored payload
  const menu = parseMenuCallback(data);
  if (menu) {
    const entry = lookupMenuKey(menu.key);
    const needsSession = menu.kind === 'rs' || menu.kind === 'rc';
    if (!entry || (needsSession && (!entry.path || !entry.sessionId))) {
      answerCallbackQuery(query.id, MENU_EXPIRED);
      return;
    }
    await handleMenuSelection(menu.kind, entry, query.id, appendStatus);
    return;
  }

  const parsed: ParsedCallback | null = parseCallbackData(data);
  if (!parsed) {
    answerCallbackQuery(query.id, 'Invalid callback');
    return;
  }

  const { type } = parsed;

  // Legacy menu buttons (sent before short keys): new:/rp: name the project
  // explicitly and still work...
  if (type === 'new' || type === 'rp') {
    await handleMenuSelection(type, { name: parsed.projectName }, query.id, appendStatus);
    return;
  }
  // ...but rs:/rc: carried a list position that may now point at another conversation
  if (type === 'rs' || type === 'rc') {
    answerCallbackQuery(query.id, MENU_EXPIRED);
    return;
  }

  const { promptId } = parsed;

  // Prompt buttons: only respond while a hook is still waiting. A dead hook (timed
  // out, Esc, session gone) would never read the response — don't claim success.
  const pending = isPromptAlive(promptId) ? readPending(promptId) : null;
  if (!pending) {
    if (readResponse(promptId)) {
      answerCallbackQuery(query.id, 'Already answered');
      return;
    }
    answerCallbackQuery(query.id, '\u231b Expired');
    await appendStatus('\u231b <i>This request expired (Claude stopped waiting)</i>');
    return;
  }

  /** Write the response file the hook is polling for; false (and a toast) on failure. */
  const respond = (response: Record<string, unknown>, what: string): boolean => {
    try {
      writeResponse(promptId, response);
      logger.info(`Wrote ${what} response for promptId=${promptId}: ${JSON.stringify(response)}`);
      return true;
    } catch (err: unknown) {
      logger.error(`Failed to write ${what} response: ${(err as Error).message}`);
      answerCallbackQuery(query.id, 'Failed to save response');
      return false;
    }
  };

  const options: string[] = Array.isArray(pending.options) ? (pending.options as string[]) : [];

  if (type === 'perm') {
    // Permission response: write response file for the polling hook
    const { action } = parsed;
    const label: string = action === 'allow' ? '\u2705 Allowed'
      : action === 'always' ? '\u{1F513} Always Allowed'
      : action === 'defer' ? '\u23f8 Deferred'
      : '\u274c Denied';

    if (!respond({ action }, 'permission')) return;
    answerCallbackQuery(query.id, label);
    // Edit message to show result and remove buttons
    await appendStatus(`\u2014 ${escapeHtml(label)}`);

  } else if (type === 'opt') {
    // Question option: write response file so hook returns updatedInput
    // (No keystroke injection needed — hook polls for this file)
    const optIdx: number = parsed.optionIndex - 1;
    const optionLabel: string = options[optIdx] ?? `Option ${parsed.optionIndex}`;

    // Multi-select: toggle selection state, update buttons, don't submit yet
    if (pending.multiSelect) {
      if (!(optIdx >= 0 && optIdx < options.length)) {
        answerCallbackQuery(query.id, 'Invalid option');
        return;
      }
      const selected: boolean[] = Array.isArray(pending.selectedOptions)
        ? (pending.selectedOptions as boolean[]).slice()
        : options.map(() => false);
      selected[optIdx] = !selected[optIdx];
      updatePending(promptId, { selectedOptions: selected });

      // Rebuild keyboard with updated checkboxes
      const buttons = options.map((label: string, idx: number) => ({
        text: `${selected[idx] ? '\u2611' : '\u2610'} ${idx + 1}. ${label}`,
        callback_data: `opt:${promptId}:${idx + 1}`,
      }));
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
      keyboard.push([{ text: '\u2705 Submit', callback_data: `opt-submit:${promptId}` }]);

      const checkLabel: string = selected[optIdx] ? '\u2611' : '\u2610';
      answerCallbackQuery(query.id, `${checkLabel} ${optionLabel}`);

      // Swap only the keyboard — the text (and its formatting) stays as sent
      if (messageId) {
        try {
          await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: keyboard });
        } catch (err: unknown) {
          logger.error(`Failed to update checkboxes: ${(err as Error).message}`);
        }
      }
      return;
    }

    // Single-select: write response file so hook can return updatedInput
    if (!respond({ action: 'answer', selectedOption: parsed.optionIndex, selectedLabel: optionLabel }, 'question')) return;
    answerCallbackQuery(query.id, `Selected: ${optionLabel}`);
    // Edit message to show selection and remove buttons
    await appendStatus(`\u2714 Selected: <b>${escapeHtml(optionLabel)}</b>`);
    // Note: hook will clean up the prompt files after reading the response

  } else if (type === 'opt-submit') {
    // Multi-select submit: write response file so hook returns updatedInput
    const selected: boolean[] = Array.isArray(pending.selectedOptions) ? (pending.selectedOptions as boolean[]) : [];
    const selectedLabels: string[] = options.filter((_: string, idx: number) => selected[idx]);

    if (selectedLabels.length === 0) {
      answerCallbackQuery(query.id, 'No options selected');
      return;
    }

    const selectedIndices: number[] = selected
      .map((sel: boolean, idx: number) => sel ? idx + 1 : null)
      .filter((idx): idx is number => idx !== null);

    if (!respond({ action: 'answer', selectedOptions: selectedIndices, selectedLabels }, 'multi-select')) return;
    answerCallbackQuery(query.id, `Submitted ${selectedLabels.length} options`);

    // Edit message to show selections and remove buttons
    const selectionText: string = selectedLabels.map(l => `\u2022 ${escapeHtml(l)}`).join('\n');
    await appendStatus(`\u2714 Selected:\n${selectionText}`);
    // Note: hook will clean up the prompt files after reading the response

  } else if (type === 'qperm') {
    // Combined question+permission: allow permission AND inject answer keystroke
    const optIdx: number = parsed.optionIndex - 1;
    const optionLabel: string = options[optIdx] ?? `Option ${parsed.optionIndex}`;

    // 1. Write permission response (allow) — unblocks the permission hook
    if (!respond({ action: 'allow', selectedOption: parsed.optionIndex }, 'qperm')) return;
    answerCallbackQuery(query.id, `Selected: ${optionLabel}`);

    // 2. Inject the answer keystrokes once the question UI renders (detached)
    if (pending.tmuxSession) {
      const tmuxName: string = pending.tmuxSession as string;
      injectQuestionAnswer(tmuxName, options, optIdx).catch((err: unknown) => {
        logger.error(`Failed to inject question answer: ${(err as Error).message}`);
      });
    }

    // Edit message to show selection
    await appendStatus(`\u2014 Selected: <b>${escapeHtml(optionLabel)}</b>`);

  } else if (type === 'perm-denied') {
    // Permission denied retry/dismiss
    const { action } = parsed;
    const label: string = action === 'retry' ? '\u{1F504} Retrying...' : '\u274c Dismissed';

    if (!respond({ action }, 'perm-denied')) return;
    answerCallbackQuery(query.id, label);
    // Edit message to show result and remove buttons
    await appendStatus(`\u2014 ${escapeHtml(label)}`);

  } else if (type === 'pre-compact') {
    // Pre-compact proceed/block
    const { action } = parsed;
    const label: string = action === 'block' ? '\u{1F6D1} Blocked' : '\u2705 Proceeding...';

    if (!respond({ action }, 'pre-compact')) return;
    answerCallbackQuery(query.id, label);
    // Edit message to show result and remove buttons
    await appendStatus(`\u2014 ${escapeHtml(label)}`);
  }
}

/** /new and /resume menu clicks. Session-changing work runs in the message queue. */
async function handleMenuSelection(
  kind: MenuKind,
  entry: MenuPayload,
  queryId: string,
  appendStatus: (statusHtml: string) => Promise<void>,
): Promise<void> {
  const { name } = entry;
  if (kind === 'new') {
    answerCallbackQuery(queryId, `Starting ${name}...`);
    await appendStatus(`\u2014 Starting <b>${escapeHtml(name)}</b>...`);
    await runSerialized(() => startProject(name, entry.path));
  } else if (kind === 'rp') {
    answerCallbackQuery(queryId, `Loading ${name}...`);
    await appendStatus('\u2014 Loading sessions...');
    await runSerialized(() => resumeProject(name, entry.path));
  } else if (kind === 'rpall') {
    answerCallbackQuery(queryId, 'Loading projects...');
    await runSerialized(() => showAllProjectsPicker());
  } else if (entry.path && entry.sessionId) {
    // rs: resume a specific conversation; rc: confirmed (kill active + restart)
    const force = kind === 'rc';
    answerCallbackQuery(queryId, force ? 'Resuming...' : 'Starting resume...');
    if (force) await appendStatus('\u2014 Resuming...');
    const { path: projectPath, sessionId } = entry;
    await runSerialized(() => resumeSession(name, projectPath, sessionId, force));
  }
}

/**
 * qperm: wait for the question UI to actually render in the pane, THEN inject the
 * arrow/Enter keystrokes for option `optIdx`.
 * Fork patch: original used a fixed 4s setTimeout — sometimes injected into the
 * wrong place (terminal had not finished rendering, or had moved on). Now we poll
 * pane content until we see a question-UI marker, then settle and inject.
 */
async function injectQuestionAnswer(tmuxName: string, options: string[], optIdx: number): Promise<void> {
  const session = findSessionByTmuxName(tmuxName);
  const isGhostty = (session && isGhosttySession(session)) || ghosttySessionManager.has(tmuxName);
  // Ghostty has no cheap screen capture — fall back to a fixed settle delay
  const capture = async (): Promise<string | null> => {
    if (isGhostty) return null;
    if (isPtySession(tmuxName)) return ptySessionManager.capture(tmuxName, 40);
    try { return await capturePane(await resolvePaneTarget(tmuxName, session?.tmuxPane)); }
    catch { return null; }
  };

  let ready = false;
  if (isGhostty) {
    await sleep(4000);
  } else {
    const baseline = (await capture()) ?? '';
    const optionMarker = options.length > 0 ? String(options[0]).trim().slice(0, 20) : '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(200);
      const now = await capture();
      if (now === null || now === baseline) continue;
      if (now.includes('\u276f') || now.includes('Use arrow') || (optionMarker && now.includes(optionMarker))) {
        ready = true;
        break;
      }
    }
    await sleep(ready ? 300 : 500);
  }
  for (let i = 0; i < optIdx; i++) {
    await sessionSendKey(tmuxName, 'Down', session);
  }
  await sessionSendKey(tmuxName, 'Enter', session);
  startTypingIndicator();
  logger.info(`Injected question answer into ${tmuxName}: option ${optIdx + 1} (ready=${ready})`);
}

// ── Message router ──────────────────────────────────────────────

async function processMessage(msg: TelegramMessage): Promise<void> {
  // Only accept messages from the configured chat
  const chatId: string = String(msg.chat.id);
  if (chatId !== String(CHAT_ID)) {
    logger.warn(`Ignoring message from unauthorized chat: ${chatId}`);
    return;
  }
  stopTypingIndicator();

  const text: string = (msg.text || '').trim();
  if (!text) return;

  logger.info(`Received: ${text}`);

  // A reply to a question / MCP-input message that a hook is still waiting on is the
  // answer — even when it looks like a command or path (`/skip`, `/tmp`).
  const replyToId: number | undefined = msg.reply_to_message?.message_id;
  if (replyToId) {
    const promptId: string | null = findAwaitingTextPrompt(replyToId);
    if (promptId) {
      await deliverTextAnswer(promptId, text);
      return;
    }
  }

  // /help
  if (text === '/help' || text === '/start') {
    await handleHelp();
    return;
  }

  // /sessions
  if (text === '/sessions') {
    await handleSessions();
    return;
  }

  // /clear — fork patch: prune dead/completed sessions from session-map
  if (text === '/clear' || text === '/clear all') {
    await handleClear(text === '/clear all');
    return;
  }

  // /status [workspace]
  const statusMatch: RegExpMatchArray | null = text.match(/^\/status(?:\s+(\S+))?$/);
  if (statusMatch) {
    await handleStatus(statusMatch[1] || null);
    return;
  }

  // /stop [workspace]
  const stopMatch: RegExpMatchArray | null = text.match(/^\/stop(?:\s+(\S+))?$/);
  if (stopMatch) {
    await handleStop(stopMatch[1] || null);
    return;
  }

  // /use [workspace]
  const useMatch: RegExpMatchArray | null = text.match(/^\/use(?:\s+(.*))?$/);
  if (useMatch) {
    await handleUse(useMatch[1] ? useMatch[1].trim() : null);
    return;
  }

  // /compact [workspace]
  const compactMatch: RegExpMatchArray | null = text.match(/^\/compact(?:\s+(\S+))?$/);
  if (compactMatch) {
    await handleCompact(compactMatch[1] || null);
    return;
  }

  // /new [project]
  const newMatch: RegExpMatchArray | null = text.match(/^\/new(?:\s+(.+))?$/);
  if (newMatch) {
    await handleNew(newMatch[1] ? newMatch[1].trim() : null);
    return;
  }

  // /resume [project]
  const resumeMatch: RegExpMatchArray | null = text.match(/^\/resume(?:\s+(.+))?$/);
  if (resumeMatch) {
    await handleResume(resumeMatch[1] ? resumeMatch[1].trim() : null);
    return;
  }

  // /link <prompt>
  const linkMatch: RegExpMatchArray | null = text.match(/^\/link(?:\s+(.+))?$/s);
  if (linkMatch) {
    await handleLink(linkMatch[1] ? linkMatch[1].trim() : '');
    return;
  }

  // /effort [workspace] low|medium|high
  const effortMatch: RegExpMatchArray | null = text.match(/^\/effort(?:\s+(.+))?$/);
  if (effortMatch) {
    await handleEffort(effortMatch[1] ? effortMatch[1].trim() : '');
    return;
  }

  // /model [workspace] <model>
  const modelMatch: RegExpMatchArray | null = text.match(/^\/model(?:\s+(.+))?$/);
  if (modelMatch) {
    await handleModel(modelMatch[1] ? modelMatch[1].trim() : '');
    return;
  }

  // /cmd TOKEN command
  const cmdMatch: RegExpMatchArray | null = text.match(/^\/cmd\s+(\S+)\s+(.+)/s);
  if (cmdMatch) {
    await handleCmd(cmdMatch[1], cmdMatch[2]);
    return;
  }

  // Anything else starting with "/": `/<workspace> text`, `/<workspace>` (status),
  // a Claude Code slash command (`/review src/api`), or a path (`/Users/me/x.py 有bug`)
  const slash = parseSlashMessage(text);
  if (slash) {
    // Skip Telegram built-in bot commands addressed with @botname
    if (slash.token.includes('@')) return;

    // A path, not a command — plain text for the default workspace
    if (slash.isPath) {
      await routePlainText(msg, text);
      return;
    }

    // One of our own commands with arguments it doesn't take: never forward it
    // (e.g. `/clear foo` must not become Claude's /clear)
    if (BOT_COMMAND_NAMES.has(slash.token.toLowerCase())) {
      await sendHtmlMessage(`Unrecognised usage of <code>/${escapeHtml(slash.token)}</code>. Try /help`);
      return;
    }

    // Explicit `/name`: the only place a workspace may be prefix-matched
    const resolved: ResolveResult = resolveWorkspace(slash.token);
    if (resolved.type === 'exact' || resolved.type === 'prefix') {
      if (slash.rest === null) {
        await handleStatus(resolved.workspace);
      } else {
        await injectAndRespond(resolved.match.session, slash.rest, resolved.workspace);
      }
      return;
    }
    if (resolved.type === 'ambiguous') {
      const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
      await sendMessage(`Multiple matches: ${names}. Be more specific.`);
      return;
    }

    // Not a workspace — most likely a Claude Code slash command: forward it whole
    if (await routeToDefault(text)) return;
    await sendHtmlMessage(`Unknown command: <code>${escapeHtml(text.slice(0, 200))}</code>. Try /help`);
    return;
  }

  await routePlainText(msg, text);
}

/**
 * Split a message starting with "/" into its first token and the rest. `isPath` when
 * the token itself contains "/" (`/Users/me/x.py 有bug` is text, not a command).
 */
export function parseSlashMessage(text: string): { token: string; rest: string | null; isPath: boolean } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(text);
  if (!m) return null;
  return { token: m[1], rest: m[2] ?? null, isPath: m[1].includes('/') };
}

/** Hand a typed answer to the hook waiting on `promptId` (it polls for `textAnswer`). */
async function deliverTextAnswer(promptId: string, text: string): Promise<void> {
  try {
    writeResponse(promptId, { textAnswer: text });
    logger.info(`Wrote text answer for promptId=${promptId}`);
    await sendMessage('\u2705 Answer sent');
  } catch (err: unknown) {
    logger.error(`Failed to write text answer: ${(err as Error).message}`);
    await sendMessage('\u274c Failed to deliver the answer.');
  }
}

/** Send `text` to the default workspace (exact name only). False if there is no default. */
async function routeToDefault(text: string): Promise<boolean> {
  const defaultWs: string | null = getDefaultWorkspace();
  if (!defaultWs) return false;
  await handleWorkspaceCommand(defaultWs, text, false);
  return true;
}

/**
 * Plain text: answer a hook waiting for typed input, else reply-to routing, else the
 * default workspace, else a hint.
 */
async function routePlainText(msg: TelegramMessage, text: string): Promise<void> {
  const replyToId: number | undefined = msg.reply_to_message?.message_id;
  const replyWorkspace: string | null = replyToId ? getWorkspaceForMessage(replyToId) : null;

  // A free-text question / MCP elicitation hook is blocking on an answer: deliver it
  // there instead of typing it into Claude as a new prompt. (A reply to the prompt's
  // own message was already handled in processMessage.) Without such a reply, a single
  // waiting prompt is unambiguous — unless the message replies to some other known
  // notification, which routes to its workspace as usual.
  const promptId: string | null = replyWorkspace ? null : findAwaitingTextPrompt();
  if (promptId) {
    await deliverTextAnswer(promptId, text);
    return;
  }

  if (replyWorkspace) {
    await handleWorkspaceCommand(replyWorkspace, text, false);
    return;
  }

  if (await routeToDefault(text)) return;

  await sendMessage('Use `/help` to see available commands, or `/use <workspace>` to set a default.');
}

// ── Update dispatch ─────────────────────────────────────────────

// Text messages are handled strictly in arrival order (a prompt typed after /new must
// reach the new session), but never on the polling loop itself: a slow handler must
// not delay callback buttons, which Telegram expires after ~15 s.
let serialQueue: Promise<void> = Promise.resolve();

/** Run `task` after every previously queued task has settled. */
function runSerialized(task: () => Promise<void>): Promise<void> {
  const run = serialQueue.then(task);
  serialQueue = run.catch(() => {});
  return run;
}

function dispatchUpdate(update: TelegramUpdate): void {
  if (update.callback_query) {
    const query = update.callback_query;
    processCallbackQuery(query).catch((err: unknown) => {
      logger.error(`Error processing callback query: ${(err as Error).message}`);
    });
  } else if (update.message) {
    const message = update.message;
    runSerialized(() => processMessage(message)).catch((err: unknown) => {
      logger.error(`Error processing message: ${(err as Error).message}`);
    });
  }
}

// ── Poll offset persistence ─────────────────────────────────────
// Telegram only marks updates confirmed on the *next* getUpdates call, so without
// this a restart re-delivers (and re-executes) the last batch.

const POLL_OFFSET_PATH: string = path.join(PROJECT_ROOT, 'src/data', 'poll-offset.json');
/** Older than this, every stored update has long been confirmed server-side — and after
 *  a week of inactivity Telegram may restart update ids at a random (lower) value. */
const POLL_OFFSET_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BOT_ID: string = String(BOT_TOKEN).split(':')[0];

interface PollOffsetFile { botId: string; lastUpdateId: number; savedAt: number }

function loadPollOffset(): void {
  try {
    const saved = readJsonSafe<PollOffsetFile | null>(POLL_OFFSET_PATH, null);
    if (saved && saved.botId === BOT_ID && Number.isInteger(saved.lastUpdateId)
        && Date.now() - saved.savedAt < POLL_OFFSET_MAX_AGE_MS) {
      lastUpdateId = saved.lastUpdateId;
      lastUpdateAt = saved.savedAt;
      logger.info(`Resuming from update offset ${lastUpdateId + 1}`);
    }
  } catch (err: unknown) {
    logger.warn(`Could not load poll offset: ${(err as Error).message}`);
  }
}

function savePollOffset(): void {
  try {
    writeJsonAtomic(POLL_OFFSET_PATH, { botId: BOT_ID, lastUpdateId, savedAt: lastUpdateAt } as PollOffsetFile);
  } catch (err: unknown) {
    logger.warn(`Could not save poll offset: ${(err as Error).message}`);
  }
}

// ── Long polling loop ───────────────────────────────────────────

const POLL_BACKOFF_MIN_MS = 2000;
const POLL_BACKOFF_MAX_MS = 60000;

async function poll(): Promise<void> {
  let backoffMs = POLL_BACKOFF_MIN_MS;
  while (true) {
    try {
      // Without an offset Telegram returns the earliest *unconfirmed* update, which is
      // safe once everything we saw has been confirmed by later polls.
      const useOffset = lastUpdateId > 0 && Date.now() - lastUpdateAt < POLL_OFFSET_MAX_AGE_MS;
      const updates = await telegramAPI('getUpdates', {
        ...(useOffset ? { offset: lastUpdateId + 1 } : {}),
        timeout: LONG_POLL_TIMEOUT_S,
        allowed_updates: ['message', 'callback_query'],
      }) as TelegramUpdate[];

      lastPollTime = Date.now();
      backoffMs = POLL_BACKOFF_MIN_MS;
      if (!Array.isArray(updates) || updates.length === 0) continue;

      // Advance and persist the offset before handling, so a handler that crashes
      // the process can't be replayed on every restart.
      for (const update of updates) {
        if (update.update_id > lastUpdateId || !useOffset) lastUpdateId = update.update_id;
      }
      lastUpdateAt = Date.now();
      savePollOffset();

      for (const update of updates) {
        try {
          dispatchUpdate(update);
        } catch (err: unknown) {
          logger.error(`Error dispatching update ${update.update_id}: ${(err as Error).message}`);
        }
      }
    } catch (err: unknown) {
      // Network error / timeout / API error — back off and retry
      logger.error(`Polling error: ${(err as Error).message} (retrying in ${backoffMs / 1000}s)`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  // Fork patch: original only escaped _*`[ — but Markdown v1 also breaks on
  // ] ( ) and \\ (Telegram returns 400 "can't parse entities" and the message
  // silently drops). Workspace names with these chars (or Chinese punctuation
  // adjacent to them) lost their notifications.
  return String(text).replace(/([_*`\[\]()\\])/g, '\\$1');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Health check server ──────────────────────────────────────────

function startHealthServer(port: number): void {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const now: number = Date.now();
    const pollAge: number | null = lastPollTime ? now - lastPollTime : null;
    const stale: boolean = pollAge === null || pollAge > 60000;

    const sessions = listActiveSessions();
    let pendingCount = 0;
    try {
      const files: string[] = fs.readdirSync(PROMPTS_DIR).filter(f => f.startsWith('pending-'));
      pendingCount = files.length;
    } catch {}

    const body: string = JSON.stringify({
      status: stale ? 'unhealthy' : 'ok',
      uptime: Math.floor((now - startTime) / 1000),
      lastPollAge: pollAge !== null ? Math.floor(pollAge / 1000) : null,
      activeSessions: sessions.length,
      pendingPrompts: pendingCount,
    }, null, 2);

    res.writeHead(stale ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Health endpoint: http://127.0.0.1:${port}/health`);
  });

  server.on('error', (err: Error) => {
    logger.warn(`Health server error: ${err.message}`);
  });
}

// ── Startup ─────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Ensure data directory exists
  const dataDir: string = path.join(PROJECT_ROOT, 'src/data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Keep launchd/systemd log files bounded (hourly check, 5 MB, 2 old copies)
  const logsDir: string = path.join(PROJECT_ROOT, 'logs');
  startLogRotation(['bot-stdout.log', 'bot-stderr.log', 'permission-hook-debug.log'].map(f => path.join(logsDir, f)));

  const { version } = require(path.join(PROJECT_ROOT, 'package.json'));
  logger.info(`telecc v${version} — Starting Telegram bot (long polling)...`);
  logger.info(`Chat ID: ${CHAT_ID}`);

  // Don't re-run updates that were already handled before a restart
  loadPollOffset();

  // Prune expired sessions on startup
  const pruned: number = pruneExpired();
  if (pruned > 0) {
    logger.info(`Pruned ${pruned} expired sessions`);
  }

  // Delete any existing webhook to ensure long polling works
  try {
    await telegramAPI('deleteWebhook', {});
    logger.info('Webhook cleared, using long polling');
  } catch (err: unknown) {
    logger.warn(`Could not delete webhook: ${(err as Error).message}`);
  }

  // Register bot commands with Telegram (populates the "/" menu in chat)
  await registerBotCommands();

  // Start optional health check server
  const healthPort: number = parseInt(process.env.HEALTH_PORT as string, 10);
  if (healthPort) {
    startHealthServer(healthPort);
  }

  await poll();
}

// Tests import this module for its pure helpers — don't start the daemon there.
if (!process.env.VITEST) {
  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });

  start().catch((err: Error) => {
    logger.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
