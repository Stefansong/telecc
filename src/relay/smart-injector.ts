#!/usr/bin/env node

/**
 * Smart Command Injector - Multiple methods to ensure commands reach Claude Code
 *
 * Only method 1 actually injects (paste into the frontmost app, and only when that
 * app is a terminal). The other methods hand the command to the user (clipboard +
 * notification / file) and therefore report `success: false` so the caller doesn't
 * mark the email as processed. All osascript calls use execFile argv with escaped
 * AppleScript strings — command text never passes through a shell.
 */

import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface LoggerLike {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
}

interface InjectionResult {
    success: boolean;
    /** The command was handed to the user (clipboard/file + notification) instead of injected. */
    manual?: boolean;
    error?: string;
    message?: string;
}

/**
 * Apps it's acceptable to paste into — mirrors ClipboardAutomation's allowlist.
 * Anything else (browser, Obsidian, chat apps...) would receive the email text.
 */
const ALLOWED_FRONTMOST_APPS = [
    'Terminal',
    'iTerm2',
    'iTerm',
    'Claude',
    'Claude Code',
    'Visual Studio Code',
    'Code',
    'Cursor',
    'Warp',
    'WezTerm',
    'Alacritty',
    'Ghostty',
    'kitty',
    'Hyper',
];

/** pbcopy/pbpaste pick their text encoding from LANG; without it CJK text is garbled. */
const CLIPBOARD_ENV = { ...process.env, LANG: 'en_US.UTF-8' };

/** AppleScript string literal with `\` and `"` escaped (for osascript argv, never a shell). */
function appleScriptString(str: string): string {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class SmartInjector {
    log: LoggerLike;
    tempDir: string;

    constructor(logger?: LoggerLike) {
        this.log = logger || console;
        this.tempDir = path.join(__dirname, '../temp');
        this.ensureTempDir();
    }

    ensureTempDir(): void {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /** Returns true only when the command was actually injected (not merely handed off). */
    async injectCommand(token: string, command: string): Promise<boolean> {
        this.log.info(`Smart command injection: ${command.slice(0, 50)}...`);

        const methods = [
            this.tryAppleScriptInjection.bind(this),
            this.tryFileDropInjection.bind(this),
            this.tryClipboardWithPersistentNotification.bind(this),
            this.tryUrgentClipboard.bind(this)
        ];

        for (let i = 0; i < methods.length; i++) {
            const methodName = ['AppleScript Auto-injection', 'File Drag Injection', 'Persistent Notification Injection', 'Emergency Clipboard'][i];

            try {
                this.log.info(`Trying method ${i + 1}: ${methodName}`);
                const result = await methods[i](token, command);

                if (result.success) {
                    this.log.info(`${methodName} successful: ${result.message}`);
                    return true;
                } else if (result.manual) {
                    // The user has been told how to paste it; stop here, but it was NOT injected
                    this.log.warn(`${methodName}: ${result.message} — command handed off for manual paste, not injected`);
                    return false;
                } else {
                    this.log.warn(`${methodName} failed: ${result.error}`);
                }
            } catch (error: unknown) {
                this.log.error(`${methodName} exception: ${(error as Error).message}`);
            }
        }

        this.log.error('All injection methods failed');
        return false;
    }

    // Method 1: AppleScript Auto-injection — paste only into a frontmost terminal app
    async tryAppleScriptInjection(token: string, command: string): Promise<InjectionResult> {
        if (process.platform !== 'darwin') {
            return { success: false, error: 'not_supported_on_platform' };
        }

        await this.copyToClipboard(command);

        // Check the frontmost app and paste in the same script, so focus can't move in between
        const allowList = `{${ALLOWED_FRONTMOST_APPS.map(appleScriptString).join(', ')}}`;
        const script = `
                tell application "System Events"
                    set activeApp to name of first application process whose frontmost is true
                    if activeApp is not in ${allowList} then return "not_terminal:" & activeApp
                    keystroke "v" using command down
                    delay 0.3
                    keystroke return
                    return "success"
                end tell
                `;

        const { error, stdout } = await this.runOsascript(script);
        if (error) {
            if (error.message.includes('1002') || error.message.includes('not allowed')) {
                return { success: false, error: 'permission_denied' };
            }
            return { success: false, error: error.message };
        }
        const result = stdout.trim();
        if (result === 'success') {
            return { success: true, message: 'Auto-paste successful' };
        }
        if (result.startsWith('not_terminal:')) {
            return { success: false, error: `frontmost app "${result.slice('not_terminal:'.length)}" is not a terminal — refusing to paste` };
        }
        return { success: false, error: result || 'unknown_result' };
    }

    // Method 2: File Drag Injection (manual: the user drags the file into Claude Code)
    async tryFileDropInjection(token: string, command: string): Promise<InjectionResult> {
        try {
            // Create temporary command file
            const fileName = `taskping-command-${token.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`;
            const filePath = path.join(this.tempDir, fileName);

            fs.writeFileSync(filePath, command);

            // Copy file path to clipboard
            await this.copyToClipboard(filePath);

            // Send notification to guide user
            const notified = await this.notify(
                'Command file created and path copied to clipboard!\n1. Press Cmd+G in Finder and paste path\n2. Drag file to Claude Code window',
                'TaskPing File Injection',
                `Drag file: ${fileName}`,
                'Glass'
            );

            // Try to open Finder at the target directory
            await new Promise<void>(resolve => {
                execFile('open', [this.tempDir], { timeout: 5000 }, () => resolve());
            });

            if (!notified) {
                return { success: false, error: 'notification_failed' };
            }
            // Nothing was injected — the user still has to drag the file in
            return { success: false, manual: true, message: `File ${fileName} created, notification sent` };
        } catch (error: unknown) {
            return { success: false, error: (error as Error).message };
        }
    }

    // Method 3: Persistent Notification Injection (manual: the user pastes)
    async tryClipboardWithPersistentNotification(token: string, command: string): Promise<InjectionResult> {
        try {
            await this.copyToClipboard(command);
        } catch (error: unknown) {
            return { success: false, error: (error as Error).message };
        }

        // Send multiple notifications to ensure user sees them
        const notifications = [
            { delay: 0, sound: 'Basso', message: 'Email command copied! Please paste immediately to Claude Code (Cmd+V)' },
            { delay: 3000, sound: 'Ping', message: 'Reminder: Command still in clipboard, please paste and execute' },
            { delay: 8000, sound: 'Purr', message: 'Final reminder: Press Cmd+V in Claude Code to paste command' }
        ];

        const results = await Promise.all(notifications.map((notif, index) => new Promise<boolean>(resolve => {
            setTimeout(() => {
                this.notify(notif.message, `TaskPing Persistent Reminder ${index + 1}/3`, `${command.slice(0, 30)}...`, notif.sound)
                    .then(resolve);
            }, notif.delay);
        })));

        if (!results.some(Boolean)) {
            return { success: false, error: 'notification_failed' };
        }
        return { success: false, manual: true, message: 'Command copied to clipboard, persistent notifications sent' };
    }

    // Method 4: Emergency Clipboard (last resort, manual: the user pastes)
    async tryUrgentClipboard(token: string, command: string): Promise<InjectionResult> {
        try {
            await this.copyToClipboard(command);
        } catch (error: unknown) {
            return { success: false, error: (error as Error).message };
        }

        // (No executable Desktop shortcut any more: it embedded the email text in a
        // shell script, so a crafted command ran when the file was double-clicked.)
        const notified = await this.notify(
            'Emergency Mode: command copied to clipboard\nPress Cmd+V in Claude Code to paste it',
            'TaskPing Emergency Mode',
            `Command: ${command.slice(0, 20)}...`,
            'Sosumi'
        );
        if (!notified) {
            return { success: false, error: 'notification_failed' };
        }
        return { success: false, manual: true, message: 'Emergency mode: command left in clipboard' };
    }

    /** Show a macOS notification; every user-derived string is AppleScript-escaped. */
    async notify(message: string, title: string, subtitle: string, sound: string): Promise<boolean> {
        if (process.platform !== 'darwin') return false;
        const script =
            `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}` +
            ` subtitle ${appleScriptString(subtitle)} sound name ${appleScriptString(sound)}`;
        const { error } = await this.runOsascript(script);
        return !error;
    }

    /** Run an AppleScript via `osascript -e` (argv, no shell). */
    runOsascript(script: string): Promise<{ error: Error | null; stdout: string }> {
        return new Promise(resolve => {
            execFile('osascript', ['-e', script], { timeout: 10000 }, (error, stdout) => {
                resolve({ error, stdout: String(stdout || '') });
            });
        });
    }

    // Helper method: Copy to clipboard
    async copyToClipboard(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const pbcopy = spawn('pbcopy', [], { env: CLIPBOARD_ENV });
            pbcopy.on('error', reject);
            pbcopy.stdin.on('error', () => { /* reported via 'close'/'error' */ });
            pbcopy.stdin.write(text);
            pbcopy.stdin.end();

            pbcopy.on('close', (code: number | null) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`pbcopy failed with code ${code}`));
                }
            });
        });
    }

    // Clean up temporary files
    cleanup(): void {
        try {
            if (fs.existsSync(this.tempDir)) {
                const files = fs.readdirSync(this.tempDir);
                const now = Date.now();

                files.forEach(file => {
                    const filePath = path.join(this.tempDir, file);
                    const stats = fs.statSync(filePath);
                    const age = now - stats.mtime.getTime();

                    // Delete temporary files older than 1 hour
                    if (age > 60 * 60 * 1000) {
                        fs.unlinkSync(filePath);
                    }
                });
            }
        } catch (error: unknown) {
            this.log.warn(`Failed to clean up temporary files: ${(error as Error).message}`);
        }
    }
}

export = SmartInjector;
