// v0.10 StudyCard surface helpers. studyTagSlugs derives the chip row from
// typed fields; buildSiblingPreviews enriches the StudyKey-keyed sibling map
// with name/tldr/verdict-emoji so StudyCard renders without re-walking the
// corpus per card.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  studyTagSlugs,
  studyTagChips,
  buildSiblingPreviews,
  resetSiblingPreviewsCache,
  studyKeyString,
} from '../src/lib/tag-index.ts';
import type { DigestArtifact, DigestStudy } from '../src/lib/digest-data.ts';

beforeEach(() => {
  // The module-level sibling cache must reset between tests so each test
  // gets a fresh corpus.
  resetSiblingPreviewsCache();
});

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

describe('studyTagSlugs', () => {
  it('emits all 5 namespaces in stable order when all typed fields are populated', () => {
    const study = makeStudy('A', {
      modality: 'radiation',
      intent: 'palliative',
      methodology: 'phase-3-rct',
      verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
    });
    expect(studyTagSlugs(study, 'asco-2026')).toEqual([
      'radiation',
      'palliative',
      'phase-3-rct',
      'confirmatory',
      'asco-2026',
    ]);
  });

  it('omits null modality (and only modality)', () => {
    const study = makeStudy('A', {
      intent: 'palliative',
      verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
    });
    expect(studyTagSlugs(study, null)).toEqual(['palliative', 'confirmatory']);
  });

  it('drops out-of-enum modality (defensive against legacy / corrupt artifacts)', () => {
    const study = makeStudy('A', {
      // @ts-expect-error — runtime check for an out-of-enum value
      modality: 'rt',
      verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
    });
    expect(studyTagSlugs(study, null)).toEqual(['confirmatory']);
  });

  it('omits meeting when conference is null', () => {
    const study = makeStudy('A', { modality: 'radiation' });
    expect(studyTagSlugs(study, null)).toEqual(['radiation']);
  });

  it('returns empty when no typed fields and no conference', () => {
    expect(studyTagSlugs(makeStudy('A'), null)).toEqual([]);
  });

  it('deduplicates slugs (defense against future cross-namespace collision)', () => {
    // Hypothetical: if conferenceSlug somehow matched modality (e.g.
    // build-time assertion was bypassed in a test fixture), the chip row
    // shouldn't render the same slug twice.
    const study = makeStudy('A', { modality: 'radiation' });
    expect(studyTagSlugs(study, 'radiation')).toEqual(['radiation']);
  });
});

describe('studyTagChips — meeting label round-trip (P0 regression guard)', () => {
  it('emits a meeting chip with the conference NAME, not the slug', () => {
    // Adversarial finding: resolveTagDisplay(slug) without occurrences
    // returned null for meeting slugs, silently dropping every meeting chip.
    // studyTagChips resolves at the call site where conference data lives.
    const study = makeStudy('A');
    const chips = studyTagChips(study, { slug: 'asco-2026', name: 'ASCO 2026' });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({ slug: 'asco-2026', label: 'ASCO 2026' });
  });

  it('emits all 5 namespaces with display labels (not slugs)', () => {
    const study = makeStudy('A', {
      modality: 'radiation',
      intent: 'palliative',
      methodology: 'phase-3-rct',
      verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
    });
    const chips = studyTagChips(study, { slug: 'asco-2026', name: 'ASCO 2026' });
    expect(chips).toEqual([
      { slug: 'radiation', label: 'Radiation' },
      { slug: 'palliative', label: 'Palliative' },
      { slug: 'phase-3-rct', label: 'Phase 3 RCT' },
      { slug: 'confirmatory', label: 'Confirmatory' },
      { slug: 'asco-2026', label: 'ASCO 2026' },
    ]);
  });

  it('omits null namespaces (only what the study carries)', () => {
    const study = makeStudy('A', {
      intent: 'palliative',
    });
    expect(studyTagChips(study, null)).toEqual([
      { slug: 'palliative', label: 'Palliative' },
    ]);
  });

  it('drops out-of-enum typed fields silently (no chip emitted)', () => {
    const study = makeStudy('A', {
      // @ts-expect-error — runtime check for an out-of-enum value
      modality: 'RT',
      intent: 'palliative',
    });
    expect(studyTagChips(study, null)).toEqual([
      { slug: 'palliative', label: 'Palliative' },
    ]);
  });

  it('dedupes chips by slug', () => {
    const study = makeStudy('A', { modality: 'radiation' });
    const chips = studyTagChips(study, { slug: 'radiation', name: 'Radiation Conference 2026' });
    expect(chips).toHaveLength(1); // not 2
    // First match wins (modality def label, not conference name)
    expect(chips[0]!.label).toBe('Radiation');
  });

  it('returns empty for a study with no typed fields and no conference', () => {
    expect(studyTagChips(makeStudy('A'), null)).toEqual([]);
  });
});

describe('buildSiblingPreviews', () => {
  it('enriches sibling StudyKeys with name + tldr + verdict-emoji', () => {
    const studies = [
      makeStudy('Target', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
      makeStudy('Sibling', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: 'r', audience: 'a' },
      }),
    ];
    const map = buildSiblingPreviews([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const targetKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'target' });
    const previews = map.get(targetKey)!;
    expect(previews).toHaveLength(1);
    expect(previews[0]!.name).toBe('Sibling');
    expect(previews[0]!.tldr).toBe('Sibling tldr');
    expect(previews[0]!.verdictEmoji).toBeTruthy();
  });

  it('null verdictEmoji when sibling has no verdict', () => {
    const studies = [
      makeStudy('Target', {
        modality: 'radiation',
      }),
      makeStudy('Sibling', {
        modality: 'radiation',
      }),
    ];
    const map = buildSiblingPreviews([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const targetKey = studyKeyString({ date: '2026-05-27', resolvedSlug: 'target' });
    const previews = map.get(targetKey);
    // Both null modality? No — modality is radiation for both, but with no
    // verdict the sibling MATCH still requires same verdict (both undefined).
    // verdictEmoji on the preview row will be null.
    expect(previews).toBeDefined();
    expect(previews![0]!.verdictEmoji).toBeNull();
  });

  it('OMITS the map entry entirely when a study has zero siblings (no empty footer)', () => {
    const studies = [
      makeStudy('Lonely', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }),
    ];
    const map = buildSiblingPreviews([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies }]),
    ]);
    const key = studyKeyString({ date: '2026-05-27', resolvedSlug: 'lonely' });
    expect(map.has(key)).toBe(false);
  });

  it('per-DATE slug resolution propagates (cross-site name collision case)', () => {
    // Both "Trial" studies are siblings of each other and resolve to
    // {trial, trial-2}. Verifies buildSiblingPreviews uses walkStudiesPerDate.
    const make = () =>
      makeStudy('Trial', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      });
    const map = buildSiblingPreviews([
      makeDigest('2026-05-27', null, [
        { disease_site: 'breast', studies: [make()] },
        { disease_site: 'breast', studies: [make()] },
      ]),
    ]);
    expect(map.has(studyKeyString({ date: '2026-05-27', resolvedSlug: 'trial' }))).toBe(true);
    expect(map.has(studyKeyString({ date: '2026-05-27', resolvedSlug: 'trial-2' }))).toBe(true);
  });

  it('module-level cache returns the same map on second call (Codex perf fix)', () => {
    // The cache is keyed by sentinel — a subsequent call IGNORES its argument
    // and returns the cached map. The page-render pattern relies on this so
    // every static page reuses one computed map instead of re-walking the
    // corpus.
    const make = () =>
      makeStudy('A', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      });
    const first = buildSiblingPreviews([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies: [make()] }]),
    ]);
    // Pass DIFFERENT digests on second call. Cache must return the FIRST result.
    const second = buildSiblingPreviews([
      makeDigest('2026-06-01', null, [{ disease_site: 'prostate', studies: [make()] }]),
    ]);
    expect(second).toBe(first); // same Map reference
  });

  it('resetSiblingPreviewsCache forces a fresh compute on the next call', () => {
    const make = () =>
      makeStudy('A', {
        modality: 'radiation',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      });
    const first = buildSiblingPreviews([
      makeDigest('2026-05-27', null, [{ disease_site: 'breast', studies: [make()] }]),
    ]);
    resetSiblingPreviewsCache();
    const second = buildSiblingPreviews([
      makeDigest('2026-06-01', null, [{ disease_site: 'prostate', studies: [make()] }]),
    ]);
    expect(second).not.toBe(first); // fresh Map
  });
});
