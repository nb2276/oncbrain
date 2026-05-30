// v0.10 tag URL parser. The single-segment [...slug] catch-all accepts
// '+'-joined safe slugs in alphabetical canonical order, max 3-way. Anything
// else (non-canonical ordering, unsafe slug shape, 4+ way joins, empty
// parts, deep nesting, querystrings) returns { ok: false } so the page 404s.

import { describe, it, expect } from 'vitest';
import {
  parseTagPageSlug,
  listTagSummaries,
  intersectTagOccurrences,
  resolveTagDisplay,
  type TagOccurrence,
} from '../src/lib/tag-index.ts';
import type { DigestArtifact, DigestStudy } from '../src/lib/digest-data.ts';

function makeStudy(name: string, overrides: Partial<DigestStudy> = {}): DigestStudy {
  return {
    name,
    tldr: `${name} tldr`,
    details: [],
    nct: null,
    tweet_ids: [],
    ...overrides,
  };
}

function makeDigest(
  date: string,
  conferenceSlug: string | null,
  sites: Array<{ disease_site: string; studies: DigestStudy[] }>,
): DigestArtifact {
  return {
    date,
    conference: conferenceSlug ? { slug: conferenceSlug, name: conferenceSlug.toUpperCase() } : null,
    generated_at: 0,
    digest: {
      top_line: 'top',
      tldr: 'tldr',
      sites: sites.map((s) => ({
        disease_site: s.disease_site,
        intro: null,
        studies: s.studies,
        open_questions: null,
      })),
    },
    bookmarks: [],
  };
}

describe('parseTagPageSlug — accepts canonical safe slugs', () => {
  it('single-tag slug', () => {
    expect(parseTagPageSlug('radiation')).toEqual({ ok: true, tags: ['radiation'] });
  });

  it('2-way intersection in canonical alphabetical order', () => {
    expect(parseTagPageSlug('palliative+radiation')).toEqual({
      ok: true,
      tags: ['palliative', 'radiation'],
    });
  });

  it('3-way intersection in canonical alphabetical order', () => {
    expect(parseTagPageSlug('confirmatory+palliative+radiation')).toEqual({
      ok: true,
      tags: ['confirmatory', 'palliative', 'radiation'],
    });
  });

  it('handles hyphen-containing slugs (phase-3-rct)', () => {
    expect(parseTagPageSlug('phase-3-rct')).toEqual({ ok: true, tags: ['phase-3-rct'] });
    expect(parseTagPageSlug('phase-3-rct+radiation')).toEqual({
      ok: true,
      tags: ['phase-3-rct', 'radiation'],
    });
  });

  it('Astro single-element string[] form (catch-all sometimes wraps as array)', () => {
    expect(parseTagPageSlug(['radiation'])).toEqual({ ok: true, tags: ['radiation'] });
  });
});

describe('parseTagPageSlug — rejects non-canonical / unsafe inputs', () => {
  it('rejects undefined', () => {
    expect(parseTagPageSlug(undefined)).toEqual({ ok: false });
  });

  it('rejects empty string', () => {
    expect(parseTagPageSlug('')).toEqual({ ok: false });
  });

  it('rejects non-alphabetical 2-way order (b+a, not a+b)', () => {
    expect(parseTagPageSlug('radiation+palliative')).toEqual({ ok: false });
  });

  it('rejects non-alphabetical 3-way order', () => {
    expect(parseTagPageSlug('radiation+palliative+confirmatory')).toEqual({ ok: false });
  });

  it('rejects 4+ way intersections (over plan cap)', () => {
    expect(parseTagPageSlug('a+b+c+d')).toEqual({ ok: false });
  });

  it('rejects duplicate tags in a join', () => {
    expect(parseTagPageSlug('radiation+radiation')).toEqual({ ok: false });
  });

  it('rejects empty join sides', () => {
    expect(parseTagPageSlug('+')).toEqual({ ok: false });
    expect(parseTagPageSlug('foo+')).toEqual({ ok: false });
    expect(parseTagPageSlug('+foo')).toEqual({ ok: false });
    expect(parseTagPageSlug('a++b')).toEqual({ ok: false });
  });

  it('rejects unsafe slug shapes (uppercase, spaces, dots, slashes, querystring)', () => {
    expect(parseTagPageSlug('Radiation')).toEqual({ ok: false });
    expect(parseTagPageSlug('foo bar')).toEqual({ ok: false });
    expect(parseTagPageSlug('...')).toEqual({ ok: false });
    expect(parseTagPageSlug('foo?x=y')).toEqual({ ok: false });
    expect(parseTagPageSlug('foo%2Fbar')).toEqual({ ok: false });
  });

  it('rejects deep nesting (multi-element string[] from "/" in URL)', () => {
    expect(parseTagPageSlug(['foo', 'bar'])).toEqual({ ok: false });
  });
});

describe('listTagSummaries — occurrence resolution end-to-end', () => {
  it('builds a Map<slug, occurrences> grouped per-tag, newest first', () => {
    const digests = [
      makeDigest('2026-05-25', 'asco-2026', [
        {
          disease_site: 'breast',
          studies: [
            makeStudy('OLD', {
              modality: 'radiation',
              verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
            }),
          ],
        },
      ]),
      makeDigest('2026-05-27', 'asco-2026', [
        {
          disease_site: 'breast',
          studies: [
            makeStudy('NEW', {
              modality: 'radiation',
              intent: 'palliative',
              verdict: { soc_implication: 'practice-changing', rationale: '', audience: null },
            }),
          ],
        },
      ]),
    ];
    const summaries = listTagSummaries(digests);
    const radiation = summaries.get('radiation')!;
    expect(radiation.map((o) => o.study.name)).toEqual(['NEW', 'OLD']); // date desc
    expect(summaries.get('palliative')!.map((o) => o.study.name)).toEqual(['NEW']);
    expect(summaries.get('confirmatory')!.map((o) => o.study.name)).toEqual(['OLD']);
    expect(summaries.get('asco-2026')!.map((o) => o.study.name)).toEqual(['NEW', 'OLD']);
    // Disease-site NOT in /tags/ index
    expect(summaries.has('breast')).toBe(false);
  });

  it('omits a slug when no study carries it', () => {
    const digests = [
      makeDigest('2026-05-27', null, [
        {
          disease_site: 'breast',
          studies: [makeStudy('A', { modality: 'radiation' })],
        },
      ]),
    ];
    const summaries = listTagSummaries(digests);
    expect(summaries.has('surgery')).toBe(false);
  });
});

describe('intersectTagOccurrences', () => {
  it('returns only studies appearing under ALL the given tags', () => {
    const digests = [
      makeDigest('2026-05-27', null, [
        {
          disease_site: 'breast',
          studies: [
            makeStudy('A', { modality: 'radiation', intent: 'palliative' }),
            makeStudy('B', { modality: 'radiation' }), // no intent
            makeStudy('C', { modality: 'surgery', intent: 'palliative' }), // no radiation
          ],
        },
      ]),
    ];
    const summaries = listTagSummaries(digests);
    const intersect = intersectTagOccurrences(summaries, ['palliative', 'radiation']);
    expect(intersect.map((o) => o.study.name)).toEqual(['A']);
  });

  it('returns [] when one of the tags has no occurrences', () => {
    const summaries = listTagSummaries([
      makeDigest('2026-05-27', null, [
        { disease_site: 'breast', studies: [makeStudy('A', { modality: 'radiation' })] },
      ]),
    ]);
    expect(intersectTagOccurrences(summaries, ['radiation', 'phase-3-rct'])).toEqual([]);
  });

  it('returns [] for an empty tag set', () => {
    expect(intersectTagOccurrences(new Map(), [])).toEqual([]);
  });

  it('dedupes across multiple disease-site sections (per-date Set semantics)', () => {
    // Two sections, same study would have appeared twice if intersect used
    // a list intersection. Per the {date, resolvedSlug} key, this is one
    // occurrence under the (radiation, palliative) intersection.
    const digests = [
      makeDigest('2026-05-27', null, [
        {
          disease_site: 'breast',
          studies: [makeStudy('A', { modality: 'radiation', intent: 'palliative' })],
        },
      ]),
    ];
    const summaries = listTagSummaries(digests);
    const result = intersectTagOccurrences(summaries, ['palliative', 'radiation']);
    expect(result).toHaveLength(1);
  });
});

describe('resolveTagDisplay', () => {
  it('resolves modality slugs to the static def label', () => {
    expect(resolveTagDisplay('radiation')).toEqual({
      namespace: 'modality',
      label: 'Radiation',
      emoji: null,
    });
  });

  it('resolves intent slugs', () => {
    expect(resolveTagDisplay('palliative')).toEqual({
      namespace: 'intent',
      label: 'Palliative',
      emoji: null,
    });
  });

  it('resolves methodology slugs', () => {
    expect(resolveTagDisplay('phase-3-rct')).toEqual({
      namespace: 'methodology',
      label: 'Phase 3 RCT',
      emoji: null,
    });
  });

  it('resolves verdict slugs to label + emoji', () => {
    const result = resolveTagDisplay('confirmatory');
    expect(result?.namespace).toBe('verdict');
    expect(result?.label).toBe('Confirmatory');
    expect(result?.emoji).toBeTruthy();
  });

  it('resolves a meeting slug via an occurrence sample', () => {
    const occurrence: TagOccurrence = {
      date: '2026-05-27',
      conference: { slug: 'asco-2026', name: 'ASCO 2026' },
      diseaseSite: 'breast',
      resolvedSlug: 'a',
      study: makeStudy('A'),
      bookmarks: [],
    };
    const result = resolveTagDisplay('asco-2026', [occurrence]);
    expect(result).toEqual({ namespace: 'meeting', label: 'ASCO 2026', emoji: null });
  });

  it('returns null for an unknown slug with no occurrence sample', () => {
    expect(resolveTagDisplay('does-not-exist')).toBeNull();
  });

  it('REJECTS prototype-chain keys (toString, hasOwnProperty, __proto__, constructor)', () => {
    // Adversarial-review finding B1: `slug in VERDICT_META` would match
    // Object.prototype.toString and return Function.prototype as the
    // verdict meta, rendering the pill with undefined label + emoji.
    // hasOwnProperty.call gates the lookup.
    expect(resolveTagDisplay('toString')).toBeNull();
    expect(resolveTagDisplay('hasOwnProperty')).toBeNull();
    expect(resolveTagDisplay('__proto__')).toBeNull();
    expect(resolveTagDisplay('constructor')).toBeNull();
    expect(resolveTagDisplay('valueOf')).toBeNull();
  });
});
