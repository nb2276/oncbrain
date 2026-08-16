// v0.50: an override must survive the study being renamed.
//
// Every override key is a slug, and a slug is derived from the name Phase 1
// writes. A rebuild renames studies, the key stops matching, and the override
// silently does nothing. That failed twice in one cycle: an EDIT no-op'd
// (v0.45.1) and three SUPPRESSions republished hidden duplicates (v0.49.0) —
// RADIOSA, EXTEND and PEACE-2 each rendered twice on the live site.
//
// The identity block records what the study WAS, so the override can be
// re-pointed. These tests are mostly about when it must REFUSE to re-point,
// because guessing wrong either deletes a card the curator wants or republishes
// one they hid, and both are silent.

import { describe, it, expect } from 'vitest';
import { applyOverrides } from '../src/lib/digest-overrides.ts';
import type { DigestOutput } from '../src/lib/llm-pipeline.ts';

const study = (slug: string, name: string, nct: string | null = null) =>
  ({ name, slug, nct, tldr: 't', details: [], tweet_ids: [] }) as never;

const digest = (...studies: unknown[]) =>
  ({
    top_line: 'x',
    tldr: 'y',
    sites: [{ disease_site: 'prostate', intro: null, studies, open_questions: null }],
    meta: { studies_analyzed: studies.length, dropped: [], ocr_available: true },
  }) as unknown as DigestOutput;

describe('override identity survives a rename', () => {
  it('re-points a suppress when the study was renamed, matching on NCT', () => {
    const d = digest(study('radiosa-mfs-posthoc', 'RADIOSA', 'NCT03940235'), study('other', 'Other'));
    const r = applyOverrides(d, {
      suppress: ['radiosa'],
      identity: { radiosa: { nct: 'NCT03940235', name: 'RADIOSA' } },
    });
    expect(r.digest.sites[0].studies).toHaveLength(1);
    expect(r.summary.suppressed).toEqual(['radiosa-mfs-posthoc']);
    expect(r.summary.suppressMissing).toEqual([]);
    expect(r.summary.resolvedRenames).toEqual(['radiosa → radiosa-mfs-posthoc']);
  });

  it('re-points on the acronym when the study carries no NCT', () => {
    // the real EXTEND case: `extend` became `extend-trial`, no NCT on either
    const d = digest(study('extend-trial', 'EXTEND'), study('keep', 'Something Else'));
    const r = applyOverrides(d, {
      suppress: ['extend'],
      identity: { extend: { nct: null, name: 'EXTEND' } },
    });
    expect(r.summary.suppressed).toEqual(['extend-trial']);
    expect(r.digest.sites[0].studies.map((s) => s.slug)).toEqual(['keep']);
  });

  it('re-points an EDIT too, which currently only warns', () => {
    const d = digest(study('peace-2', 'PEACE-2'));
    const r = applyOverrides(d, {
      edits: { 'peace2-pelvic-rt': { tldr: 'curated' } },
      identity: { 'peace2-pelvic-rt': { nct: null, name: 'PEACE 2' } },
    });
    expect(r.digest.sites[0].studies[0].tldr).toBe('curated');
    expect(r.summary.editMissing).toEqual([]);
  });

  it('REFUSES an ambiguous match rather than guessing which card to drop', () => {
    // two live studies answer to one identity; dropping either is a coin flip
    const d = digest(study('extend-trial', 'EXTEND'), study('extend-2', 'EXTEND'));
    const r = applyOverrides(d, {
      suppress: ['extend'],
      identity: { extend: { nct: null, name: 'EXTEND' } },
    });
    expect(r.digest.sites[0].studies).toHaveLength(2); // nothing dropped
    expect(r.summary.suppressMissing).toEqual(['extend']); // stays fatal upstream
    expect(r.summary.resolvedRenames).toEqual([]);
  });

  it('does not re-point when the identity matches nothing', () => {
    const d = digest(study('a', 'Trial A'));
    const r = applyOverrides(d, {
      suppress: ['gone'],
      identity: { gone: { nct: 'NCT99999999', name: 'Vanished Trial' } },
    });
    expect(r.digest.sites[0].studies).toHaveLength(1);
    expect(r.summary.suppressMissing).toEqual(['gone']);
  });

  it('never re-points a slug that still exists — an exact match always wins', () => {
    // both live; the override must hit its own target, not the identity twin
    const d = digest(study('extend', 'EXTEND'), study('extend-trial', 'EXTEND'));
    const r = applyOverrides(d, {
      suppress: ['extend'],
      identity: { extend: { nct: null, name: 'EXTEND' } },
    });
    expect(r.summary.suppressed).toEqual(['extend']);
    expect(r.digest.sites[0].studies.map((s) => s.slug)).toEqual(['extend-trial']);
  });

  it('works unchanged on a legacy sidecar with no identity block', () => {
    const d = digest(study('a', 'Trial A'), study('b', 'Trial B'));
    const r = applyOverrides(d, { suppress: ['a'] });
    expect(r.digest.sites[0].studies.map((s) => s.slug)).toEqual(['b']);
    expect(r.summary.suppressed).toEqual(['a']);
    expect(r.summary.resolvedRenames).toEqual([]);
  });
});

// Provenance identity. Trial lineage suppresses a superseded card
// automatically, and that act is what breaks the override: the card leaves the
// published artifact, so the next rebuild cannot hold its slug and renames it.
// Neither older pass can re-find it — a split trial's two cards share one
// acronym key, and abstract-era cards routinely carry no NCT. The source rows
// are what identify a card, which is the identity slug persistence already uses.
describe('override identity via provenance', () => {
  const withSources = (slug: string, name: string, ids: number[], nct: string | null = null) =>
    ({
      name,
      slug,
      nct,
      tldr: 't',
      details: [],
      tweet_ids: [],
      source_ids: ids.map((id) => ({ type: 'paper', id })),
    }) as never;

  it('re-points a suppress when name and NCT are both ambiguous', () => {
    // The real NRG-GU005 case: splitting one trial into a disease-free-survival
    // card and a quality-of-life card gives both the same studyDedupKey, and
    // neither carries an NCT. Only the source rows separate them.
    const d = digest(
      withSources('nrg-gu005-dfs', 'NRG-GU005 (disease-free survival)', [44]),
      withSources('nrg-gu005-qol', 'NRG-GU005 (quality of life)', [43]),
    );
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: {
        'nrg-gu005': {
          nct: null,
          name: 'NRG-GU005 (disease-free survival)',
          source_ids: [{ type: 'paper', id: 44 }],
        },
      },
    });
    expect(r.summary.suppressed).toEqual(['nrg-gu005-dfs']);
    expect(r.summary.resolvedRenames).toEqual(['nrg-gu005 → nrg-gu005-dfs']);
    // the quality-of-life card survives — suppressing it too would delete a
    // finding the superseding publication never reported
    expect(r.digest.sites[0].studies.map((s) => s.slug)).toEqual(['nrg-gu005-qol']);
  });

  it('REFUSES when the recorded sources match two studies', () => {
    // Genuine ambiguity is two cards with the SAME source set. (A card that
    // merely CONTAINS the recorded source is a different card under equality
    // matching — covered separately below.)
    const d = digest(
      withSources('a', 'NRG-GU005 (disease-free survival)', [44]),
      withSources('b', 'NRG-GU005 (quality of life)', [44]),
    );
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { nct: null, source_ids: [{ type: 'paper', id: 44 }] } },
    });
    expect(r.summary.suppressMissing).toEqual(['nrg-gu005']);
    expect(r.digest.sites[0].studies).toHaveLength(2);
  });

  it('REFUSES when no study carries the recorded sources', () => {
    const d = digest(withSources('a', 'Something Else', [99]));
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { nct: null, source_ids: [{ type: 'paper', id: 44 }] } },
    });
    expect(r.summary.suppressMissing).toEqual(['nrg-gu005']);
    expect(r.digest.sites[0].studies).toHaveLength(1);
  });
});

// Provenance must WIN, not merely break ties. Lineage creates two cards per
// trial and then suppresses one, which vacates a slug the sibling can take on
// the next rebuild — so a live slug is not proof of identity.
describe('override identity: provenance outranks slug and name', () => {
  const withSources = (slug: string, name: string, ids: number[], nct: string | null = null) =>
    ({
      name, slug, nct, tldr: 't', details: [], tweet_ids: [],
      source_ids: ids.map((id) => ({ type: 'paper', id })),
    }) as never;

  it('does NOT suppress a different card that inherited the recorded slug', () => {
    // `nrg-gu005` was the DFS card. It got dropped, the rebuild renamed things,
    // and the quality-of-life card took the vacated slug. Short-circuiting on
    // the live slug would hide the QoL card — a finding the superseding
    // publication never reported.
    const d = digest(
      withSources('nrg-gu005', 'NRG-GU005 (quality of life)', [43]),
      withSources('nrg-gu005-dfs', 'NRG-GU005 (disease-free survival)', [44]),
    );
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { nct: null, source_ids: [{ type: 'paper', id: 44 }] } },
    });
    expect(r.summary.suppressed).toEqual(['nrg-gu005-dfs']);
    expect(r.digest.sites[0].studies.map((s) => s.slug)).toEqual(['nrg-gu005']);
  });

  it('refuses when a unique NCT hit contradicts the recorded provenance', () => {
    const d = digest(
      withSources('a', 'TRIALX', [10], 'NCT12345678'),
      withSources('b', 'TRIALY', [44]),
    );
    const r = applyOverrides(d, {
      suppress: ['old'],
      identity: { old: { nct: 'NCT12345678', source_ids: [{ type: 'paper', id: 99 }] } },
    });
    expect(r.summary.suppressMissing).toEqual(['old']);
    expect(r.digest.sites[0].studies).toHaveLength(2);
  });

  it('survives malformed source_ids instead of throwing inside build:day', () => {
    const d = digest(withSources('a', 'TRIALX', [44]));
    expect(() =>
      applyOverrides(d, {
        suppress: ['old'],
        identity: { old: { source_ids: [null, 5, { id: 44 }] } } as never,
      }),
    ).not.toThrow();
  });
});

// Provenance must be EQUALITY, not overlap, and malformed identity must fail
// closed. Overlap let a Phase-1 merge hand the suppression a card carrying an
// unrelated second objective.
describe('override provenance is exact', () => {
  const withSources = (slug: string, name: string, ids: number[]) =>
    ({ name, slug, nct: null, tldr: 't', details: [], tweet_ids: [],
       source_ids: ids.map((id) => ({ type: 'paper', id })) }) as never;

  it('does NOT match a merged card that merely CONTAINS the recorded source', () => {
    const d = digest(withSources('merged', 'NRG-GU005', [44, 43]), withSources('keep', 'OTHER', [1]));
    const r = applyOverrides(d, {
      suppress: ['old'],
      identity: { old: { source_ids: [{ type: 'paper', id: 44 }] } },
    });
    expect(r.summary.suppressMissing).toEqual(['old']);
    expect(r.digest.sites[0].studies).toHaveLength(2);
  });

  it('rejects a string id rather than matching numeric 44 by interpolation', () => {
    const d = digest(withSources('a', 'TRIALX', [44]), withSources('keep', 'OTHER', [1]));
    const r = applyOverrides(d, {
      suppress: ['old'],
      identity: { old: { source_ids: [{ type: 'paper', id: '44' }] } } as never,
    });
    expect(r.summary.suppressMissing).toEqual(['old']);
    expect(r.digest.sites[0].studies).toHaveLength(2);
  });
});

// Round three. Two ways a recorded identity could still hit the WRONG card, and
// one way a legitimate override could fail the nightly publish.
describe('override identity fails closed', () => {
  const src = (slug: string, name: string, ids: { type: string; id: number }[]) =>
    ({ name, slug, nct: null, tldr: 't', details: [], tweet_ids: [], source_ids: ids }) as never;
  const P = (id: number) => ({ type: 'paper', id });
  const S = (id: number) => ({ type: 'slide', id });

  it('does not fall back on a live slug when the identity is unparseable', () => {
    // Corrupt identity is the LEAST trustworthy state, so trusting the slug there
    // is backwards — the slug may since have been inherited by a sibling card.
    const d = digest(src('nrg-gu005', 'NRG-GU005 (quality of life)', [P(43)]), src('other', 'X', [P(1)]));
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { source_ids: [{ type: 'paper', id: '44' }] } } as never,
    });
    expect(r.summary.suppressed).toEqual([]);
    expect(r.summary.suppressMissing).toEqual(['nrg-gu005']);
    expect(r.digest.sites[0].studies).toHaveLength(2);
  });

  it('does not fall back on a live slug when valid provenance matches nothing', () => {
    const d = digest(src('nrg-gu005', 'NRG-GU005 (quality of life)', [P(43)]), src('other', 'X', [P(1)]));
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { source_ids: [P(44)] } },
    });
    expect(r.summary.suppressed).toEqual([]);
    expect(r.summary.suppressMissing).toEqual(['nrg-gu005']);
  });

  it('survives a late slide joining the target card', () => {
    // An unmatched suppress is FATAL to build:day, so before this a single
    // conference photo arriving for a past date could fail the nightly publish.
    const d = digest(src('nrg-gu005-dfs', 'NRG-GU005 (DFS)', [P(44), S(7)]), src('keep', 'X', [P(1)]));
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { source_ids: [P(44)] } },
    });
    expect(r.summary.suppressed).toEqual(['nrg-gu005-dfs']);
    expect(r.summary.suppressMissing).toEqual([]);
  });
});

// An override sidecar is hand-editable, so a malformed entry must fail closed —
// never suppress the wrong card, and never abort the nightly build.
describe('malformed identity entries fail closed', () => {
  const src = (slug: string, name: string, ids: number[]) =>
    ({ name, slug, nct: null, tldr: 't', details: [], tweet_ids: [],
       source_ids: ids.map((id) => ({ type: 'paper', id })) }) as never;

  it('does not CRASH build:day on a primitive identity entry', () => {
    // `'source_ids' in (id ?? {})` throws a TypeError on a string, which aborted
    // the whole nightly publish.
    const d = digest(src('a', 'A', [1]), src('b', 'B', [2]));
    let r: ReturnType<typeof applyOverrides>;
    expect(() => {
      r = applyOverrides(d, { suppress: ['a'], identity: { a: 'corrupt' } as never });
    }).not.toThrow();
    expect(r!.summary.suppressed).toEqual([]);
    expect(r!.summary.suppressMissing).toEqual(['a']);
  });

  it('treats an explicit null source_ids as CORRUPT, not as absent', () => {
    // Reading it as "legacy, no provenance recorded" took the live-slug
    // shortcut — the sibling-card reuse this mechanism exists to prevent.
    const d = digest(src('nrg-gu005', 'NRG-GU005 (quality of life)', [43]), src('o', 'X', [1]));
    const r = applyOverrides(d, {
      suppress: ['nrg-gu005'],
      identity: { 'nrg-gu005': { source_ids: null } } as never,
    });
    expect(r.summary.suppressed).toEqual([]);
    expect(r.summary.suppressMissing).toEqual(['nrg-gu005']);
    expect(r.digest.sites[0].studies).toHaveLength(2);
  });
});
