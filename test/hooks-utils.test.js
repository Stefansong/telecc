import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir;
let hu;
let bridge;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-utils-test-'));
  process.env.PROMPTS_DIR = testDir;
  vi.resetModules();
  hu = await import('../src/utils/hook-utils.js');
  bridge = await import('../prompt-bridge.js');
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.PROMPTS_DIR;
});

/** Telegram-HTML well-formedness: only known tags, balanced, properly nested, no raw '<'/'>'/'&'. */
function assertWellFormed(html) {
  const allowed = new Set(['b', 'i', 'code', 'pre']);
  const stack = [];
  const re = /<(\/?)([a-z]+)>/g;
  let last = 0;
  let m;
  const textParts = [];
  while ((m = re.exec(html))) {
    textParts.push(html.slice(last, m.index));
    last = re.lastIndex;
    const [, closing, tag] = m;
    expect(allowed.has(tag)).toBe(true);
    if (closing) {
      expect(stack.pop()).toBe(tag);
    } else {
      stack.push(tag);
    }
  }
  textParts.push(html.slice(last));
  expect(stack).toEqual([]);
  for (const t of textParts) {
    expect(t).not.toMatch(/[<>]/);
    // every & starts an entity
    expect(t.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
  }
}

describe('escapeHtml / decodeHtmlEntities / htmlToPlain', () => {
  it('escapes &, <, >', () => {
    expect(hu.escapeHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('decodes entities in a single pass', () => {
    expect(hu.decodeHtmlEntities('&lt;b&gt; &amp;lt; &#39;x&#x27; &quot;')).toBe('<b> &lt; \'x\' "');
    expect(hu.decodeHtmlEntities('&bogus; &#99999999;')).toBe('&bogus; &#99999999;');
  });

  it('htmlToPlain strips tags and decodes entities (no leftover &lt; &gt; &amp;)', () => {
    const html = `<b>Tool:</b> <code>Bash</code>\n<pre>if [ a &lt; b ] &amp;&amp; echo &gt; f</pre>`;
    expect(hu.htmlToPlain(html)).toBe('Tool: Bash\nif [ a < b ] && echo > f');
  });

  it('round-trips escape → plain', () => {
    const raw = 'x <script> & "y" \'z\' &amp;';
    expect(hu.htmlToPlain(`<i>${hu.escapeHtml(raw)}</i>`)).toBe(raw);
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(hu.truncateText('hello', 10)).toBe('hello');
  });

  it('truncates to max including the ellipsis', () => {
    const out = hu.truncateText('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
  });

  it('never splits a surrogate pair', () => {
    const s = 'ab\u{1F600}cd'; // a b [hi lo] c d
    const out = hu.truncateText(s, 4); // cut would land between hi and lo
    expect(out).toBe('ab…');
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it('handles non-positive max', () => {
    expect(hu.truncateText('abc', 0)).toBe('');
  });
});

describe('fitHtml', () => {
  it('shrinks the raw budget until the HTML fits, keeping tags closed', () => {
    const raw = '<&>'.repeat(5000); // escapes to 4–5x its length
    const html = hu.fitHtml(budget => `<b>Header</b>\n${hu.preBlock(raw, budget)}`, 3500);
    expect(html.length).toBeLessThanOrEqual(4096);
    expect(html.startsWith('<b>Header</b>\n<pre>')).toBe(true);
    expect(html.endsWith('</pre>')).toBe(true);
    assertWellFormed(html);
  });

  it('returns the render unchanged when it already fits', () => {
    const html = hu.fitHtml(b => `<i>${hu.escapeHtml(hu.truncateText('short', b))}</i>`, 100);
    expect(html).toBe('<i>short</i>');
  });

  it('degrades to escaped plain text when even the fixed parts are too long', () => {
    const fixed = 'x&'.repeat(4000);
    const html = hu.fitHtml(() => `<b>${hu.escapeHtml(fixed)}</b>`, 100);
    expect(html.length).toBeLessThanOrEqual(4096);
    assertWellFormed(html);
  });

  it('respects a custom max length', () => {
    const html = hu.fitHtml(b => hu.preBlock('y'.repeat(1000), b), 1000, 200);
    expect(html.length).toBeLessThanOrEqual(200);
    assertWellFormed(html);
  });
});

describe('markdownToHtml', () => {
  it('converts code blocks, inline code, bold, italic, bullets', () => {
    const html = hu.markdownToHtml('# Title\n**bold** and *it*\n- item\n`a<b`\n```js\nif (a && b) {}\n```');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<i>it</i>');
    expect(html).toContain('• item');
    expect(html).toContain('<code>a&lt;b</code>');
    expect(html).toContain('<pre>if (a &amp;&amp; b) {}</pre>');
    expect(html).not.toContain('#');
    assertWellFormed(html);
  });

  it('never produces mis-nested bold/italic', () => {
    for (const md of ['**a *b** c*', '*a **b* c**', '***x***', '**a `c` b**', '* a *b* c', '``` unclosed\n**x']) {
      assertWellFormed(hu.markdownToHtml(md));
    }
  });

  it('cannot be tricked by NUL placeholders in the input', () => {
    const html = hu.markdownToHtml('\x00P0\x00 `x`');
    assertWellFormed(html);
    expect(html).toContain('<code>x</code>');
  });

  it('stays well-formed when truncated mid-structure', () => {
    const md = '**bold** text `code` more\n```\nblock & <stuff>\n```\n*end*';
    for (let n = 0; n <= md.length; n++) {
      assertWellFormed(hu.markdownToHtml(hu.truncateText(md, n)));
    }
  });
});

describe('formatToolDescriptionHtml', () => {
  it('escapes and wraps a Bash command in <pre>', () => {
    const html = hu.formatToolDescriptionHtml('Bash', { command: 'cat a | grep "x" > out && echo `id` *_[', description: 'Run <it>' });
    expect(html).toContain('<i>Run &lt;it&gt;</i>');
    expect(html).toContain('<pre>cat a | grep "x" &gt; out &amp;&amp; echo `id` *_[</pre>');
    assertWellFormed(html);
  });

  it('truncates the raw command to the budget (before escaping)', () => {
    const html = hu.formatToolDescriptionHtml('Bash', { command: '&'.repeat(5000) }, 100);
    const pre = html.match(/<pre>([\s\S]*)<\/pre>/)[1];
    expect(hu.decodeHtmlEntities(pre).length).toBe(100);
    assertWellFormed(html);
  });

  it('renders an Edit diff with line caps', () => {
    const old = Array.from({ length: 20 }, (_, i) => `old ${i} <tag>`).join('\n');
    const html = hu.formatToolDescriptionHtml('Edit', { file_path: '/a/b_c*.ts', old_string: old, new_string: 'new & line' });
    expect(html).toContain('<b>File:</b> <code>/a/b_c*.ts</code>');
    expect(html).toContain('- old 0 &lt;tag&gt;');
    expect(html).toContain('(8 more lines)');
    expect(html).toContain('+ new &amp; line');
    assertWellFormed(html);
  });

  it('falls back to pretty JSON for other tools', () => {
    const html = hu.formatToolDescriptionHtml('mcp__x__y', { query: 'a<b', nested: { k: 1 } });
    expect(html.startsWith('<pre>')).toBe(true);
    expect(html).toContain('"query": "a&lt;b"');
    assertWellFormed(html);
  });

  it('returns empty string for empty input', () => {
    expect(hu.formatToolDescriptionHtml('Foo', {})).toBe('');
  });

  it('builds a complete permission message ≤ 4096 for a huge hostile command', () => {
    const cmd = '<b>&amp;</b>\n'.repeat(2000);
    const html = hu.fitHtml(budget =>
      `\u{1F510} <b>Permission</b> — ${hu.escapeHtml('ws_*[')}\n\n<b>Tool:</b> <code>Bash</code>\n`
      + hu.formatToolDescriptionHtml('Bash', { command: cmd }, budget), 3000);
    expect(html.length).toBeLessThanOrEqual(4096);
    assertWellFormed(html);
    expect(hu.htmlToPlain(html).length).toBeLessThanOrEqual(4096);
  });
});

describe('deadline math', () => {
  it('safety margin is ~10 s for long hooks and 25% for short ones', () => {
    expect(hu.safetyMarginMs(120_000)).toBe(10_000);
    expect(hu.safetyMarginMs(30_000)).toBe(7_500);
    expect(hu.safetyMarginMs(5_000)).toBe(1_250);
  });

  it('computeDeadline = start + timeout − safety', () => {
    expect(hu.computeDeadline(120_000, 1_000_000)).toBe(1_000_000 + 110_000);
    expect(hu.computeDeadline(30_000, 0, 10_000)).toBe(20_000);
  });

  it('time already spent is subtracted (deadline is absolute from process start)', () => {
    const start = 50_000;
    const deadline = hu.computeDeadline(120_000, start);
    // 30 s already spent → 80 s left
    expect(hu.remainingMs(deadline, start + 30_000)).toBe(80_000);
    expect(hu.remainingMs(deadline, start + 200_000)).toBe(0);
  });

  it('processStartedAt is not in the future', () => {
    const now = Date.now();
    const started = hu.processStartedAt(now);
    expect(started).toBeLessThanOrEqual(now);
  });

  it('hookDeadline uses the installed hook timeouts and ends before the kill', async () => {
    const defs = await import('../src/utils/hook-definitions.js');
    expect(defs.hookTimeoutSeconds('permission-hook.js')).toBe(120);
    expect(defs.hookTimeoutSeconds('question-notify.js')).toBe(120);
    expect(defs.hookTimeoutSeconds('elicitation-notify.js')).toBe(120);
    expect(defs.hookTimeoutSeconds('permission-denied-notify.js')).toBe(30);
    expect(defs.hookTimeoutSeconds('pre-compact-notify.js')).toBe(30);
    expect(defs.hookTimeoutSeconds('enhanced-hook-notify.js', 'completed')).toBe(5);
    expect(defs.hookTimeoutSeconds('nope.js', undefined, 42)).toBe(42);

    const startedAt = hu.processStartedAt();
    const d = hu.hookDeadline('permission-hook.js');
    expect(d).toBeGreaterThan(startedAt);
    expect(d).toBeLessThanOrEqual(startedAt + 120_000 - 10_000 + 5);
  });
});

describe('prompt lifecycle', () => {
  it('pollForResponse resolves with the response file', async () => {
    const id = 'aaaa0001';
    hu.openPrompt(id, { type: 'permission' });
    setTimeout(() => bridge.writeResponse(id, { action: 'allow' }), 60);
    const res = await hu.pollForResponse(id, Date.now() + 2000, 20);
    expect(res.action).toBe('allow');
    hu.closePrompt(id);
    expect(bridge.readPending(id)).toBeNull();
    expect(bridge.readResponse(id)).toBeNull();
  });

  it('pollForResponse resolves null at the deadline', async () => {
    const t0 = Date.now();
    const res = await hu.pollForResponse('aaaa0002', t0 + 120, 20);
    expect(res).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('closeAllPrompts removes every outstanding prompt', () => {
    hu.openPrompt('bbbb0001', { type: 'question' });
    hu.openPrompt('bbbb0002', { type: 'question' });
    expect(hu.outstandingPromptIds()).toEqual(expect.arrayContaining(['bbbb0001', 'bbbb0002']));
    hu.closeAllPrompts();
    expect(hu.outstandingPromptIds()).toEqual([]);
    expect(bridge.readPending('bbbb0001')).toBeNull();
    expect(bridge.readPending('bbbb0002')).toBeNull();
  });

  it('opening the next prompt before closing the previous never leaves a gap', () => {
    hu.openPrompt('dddd0001', { type: 'elicitation', awaitingText: true });
    expect(bridge.findAwaitingTextPrompt()).toBe('dddd0001');
    bridge.writeResponse('dddd0001', { textAnswer: 'x' }); // answered → no longer alive
    hu.openPrompt('dddd0002', { type: 'elicitation', awaitingText: true });
    // both files exist momentarily, but only the new one is waiting
    expect(bridge.findAwaitingTextPrompt()).toBe('dddd0002');
    hu.closePrompt('dddd0001');
    expect(bridge.findAwaitingTextPrompt()).toBe('dddd0002');
    hu.closePrompt('dddd0002');
    expect(bridge.findAwaitingTextPrompt()).toBeNull();
  });

  it('openPrompt records the hook pid so the bot can detect dead prompts', () => {
    hu.openPrompt('cccc0001', { type: 'permission' });
    expect(bridge.readPending('cccc0001').pid).toBe(process.pid);
    expect(bridge.isPromptAlive('cccc0001')).toBe(true);
    hu.closePrompt('cccc0001');
    expect(bridge.isPromptAlive('cccc0001')).toBe(false);
  });
});

describe('telegramConfigured', () => {
  it('requires TELEGRAM_ENABLED=true, a bot token and a chat id', () => {
    const full = { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
    expect(hu.telegramConfigured(full)).toBe(true);
    expect(hu.telegramConfigured({ ...full, TELEGRAM_ENABLED: 'false' })).toBe(false);
    expect(hu.telegramConfigured({ ...full, TELEGRAM_ENABLED: undefined })).toBe(false);
    expect(hu.telegramConfigured({ ...full, TELEGRAM_BOT_TOKEN: '' })).toBe(false);
    expect(hu.telegramConfigured({ ...full, TELEGRAM_CHAT_ID: undefined })).toBe(false);
  });
});

describe('misc', () => {
  it('sanitizeSessionName replaces dots, colons and spaces', () => {
    expect(hu.sanitizeSessionName('my.proj: v2 x')).toBe('my-proj--v2-x');
  });

  it('parsePayload only accepts JSON objects', () => {
    expect(hu.parsePayload('{"a":1}')).toEqual({ a: 1 });
    expect(hu.parsePayload('[1]')).toBeNull();
    expect(hu.parsePayload('')).toBeNull();
    expect(hu.parsePayload('nope')).toBeNull();
  });
});
