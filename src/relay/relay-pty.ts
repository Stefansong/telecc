#!/usr/bin/env node

/**
 * relay-pty.ts - Fixed version
 * Uses node-imap instead of ImapFlow to resolve Feishu email compatibility issues
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from '../utils/paths';
import { optionalRequire } from '../utils/optional-require';
import { readJsonSafe } from '../utils/atomic-json';

const envPath = path.join(PROJECT_ROOT, '.env');
dotenv.config({ path: envPath });

const Imap = optionalRequire('node-imap', 'IMAP email relay') as any;
const mailparserModule = optionalRequire('mailparser', 'email parsing') as any;
const simpleParser = mailparserModule ? mailparserModule.simpleParser : null;
const nodePty = optionalRequire('node-pty', 'PTY terminal emulation') as any;
const _spawn = nodePty ? nodePty.spawn : null;
const pinoModule = optionalRequire('pino', 'structured logging') as any;

interface LogMethods {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

/** mailparser address object: `value` holds the parsed addresses (groups nest). */
interface ParsedAddress {
    address?: string;
    name?: string;
    group?: ParsedAddress[];
}

interface ParsedEmail {
    uid?: number;
    messageId?: string;
    subject?: string;
    text?: string;
    date?: Date;
    from?: { text?: string; value?: ParsedAddress[] };
}

interface SessionEntry {
    type?: string;
    sessionType?: string;
    tmuxSession?: string;
    tmuxPane?: string;
    expiresAt?: number;
    endedAt?: number;
    [key: string]: unknown;
}

interface ProcessedMessageRecord {
    id: string | number;
    timestamp: number;
}

interface SentMessageRecord {
    messageId: string;
    sentAt: string;
}

interface SentMessagesFile {
    messages: SentMessageRecord[];
}

// Configure logging with fallback to console
let log: LogMethods;
if (pinoModule) {
    const pinoPretty = optionalRequire('pino-pretty', 'log formatting');
    if (pinoPretty) {
        log = pinoModule({
            level: process.env.LOG_LEVEL || 'info',
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss' }
            }
        });
    } else {
        log = pinoModule({ level: process.env.LOG_LEVEL || 'info' });
    }
} else {
    const logLevel = process.env.LOG_LEVEL || 'info';
    const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const minLevel = levels[logLevel] ?? 1;
    log = {
        debug: (...args: unknown[]) => { if (minLevel <= 0) console.log('[DEBUG]', ...args); },
        info: (...args: unknown[]) => { if (minLevel <= 1) console.log('[INFO]', ...args); },
        warn: (...args: unknown[]) => { if (minLevel <= 2) console.warn('[WARN]', ...args); },
        error: (...args: unknown[]) => { if (minLevel <= 3) console.error('[ERROR]', ...args); },
    };
}

// Global configuration
const SESS_PATH = process.env.SESSION_MAP_PATH || path.join(PROJECT_ROOT, 'src/data/session-map.json');
const PROCESSED_PATH = path.join(PROJECT_ROOT, 'src/data/processed-messages.json');
const SENT_MESSAGES_PATH = path.join(PROJECT_ROOT, 'src/data/sent-messages.json');
const ALLOWED_SENDERS = (process.env.ALLOWED_SENDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PTY_POOL = new Map<string, unknown>();
let PROCESSED_MESSAGES = new Set<string | number>();

// Load processed messages
function loadProcessedMessages(): void {
    if (existsSync(PROCESSED_PATH)) {
        try {
            const data: ProcessedMessageRecord[] = JSON.parse(readFileSync(PROCESSED_PATH, 'utf8'));
            const now = Date.now();
            // Keep only records from the last 7 days
            const validMessages = data.filter(item => (now - item.timestamp) < 7 * 24 * 60 * 60 * 1000);
            PROCESSED_MESSAGES = new Set(validMessages.map(item => item.id));
            // Update file, remove expired records
            saveProcessedMessages();
        } catch (error: unknown) {
            log.error({ error }, 'Failed to load processed messages');
            PROCESSED_MESSAGES = new Set();
        }
    }
}

// Save processed messages
function saveProcessedMessages(): void {
    try {
        const now = Date.now();
        const data = Array.from(PROCESSED_MESSAGES).map(id => ({
            id,
            timestamp: now
        }));

        // Ensure directory exists
        const dir = path.dirname(PROCESSED_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        writeFileSync(PROCESSED_PATH, JSON.stringify(data, null, 2));
    } catch (error: unknown) {
        log.error({ error }, 'Failed to save processed messages');
    }
}

// Load session mapping (read-only; retries a file caught mid-write)
function loadSessions(): Record<string, SessionEntry> {
    try {
        const map = readJsonSafe<Record<string, SessionEntry> | null>(SESS_PATH, {});
        return map && typeof map === 'object' ? map : {};
    } catch (error: unknown) {
        log.error({ error }, 'Failed to load session map');
        return {};
    }
}

/** All parsed mailbox addresses in a From header (lower-cased), including group members. */
function extractSenderAddresses(from: ParsedEmail['from'] | undefined): string[] {
    const out: string[] = [];
    const walk = (list: ParsedAddress[] | undefined) => {
        for (const entry of list || []) {
            if (entry && typeof entry.address === 'string' && entry.address.trim()) {
                out.push(entry.address.trim().toLowerCase());
            }
            if (entry && Array.isArray(entry.group)) walk(entry.group);
        }
    };
    walk(from?.value);
    return out;
}

/**
 * Check if the sender is in the whitelist.
 *
 * Compares the *parsed* address(es) exactly (case-insensitive) — never a substring of
 * `from.text`, which includes the display name: `"me@allowed.com" <attacker@evil.com>`
 * used to pass. An ALLOWED_SENDERS entry starting with "@" allows a whole domain
 * (exact domain match). Every From address must be allowed, and there must be one.
 */
function isAllowed(from: ParsedEmail['from'] | undefined, allowedSenders: string[] = ALLOWED_SENDERS): boolean {
    const addresses = extractSenderAddresses(from);
    if (addresses.length === 0 || allowedSenders.length === 0) return false;
    return addresses.every(addr => allowedSenders.some(allowed =>
        allowed.startsWith('@') ? addr.endsWith(allowed) && addr.indexOf('@') === addr.length - allowed.length : addr === allowed
    ));
}

// Extract telecc token from subject
function extractTokenFromSubject(subject: string = ''): string | null {
    const patterns = [
        /\[telecc\s+#([A-Z0-9]+)\]/,
        /Re:\s*\[telecc\s+#([A-Z0-9]+)\]/
    ];

    for (const pattern of patterns) {
        const match = subject.match(pattern);
        if (match) return match[1];
    }

    return null;
}

// Clean email text
function cleanEmailText(text: string = ''): string {
    const lines = text.split(/\r?\n/);
    const cleanLines: string[] = [];

    for (const line of lines) {
        // Detect quoted content (more comprehensive detection)
        if (line.includes('-----Original Message-----') ||
            line.includes('--- Original Message ---') ||
            line.includes('at') && line.includes('wrote:') ||
            line.includes('On') && line.includes('wrote:') ||
            line.includes('Session ID:') ||
            line.includes(`<${process.env.SMTP_USER}>`) ||
            line.includes('telecc Notification System') ||
            line.includes('on 2025') && line.includes('wrote:') ||
            line.match(/^>.*/) ||  // Quote lines start with >
            line.includes('From:') && line.includes('@') ||
            line.includes('To:') && line.includes('@') ||
            line.includes('Subject:') ||
            line.includes('Sent:') ||
            line.includes('Date:')) {
            break;
        }

        // Detect email signature
        if (line.match(/^--\s*$/) ||
            line.includes('Sent from') ||
            line.includes('Sent from my') ||
            line.includes('Best regards') ||
            line.includes('Sincerely')) {
            break;
        }

        cleanLines.push(line);
    }

    // Get valid content
    const cleanText = cleanLines.join('\n').trim();

    // Find actual command content (skip greetings, etc.)
    const contentLines = cleanText.split(/\r?\n/).filter(l => l.trim().length > 0);

    // Collect all valid command lines (support multi-line commands)
    const validCommandLines: string[] = [];

    for (const line of contentLines) {
        const trimmedLine = line.trim();

        // Skip common greetings (but only if they're standalone)
        if (trimmedLine.match(/^(hi|hello|thank you|thanks|ok|yes)$/i)) {
            continue;
        }

        // Skip remaining email quotes
        if (trimmedLine.includes('telecc Notification System') ||
            trimmedLine.includes(`<${process.env.SMTP_USER}>`) ||
            trimmedLine.includes('on 2025')) {
            continue;
        }

        // Collect valid command lines
        if (trimmedLine.length > 0) {
            validCommandLines.push(trimmedLine);
        }
    }

    // Join all valid lines to form the complete command
    if (validCommandLines.length > 0) {
        const fullCommand = validCommandLines.join('\n').slice(0, 8192);
        const deduplicatedCommand = deduplicateCommand(fullCommand);
        return deduplicatedCommand;
    }

    // If no obvious command is found, return first non-empty line (and deduplicate)
    const firstLine = contentLines[0] || '';
    const command = firstLine.slice(0, 8192).trim();
    return deduplicateCommand(command);
}

/** A repeated unit shorter than this (in code points) is never collapsed: "11", "哈哈", "ok ok". */
const DEDUP_MIN_UNIT_CHARS = 10;
/** Max whitespace allowed between the two copies ("abc abc", "abc\nabc", "abc\r\n\r\nabc"). */
const DEDUP_MAX_SEPARATOR = 4;

/**
 * Collapse a command that is exactly two copies of itself — what some mail clients
 * produce when a long reply is pasted twice / the text part is duplicated, e.g.
 * "please refactor the parser please refactor the parser" → "please refactor the parser".
 *
 * Deliberately conservative (the old version truncated "11" → "1", "哈哈" → "哈",
 * "abab" → "ab"): only an exact 2× repetition, optionally separated by a little
 * whitespace, of a unit that is at least DEDUP_MIN_UNIT_CHARS code points long and
 * not itself a repetition of something shorter ("====…", "hahaha…" stay intact).
 */
function deduplicateCommand(command: string): string {
    if (!command) {
        return command;
    }

    const text = command.trim();
    const n = text.length;
    // Unit length L (UTF-16 units) with text = unit + sep + unit and sep whitespace-only
    for (let sepLen = n % 2; sepLen <= DEDUP_MAX_SEPARATOR && sepLen < n; sepLen += 2) {
        const unitLen = (n - sepLen) / 2;
        const unit = text.slice(0, unitLen);
        const sep = text.slice(unitLen, unitLen + sepLen);
        const second = text.slice(unitLen + sepLen);
        if (unit !== second || !/^\s*$/.test(sep)) continue;
        if (Array.from(unit.trim()).length < DEDUP_MIN_UNIT_CHARS) continue;
        // Primitive check: a unit that is itself periodic ("abab…") is left alone
        if ((unit + unit).indexOf(unit, 1) !== unit.length) continue;

        log.debug({
            originalCommand: command,
            deduplicatedCommand: unit
        }, 'Detected and removed command duplication');
        return unit;
    }

    // No repetition detected, return original command
    return command;
}

// Unattended remote command injection - tmux priority, smart fallback
async function injectCommandRemote(token: string, command: string): Promise<boolean> {
    const sessions = loadSessions();
    const session = sessions[token];

    if (!session) {
        log.warn({ token }, 'Session not found');
        return false;
    }

    // Check if session has expired
    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt && session.expiresAt < now) {
        log.warn({ token }, 'Session expired');
        return false;
    }

    // A SessionEnd hook marked this session ended — Claude is gone
    if (session.endedAt) {
        log.warn({ token }, 'Session has ended');
        return false;
    }

    try {
        log.info({ token, command }, 'Starting remote command injection');

        // Method 1: Prefer tmux unattended injection
        const TmuxInjector = require('./tmux-injector');
        const tmuxSessionName = session.tmuxSession || 'claude-taskping';
        const tmuxInjector = new TmuxInjector(log, tmuxSessionName, session.tmuxPane || null);

        const tmuxResult = await tmuxInjector.injectCommandFull(token, command);

        if (tmuxResult.success) {
            log.info({ token, session: tmuxResult.session }, 'Tmux remote injection successful');
            return true;
        }

        // A tmux-backed session whose tmux session is gone means Claude is gone: don't
        // paste the command into whatever terminal happens to be in front instead.
        const isTmuxSession = session.type === 'tmux' || session.sessionType === 'tmux';
        if (isTmuxSession && tmuxResult.error === 'session_not_found') {
            log.error({ token, tmuxSession: tmuxSessionName }, 'Target tmux session no longer exists — not injecting');
            return false;
        }

        log.warn({ token, error: tmuxResult.error }, 'Tmux injection failed, trying smart fallback');

        // Method 2: Fall back to smart injector
        const SmartInjector = require('./smart-injector');
        const smartInjector = new SmartInjector(log);

        const smartResult = await smartInjector.injectCommand(token, command);

        if (smartResult) {
            log.info({ token }, 'Smart injection fallback successful');
            return true;
        } else {
            log.error({ token }, 'All remote injection methods failed');
            return false;
        }

    } catch (error: unknown) {
        log.error({ error, token }, 'Failed to inject command remotely');
        return false;
    }
}

// Handle email message
async function handleMailMessage(parsed: ParsedEmail): Promise<void> {
    try {
        log.debug({ uid: parsed.uid, messageId: parsed.messageId }, 'handleMailMessage called');

        // Check if this is a system-sent email
        const messageId = parsed.messageId;
        if (await isSystemSentEmail(messageId)) {
            log.info({ messageId }, 'Skipping system-sent email');
            await removeFromSentMessages(messageId!);
            return;
        }

        // Simplified duplicate detection (UID already checked earlier)
        const uid = parsed.uid;

        // Only perform additional checks for emails without UID
        if (!uid) {
            const identifier = messageId;
            if (identifier && PROCESSED_MESSAGES.has(identifier)) {
                log.debug({ messageId, identifier }, 'Message already processed by messageId, skipping');
                return;
            }

            // Content hash deduplication (as last resort)
            const emailSubject = parsed.subject || '';
            const emailDate = parsed.date || new Date();
            const contentHash = `${emailSubject}_${emailDate.getTime()}`;

            if (PROCESSED_MESSAGES.has(contentHash)) {
                log.debug({ subject: emailSubject, date: emailDate, contentHash }, 'Message already processed by content hash, skipping');
                return;
            }
        }

        // Verify sender (parsed address, not the display text)
        if (!isAllowed(parsed.from)) {
            log.warn({ from: parsed.from?.text, addresses: extractSenderAddresses(parsed.from) }, 'Sender not allowed');
            return;
        }

        // Extract token
        const subject = parsed.subject || '';
        const token = extractTokenFromSubject(subject);

        if (!token) {
            log.warn({ subject }, 'No token found in email');
            return;
        }

        // Extract command - add detailed debugging
        log.debug({
            token,
            rawEmailText: parsed.text?.substring(0, 500),
            emailSubject: parsed.subject
        }, 'Raw email content before cleaning');

        const command = cleanEmailText(parsed.text);

        log.debug({
            token,
            cleanedCommand: command,
            commandLength: command?.length
        }, 'Email content after cleaning');

        if (!command) {
            log.warn({ token }, 'No command found in email');
            return;
        }

        log.info({ token, command }, 'Processing email command');

        // Unattended remote command injection (tmux priority, smart fallback)
        const success = await injectCommandRemote(token, command);

        if (!success) {
            log.warn({ token }, 'Could not inject command');
            return;
        }

        // Mark as processed (only mark after successful processing)
        if (uid) {
            // Mark UID as processed
            PROCESSED_MESSAGES.add(uid);
            log.debug({ uid }, 'Marked message UID as processed');
        } else {
            // For emails without UID, use messageId and content hash
            if (messageId) {
                PROCESSED_MESSAGES.add(messageId);
                log.debug({ messageId }, 'Marked message as processed by messageId');
            }

            // Content hash marking
            const emailSubject = parsed.subject || '';
            const emailDate = parsed.date || new Date();
            const contentHash = `${emailSubject}_${emailDate.getTime()}`;
            PROCESSED_MESSAGES.add(contentHash);
            log.debug({ contentHash }, 'Marked message as processed by content hash');
        }

        // Persist processed messages
        saveProcessedMessages();

        log.info({ token }, 'Command injected successfully via remote method');

    } catch (error: unknown) {
        log.error({ error }, 'Failed to handle email message');
    }
}

// Start IMAP listening
function startImap(): void {
    if (!Imap) {
        console.error('Error: node-imap is required for the email relay. Install with: npm install node-imap');
        process.exit(1);
    }
    if (!simpleParser) {
        console.error('Error: mailparser is required for the email relay. Install with: npm install mailparser');
        process.exit(1);
    }

    // First load processed messages
    loadProcessedMessages();

    log.info('Starting relay-pty service', {
        mode: 'pty',
        imapHost: process.env.IMAP_HOST,
        imapUser: process.env.IMAP_USER,
        allowedSenders: ALLOWED_SENDERS,
        sessionMapPath: SESS_PATH,
        processedCount: PROCESSED_MESSAGES.size
    });

    const imap = new Imap({
        user: process.env.IMAP_USER,
        password: process.env.IMAP_PASS,
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT || '993') || 993,
        tls: process.env.IMAP_SECURE === 'true',
        connTimeout: 60000,
        authTimeout: 30000,
        keepalive: true
    });

    imap.once('ready', function() {
        log.info('Connected to IMAP server');

        imap.openBox('INBOX', false, function(err: Error | null, box: any) {
            if (err) {
                log.error({ error: err.message }, 'Failed to open INBOX');
                return;
            }

            log.info(`Mailbox opened: ${box.messages.total} total messages, ${box.messages.new} new`);

            // Only process existing unread emails at startup
            processExistingEmails(imap);

            // Listen for new emails (main mechanism)
            imap.on('mail', function(numNewMsgs: number) {
                log.info({ newMessages: numNewMsgs }, 'New mail arrived');
                // Add delay to avoid conflicts with existing email processing
                setTimeout(() => {
                    processNewEmails(imap);
                }, 1000);
            });

            // Periodic check for new emails (backup only, extended interval)
            setInterval(() => {
                log.debug('Periodic email check...');
                processNewEmails(imap);
            }, 120000); // Check every 2 minutes, reduced frequency
        });
    });

    imap.once('error', function(err: Error) {
        log.error({ error: err.message }, 'IMAP error');
        // Reconnection mechanism
        setTimeout(() => {
            log.info('Attempting to reconnect...');
            startImap();
        }, 10000);
    });

    imap.once('end', function() {
        log.info('IMAP connection ended');
    });

    imap.connect();

    // Graceful shutdown
    process.on('SIGINT', () => {
        log.info('Shutting down gracefully...');
        imap.end();
        process.exit(0);
    });
}

// Process existing emails
function processExistingEmails(imap: any): void {
    // Search unread emails
    imap.search(['UNSEEN'], function(err: Error | null, results: number[]) {
        if (err) {
            log.error({ error: err.message }, 'Failed to search emails');
            return;
        }

        if (results.length > 0) {
            log.info(`Found ${results.length} unread messages`);
            log.debug({ uids: results }, 'Unread message UIDs');
            fetchAndProcessEmails(imap, results);
        } else {
            log.debug('No unread messages found');
        }
    });
}

// Process new emails
function processNewEmails(imap: any): void {
    // Search emails from the last 5 minutes
    const since = new Date();
    since.setMinutes(since.getMinutes() - 5);
    const sinceStr = since.toISOString().split('T')[0]; // YYYY-MM-DD

    imap.search([['SINCE', sinceStr], 'UNSEEN'], function(err: Error | null, results: number[]) {
        if (err) {
            log.error({ error: err.message }, 'Failed to search new emails');
            return;
        }

        if (results.length > 0) {
            log.info(`Found ${results.length} new messages`);
            fetchAndProcessEmails(imap, results);
        }
    });
}

// Fetch and process emails
function fetchAndProcessEmails(imap: any, uids: number[]): void {
    log.debug({ uids }, 'Starting to fetch emails');
    const fetch = imap.fetch(uids, {
        bodies: '',  // Get complete email
        markSeen: true  // Mark as read
    });

    fetch.on('message', function(msg: any, seqno: number) {
        let buffer = '';
        let messageUid: number | null = null;
        let skipProcessing = false;
        let bodyProcessed = false;
        let attributesReceived = false;

        // Get UID to prevent duplicate processing
        msg.once('attributes', function(attrs: { uid: number }) {
            messageUid = attrs.uid;
            attributesReceived = true;
            log.debug({ uid: messageUid, seqno }, 'Received attributes');

            // Only check if already processed, don't mark immediately
            if (messageUid && PROCESSED_MESSAGES.has(messageUid)) {
                log.debug({ uid: messageUid, seqno }, 'Message UID already processed, skipping entire message');
                skipProcessing = true;
                return; // Return directly, do not continue processing
            }
            log.debug({ uid: messageUid, seqno }, 'Message UID ready for processing');

            // If body is processed, can now parse email
            if (bodyProcessed && !skipProcessing) {
                processEmailBuffer(buffer, messageUid, seqno);
            }
        });

        msg.on('body', function(stream: any, _info: unknown) {
            stream.on('data', function(chunk: Buffer) {
                buffer += chunk.toString('utf8');
            });

            stream.once('end', function() {
                bodyProcessed = true;
                log.debug({ uid: messageUid, seqno, bufferLength: buffer.length, attributesReceived }, 'Body stream ended');

                // If attributes received and not marked to skip, can now parse email
                if (attributesReceived && !skipProcessing) {
                    processEmailBuffer(buffer, messageUid, seqno);
                }
            });
        });

        // Separated email processing function
        function processEmailBuffer(buffer: string, uid: number | null, seqno: number): void {
            if (buffer.length > 0 && uid) {
                log.debug({ uid, seqno }, 'Starting email parsing');
                simpleParser(buffer, function(err: Error | null, parsed: ParsedEmail) {
                    if (err) {
                        log.error({ error: err.message, seqno, uid }, 'Failed to parse email');
                        PROCESSED_MESSAGES.delete(uid);
                    } else {
                        log.debug({ uid, seqno }, 'Email parsed successfully, calling handleMailMessage');
                        parsed.uid = uid;
                        handleMailMessage(parsed);
                    }
                });
            } else {
                log.debug({ uid, seqno, bufferLength: buffer.length }, 'Skipping email - no buffer or uid');
            }
        }

        msg.once('error', function(err: Error) {
            log.error({ error: err.message, seqno, uid: messageUid }, 'Error fetching message');
        });
    });

    fetch.once('error', function(err: Error) {
        log.error({ error: err.message }, 'Error fetching emails');
    });

    fetch.once('end', function() {
        log.debug('Email fetch completed');
    });
}

// Check if email is system-sent
async function isSystemSentEmail(messageId: string | undefined): Promise<boolean> {
    if (!messageId || !existsSync(SENT_MESSAGES_PATH)) {
        return false;
    }

    try {
        const sentMessages: SentMessagesFile = JSON.parse(readFileSync(SENT_MESSAGES_PATH, 'utf8'));
        return sentMessages.messages.some(msg => msg.messageId === messageId);
    } catch (error: unknown) {
        log.error({ error }, 'Error reading sent messages');
        return false;
    }
}

// Remove email from sent messages tracking
async function removeFromSentMessages(messageId: string): Promise<void> {
    if (!existsSync(SENT_MESSAGES_PATH)) {
        return;
    }

    try {
        const sentMessages: SentMessagesFile = JSON.parse(readFileSync(SENT_MESSAGES_PATH, 'utf8'));
        sentMessages.messages = sentMessages.messages.filter(msg => msg.messageId !== messageId);

        // Also clean up old messages (older than 24 hours)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        sentMessages.messages = sentMessages.messages.filter(msg => {
            return new Date(msg.sentAt) > oneDayAgo;
        });

        writeFileSync(SENT_MESSAGES_PATH, JSON.stringify(sentMessages, null, 2));
        log.debug({ messageId }, 'Removed message from sent tracking');
    } catch (error: unknown) {
        log.error({ error }, 'Error removing from sent messages');
    }
}

// Start service
if (require.main === module) {
    startImap();
}

export {
    startImap,
    handleMailMessage,
    extractTokenFromSubject,
    cleanEmailText,
    deduplicateCommand,
    isAllowed,
    extractSenderAddresses,
};
