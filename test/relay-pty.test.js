import { describe, it, expect, beforeAll, vi } from 'vitest';

// Keep the import hermetic: no pino worker, no node-imap/node-pty/mailparser loading.
vi.mock('../src/utils/optional-require', () => ({
  optionalRequire: () => null,
  getUUID: () => () => '00000000-0000-4000-8000-000000000000',
}));

let relay;

beforeAll(async () => {
  process.env.ALLOWED_SENDERS = 'Me@Example.com, ops@corp.test ,@team.test';
  process.env.LOG_LEVEL = 'error';
  vi.resetModules();
  relay = await import('../src/relay/relay-pty.ts');
});

const from = (...addresses) => ({
  text: addresses.join(', '),
  value: addresses.map(address => ({ address, name: '' })),
});

describe('deduplicateCommand', () => {
  it('never collapses short repeated strings', () => {
    for (const s of ['11', '哈哈', '哈哈哈哈', 'okok', 'ok ok', 'yes yes', 'abab', '继续继续', '😀😀', 'aa']) {
      expect(relay.deduplicateCommand(s)).toBe(s);
    }
  });

  it('never collapses a single repeated character, however long', () => {
    const eq = '='.repeat(40);
    const ha = '哈'.repeat(30);
    expect(relay.deduplicateCommand(eq)).toBe(eq);
    expect(relay.deduplicateCommand(ha)).toBe(ha);
  });

  it('never collapses a unit that is itself periodic', () => {
    const s = 'hahahahahahahahahahahaha';
    expect(relay.deduplicateCommand(s)).toBe(s);
  });

  it('collapses a long command pasted twice back to back', () => {
    expect(relay.deduplicateCommand('please refactor the parserplease refactor the parser'))
      .toBe('please refactor the parser');
  });

  it('collapses a long command duplicated with whitespace / newline between copies', () => {
    expect(relay.deduplicateCommand('drink cola okay drink cola okay')).toBe('drink cola okay');
    expect(relay.deduplicateCommand('run the full test suite\nrun the full test suite')).toBe('run the full test suite');
    expect(relay.deduplicateCommand('修复登录页面的样式问题吧\r\n修复登录页面的样式问题吧')).toBe('修复登录页面的样式问题吧');
  });

  it('leaves three copies, partial repeats and distinct text alone', () => {
    const three = 'run the full test suite run the full test suite run the full test suite';
    expect(relay.deduplicateCommand(three)).toBe(three);
    const partial = 'run the full test suite run the full test';
    expect(relay.deduplicateCommand(partial)).toBe(partial);
    const normal = 'fix the bug in workspace-router.ts and add tests';
    expect(relay.deduplicateCommand(normal)).toBe(normal);
  });

  it('handles empty input', () => {
    expect(relay.deduplicateCommand('')).toBe('');
  });
});

describe('cleanEmailText', () => {
  it('keeps short and CJK commands intact', () => {
    expect(relay.cleanEmailText('11')).toBe('11');
    expect(relay.cleanEmailText('哈哈')).toBe('哈哈');
  });
});

describe('isAllowed (sender allow-list)', () => {
  it('accepts an allowed address exactly, case-insensitively', () => {
    expect(relay.isAllowed(from('me@example.com'))).toBe(true);
    expect(relay.isAllowed(from('ME@EXAMPLE.COM'))).toBe(true);
    expect(relay.isAllowed(from('ops@corp.test'))).toBe(true);
  });

  it('rejects an allowed address that only appears in the display name', () => {
    const spoofed = {
      text: '"me@example.com" <attacker@evil.test>',
      value: [{ name: 'me@example.com', address: 'attacker@evil.test' }],
    };
    expect(relay.isAllowed(spoofed)).toBe(false);
  });

  it('rejects addresses that merely contain an allowed one', () => {
    expect(relay.isAllowed(from('xme@example.com'))).toBe(false);
    expect(relay.isAllowed(from('me@example.com.evil.test'))).toBe(false);
  });

  it('supports @domain entries with an exact domain match', () => {
    expect(relay.isAllowed(from('anyone@team.test'))).toBe(true);
    expect(relay.isAllowed(from('anyone@evilteam.test'))).toBe(false);
    expect(relay.isAllowed(from('anyone@sub.team.test'))).toBe(false);
  });

  it('requires every From address to be allowed', () => {
    expect(relay.isAllowed(from('me@example.com', 'attacker@evil.test'))).toBe(false);
    expect(relay.isAllowed(from('me@example.com', 'ops@corp.test'))).toBe(true);
  });

  it('walks address groups', () => {
    const grouped = { text: 'grp', value: [{ name: 'grp', group: [{ address: 'attacker@evil.test' }] }] };
    expect(relay.isAllowed(grouped)).toBe(false);
    const ok = { text: 'grp', value: [{ name: 'grp', group: [{ address: 'me@example.com' }] }] };
    expect(relay.isAllowed(ok)).toBe(true);
  });

  it('fails closed on missing/empty sender or empty allow-list', () => {
    expect(relay.isAllowed(undefined)).toBe(false);
    expect(relay.isAllowed({ text: 'me@example.com' })).toBe(false); // text only, no parsed value
    expect(relay.isAllowed(from('me@example.com'), [])).toBe(false);
  });

  it('extractSenderAddresses lower-cases and trims parsed addresses', () => {
    expect(relay.extractSenderAddresses(from(' Me@Example.com '))).toEqual(['me@example.com']);
  });
});
