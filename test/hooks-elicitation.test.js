import { describe, it, expect } from 'vitest';
import {
  coerceElicitationAnswer as coerce,
  elicitationChoices,
  matchChoice,
  describeElicitationField,
} from '../src/utils/hook-utils.js';

describe('coerceElicitationAnswer — numbers', () => {
  it('parses numbers', () => {
    expect(coerce(' 3.5 ', { type: 'number' }, true)).toEqual({ kind: 'value', value: 3.5 });
    expect(coerce('-2', { type: 'number' }, true)).toEqual({ kind: 'value', value: -2 });
  });

  it('rejects non-numbers', () => {
    expect(coerce('abc', { type: 'number' }, true).kind).toBe('invalid');
    expect(coerce('Infinity', { type: 'number' }, true).kind).toBe('invalid');
  });

  it('integers must be whole', () => {
    expect(coerce('42', { type: 'integer' }, true)).toEqual({ kind: 'value', value: 42 });
    expect(coerce('4.2', { type: 'integer' }, true).kind).toBe('invalid');
  });

  it('enforces minimum / maximum', () => {
    const prop = { type: 'integer', minimum: 1, maximum: 10 };
    expect(coerce('0', prop, true).kind).toBe('invalid');
    expect(coerce('11', prop, true).kind).toBe('invalid');
    expect(coerce('10', prop, true)).toEqual({ kind: 'value', value: 10 });
  });
});

describe('coerceElicitationAnswer — booleans', () => {
  it('accepts common yes/no words (case-insensitive, incl. Chinese)', () => {
    for (const yes of ['yes', 'Y', 'TRUE', '1', 'on', 'ok', '是']) {
      expect(coerce(yes, { type: 'boolean' }, true)).toEqual({ kind: 'value', value: true });
    }
    for (const no of ['no', 'N', 'false', '0', 'off', '否']) {
      expect(coerce(no, { type: 'boolean' }, true)).toEqual({ kind: 'value', value: false });
    }
  });

  it('rejects anything else', () => {
    expect(coerce('maybe', { type: 'boolean' }, true).kind).toBe('invalid');
  });
});

describe('coerceElicitationAnswer — enums', () => {
  const prop = { type: 'string', enum: ['small', 'medium', 'large'], enumNames: ['Small', 'Medium', 'Large (XL)'] };

  it('matches exact value, case-insensitive value/label, or 1-based index', () => {
    expect(coerce('medium', prop, true)).toEqual({ kind: 'value', value: 'medium' });
    expect(coerce('LARGE', prop, true)).toEqual({ kind: 'value', value: 'large' });
    expect(coerce('large (xl)', prop, true)).toEqual({ kind: 'value', value: 'large' });
    expect(coerce('1', prop, true)).toEqual({ kind: 'value', value: 'small' });
  });

  it('prefers an exact value over an index', () => {
    const numeric = { type: 'string', enum: ['2', '1'] };
    expect(coerce('1', numeric, true)).toEqual({ kind: 'value', value: '1' });
  });

  it('rejects unknown options and lists the choices', () => {
    const r = coerce('huge', prop, true);
    expect(r.kind).toBe('invalid');
    expect(r.error).toContain('1. Small');
    expect(coerce('4', prop, true).kind).toBe('invalid');
  });

  it('supports titled enums via oneOf const/title', () => {
    const titled = { type: 'string', oneOf: [{ const: '#f00', title: 'Red' }, { const: '#0f0', title: 'Green' }] };
    expect(coerce('green', titled, true)).toEqual({ kind: 'value', value: '#0f0' });
    expect(coerce('1', titled, true)).toEqual({ kind: 'value', value: '#f00' });
  });
});

describe('coerceElicitationAnswer — arrays (multi-select)', () => {
  const prop = { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 };

  it('splits on commas (incl. full-width) and dedupes', () => {
    expect(coerce('a, 3', prop, true)).toEqual({ kind: 'value', value: ['a', 'c'] });
    expect(coerce('b，b', prop, true)).toEqual({ kind: 'value', value: ['b'] });
  });

  it('enforces minItems / maxItems and option validity', () => {
    expect(coerce('a,b,c', prop, true).kind).toBe('invalid');
    expect(coerce('z', prop, true).kind).toBe('invalid');
  });

  it('free-form string arrays pass through', () => {
    expect(coerce('x, y', { type: 'array', items: { type: 'string' } }, true)).toEqual({ kind: 'value', value: ['x', 'y'] });
  });
});

describe('coerceElicitationAnswer — strings', () => {
  it('returns trimmed text', () => {
    expect(coerce('  hello world ', { type: 'string' }, true)).toEqual({ kind: 'value', value: 'hello world' });
  });

  it('defaults to string when type is missing', () => {
    expect(coerce('42', {}, true)).toEqual({ kind: 'value', value: '42' });
  });

  it('enforces length limits', () => {
    expect(coerce('ab', { type: 'string', minLength: 3 }, true).kind).toBe('invalid');
    expect(coerce('abcd', { type: 'string', maxLength: 3 }, true).kind).toBe('invalid');
  });

  it('checks formats', () => {
    expect(coerce('me@example.com', { type: 'string', format: 'email' }, true).kind).toBe('value');
    expect(coerce('not-an-email', { type: 'string', format: 'email' }, true).kind).toBe('invalid');
    expect(coerce('https://x.dev/a', { type: 'string', format: 'uri' }, true).kind).toBe('value');
    expect(coerce('nope', { type: 'string', format: 'uri' }, true).kind).toBe('invalid');
    expect(coerce('2026-10-05', { type: 'string', format: 'date' }, true).kind).toBe('value');
    expect(coerce('05/10/2026', { type: 'string', format: 'date' }, true).kind).toBe('invalid');
    expect(coerce('2026-10-05T10:00:00Z', { type: 'string', format: 'date-time' }, true).kind).toBe('value');
  });
});

describe('coerceElicitationAnswer — optional fields', () => {
  it('"-" or /skip skips an optional field', () => {
    expect(coerce('-', { type: 'number' }, false)).toEqual({ kind: 'skip' });
    expect(coerce('/SKIP', { type: 'boolean' }, false)).toEqual({ kind: 'skip' });
  });

  it('"-" is a literal value for a required string', () => {
    expect(coerce('-', { type: 'string' }, true)).toEqual({ kind: 'value', value: '-' });
  });

  it('"-" is invalid for a required number', () => {
    expect(coerce('-', { type: 'number' }, true).kind).toBe('invalid');
  });
});

describe('elicitationChoices / matchChoice / describeElicitationField', () => {
  it('returns null for free-form fields', () => {
    expect(elicitationChoices({ type: 'string' })).toBeNull();
    expect(elicitationChoices({ type: 'array' })).toBeNull();
  });

  it('matchChoice returns null for out-of-range index', () => {
    expect(matchChoice('0', [{ value: 'a', label: 'A' }])).toBeNull();
  });

  it('describes constraints for the user', () => {
    expect(describeElicitationField({ type: 'integer', minimum: 1, maximum: 5 }, true)).toEqual(['Expects a whole number (≥ 1, ≤ 5).']);
    const lines = describeElicitationField({ type: 'string', enum: ['x', 'y'], default: 'x' }, false);
    expect(lines[0]).toBe('Options: 1. x, 2. y');
    expect(lines).toContain('Default: x');
    expect(lines.some(l => l.includes('"-" to skip'))).toBe(true);
    expect(describeElicitationField({ type: 'boolean' }, true)).toEqual(['Reply yes or no.']);
  });
});
