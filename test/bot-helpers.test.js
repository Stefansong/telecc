import { describe, it, expect, beforeAll } from 'vitest';

// The bot module exits at load without these; VITEST (set by vitest) keeps it from
// starting the polling daemon, so only its pure helpers are exercised here.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:test-token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1';

let bot;

beforeAll(async () => {
  bot = await import('../workspace-telegram-bot.js');
});

describe('entitiesToHtml', () => {
  it('escapes plain text with no entities', () => {
    expect(bot.entitiesToHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
  });

  it('restores bold / code / italic entities', () => {
    // "❓ Question — my_ws" with "Question" bold and "my_ws" code
    const text = 'Q: my_ws done';
    const html = bot.entitiesToHtml(text, [
      { type: 'bold', offset: 0, length: 2 },
      { type: 'code', offset: 3, length: 5 },
      { type: 'italic', offset: 9, length: 4 },
    ]);
    expect(html).toBe('<b>Q:</b> <code>my_ws</code> <i>done</i>');
  });

  it('nests entities correctly (inner closes first)', () => {
    const html = bot.entitiesToHtml('abcdef', [
      { type: 'italic', offset: 2, length: 4 },
      { type: 'bold', offset: 0, length: 6 },
    ]);
    expect(html).toBe('<b>ab<i>cdef</i></b>');
  });

  it('handles adjacent entities and links', () => {
    const html = bot.entitiesToHtml('xy', [
      { type: 'bold', offset: 0, length: 1 },
      { type: 'text_link', offset: 1, length: 1, url: 'https://e.x/?a=1&b="2"' },
    ]);
    expect(html).toBe('<b>x</b><a href="https://e.x/?a=1&amp;b=&quot;2&quot;">y</a>');
  });

  it('ignores auto-detected and out-of-range entities', () => {
    const html = bot.entitiesToHtml('see https://x.y', [
      { type: 'url', offset: 4, length: 11 },
      { type: 'bold', offset: 10, length: 50 },
    ]);
    expect(html).toBe('see https://x.y');
  });

  it('uses UTF-16 offsets (emoji / CJK before an entity)', () => {
    const text = '\u{1F50C} 中文 *x*';
    const offset = text.indexOf('*x*');
    const html = bot.entitiesToHtml(text, [{ type: 'bold', offset, length: 3 }]);
    expect(html).toBe('\u{1F50C} 中文 <b>*x*</b>');
  });
});

describe('buildEditHtml', () => {
  it('appends a status suffix to the rebuilt original', () => {
    const html = bot.buildEditHtml('Allow rm_rf?', [{ type: 'bold', offset: 0, length: 5 }], '\n\n— ✅ Allowed');
    expect(html).toBe('<b>Allow</b> rm_rf?\n\n— ✅ Allowed');
  });

  it('keeps the total within 4096 visible characters', () => {
    const text = 'x'.repeat(4096);
    const suffix = '\n\n✔ Selected: <b>' + 'y'.repeat(50) + '</b>';
    const html = bot.buildEditHtml(text, [{ type: 'bold', offset: 4000, length: 96 }], suffix);
    expect(bot.htmlVisibleLength(html)).toBeLessThanOrEqual(4096);
    expect(html.endsWith(suffix)).toBe(true);
    expect(html).toContain('…');
    // A truncated entity is clamped, not dropped mid-tag
    expect((html.match(/<b>/g) || []).length).toBe((html.match(/<\/b>/g) || []).length);
  });

  it('does not split a surrogate pair when truncating', () => {
    const text = 'a' + '\u{1F600}'.repeat(10);
    const html = bot.buildEditHtml(text, [], '', 4);
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(bot.htmlVisibleLength(html)).toBeLessThanOrEqual(4);
  });
});

describe('htmlToPlain / tailText', () => {
  it('decodes entities instead of leaking them', () => {
    expect(bot.htmlToPlain('<b>a &lt;b&gt; &amp;amp;</b>')).toBe('a <b> &amp;');
  });

  it('keeps the tail, preferring a line boundary', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const tail = bot.tailText(text, 40);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.startsWith('…line ')).toBe(true);
    expect(tail.endsWith('line 49')).toBe(true);
    expect(bot.tailText('short', 40)).toBe('short');
  });
});

describe('menu callback keys', () => {
  it('stays within 64 bytes for long CJK project names', () => {
    const payload = {
      name: '超长的中文项目名称'.repeat(10),
      path: '/Users/someone/项目/' + '很长的路径'.repeat(20),
      sessionId: '0c9a7c4e-3b1a-4d5e-9f00-1234567890ab',
    };
    for (const kind of ['new', 'rp', 'rs', 'rc', 'rpall']) {
      const data = bot.encodeMenuCallback(kind, bot.menuKeyFor(payload));
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      expect(bot.parseMenuCallback(data)).toEqual({ kind, key: bot.menuKeyFor(payload) });
    }
  });

  it('gives different conversations of one project different keys', () => {
    const a = bot.menuKeyFor({ name: 'p', path: '/p', sessionId: 'aaaaaaaa-1' });
    const b = bot.menuKeyFor({ name: 'p', path: '/p', sessionId: 'bbbbbbbb-2' });
    expect(a).not.toBe(b);
    expect(bot.menuKeyFor({ name: 'p', path: '/p', sessionId: 'aaaaaaaa-1' })).toBe(a);
  });

  it('does not treat legacy name/index buttons as keyed buttons', () => {
    expect(bot.parseMenuCallback('new:my-project')).toBeNull();
    expect(bot.parseMenuCallback('rs:my-project:0')).toBeNull();
    expect(bot.parseMenuCallback('perm:abc12345:allow')).toBeNull();
  });
});

describe('parseSlashMessage', () => {
  it('splits /workspace text', () => {
    expect(bot.parseSlashMessage('/assistant hello\nworld')).toEqual({
      token: 'assistant', rest: 'hello\nworld', isPath: false,
    });
  });

  it('flags a leading path as text, not a command', () => {
    expect(bot.parseSlashMessage('/Users/x/main.py 有bug').isPath).toBe(true);
    expect(bot.parseSlashMessage('/tmp/log.txt').isPath).toBe(true);
  });

  it('keeps Claude slash commands as commands', () => {
    expect(bot.parseSlashMessage('/review src/api')).toEqual({ token: 'review', rest: 'src/api', isPath: false });
    expect(bot.parseSlashMessage('/cost')).toEqual({ token: 'cost', rest: null, isPath: false });
  });

  it('returns null for a lone slash', () => {
    expect(bot.parseSlashMessage('/')).toBeNull();
  });
});

describe('isLocalClaudeCommand', () => {
  it('detects built-in local commands that never produce UserPromptSubmit/Stop', () => {
    for (const t of ['/model opus', '/effort high', '/compact', '/cost', '/CLEAR', '  /context  ']) {
      expect(bot.isLocalClaudeCommand(t)).toBe(true);
    }
  });

  it('leaves prompts and prompt-based slash commands to be marked', () => {
    for (const t of ['/review src/api', '/init', '/my-custom-cmd arg', 'fix the /model bug', '/models', '/Users/x.py']) {
      expect(bot.isLocalClaudeCommand(t)).toBe(false);
    }
  });
});

describe('decideTerminalState', () => {
  it('relaunches in a tmux pane that is back at its shell prompt', () => {
    expect(bot.decideTerminalState({ backend: 'tmux', ended: true, atShellPrompt: true })).toBe('shell');
    // even without a SessionEnd record (e.g. Claude crashed)
    expect(bot.decideTerminalState({ backend: 'tmux', ended: false, atShellPrompt: true })).toBe('shell');
  });

  it('never types into an ended pane that another program owns', () => {
    expect(bot.decideTerminalState({ backend: 'tmux', ended: true, atShellPrompt: false })).toBe('busy');
  });

  it('treats a live tmux pane as running Claude', () => {
    expect(bot.decideTerminalState({ backend: 'tmux', ended: false, atShellPrompt: false })).toBe('claude');
  });

  it('uses SessionEnd as the only Ghostty signal', () => {
    expect(bot.decideTerminalState({ backend: 'ghostty', ended: true })).toBe('shell');
    expect(bot.decideTerminalState({ backend: 'ghostty', ended: false })).toBe('claude');
  });

  it('treats a live PTY handle as Claude itself', () => {
    expect(bot.decideTerminalState({ backend: 'pty', ended: true })).toBe('claude');
  });
});
