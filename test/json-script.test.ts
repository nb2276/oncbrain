// v0.11 PR-1a: jsonForScriptTag closes the XSS contract gap that
// `set:html={JSON.stringify(...)}` leaves open. Today's slugs can't
// trigger any of these escapes, but the contract is "any future
// caller passing an unconstrained string."

import { describe, it, expect } from 'vitest';
import { jsonForScriptTag } from '../src/lib/json-script.ts';

describe('jsonForScriptTag', () => {
  it('escapes `<` so `</script>` cannot terminate the script tag', () => {
    const out = jsonForScriptTag({ name: '</script><script>alert(1)' });
    expect(out).not.toMatch(/<\/script>/);
    expect(out).toContain('\\u003c');
  });

  it('escapes `<` inside any nested string value', () => {
    const out = jsonForScriptTag({ a: [{ b: '<!-- xss' }, 'plain'] });
    expect(out).not.toContain('<!');
    expect(out).toContain('\\u003c!--');
  });

  it('escapes the U+2028 line separator', () => {
    const out = jsonForScriptTag({ s: 'a b' });
    expect(out).not.toContain(' ');
    expect(out).toContain('\\u2028');
  });

  it('escapes the U+2029 paragraph separator', () => {
    const out = jsonForScriptTag({ s: 'a b' });
    expect(out).not.toContain(' ');
    expect(out).toContain('\\u2029');
  });

  it('produces valid JSON that parses back to the original value', () => {
    const value = {
      name: '</script>',
      list: ['<!-- hi', 'a b'],
      n: 42,
      yes: true,
      no: null,
    };
    const serialized = jsonForScriptTag(value);
    // The escaped form is still valid JSON (JSON.parse honors \uNNNN).
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(value);
  });

  it('handles primitives, arrays, and objects', () => {
    expect(jsonForScriptTag('hi')).toBe('"hi"');
    expect(jsonForScriptTag(42)).toBe('42');
    expect(jsonForScriptTag(null)).toBe('null');
    expect(jsonForScriptTag([1, 2, 3])).toBe('[1,2,3]');
    expect(jsonForScriptTag({ a: 1 })).toBe('{"a":1}');
  });
});
