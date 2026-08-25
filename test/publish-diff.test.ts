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
