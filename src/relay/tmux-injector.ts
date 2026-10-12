#!/usr/bin/env node

/**
 * Tmux Command Injector - Unattended remote control solution
 *
 * All tmux calls go through ../utils/tmux (execFile argv, exact `=name` targets,
 * `send-keys -l --` for the command text), so nothing from an email ever reaches a
 * shell. Injection only targets an existing session: if it is gone we fail rather
 * than spawning a fresh Claude somewhere, and permission prompts are never
 * auto-approved — they are left for the user (terminal or Telegram).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
    tmux,
    hasSession,
    sessionTarget,
    resolvePaneTarget,
    sendLiteral,
    sendKeys,
    capturePane,
} from '../utils/tmux';

interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}

interface InjectionResult {
    success: boolean;
    error?: string;
    message?: string;
    session?: string;
}

interface CaptureResult {
    success: boolean;
    output?: string;
    error?: string;
}

interface SessionInfo {
    exists: boolean;
    info?: string;
    name?: string;
}

/** AppleScript string literal with `\` and `"` escaped (for osascript argv, never a shell). */
function appleScriptString(str: string): string {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Prompts Claude Code shows when it needs the user's decision. Only matched against
 * the last few non-empty lines of the pane (where an active prompt is rendered),
 * never anywhere in the scrollback.
 */
const CONFIRMATION_PATTERNS: RegExp[] = [
    /Do you want to (proceed|make this edit|create|run)/i,
    /^\s*[❯▷>]?\s*1\.\s*Yes\b/,
    /\((y\/n)\)|\[Y\/n\]|\[y\/N\]/,
    /Press Enter to continue/i,
];

class TmuxInjector {
    log: Logger;
    sessionName: string;
    paneId: string | null;
    logFile: string;

    constructor(logger?: Logger, sessionName: string | null = null, paneId: string | null = null) {
        this.log = logger || console;
        this.sessionName = sessionName || 'claude-taskping';
        this.paneId = paneId;
        this.logFile = path.join(__dirname, '../logs/tmux-injection.log');
        this.ensureLogDir();
    }

    ensureLogDir(): void {
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    // Check if tmux is installed
    async checkTmuxAvailable(): Promise<boolean> {
        try {
            await tmux(['-V']);
            return true;
        } catch {
            return false;
        }
    }

    // Check if Claude tmux session exists (exact name, no prefix match)
    async checkClaudeSession(): Promise<boolean> {
        return hasSession(this.sessionName);
    }

    /**
     * Create a Claude tmux session in `cwd`. Only for explicit use — injection never
     * calls this. Claude starts with its normal permission prompts.
     */
    async createClaudeSession(cwd: string = process.cwd()): Promise<InjectionResult> {
        // Use clauderun command to start Claude (without pre-filling any commands)
        this.log.info(`Creating tmux session ${this.sessionName} in ${cwd} with clauderun`);
        try {
            await tmux(['new-session', '-d', '-s', this.sessionName, '-c', cwd, 'clauderun']);
            this.log.info('Tmux Claude session created successfully (clauderun)');
        } catch (error) {
            this.log.warn(`Failed to create tmux session with clauderun: ${(error as Error).message}`);
            // If clauderun fails, try the claude binary directly
            this.log.info('Fallback to full path command...');
            const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
            try {
                await tmux(['new-session', '-d', '-s', this.sessionName, '-c', cwd, claudePath]);
                this.log.info('Tmux Claude session created successfully (full path)');
            } catch (fallbackError) {
                this.log.error(`Failed to create tmux session with fallback: ${(fallbackError as Error).message}`);
                return { success: false, error: (fallbackError as Error).message };
            }
        }
        // Wait for Claude initialization
        await sleep(3000);
        return { success: true };
    }

    // Inject command into tmux session
    async injectCommand(command: string): Promise<InjectionResult> {
        try {
            const target = await resolvePaneTarget(this.sessionName, this.paneId);
            this.log.debug(`Injecting command via tmux (${target}): ${command}`);

            // 1. Clear input field
            await sendKeys(target, 'C-u');
            await sleep(200);
            // 2. Send command text literally
            await sendLiteral(target, command);
            await sleep(200);
            // 3. Send enter
            await sendKeys(target, 'C-m');

            this.log.debug('Command sent successfully in 3 steps');

            // Brief wait for command sending
            await sleep(1000);

            // Check if command is already displayed in Claude
            const capture = await this.getCaptureOutput();
            if (capture.success) {
                this.log.debug(`Claude state after injection: ${capture.output!.slice(-200).replace(/\n/g, ' ')}`);
            }

            // Report (never answer) a pending confirmation prompt
            await this.handleConfirmations();

            // Record injection log
            this.logInjection(command);

            return { success: true };
        } catch (error) {
            this.log.error(`Failed to inject command: ${(error as Error).message}`);
            return { success: false, error: (error as Error).message };
        }
    }

    /**
     * Detect whether Claude is now waiting on a confirmation/permission prompt.
     *
     * This used to auto-answer prompts (choosing "Yes, and don't ask again", typing
     * `y` + Enter whenever "(y/n)" or "Press Enter" appeared anywhere on screen),
     * which let any email command approve its own tool calls. Prompts are now only
     * reported; the user approves them from the terminal or the Telegram permission
     * notification.
     */
    async handleConfirmations(): Promise<boolean> {
        await sleep(1500);
        const capture = await this.getCaptureOutput();
        if (!capture.success) return false;

        const tail = capture.output!
            .split('\n')
            .map(l => l.trimEnd())
            .filter(l => l.trim().length > 0)
            .slice(-8);
        const pending = tail.some(line => CONFIRMATION_PATTERNS.some(re => re.test(line)));
        if (pending) {
            this.log.warn(`Claude in ${this.sessionName} is waiting for a confirmation — not auto-approving; answer it in the terminal or via Telegram`);
        }
        return pending;
    }

    // Get tmux session output
    async getCaptureOutput(): Promise<CaptureResult> {
        try {
            const target = await resolvePaneTarget(this.sessionName, this.paneId);
            return { success: true, output: await capturePane(target) };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    }

    // Restart Claude session (explicit use only — injection never calls this)
    async restartClaudeSession(cwd: string = process.cwd()): Promise<InjectionResult> {
        this.log.info('Restarting Claude tmux session...');

        // Kill existing session (exact target)
        try {
            await tmux(['kill-session', '-t', sessionTarget(this.sessionName)]);
        } catch { /* already gone */ }

        // Wait a moment
        await sleep(1000);

        // Create new session
        return this.createClaudeSession(cwd);
    }

    // Complete command injection workflow
    async injectCommandFull(token: string, command: string): Promise<InjectionResult> {
        try {
            this.log.debug(`Starting tmux command injection (Token: ${token})`);

            // 1. Check if tmux is available
            const tmuxAvailable = await this.checkTmuxAvailable();
            if (!tmuxAvailable) {
                return { success: false, error: 'tmux_not_installed', message: 'Need to install tmux: brew install tmux' };
            }

            // 2. The target session must still exist — never start a new Claude here
            const sessionExists = await this.checkClaudeSession();
            if (!sessionExists) {
                this.log.warn(`Claude tmux session '${this.sessionName}' not found — not injecting`);
                return {
                    success: false,
                    error: 'session_not_found',
                    message: `tmux session '${this.sessionName}' no longer exists`,
                };
            }

            // 3. Inject command
            const injectResult = await this.injectCommand(command);

            if (injectResult.success) {
                // 4. Send success notification
                await this.sendSuccessNotification(command);

                return {
                    success: true,
                    message: 'Command successfully injected into Claude tmux session',
                    session: this.sessionName
                };
            } else {
                return {
                    success: false,
                    error: 'injection_failed',
                    message: injectResult.error
                };
            }

        } catch (error) {
            this.log.error(`Tmux injection error: ${(error as Error).message}`);
            return { success: false, error: 'unexpected_error', message: (error as Error).message };
        }
    }

    // Send success notification (osascript argv + escaped AppleScript strings, no shell)
    async sendSuccessNotification(command: string): Promise<void> {
        if (process.platform !== 'darwin') return;
        const shortCommand = command.length > 30 ? command.substring(0, 30) + '...' : command;
        const notificationScript =
            `display notification ${appleScriptString('🎉 Command automatically injected into Claude! No manual operation needed')}` +
            ` with title "TaskPing Remote Control Success" subtitle ${appleScriptString(shortCommand)} sound name "Glass"`;

        execFile('osascript', ['-e', notificationScript], { timeout: 5000 }, (error) => {
            if (error) {
                this.log.warn('Failed to send success notification');
            } else {
                this.log.info('Success notification sent');
            }
        });
    }

    // Record injection log
    logInjection(command: string): void {
        const logEntry = {
            timestamp: new Date().toISOString(),
            command: command,
            session: this.sessionName,
            pid: process.pid
        };

        const logLine = JSON.stringify(logEntry) + '\n';

        try {
            fs.appendFileSync(this.logFile, logLine);
        } catch (error) {
            this.log.warn(`Failed to write injection log: ${(error as Error).message}`);
        }
    }

    // Get session status information (exact session name match)
    async getSessionInfo(): Promise<SessionInfo> {
        try {
            const out = await tmux(['list-sessions']);
            const line = out.split('\n').find(l => l.startsWith(`${this.sessionName}:`));
            if (!line) return { exists: false };
            return { exists: true, info: line.trim(), name: this.sessionName };
        } catch {
            return { exists: false };
        }
    }
}

export = TmuxInjector;
