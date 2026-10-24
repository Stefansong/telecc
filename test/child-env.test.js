import { describe, it, expect } from 'vitest';
import { childEnv, isOwnConfigKey } from '../src/utils/child-env.js';

describe('childEnv', () => {
  it('drops the daemon\'s own configuration and keeps everything else', () => {
    const env = childEnv({
      TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '1', TELEGRAM_ENABLED: 'true',
      LINE_CHANNEL_SECRET: 'x', PROMPTS_DIR: '/p', SESSION_MAP_PATH: '/m', CCGRAM_DATA_DIR: '/d',
      PATH: '/usr/bin', HOME: '/Users/me', TMUX: '/tmp/tmux-1/default,1,0', ANTHROPIC_API_KEY: 'keep',
    });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'PATH', 'TMUX']);
  });

  it('classifies keys', () => {
    expect(isOwnConfigKey('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(isOwnConfigKey('HEALTH_PORT')).toBe(true);
    expect(isOwnConfigKey('PATH')).toBe(false);
    expect(isOwnConfigKey('TELEGRAMMY')).toBe(false);
  });
});
