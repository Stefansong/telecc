/**
 * Clipboard Automation
 * Send commands to Claude Code via clipboard and keyboard automation
 */

import { spawn } from 'child_process';
import Logger from '../core/logger';

/**
 * pbcopy/pbpaste choose their text encoding from LANG; under launchd/cron LANG is
 * often unset and CJK text round-trips as garbage. Force UTF-8 for both.
 */
const CLIPBOARD_ENV = { ...process.env, LANG: 'en_US.UTF-8' };

/** Give the target app a moment to read the pasteboard before it is restored. */
const RESTORE_DELAY_MS = 500;

class ClipboardAutomation {
    logger: Logger;

    constructor() {
        this.logger = new Logger('ClipboardAutomation');
    }

    /**
     * Send command to Claude Code (via clipboard)
     */
    async sendCommand(command: string): Promise<boolean> {
        // Step 0: Save the user's clipboard (text) so it can be put back afterwards.
        // null = couldn't read it → leave the clipboard alone at the end.
        const saved = await this._readClipboard();
        let copied = false;

        try {
            // Step 1: Copy command to clipboard
            await this._copyToClipboard(command);
            copied = true;

            // Step 2: Activate Claude Code and paste
            const success = await this._activateAndPaste();

            if (success) {
                this.logger.info('Command sent successfully via clipboard automation');
                return true;
            } else {
                this.logger.warn('Failed to activate Claude Code, trying fallback');
                // Try generic approach
                return await this._sendToActiveWindow(command);
            }

        } catch (error: unknown) {
            this.logger.error('Clipboard automation failed:', (error as Error).message);
            return false;
        } finally {
            if (copied && saved !== null) {
                await new Promise<void>(resolve => setTimeout(resolve, RESTORE_DELAY_MS));
                try {
                    await this._copyToClipboard(saved);
                    this.logger.debug('Restored previous clipboard contents');
                } catch (restoreError: unknown) {
                    this.logger.warn('Failed to restore clipboard:', (restoreError as Error).message);
                }
            }
        }
    }

    /**
     * Read the clipboard as text (UTF-8). Returns null when it can't be read
     * (unsupported platform, tool missing), so callers don't "restore" garbage.
     */
    async _readClipboard(): Promise<string | null> {
        const run = (cmd: string, args: string[]): Promise<string | null> => new Promise((resolve) => {
            const child = spawn(cmd, args, { env: CLIPBOARD_ENV });
            const chunks: Buffer[] = [];
            child.stdout.on('data', (data: Buffer) => chunks.push(data));
            child.on('error', () => resolve(null));
            child.on('close', (code: number | null) => {
                resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
            });
        });

        if (process.platform === 'darwin') {
            return run('pbpaste', []);
        }
        if (process.platform === 'linux') {
            return (await run('xclip', ['-selection', 'clipboard', '-o'])) ?? run('xsel', ['--clipboard', '--output']);
        }
        return null;
    }

    /**
     * Copy text to clipboard
     */
    async _copyToClipboard(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (process.platform === 'darwin') {
                // macOS
                const pbcopy = spawn('pbcopy', [], { env: CLIPBOARD_ENV });
                pbcopy.stdin.on('error', () => { /* reported via close/error */ });
                pbcopy.stdin.write(text);
                pbcopy.stdin.end();

                pbcopy.on('close', (code: number | null) => {
                    if (code === 0) {
                        this.logger.debug('Text copied to clipboard');
                        resolve();
                    } else {
                        reject(new Error('Failed to copy to clipboard'));
                    }
                });

                pbcopy.on('error', reject);
            } else if (process.platform === 'linux') {
                // Linux (requires xclip or xsel)
                const tryXsel = () => {
                    const xsel = spawn('xsel', ['--clipboard', '--input']);
                    xsel.on('error', () => reject(new Error('Failed to copy to clipboard (xclip/xsel not available)')));
                    xsel.stdin.on('error', () => {});
                    xsel.stdin.write(text);
                    xsel.stdin.end();

                    xsel.on('close', (code2: number | null) => {
                        if (code2 === 0) {
                            resolve();
                        } else {
                            reject(new Error('Failed to copy to clipboard (xclip/xsel not available)'));
                        }
                    });
                };

                const xclip = spawn('xclip', ['-selection', 'clipboard']);
                let fellBack = false;
                const fallback = () => { if (!fellBack) { fellBack = true; tryXsel(); } };
                xclip.on('error', fallback);
                xclip.stdin.on('error', () => {});
                xclip.stdin.write(text);
                xclip.stdin.end();

                xclip.on('close', (code: number | null) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        // Try xsel
                        fallback();
                    }
                });
            } else {
                reject(new Error('Clipboard automation not supported on this platform'));
            }
        });
    }

    /**
     * Activate Claude Code and paste command
     */
    async _activateAndPaste(): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }

        return new Promise((resolve) => {
            const script = `
                tell application "System Events"
                    -- Try to find Claude Code related applications
                    set targetApps to {"Claude Code", "Terminal", "iTerm2", "iTerm", "Visual Studio Code", "Code", "Cursor"}
                    set foundApp to null
                    set appName to ""

                    repeat with currentApp in targetApps
                        try
                            if application process currentApp exists then
                                set foundApp to application process currentApp
                                set appName to currentApp
                                exit repeat
                            end if
                        end try
                    end repeat

                    if foundApp is not null then
                        -- Activate application
                        set frontmost of foundApp to true
                        delay 0.5

                        -- Try to find input box and click
                        try
                            -- For some applications, may need to click specific input area
                            if appName is "Claude Code" then
                                -- Claude Code specific handling
                                key code 125 -- Down arrow, ensure cursor is in input box
                                delay 0.2
                            end if

                            -- Paste content
                            keystroke "v" using command down
                            delay 0.3

                            -- Send command (Enter)
                            keystroke return

                            return "success"
                        on error errorMessage
                            return "paste_failed: " & errorMessage
                        end try
                    else
                        return "no_app_found"
                    end if
                end tell
            `;

            const osascript = spawn('osascript', ['-e', script]);
            let output = '';
            let error = '';

            osascript.stdout.on('data', (data: Buffer) => {
                output += data.toString().trim();
            });

            osascript.stderr.on('data', (data: Buffer) => {
                error += data.toString();
            });

            osascript.on('close', (code: number | null) => {
                if (code === 0 && output === 'success') {
                    this.logger.debug('Successfully activated app and pasted command');
                    resolve(true);
                } else {
                    this.logger.warn('AppleScript execution result:', { code, output, error });
                    resolve(false);
                }
            });

            osascript.on('error', (err: Error) => {
                this.logger.error('AppleScript execution error:', err.message);
                resolve(false);
            });
        });
    }

    /**
     * Send to current active window (generic approach)
     * Only pastes when the frontmost app is a known terminal/editor —
     * otherwise the keystrokes leak into whatever the user is using (Obsidian, browser, etc.).
     */
    async _sendToActiveWindow(command: string): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }

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

        return new Promise((resolve) => {
            const script = `
                tell application "System Events"
                    set activeApp to name of first application process whose frontmost is true
                    return activeApp
                end tell
            `;

            const probe = spawn('osascript', ['-e', script]);
            let activeApp = '';

            probe.stdout.on('data', (data: Buffer) => {
                activeApp += data.toString().trim();
            });

            probe.on('close', (code: number | null) => {
                if (code !== 0) {
                    resolve(false);
                    return;
                }

                if (!ALLOWED_FRONTMOST_APPS.includes(activeApp)) {
                    this.logger.warn(
                        `Refusing to paste into non-terminal app "${activeApp}" — message dropped to avoid leaking into Obsidian/Notion/browser. Grant Accessibility permission to your terminal to fix the primary path.`
                    );
                    resolve(false);
                    return;
                }

                const pasteScript = `
                    tell application "System Events"
                        keystroke "v" using command down
                        delay 0.3
                        keystroke return
                    end tell
                `;

                const paste = spawn('osascript', ['-e', pasteScript]);
                paste.on('close', (pasteCode: number | null) => {
                    if (pasteCode === 0) {
                        this.logger.debug(`Command sent to active terminal app: ${activeApp}`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                });
                paste.on('error', () => resolve(false));
            });

            probe.on('error', () => resolve(false));
        });
    }

    /**
     * Check if clipboard automation is supported
     */
    isSupported(): boolean {
        return process.platform === 'darwin' || process.platform === 'linux';
    }

    /**
     * Get current clipboard content (for testing)
     */
    async getClipboardContent(): Promise<string | null> {
        if (process.platform === 'darwin') {
            return new Promise((resolve, reject) => {
                const pbpaste = spawn('pbpaste', [], { env: CLIPBOARD_ENV });
                const chunks: Buffer[] = [];

                pbpaste.stdout.on('data', (data: Buffer) => {
                    chunks.push(data);
                });

                pbpaste.on('error', reject);
                pbpaste.on('close', (code: number | null) => {
                    if (code === 0) {
                        resolve(Buffer.concat(chunks).toString('utf8'));
                    } else {
                        reject(new Error('Failed to read clipboard'));
                    }
                });
            });
        }
        return null;
    }
}

export = ClipboardAutomation;
