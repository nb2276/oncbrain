import { describe, it, expect } from 'vitest';
import { deriveSlug } from '../src/lib/slug.ts';

describe('deriveSlug', () => {
  it('lowercases and kebab-cases a normal name', () => {
    expect(deriveSlug('EXTEND Trial')).toBe('extend-trial');
  });

  it('strips punctuation', () => {
    expect(deriveSlug('PRESTIGE-PSMA (Lu-PSMA)')).toBe('prestige-psma-lu-psma');
  });

  it('collapses runs of separators', () => {
    expect(deriveSlug('foo   bar')).toBe('foo-bar');
    expect(deriveSlug('foo___bar')).toBe('foo-bar');
  });

  it('strips leading and trailing separators', () => {
    expect(deriveSlug('  --foo--  ')).toBe('foo');
  });

  it('strips diacritics', () => {
    expect(deriveSlug('Bauüm Trial')).toBe('bauum-trial');
  });

  it('handles slashes and em dashes', () => {
    expect(deriveSlug('POP-RT vs PEACE-2 — OS')).toBe('pop-rt-vs-peace-2-os');
  });

  it('truncates to 64 chars without trailing separator', () => {
    const long = 'a'.repeat(70);
    const out = deriveSlug(long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).not.toMatch(/-$/);
  });

  it('returns fallback for empty-after-strip input', () => {
    expect(deriveSlug('')).toBe('study');
    expect(deriveSlug('---')).toBe('study');
    expect(deriveSlug('!!!')).toBe('study');
  });

  it('preserves numeric-prefix names', () => {
    expect(deriveSlug('5-year follow-up')).toBe('5-year-follow-up');
  });

  it('is idempotent on already-slug-shaped input', () => {
    expect(deriveSlug('peace-3')).toBe('peace-3');
  });
});
