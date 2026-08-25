// The publish boundary is where "did this remove something live?" is answerable
// without knowing HOW. The in-builder guard asks about Phase 2 casualties, which
// misses every loss that does not go through meta.dropped — a stale feature
// branch, a Phase 1 merge, a rename with a null dedup key. Same symptom, three
// mechanisms, and a fourth nobody has found yet.
import { describe, it, expect } from 'vitest';
import {
  studiesLostInPublish,
  publishRemovesContent,
  describePublishDiff,
} from '../src/lib/publish-diff.ts';

const artifact = (studies: Array<[string, string]>, aliases: string[] = []) => ({
  digest: { sites: [{ studies: studies.map(([slug, name]) => ({ slug, name })) }] },
  slug_aliases: aliases,
});

// With provenance, for the merge-vs-rename cases. A merged card carries BOTH
// originals' source_ids; a renamed one carries only its own.
const withSources = (
  studies: Array<[string, string, number[]]>,
  aliases: string[] = [],
) => ({
  digest: {
    sites: [
      {
        studies: studies.map(([slug, name, ids]) => ({
          slug,
          name,
          source_ids: ids.map((id) => ({ type: 'paper', id })),
        })),
      },
    ],
  },
  slug_aliases: aliases,
});

describe('studiesLostInPublish', () => {
  it('passes an unchanged publish', () => {
    const a = artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO']]);
    expect(publishRemovesContent(studiesLostInPublish({ baseline: a, incoming: a }))).toBe(false);
  });

  it('passes a publish that ADDS a study', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA']]),
      incoming: artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO']]),
    });
    expect(publishRemovesContent(d)).toBe(false);
  });

  // The stale-feature-branch case: main published CHARLIE after the branch was
  // cut, so the branch's rebuild has never heard of it.
  it('catches a card main has that the incoming artifact never knew about', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA'], ['charlie', 'CHARLIE']]),
      incoming: artifact([['alpha', 'ALPHA']]),
    });
    expect(d.lost.map((s) => s.slug)).toEqual(['charlie']);
    expect(publishRemovesContent(d)).toBe(true);
  });

  it('treats a recorded alias as a rename, not a loss', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['old-slug', 'PRESTIGE-PSMA']]),
      incoming: artifact([['new-slug', 'PRESTIGE-PSMA primary']], ['old-slug']),
    });
    expect(d.lost).toEqual([]);
    expect(publishRemovesContent(d)).toBe(false);
  });

  // The merge: every slug IS accounted for, because the retired one is an alias.
  // Only the count reveals that two cards became one.
  it('catches a Phase 1 merge that hides behind slug_aliases', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO']]),
      incoming: artifact([['alpha', 'ALPHA + BRAVO']], ['bravo']),
    });
    expect(d.lost).toEqual([]); // slug accounted for...
    expect(d.countShortfall).toBe(1); // ...count is not
    expect(publishRemovesContent(d)).toBe(true);
    expect(describePublishDiff('2026-07-08', d)).toContain('merge');
  });

  it('allows a deliberate suppression', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO']]),
      incoming: artifact([['alpha', 'ALPHA']]),
      suppressed: ['bravo'],
    });
    expect(publishRemovesContent(d)).toBe(false);
  });

  it('does not let a suppression excuse an UNRELATED loss', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO'], ['charlie', 'CHARLIE']]),
      incoming: artifact([['alpha', 'ALPHA']]),
      suppressed: ['bravo'],
    });
    expect(d.lost.map((s) => s.slug)).toEqual(['charlie']);
  });

  it('is inert when main has no baseline for the date', () => {
    const d = studiesLostInPublish({ baseline: null, incoming: artifact([['a', 'A']]) });
    expect(publishRemovesContent(d)).toBe(false);
  });

  it('is inert on a malformed baseline rather than blocking every publish', () => {
    // readPublishedArtifact-style fail-open: a guard that cannot read its input
    // must not become a permanent outage.
    for (const junk of [{}, { digest: {} }, { digest: { sites: [] } }, 'nonsense']) {
      expect(publishRemovesContent(studiesLostInPublish({ baseline: junk, incoming: artifact([['a', 'A']]) }))).toBe(false);
    }
  });

  it('names every casualty in the operator message', () => {
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO'], ['charlie', 'CHARLIE']]),
      incoming: artifact([['alpha', 'ALPHA']]),
    });
    const msg = describePublishDiff('2026-07-08', d);
    expect(msg).toContain('BRAVO');
    expect(msg).toContain('CHARLIE');
  });
});

// THE COUNT CHECK ONLY CATCHES A MERGE WHEN NOTHING ELSE CHANGED.
//
// Add one new study the same night and the arithmetic balances: two cards became
// one, one card appeared, total unchanged — while the retired slug sits in
// slug_aliases looking like an ordinary rename. From slugs and counts alone a
// merge and a rename are genuinely indistinguishable. Provenance is what tells
// them apart, and every study in the corpus records it.
describe('a merge masked by a new card', () => {
  it('is caught by provenance when counts and slugs both balance', () => {
    const d = studiesLostInPublish({
      baseline: withSources([['alpha', 'ALPHA', [1]], ['bravo', 'BRAVO', [2]]]),
      incoming: withSources([['alpha', 'ALPHA + BRAVO', [1, 2]], ['charlie', 'CHARLIE', [3]]], ['bravo']),
    });
    expect(d.lost).toEqual([]); // slug is aliased
    expect(d.countShortfall).toBe(0); // arithmetic balances
    expect(d.merged.map((m) => m.slug)).toEqual(['bravo']); // provenance does not
    expect(publishRemovesContent(d)).toBe(true);
  });

  it('does NOT fire on a legitimate rename alongside a new card', () => {
    const d = studiesLostInPublish({
      baseline: withSources([['old-slug', 'PRESTIGE-PSMA', [1]]]),
      incoming: withSources([['new-slug', 'PRESTIGE-PSMA primary', [1]], ['c', 'CHARLIE', [3]]], ['old-slug']),
    });
    expect(publishRemovesContent(d)).toBe(false);
  });

  it('does not report the card that SURVIVED the merge', () => {
    // alpha kept its slug and is still on the page; only bravo was swallowed.
    const d = studiesLostInPublish({
      baseline: withSources([['alpha', 'ALPHA', [1]], ['bravo', 'BRAVO', [2]]]),
      incoming: withSources([['alpha', 'ALPHA + BRAVO', [1, 2]]], ['bravo']),
    });
    expect(d.merged.map((m) => m.slug)).toEqual(['bravo']);
  });

  it('abstains when provenance is absent, rather than guessing', () => {
    // Older artifacts may predate source_ids; a guard that cannot read its input
    // must not become a permanent outage.
    const d = studiesLostInPublish({
      baseline: artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO']]),
      incoming: artifact([['alpha', 'MERGED'], ['charlie', 'C']], ['bravo']),
    });
    expect(d.merged).toEqual([]);
  });

  it('ignores a deliberately suppressed card', () => {
    const d = studiesLostInPublish({
      baseline: withSources([['alpha', 'ALPHA', [1]], ['bravo', 'BRAVO', [2]]]),
      incoming: withSources([['alpha', 'ALPHA + BRAVO', [1, 2]], ['c', 'C', [3]]], ['bravo']),
      suppressed: ['bravo'],
    });
    expect(d.merged).toEqual([]);
  });

  it('a late slide on the surviving card does not read as a merge', () => {
    // Slides are non-substantive on both sides — a conference photo can arrive
    // for a past date long after the card was built.
    const baseline = {
      digest: { sites: [{ studies: [
        { slug: 'alpha', name: 'ALPHA', source_ids: [{ type: 'paper', id: 1 }] },
        { slug: 'bravo', name: 'BRAVO', source_ids: [{ type: 'paper', id: 2 }] },
      ] }] },
      slug_aliases: [],
    };
    const incoming = {
      digest: { sites: [{ studies: [
        { slug: 'alpha', name: 'ALPHA', source_ids: [{ type: 'paper', id: 1 }, { type: 'slide', id: 7 }] },
        { slug: 'bravo', name: 'BRAVO', source_ids: [{ type: 'paper', id: 2 }] },
      ] }] },
      slug_aliases: [],
    };
    expect(publishRemovesContent(studiesLostInPublish({ baseline, incoming }))).toBe(false);
  });

  it('names the swallowed card in the operator message', () => {
    const d = studiesLostInPublish({
      baseline: withSources([['alpha', 'ALPHA', [1]], ['bravo', 'BRAVO', [2]]]),
      incoming: withSources([['alpha', 'MERGED', [1, 2]], ['c', 'C', [3]]], ['bravo']),
    });
    const msg = describePublishDiff('2026-07-08', d);
    expect(msg).toContain('BRAVO');
    expect(msg).toContain('absorbed');
  });
});
