// v0.10 30-day tag activity helper. Window semantics: last N PUBLISHED-digest
// dates, not last N calendar days. Trend computed by half-window comparison.

import { describe, it, expect } from 'vitest';
import { buildTagActivity } from '../src/lib/tag-index.ts';
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
  studies: DigestStudy[],
): DigestArtifact {
  return {
    date,
    conference: conferenceSlug ? { slug: conferenceSlug, name: conferenceSlug.toUpperCase() } : null,
    generated_at: 0,
    digest: {
      top_line: 'top',
      tldr: 'tldr',
      sites: [{ disease_site: 'breast', intro: null, studies, open_questions: null }],
    },
    bookmarks: [],
  };
}

describe('buildTagActivity', () => {
  it('returns [] on an empty corpus', () => {
    expect(buildTagActivity([])).toEqual([]);
  });

  it('returns [] when no studies carry any tags', () => {
    const digests = [makeDigest('2026-05-27', null, [makeStudy('A')])];
    expect(buildTagActivity(digests)).toEqual([]);
  });

  it('window collapses to corpus size when corpus < window', () => {
    // 3 digests, window=30 → counts.length should be 3, not 30.
    const digests = [
      makeDigest('2026-05-25', null, [makeStudy('A', { modality: 'radiation' })]),
      makeDigest('2026-05-26', null, [makeStudy('B', { modality: 'radiation' })]),
      makeDigest('2026-05-27', null, [makeStudy('C', { modality: 'radiation' })]),
    ];
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    expect(result).toHaveLength(1);
    expect(result[0]!.counts).toHaveLength(3);
  });

  it('window caps to N when corpus > window', () => {
    const digests = Array.from({ length: 12 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return makeDigest(`2026-05-${day}`, null, [makeStudy(`A${i}`, { modality: 'radiation' })]);
    });
    const result = buildTagActivity(digests, { limit: 5, window: 5 });
    expect(result[0]!.counts).toHaveLength(5);
  });

  it('counts emit per published date, oldest first', () => {
    const digests = [
      // Note: digests can arrive in any order; buildTagActivity should handle.
      makeDigest('2026-05-27', null, [
        makeStudy('A', { modality: 'radiation' }),
        makeStudy('B', { modality: 'radiation' }),
      ]),
      makeDigest('2026-05-25', null, [makeStudy('C', { modality: 'radiation' })]),
      makeDigest('2026-05-26', null, [makeStudy('D', { modality: 'radiation' })]),
    ];
    // listDigests sorts date-desc; emulate that here.
    digests.sort((a, b) => (a.date < b.date ? 1 : -1));
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    expect(result[0]!.counts).toEqual([1, 1, 2]); // 05-25, 05-26, 05-27
    expect(result[0]!.totalRecent).toBe(4);
  });

  it('trend: up when later half > earlier half + 1', () => {
    const digests = [
      makeDigest('2026-05-21', null, []),
      makeDigest('2026-05-22', null, []),
      makeDigest('2026-05-23', null, []),
      makeDigest('2026-05-24', null, []),
      makeDigest('2026-05-25', null, [
        makeStudy('A', { modality: 'radiation' }),
        makeStudy('B', { modality: 'radiation' }),
      ]),
      makeDigest('2026-05-26', null, [
        makeStudy('C', { modality: 'radiation' }),
        makeStudy('D', { modality: 'radiation' }),
      ]),
    ].sort((a, b) => (a.date < b.date ? 1 : -1));
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    expect(result[0]!.trend).toBe('up'); // earlier=0, later=4
  });

  it('trend: down when later half < earlier half - 1', () => {
    const digests = [
      makeDigest('2026-05-21', null, [
        makeStudy('A', { modality: 'radiation' }),
        makeStudy('B', { modality: 'radiation' }),
      ]),
      makeDigest('2026-05-22', null, [
        makeStudy('C', { modality: 'radiation' }),
        makeStudy('D', { modality: 'radiation' }),
      ]),
      makeDigest('2026-05-23', null, []),
      makeDigest('2026-05-24', null, []),
      makeDigest('2026-05-25', null, []),
      makeDigest('2026-05-26', null, []),
    ].sort((a, b) => (a.date < b.date ? 1 : -1));
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    expect(result[0]!.trend).toBe('down');
  });

  it('trend: flat when difference is within ±1 (small-corpus tolerance)', () => {
    const digests = [
      makeDigest('2026-05-25', null, [makeStudy('A', { modality: 'radiation' })]),
      makeDigest('2026-05-26', null, [makeStudy('B', { modality: 'radiation' })]),
    ].sort((a, b) => (a.date < b.date ? 1 : -1));
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    // earlier=1, later=1 → flat
    expect(result[0]!.trend).toBe('flat');
  });

  it('resolves labels: modality → "Radiation", verdict → "Confirmatory", meeting → conference.name', () => {
    const digests = [
      makeDigest('2026-05-27', 'asco-2026', [
        makeStudy('A', {
          modality: 'radiation',
          verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
        }),
      ]),
    ];
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    const labels = result.map((r) => r.label);
    expect(labels).toContain('Radiation');
    expect(labels).toContain('Confirmatory');
    expect(labels).toContain('ASCO-2026'); // conference.name from the test fixture
  });

  it('top-N: returns at most `limit` entries', () => {
    // 7 different tags via 7 verdicts × 0 isn't possible. Use a mix of
    // namespaces to get 6 distinct slugs.
    const digests = [
      makeDigest('2026-05-27', 'asco-2026', [
        makeStudy('A', {
          modality: 'radiation',
          intent: 'palliative',
          methodology: 'phase-3-rct',
          verdict: { soc_implication: 'practice-changing', rationale: '', audience: null },
        }),
      ]),
    ];
    const result = buildTagActivity(digests, { limit: 3, window: 30 });
    expect(result).toHaveLength(3);
  });

  it('top-N ordering: totalRecent desc, then trend (up > flat > down), then alphabetic', () => {
    const digests = [
      makeDigest('2026-05-25', null, [
        // intent:palliative gets 1 study, intent:curative gets 2
        makeStudy('A', { intent: 'curative' }),
        makeStudy('B', { intent: 'curative' }),
      ]),
      makeDigest('2026-05-26', null, [makeStudy('C', { intent: 'palliative' })]),
    ].sort((a, b) => (a.date < b.date ? 1 : -1));
    const result = buildTagActivity(digests, { limit: 5, window: 30 });
    expect(result[0]!.slug).toBe('curative'); // 2 > 1
    expect(result[1]!.slug).toBe('palliative');
  });
});
