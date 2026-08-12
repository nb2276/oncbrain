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
