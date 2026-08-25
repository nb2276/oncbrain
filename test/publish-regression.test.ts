// A rebuild must not publish a deletion.
//
// buildDigest survives a Phase 2 failure by design — it records the casualty in
// meta.dropped and ships whatever else succeeded, which is right for a FIRST
// build of a date. On a REBUILD of an already-published date the same behaviour
// silently unpublishes a live card: the artifact is overwritten without it, the
// rebuild drain sees exit 0 and dequeues, daily-build.sh keeps rebuilt past
// dates out of ANNOUNCE_DATES so no DM is sent, and DigitalOcean's
// catchall_document turns the dead permalink into a 200 home page instead of a
// 404. Every layer that could have reported it stays quiet.

import { describe, it, expect } from 'vitest';
import { lostPublishedStudies, publishRegressionMessage } from '../src/lib/publish-regression.ts';

const pub = (slug: string, name: string) => ({ slug, name });
const drop = (slug: string, name: string, reason = 'Phase 2 not valid JSON') => ({
  slug,
  name,
  reason,
});

describe('lostPublishedStudies', () => {
  it('catches a published study that Phase 2 failed to reproduce', () => {
    const lost = lostPublishedStudies({
      published: [pub('prestige-psma', 'PRESTIGE-PSMA'), pub('aranote', 'ARANOTE')],
      dropped: [drop('prestige-psma', 'PRESTIGE-PSMA')],
    });
    expect(lost.map((d) => d.slug)).toEqual(['prestige-psma']);
  });

  it('matches through a rename, so a re-slug does not read as “nothing lost”', () => {
    // Phase 1 renames studies between builds; the slug is derived from the name.
    // Comparing slugs alone would miss the very case this guard exists for.
    const lost = lostPublishedStudies({
      published: [pub('prestige-psma-primary', 'PRESTIGE-PSMA primary results')],
      dropped: [drop('prestige-psma', 'PRESTIGE-PSMA')],
    });
    expect(lost).toHaveLength(1);
  });

  it('ignores a dropped study that was never published', () => {
    // A brand-new study failing Phase 2 removes nothing. It is still reported by
    // the curator DM; it just must not block the publish.
    const lost = lostPublishedStudies({
      published: [pub('aranote', 'ARANOTE')],
      dropped: [drop('brand-new-trial', 'BRAND-NEW')],
    });
    expect(lost).toEqual([]);
  });

  it('ignores a suppression, which is a decision and not a casualty', () => {
    const lost = lostPublishedStudies({
      published: [pub('radiosa', 'RADIOSA')],
      dropped: [drop('radiosa', 'RADIOSA')],
      intentionallyRemoved: new Set(['radiosa']),
    });
    expect(lost).toEqual([]);
  });

  it('is inert on a first build, where there is nothing to lose', () => {
    expect(
      lostPublishedStudies({ published: [], dropped: [drop('a', 'A')] }),
    ).toEqual([]);
  });

  it('is inert when Phase 2 dropped nothing', () => {
    expect(
      lostPublishedStudies({ published: [pub('a', 'A')], dropped: [] }),
    ).toEqual([]);
  });

  it('reports every casualty, not just the first', () => {
    const lost = lostPublishedStudies({
      published: [pub('a', 'ALPHA'), pub('b', 'BRAVO'), pub('c', 'CHARLIE')],
      dropped: [drop('a', 'ALPHA'), drop('c', 'CHARLIE')],
    });
    expect(lost.map((d) => d.slug)).toEqual(['a', 'c']);
  });
});

describe('publishRegressionMessage', () => {
  it('names the casualties and both recovery routes', () => {
    const msg = publishRegressionMessage('2026-07-08', [drop('nrg-gu005', 'NRG-GU005', 'timed out')]);
    expect(msg).toContain('NRG-GU005');
    expect(msg).toContain('timed out');
    // Retry is the usual fix, because the failure is usually transient.
    expect(msg).toContain('npm run build:day -- --date=2026-07-08');
    // And if the removal really is wanted, it has to be said out loud.
    expect(msg).toContain('--suppress=');
  });
});
