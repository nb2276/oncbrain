// Guards the "a rebuild must not rename a study's URL" fix.
//
// Two failure directions and they are not symmetric. Failing to REUSE a slug
// breaks a permalink and a curator override, silently (the DO catchall serves
// the home page with HTTP 200, never a 404). Reusing a slug WRONGLY points a
// published URL at a different study, which is worse. So the matcher has to be
// confident, and most of these tests are about when it must refuse.

import { describe, it, expect } from 'vitest';
import { persistSlugs, matchScore } from '../src/lib/slug-persistence.ts';

const S = (slug: string, opts: Partial<{ nct: string | null; sources: number[]; name: string }> = {}) => ({
  slug,
  name: opts.name ?? slug,
  nct: opts.nct ?? null,
  source_ids: (opts.sources ?? []).map((id) => ({ type: 'paper', id })),
});

describe('persistSlugs', () => {
  it('keeps the published slug when the LLM renames the study', () => {
    // the real 2026-08-07 case: "STELLAR" clustered from the same paper twice
    const prev = [S('stellar-tnt-larc', { sources: [42] })];
    const next = [S('stellar', { sources: [42] })];
    expect(persistSlugs(prev, next).slugs).toEqual(['stellar-tnt-larc']);
  });

  it('is a no-op in the steady state', () => {
    const prev = [S('a', { sources: [1] }), S('b', { sources: [2] })];
    const next = [S('a', { sources: [1] }), S('b', { sources: [2] })];
    const r = persistSlugs(prev, next);
    expect(r.slugs).toEqual(['a', 'b']);
    expect(r.retired).toEqual([]);
  });

  it('matches on NCT when the sources changed (a fuller paper replaced a tweet)', () => {
    const prev = [S('old-name', { nct: 'NCT01234567', sources: [1] })];
    const next = [S('new-name', { nct: 'NCT01234567', sources: [99] })];
    expect(persistSlugs(prev, next).slugs).toEqual(['old-name']);
  });

  it('REFUSES to fuse two trials that state different NCTs', () => {
    // a single source can legitimately cover two trials, so shared provenance
    // must not outrank an explicit registration disagreement
    const prev = [S('trial-a', { nct: 'NCT00000001', sources: [7] })];
    const next = [S('trial-b', { nct: 'NCT00000002', sources: [7] })];
    expect(matchScore(next[0], prev[0])).toBe(0);
    expect(persistSlugs(prev, next).slugs).toEqual(['trial-b']);
  });

  it('refuses when there is no shared provenance and no NCT', () => {
    const prev = [S('something-old', { sources: [1] })];
    const next = [S('something-new', { sources: [2] })];
    expect(persistSlugs(prev, next).slugs).toEqual(['something-new']);
  });

  it('gives a published slug to only ONE half of a split cluster', () => {
    const prev = [S('combined', { sources: [1, 2] })];
    const next = [S('part-one', { sources: [1] }), S('part-two', { sources: [2] })];
    const r = persistSlugs(prev, next);
    expect(r.slugs.filter((s) => s === 'combined')).toHaveLength(1);
    expect(new Set(r.slugs).size).toBe(2); // never a duplicate
  });

  it('takes only one old slug when two studies merge, and retires the other', () => {
    const prev = [S('first', { sources: [1] }), S('second', { sources: [2] })];
    const next = [S('merged', { sources: [1, 2] })];
    const r = persistSlugs(prev, next);
    expect(r.slugs).toHaveLength(1);
    expect(['first', 'second']).toContain(r.slugs[0]);
    expect(r.retired).toHaveLength(1);
  });

  it('never emits a duplicate slug, even when a new study derives a reused one', () => {
    // 'b' is reused for the study that owns it; the newcomer that also derived
    // 'b' must be pushed off rather than collide
    const prev = [S('b', { sources: [1] })];
    const next = [S('b', { sources: [2] }), S('b', { sources: [1] })];
    const r = persistSlugs(prev, next);
    expect(new Set(r.slugs).size).toBe(2);
    expect(r.slugs).toContain('b');
  });

  it('reports slugs that no longer exist, so the caller can alias them', () => {
    const prev = [S('kept', { sources: [1] }), S('dropped', { sources: [9] })];
    const next = [S('renamed', { sources: [1] })];
    const r = persistSlugs(prev, next);
    expect(r.slugs).toEqual(['kept']);
    expect(r.retired).toEqual(['dropped']);
  });

  it('is inert on a first build with no previous artifact', () => {
    const next = [S('fresh', { sources: [1] })];
    expect(persistSlugs([], next)).toEqual({ slugs: ['fresh'], retired: [] });
  });

  it('is deterministic when two candidates score identically', () => {
    const prev = [S('shared', { sources: [1] })];
    const next = [S('x', { sources: [1] }), S('y', { sources: [1] })];
    const a = persistSlugs(prev, next).slugs;
    const b = persistSlugs(prev, next).slugs;
    expect(a).toEqual(b);
    expect(a[0]).toBe('shared'); // input order breaks the tie
  });
});
