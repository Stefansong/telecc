/**
 * Controller Injector
 * Injects commands into tmux sessions or PTY
 */

import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import Logger from '../core/logger';
import { PROJECT_ROOT } from './paths';
import { hasSession, resolvePaneTarget, sendLiteral, sendKeys } from './tmux';
import { readJsonSafe } from './atomic-json';
import type { SessionEntry } from '../types/session';

interface ControllerInjectorConfig {
    mode?: string;
    defaultSession?: string;
}

interface SessionInfo {
    ptyPath?: string;
    [key: string]: unknown;
}

interface SessionMap {
    [sessionName: string]: SessionInfo;
}

class ControllerInjector {
    logger: Logger;
    mode: string;
    defaultSession: string;

    constructor(config: ControllerInjectorConfig = {}) {
        this.logger = new Logger('ControllerInjector');
        this.mode = config.mode || process.env.INJECTION_MODE || 'pty';
        this.defaultSession = config.defaultSession || process.env.TMUX_SESSION || 'claude-code';
    }

    async injectCommand(command: string, sessionName: string | null = null): Promise<boolean> {
        const session = sessionName || this.defaultSession;

        if (this.mode === 'tmux') {
            return this._injectTmux(command, session);
        } else {
            return this._injectPty(command, session);
        }
    }

    async _injectTmux(command: string, sessionName: string): Promise<boolean> {
        try {
            // Check if tmux session exists (exact name match, no prefix fallback)
            if (!await hasSession(sessionName)) {
                throw new Error(`Tmux session '${sessionName}' not found`);
            }

            const target = await resolvePaneTarget(sessionName, this._recordedPane(sessionName));
            // Send the text literally (send-keys -l --: no shell, no key-name parsing)
            await sendLiteral(target, command);
            // Then send Enter as separate command
            await sendKeys(target, 'Enter');

            this.logger.info(`Command injected to tmux session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via tmux:', (error as Error).message);
            throw error;
        }
    }

    /** Pane id ($TMUX_PANE) recorded by the hooks for the newest live entry of this tmux session. */
    _recordedPane(sessionName: string): string | undefined {
        const sessionMapPath = process.env.SESSION_MAP_PATH ||
                               path.join(PROJECT_ROOT, 'src/data/session-map.json');
        try {
            const map = readJsonSafe<Record<string, Partial<SessionEntry>>>(sessionMapPath, {});
            let best: Partial<SessionEntry> | undefined;
            for (const entry of Object.values(map || {})) {
                if (!entry || entry.tmuxSession !== sessionName || entry.endedAt || !entry.tmuxPane) continue;
                if (!best || (entry.createdAt || 0) > (best.createdAt || 0)) best = entry;
            }
            return best?.tmuxPane;
        } catch {
            return undefined;
        }
    }

    _injectPty(command: string, sessionName: string): boolean {
        try {
            // Find PTY session file
            const sessionMapPath = process.env.SESSION_MAP_PATH ||
                                   path.join(PROJECT_ROOT, 'src/data/session-map.json');

            if (!fs.existsSync(sessionMapPath)) {
                throw new Error('Session map file not found');
            }

            const sessionMap: SessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
            const sessionInfo = sessionMap[sessionName];

            if (!sessionInfo || !sessionInfo.ptyPath) {
                throw new Error(`PTY session '${sessionName}' not found`);
            }

            // Write command to PTY
            fs.writeFileSync(sessionInfo.ptyPath, command + '\n');

            this.logger.info(`Command injected to PTY session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via PTY:', (error as Error).message);
            throw error;
        }
    }

    listSessions(): string[] {
        if (this.mode === 'tmux') {
            try {
                const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 5000,
                });
                return output.trim().split('\n').filter(Boolean);
            } catch (error) {
                return [];
            }
        } else {
            try {
                const sessionMapPath = process.env.SESSION_MAP_PATH ||
                                       path.join(PROJECT_ROOT, 'src/data/session-map.json');

                if (!fs.existsSync(sessionMapPath)) {
                    return [];
                }

                const sessionMap: SessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
                return Object.keys(sessionMap);
            } catch (error) {
                return [];
            }
        }
    }
}

export = ControllerInjector;
