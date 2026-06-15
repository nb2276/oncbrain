import { describe, it, expect } from 'vitest';
import { assignSlugsForDate } from '../src/lib/slug-resolve.ts';

describe('assignSlugsForDate', () => {
  it('uses persisted slugs uncontested', () => {
    const studies = [
      { name: 'A', slug: 'alpha' },
      { name: 'B', slug: 'beta' },
    ];
    expect(assignSlugsForDate(studies)).toEqual(['alpha', 'beta']);
  });

  it('falls back to deriveSlug when slug is missing', () => {
    const studies = [{ name: 'EXTEND Trial' }, { name: 'PEACE-3' }];
    expect(assignSlugsForDate(studies)).toEqual(['extend-trial', 'peace-3']);
  });

  it('falls back to deriveSlug when slug is empty', () => {
    const studies = [{ name: 'EXTEND Trial', slug: '' }];
    expect(assignSlugsForDate(studies)).toEqual(['extend-trial']);
  });

  it('disambiguates fallback-slug collisions across distinct names', () => {
    const studies = [{ name: '研究' }, { name: '🧪' }];
    // Both derive to "study"; second gets suffixed.
    const out = assignSlugsForDate(studies);
    expect(out[0]).toBe('study');
    expect(out[1]).toBe('study-2');
  });

  it('disambiguates Trial vs Trial — α', () => {
    const studies = [{ name: 'Trial' }, { name: 'Trial — α' }];
    const out = assignSlugsForDate(studies);
    expect(out[0]).toBe('trial');
    expect(out[1]).toBe('trial-2');
  });

  it('suffixes -2, -3 for 3-way collisions', () => {
    const studies = [{ name: '🧪' }, { name: '研究' }, { name: '😀' }];
    const out = assignSlugsForDate(studies);
    expect(out).toEqual(['study', 'study-2', 'study-3']);
  });

  it('does not suffix when persisted slug is unique', () => {
    const studies = [
      { name: 'EXTEND', slug: 'extend-prostate' },
      { name: 'EXTEND', slug: 'extend-breast' },
    ];
    expect(assignSlugsForDate(studies)).toEqual(['extend-prostate', 'extend-breast']);
  });

  it('handles persisted slug colliding with derived fallback', () => {
    // A persisted "trial" then a derived "trial" — second should suffix.
    const studies = [{ name: 'A', slug: 'trial' }, { name: 'Trial' }];
    const out = assignSlugsForDate(studies);
    expect(out[0]).toBe('trial');
    expect(out[1]).toBe('trial-2');
  });

  it('trims base when suffix would push past 64 chars', () => {
    const longName = 'a'.repeat(70);
    const longName2 = 'a'.repeat(71);
    const out = assignSlugsForDate([{ name: longName }, { name: longName2 }]);
    expect(out[0]).toHaveLength(64);
    expect(out[1].length).toBeLessThanOrEqual(64);
    expect(out[1]).toMatch(/-2$/);
    expect(out[1]).not.toMatch(/--+/);
  });

  it('reserves resolved slug to prevent double collision', () => {
    // Three studies: name "X", name "X", name with persisted slug "x-2".
    // The third should get suffixed past "x-2" rather than colliding.
    const studies = [{ name: 'X' }, { name: 'X' }, { name: 'Y', slug: 'x-2' }];
    const out = assignSlugsForDate(studies);
    expect(out[0]).toBe('x');
    expect(out[1]).toBe('x-2');
    expect(out[2]).toBe('x-2-2');
  });

  it('returns empty for empty input', () => {
    expect(assignSlugsForDate([])).toEqual([]);
  });

  it('does not duplicate when an explicit -N slug precedes a colliding base (loop-until-unused)', () => {
    // Regression: explicit "x-2" first, then two studies that both derive to
    // "x" — the suffix run must skip the already-taken "x-2" → "x-3", not
    // re-emit a duplicate "x-2" (duplicate DOM ids / ambiguous anchors).
    const out = assignSlugsForDate([{ name: 'Y', slug: 'x-2' }, { name: 'X' }, { name: 'X' }]);
    expect(out).toEqual(['x-2', 'x', 'x-3']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('stays unique across a longer collision run with a pre-taken suffix', () => {
    const out = assignSlugsForDate([
      { name: 'Y', slug: 'x-2' },
      { name: 'X' },
      { name: 'X' },
      { name: 'X' },
    ]);
    expect(new Set(out).size).toBe(out.length);
  });
});
