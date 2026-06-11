// v0.11 PR-1a: namespace map + built-intersections allowlist.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNamespaceMap,
  buildIntersectionAllowlist,
  tagFoundations,
  resetTagFoundationsCache,
  buildFilterRailOptions,
  type FilterStudyContext,
} from '../src/lib/tag-foundations.ts';
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
  confSlug: string | null,
  studies: DigestStudy[],
): DigestArtifact {
  return {
    date,
    conference: confSlug ? { slug: confSlug, name: confSlug.toUpperCase() } : null,
    generated_at: 0,
    digest: {
      top_line: 'top',
      tldr: 'tldr',
      sites: [{ disease_site: 'breast', intro: null, studies, open_questions: null }],
    },
    bookmarks: [],
  };
}

function writeDigestsFixture(digests: DigestArtifact[]): string {
  const root = mkdtempSync(join(tmpdir(), 'tag-foundations-'));
  const digestsDir = join(root, 'digests');
  mkdirSync(digestsDir, { recursive: true });
  for (const d of digests) {
    writeFileSync(join(digestsDir, `${d.date}.json`), JSON.stringify(d));
  }
  return digestsDir;
}

describe('buildNamespaceMap', () => {
  it('includes every modality / intent / methodology / verdict slug', () => {
    const { map } = buildNamespaceMap([]);
    expect(map.radiation).toBe('modality');
    expect(map.surgery).toBe('modality');
    expect(map.systemic).toBe('modality');
    expect(map.combined).toBe('modality');
    expect(map.curative).toBe('intent');
    expect(map.palliative).toBe('intent');
    expect(map.supportive).toBe('intent');
    expect(map['phase-3-rct']).toBe('methodology');
    expect(map['meta-analysis']).toBe('methodology');
    expect(map['practice-changing']).toBe('verdict');
    expect(map['challenges-soc']).toBe('verdict');
  });

  it('adds meeting slugs collected from the digest corpus', () => {
    const digests = [
      makeDigest('2026-05-21', 'asco-2026', [makeStudy('A')]),
      makeDigest('2026-05-22', 'esmo-2026', [makeStudy('B')]),
    ];
    const { map } = buildNamespaceMap(digests);
    expect(map['asco-2026']).toBe('meeting');
    expect(map['esmo-2026']).toBe('meeting');
  });

  it('intentionally omits disease-site slugs (intent:supportive collides with site:supportive)', () => {
    const { map } = buildNamespaceMap([]);
    expect(map.breast).toBeUndefined();
    expect(map.prostate).toBeUndefined();
    // The intent slug must win — that's the namespace v0.10's slug-
    // uniqueness assertion guards.
    expect(map.supportive).toBe('intent');
  });

  it('returns version 1', () => {
    const result = buildNamespaceMap([]);
    expect(result.version).toBe(1);
  });
});

describe('buildIntersectionAllowlist', () => {
  it('returns version 1 with a sorted paths array', () => {
    const digests = [
      makeDigest('2026-05-21', null, [
        makeStudy('A', { modality: 'radiation', intent: 'curative' }),
        makeStudy('B', { modality: 'radiation', intent: 'curative' }),
        makeStudy('C', { modality: 'radiation', intent: 'curative' }),
      ]),
    ];
    const result = buildIntersectionAllowlist(digests);
    expect(result.version).toBe(1);
    expect(Array.isArray(result.paths)).toBe(true);
    // Path strings are canonical alphabetical 'a+b' shape, no slashes.
    for (const p of result.paths) {
      expect(p).toMatch(/^[a-z0-9-]+(?:\+[a-z0-9-]+){1,2}$/);
    }
    const sorted = [...result.paths].sort();
    expect(result.paths).toEqual(sorted);
  });

  it('emits no paths when no 2-way intersection meets the threshold', () => {
    const digests = [
      makeDigest('2026-05-21', null, [
        makeStudy('A', { modality: 'radiation', intent: 'curative' }),
      ]),
    ];
    // Single study can't satisfy threshold=3 → no intersections.
    const result = buildIntersectionAllowlist(digests);
    expect(result.paths).toEqual([]);
  });
});

describe('tagFoundations (module cache)', () => {
  beforeEach(() => {
    resetTagFoundationsCache();
  });

  it('returns the same object reference on a second call (memoization)', () => {
    const digestsDir = writeDigestsFixture([
      makeDigest('2026-05-21', 'asco-2026', [makeStudy('A')]),
    ]);
    try {
      const a = tagFoundations(digestsDir);
      const b = tagFoundations(digestsDir);
      expect(a.namespaceMap).toBe(b.namespaceMap);
      expect(a.intersectionAllowlist).toBe(b.intersectionAllowlist);
    } finally {
      rmSync(digestsDir, { recursive: true, force: true });
    }
  });

  it('recomputes when the digest file set changes', () => {
    const digestsDir = writeDigestsFixture([
      makeDigest('2026-05-21', 'asco-2026', [makeStudy('A')]),
    ]);
    try {
      const first = tagFoundations(digestsDir);
      // Add a new digest with a different conference → namespace map gains
      // a new meeting slug.
      writeFileSync(
        join(digestsDir, '2026-05-22.json'),
        JSON.stringify(makeDigest('2026-05-22', 'esmo-2026', [makeStudy('B')])),
      );
      const second = tagFoundations(digestsDir);
      expect(first.namespaceMap.map['esmo-2026']).toBeUndefined();
      expect(second.namespaceMap.map['esmo-2026']).toBe('meeting');
      // Object reference differs after cache invalidation.
      expect(first.namespaceMap).not.toBe(second.namespaceMap);
    } finally {
      rmSync(digestsDir, { recursive: true, force: true });
    }
  });

  it('handles a missing digests dir without throwing', () => {
    const nonexistent = join(tmpdir(), `tag-foundations-missing-${Date.now()}`);
    const result = tagFoundations(nonexistent);
    expect(result.namespaceMap.version).toBe(1);
    expect(result.namespaceMap.map.radiation).toBe('modality');
    expect(result.intersectionAllowlist.paths).toEqual([]);
  });
});

describe('buildFilterRailOptions', () => {
  function ctx(
    study: Partial<DigestStudy>,
    conferenceSlug: string | null = null,
    conferenceLabel: string | null = null,
  ): FilterStudyContext {
    return {
      study: {
        name: 'X',
        tldr: 'X',
        details: [],
        nct: null,
        tweet_ids: [],
        ...study,
      } as DigestStudy,
      conferenceSlug,
      conferenceLabel,
    };
  }

  it('groups tags into the five namespaces with per-page counts', () => {
    const out = buildFilterRailOptions([
      ctx({
        modality: 'radiation',
        intent: 'curative',
        methodology: 'phase-3-rct',
        verdict: { soc_implication: 'practice-changing', rationale: '', audience: null },
      }, 'asco-2026', 'ASCO 2026'),
      ctx({
        modality: 'radiation',
        intent: 'palliative',
        methodology: 'phase-2-trial',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }, 'asco-2026', 'ASCO 2026'),
      ctx({
        modality: 'surgery',
        intent: 'curative',
        methodology: 'phase-3-rct',
        verdict: { soc_implication: 'confirmatory', rationale: '', audience: null },
      }, 'esmo-2026', 'ESMO 2026'),
    ]);
    expect(out.modality.map((o) => [o.slug, o.count])).toEqual([
      ['radiation', 2],
      ['surgery', 1],
    ]);
    expect(out.intent.map((o) => [o.slug, o.count])).toEqual([
      ['curative', 2],
      ['palliative', 1],
    ]);
    expect(out.methodology.map((o) => [o.slug, o.count])).toEqual([
      ['phase-3-rct', 2],
      ['phase-2-trial', 1],
    ]);
    // v0.14.4: verdict orders by clinical importance, NOT count — so
    // practice-changing (count 1) leads confirmatory (count 2).
    expect(out.verdict.map((o) => [o.slug, o.count])).toEqual([
      ['practice-changing', 1],
      ['confirmatory', 2],
    ]);
    expect(out.meeting.map((o) => [o.slug, o.count])).toEqual([
      ['asco-2026', 2],
      ['esmo-2026', 1],
    ]);
  });

  it('orders verdict by clinical importance even when a milder verdict has more studies', () => {
    const out = buildFilterRailOptions([
      ctx({ verdict: { soc_implication: 'unclear', rationale: '', audience: null } }),
      ctx({ verdict: { soc_implication: 'unclear', rationale: '', audience: null } }),
      ctx({ verdict: { soc_implication: 'unclear', rationale: '', audience: null } }),
      ctx({ verdict: { soc_implication: 'practice-changing', rationale: '', audience: null } }),
      ctx({ verdict: { soc_implication: 'methodologically-limited', rationale: '', audience: null } }),
    ]);
    // practice-changing first despite 'unclear' having the most studies (3).
    expect(out.verdict.map((o) => o.slug)).toEqual([
      'practice-changing',
      'methodologically-limited',
      'unclear',
    ]);
  });

  it('resolves human-readable labels per namespace', () => {
    const out = buildFilterRailOptions([
      ctx({
        modality: 'radiation',
        verdict: { soc_implication: 'practice-changing', rationale: '', audience: null },
      }, 'asco-2026', 'ASCO 2026'),
    ]);
    expect(out.modality[0]!.label).toBe('Radiation');
    expect(out.verdict[0]!.label).toBe('Practice-changing');
    expect(out.meeting[0]!.label).toBe('ASCO 2026');
  });

  it('returns empty arrays for namespaces with no studies', () => {
    const out = buildFilterRailOptions([ctx({ modality: 'radiation' })]);
    expect(out.intent).toEqual([]);
    expect(out.methodology).toEqual([]);
    expect(out.verdict).toEqual([]);
    expect(out.meeting).toEqual([]);
  });

  it('drops invalid enum values silently (legacy artifacts)', () => {
    const out = buildFilterRailOptions([
      ctx({ modality: 'chemo' as unknown as 'radiation' }),
    ]);
    expect(out.modality).toEqual([]);
  });
});
