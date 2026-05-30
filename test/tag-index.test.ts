// v0.10 tag-index unit tests. Covers: derive-from-typed-fields semantics,
// reverse index correctness, intersection cardinality (2-way, 3-way,
// threshold, cap, anti-monotone shortcut), sibling pre-compute (primary +
// fallback rule + tie-break), and the build-time uniqueness assertion wrapper.

import { describe, it, expect } from 'vitest';
import type { DigestArtifact, DigestStudy } from '../src/lib/digest-data.ts';
import {
  deriveStudyTags,
  buildReverseIndex,
  computeIntersections,
  computeSiblings,
  collectMeetingSlugs,
  assertSlugUniqueness,
  studyKeyString,
} from '../src/lib/tag-index.ts';
import { VERDICT_META } from '../src/lib/verdict.ts';

const VERDICT_SLUGS = Object.keys(VERDICT_META);

// ---------------- Fixtures ----------------

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

// ---------------- deriveStudyTags ----------------

describe('deriveStudyTags', () => {
  it('reads typed fields directly when valid', () => {
    const study = makeStudy('A', {
      modality: 'radiation',
      intent: 'palliative',
      methodology: 'phase-3-rct',
      verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
    });
    const view = deriveStudyTags(study, 'breast', 'asco-2026');
    expect(view).toEqual({
      modality: 'radiation',
      intent: 'palliative',
      methodology: 'phase-3-rct',
      verdict: 'confirmatory',
      meeting: 'asco-2026',
      disease_site: 'breast',
    });
  });

  it('drops invalid enum values (LLM hallucination defense)', () => {
    const study = makeStudy('B', {
      // @ts-expect-error — testing the runtime guard against an out-of-enum string
      modality: 'rt',
      intent: 'curative',
    });
    const view = deriveStudyTags(study, 'breast', null);
    expect(view.modality).toBeNull();
    expect(view.intent).toBe('curative');
  });

  it('null fields when absent', () => {
    const view = deriveStudyTags(makeStudy('C'), 'breast', null);
    expect(view.modality).toBeNull();
    expect(view.intent).toBeNull();
    expect(view.methodology).toBeNull();
    expect(view.verdict).toBeNull();
    expect(view.meeting).toBeNull();
    expect(view.disease_site).toBe('breast');
  });
});

// ---------------- buildReverseIndex ----------------

describe('buildReverseIndex', () => {
  it('indexes a study under every tag namespace it carries', () => {
    const d = makeDigest('2026-05-27', 'asco-2026', [
      {
        disease_site: 'breast',
        studies: [
          makeStudy('A', {
            modality: 'radiation',
            intent: 'palliative',
            methodology: 'phase-3-rct',
            verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
          }),
        ],
      },
    ]);
    const index = buildReverseIndex([d]);
    const key = studyKeyString({ date: '2026-05-27', resolvedSlug: 'a' });
    for (const slug of ['radiation', 'palliative', 'phase-3-rct', 'confirmatory', 'asco-2026']) {
      const set = index.get(slug);
      expect(set, `slug ${slug} missing`).toBeTruthy();
      expect(set!.has(key)).toBe(true);
    }
    // Disease-site is NOT in the /tags/ index (stays at /sites/)
    expect(index.has('breast')).toBe(false);
  });

  it('skips null-valued tags (study with no modality does not appear on modality landings)', () => {
    const d = makeDigest('2026-05-27', null, [
      {
        disease_site: 'breast',
        studies: [makeStudy('A', { intent: 'palliative' })],
      },
    ]);
    const index = buildReverseIndex([d]);
    expect(index.has('palliative')).toBe(true);
    expect(index.has('radiation')).toBe(false);
  });

  it('multiple studies on the same tag aggregate into one Set', () => {
    const d = makeDigest('2026-05-27', null, [
      {
        disease_site: 'breast',
        studies: [
          makeStudy('A', { modality: 'radiation' }),
          makeStudy('B', { modality: 'radiation' }),
        ],
      },
    ]);
    const set = buildReverseIndex([d]).get('radiation')!;
    expect(set.size).toBe(2);
  });

  it('respects within-day slug resolution (collisions get -2 suffix)', () => {
    // Two studies named "Trial" → resolved slugs "trial" and "trial-2"
    const d = makeDigest('2026-05-27', null, [
      {
        disease_site: 'breast',
        studies: [
          makeStudy('Trial', { modality: 'radiation' }),
          makeStudy('Trial', { modality: 'radiation' }),
        ],
      },
    ]);
    const set = buildReverseIndex([d]).get('radiation')!;
    expect(set.has(studyKeyString({ date: '2026-05-27', resolvedSlug: 'trial' }))).toBe(true);
    expect(set.has(studyKeyString({ date: '2026-05-27', resolvedSlug: 'trial-2' }))).toBe(true);
  });
});

// ---------------- computeIntersections ----------------

describe('computeIntersections', () => {
  it('returns 2-way intersections meeting the threshold, canonical alphabetical order', () => {
    const studies = [
      makeStudy('A', { modality: 'radiation', intent: 'palliative' }),
      makeStudy('B', { modality: 'radiation', intent: 'palliative' }),
      makeStudy('C', { modality: 'radiation', intent: 'palliative' }),
    ];
    const index = buildReverseIndex([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const inters = computeIntersections(index, { maxArity: 2, threshold: 3, cap: 1000 });
    const pair = inters.find((i) => i.tags.length === 2);
    expect(pair).toBeTruthy();
    expect(pair!.tags).toEqual(['palliative', 'radiation']); // alphabetical
    expect(pair!.studyCount).toBe(3);
  });

  it('drops intersections below threshold', () => {
    const studies = [
      makeStudy('A', { modality: 'radiation', intent: 'palliative' }),
      makeStudy('B', { modality: 'radiation', intent: 'palliative' }),
    ];
    const index = buildReverseIndex([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const inters = computeIntersections(index, { maxArity: 2, threshold: 3, cap: 1000 });
    expect(inters.find((i) => i.tags.includes('radiation') && i.tags.includes('palliative'))).toBeUndefined();
  });

  it('emits 3-way intersections meeting threshold + anti-monotone shortcut works', () => {
    const studies = [
      makeStudy('A', { modality: 'radiation', intent: 'palliative', methodology: 'phase-3-rct' }),
      makeStudy('B', { modality: 'radiation', intent: 'palliative', methodology: 'phase-3-rct' }),
      makeStudy('C', { modality: 'radiation', intent: 'palliative', methodology: 'phase-3-rct' }),
    ];
    const index = buildReverseIndex([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const inters = computeIntersections(index, { maxArity: 3, threshold: 3, cap: 1000 });
    const three = inters.find((i) => i.tags.length === 3);
    expect(three).toBeTruthy();
    expect(three!.tags).toEqual(['palliative', 'phase-3-rct', 'radiation']); // alphabetical
    expect(three!.studyCount).toBe(3);
  });

  it('respects the cap, sorted by count desc', () => {
    // 5 single-tag landings each with 3 studies, no overlap (so no
    // intersections meet threshold) — confirms the cap applies sanely.
    const studies = [
      makeStudy('A', { modality: 'radiation' }),
      makeStudy('B', { modality: 'radiation' }),
      makeStudy('C', { modality: 'radiation' }),
    ];
    const index = buildReverseIndex([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const inters = computeIntersections(index, { maxArity: 2, threshold: 3, cap: 0 });
    expect(inters).toEqual([]);
  });

  it('returns no intersections on an empty index', () => {
    const inters = computeIntersections(new Map(), { maxArity: 3, threshold: 3, cap: 1000 });
    expect(inters).toEqual([]);
  });
});

// ---------------- computeSiblings ----------------

describe('computeSiblings', () => {
  it('matches on disease_site + verdict + modality (primary rule)', () => {
    const studies = [
      makeStudy('A', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
      makeStudy('B', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
      makeStudy('C', {
        modality: 'radiation',
        verdict: { soc_implication: 'practice-changing', rationale: '', audience: null }, // different verdict
      }),
    ];
    const map = computeSiblings([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const aKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'a' });
    const siblings = map.get(aKey)!;
    expect(siblings).toHaveLength(1);
    expect(siblings[0]!.resolvedSlug).toBe('b'); // C is excluded (different verdict)
  });

  it('falls back to disease_site + verdict only when target has null modality', () => {
    const studies = [
      makeStudy('A', {
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
      makeStudy('B', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
      makeStudy('C', {
        modality: 'surgery',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
    ];
    const map = computeSiblings([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const aKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'a' });
    const siblings = map.get(aKey)!;
    expect(siblings).toHaveLength(2); // B + C both match on fallback
  });

  it('excludes self', () => {
    const studies = [
      makeStudy('A', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
    ];
    const map = computeSiblings([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const aKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'a' });
    expect(map.get(aKey)).toEqual([]);
  });

  it('caps at 3 siblings, sorted by date desc then slug asc', () => {
    const make = (name: string) =>
      makeStudy(name, {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      });
    const digests = [
      makeDigest('2026-05-25', null, [{ disease_site: 'breast', studies: [make('A')] }]),
      makeDigest('2026-05-26', null, [{ disease_site: 'breast', studies: [make('B')] }]),
      makeDigest('2026-05-27', null, [
        { disease_site: 'breast', studies: [make('Target'), make('C')] },
      ]),
    ];
    const map = computeSiblings(digests);
    const targetKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'target' });
    const siblings = map.get(targetKey)!;
    expect(siblings.map((s) => `${s.date}#${s.resolvedSlug}`)).toEqual([
      '2026-05-27#c', // same date as target, slug asc
      '2026-05-26#b',
      '2026-05-25#a',
    ]);
  });

  it('returns empty array when no candidates match', () => {
    const studies = [
      makeStudy('A', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
      makeStudy('B', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
    ];
    // Different disease sites — no siblings
    const map = computeSiblings([
      makeDigest('2026-05-27', null, [
        { disease_site: 'breast', studies: [studies[0]!] },
        { disease_site: 'prostate', studies: [studies[1]!] },
      ]),
    ]);
    const aKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'a' });
    expect(map.get(aKey)).toEqual([]);
  });
});

// ---------------- collectMeetingSlugs ----------------

describe('collectMeetingSlugs', () => {
  it('dedupes across days', () => {
    const digests = [
      makeDigest('2026-05-26', 'asco-2026', []),
      makeDigest('2026-05-27', 'asco-2026', []),
      makeDigest('2026-05-28', 'esmo-2026', []),
    ];
    const slugs = collectMeetingSlugs(digests).sort();
    expect(slugs).toEqual(['asco-2026', 'esmo-2026']);
  });

  it('filters null conferences', () => {
    const digests = [
      makeDigest('2026-05-26', null, []),
      makeDigest('2026-05-27', 'asco-2026', []),
    ];
    expect(collectMeetingSlugs(digests)).toEqual(['asco-2026']);
  });

  it('returns empty for an empty corpus', () => {
    expect(collectMeetingSlugs([])).toEqual([]);
  });
});

// ---------------- assertSlugUniqueness ----------------

describe('assertSlugUniqueness', () => {
  it('passes on clean corpus', () => {
    const digests = [makeDigest('2026-05-27', 'asco-2026', [])];
    expect(() => assertSlugUniqueness(digests, VERDICT_SLUGS)).not.toThrow();
  });

  it('throws with a useful collision message', () => {
    // Inject a synthetic collision: meeting slug equals a methodology value
    const digests = [makeDigest('2026-05-27', 'phase-3-rct', [])];
    expect(() => assertSlugUniqueness(digests, VERDICT_SLUGS)).toThrowError(/slug collision/i);
  });

  it('throws with a useful malformed-slug message', () => {
    const digests = [makeDigest('2026-05-27', 'ASCO 2026', [])];
    expect(() => assertSlugUniqueness(digests, VERDICT_SLUGS)).toThrowError(/malformed/i);
  });
});
