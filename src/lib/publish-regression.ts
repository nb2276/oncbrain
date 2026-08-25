// Does this build REMOVE something already published?
//
// A rebuild overwrites a date's artifact in place. Phase 2 failing on one study
// does not fail the build — `buildDigest` records the casualty in `meta.dropped`
// and returns success as long as some study survived, which is the right call
// for a FIRST build of a date (ship four studies rather than none). On a REBUILD
// of an already-published date it is a silent deletion:
//
//   1. a past date publishes cards A and B
//   2. a late slide queues that date for rebuild
//   3. `rebuild:queued` runs build:day; Phase 2 returns unparseable output for A
//      twice and succeeds for B
//   4. the artifact is rewritten with B alone, the drain sees exit 0 and
//      dequeues, the cron commits and pushes
//
// Nobody is told. `daily-build.sh` deliberately keeps rebuilt past dates out of
// ANNOUNCE_DATES (re-DMing a weeks-old date as if it were new is wrong), so the
// only trace is a DROPPED line in the cron log — and DigitalOcean's
// `catchall_document: index.html` turns A's dead permalink into a 200 home page
// rather than a 404, so the deletion is invisible from outside too.
//
// This is not hypothetical: a Phase 2 response that opened with prose instead of
// JSON dropped a practice-changing readout during an eval run in exactly this
// way. On a queued rebuild that same flake unpublishes the card.
//
// So a build that would lose an already-published study must FAIL, loudly,
// rather than publish the loss. Failing is recoverable — `rebuild:queued` bumps
// the attempt count and eventually dead-letters with a manual-rebuild command —
// whereas a published deletion is not noticed at all.

import { studyDedupKey } from './study-dedup.ts';

export type DroppedStudy = { slug: string; name: string; reason: string };
export type PublishedStudy = { slug?: string | null; name: string };

/**
 * The already-published studies this build would delete because Phase 2 failed.
 *
 * Matches a dropped study to a published one by slug first, then by the
 * cooperative-group-guarded dedup key of its name — Phase 1 can re-slug a study
 * between builds, and a rename must not read as "different card, nothing lost".
 *
 * `intentionallyRemoved` carries the slugs a curator override suppresses on
 * purpose. A suppression is a decision, not a casualty, and must never trip this
 * guard.
 */
export function lostPublishedStudies(opts: {
  published: readonly PublishedStudy[];
  dropped: readonly DroppedStudy[];
  /**
   * What this build DID produce. Without it the name-key fallback cannot tell a
   * removal from a sibling: one trial's efficacy and quality-of-life cards share
   * an acronym key, so a brand-new QoL cluster failing Phase 2 looked exactly
   * like the loss of the efficacy card that was sitting there unharmed. That is
   * a false alarm on a guard whose only action is to abort the publish.
   */
  surviving?: readonly PublishedStudy[];
  intentionallyRemoved?: ReadonlySet<string>;
}): DroppedStudy[] {
  const { published, dropped } = opts;
  const intentional = opts.intentionallyRemoved ?? new Set<string>();
  if (published.length === 0 || dropped.length === 0) return [];

  const slugOf = (s: PublishedStudy) => (s.slug ?? '').trim();
  const publishedSlugs = new Set(published.map(slugOf).filter((s) => s.length > 0));
  const survivingSlugs = new Set((opts.surviving ?? []).map(slugOf).filter((s) => s.length > 0));

  const lost: DroppedStudy[] = [];
  for (const d of dropped) {
    if (intentional.has(d.slug)) continue;

    // Exact slug: this card was published and is now a casualty.
    if (publishedSlugs.has(d.slug)) {
      if (!survivingSlugs.has(d.slug)) lost.push(d);
      continue;
    }

    // Name key: catches a Phase 1 rename, where the slug moved but the study is
    // the same one. Only when it resolves to a SINGLE published card — two cards
    // of one trial share a key, and guessing between them is what produced the
    // false alarm above.
    const key = studyDedupKey(d.name);
    if (!key) continue;
    const matches = published.filter((s) => studyDedupKey(s.name) === key);
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    // Still standing under its own slug → nothing was lost.
    if (survivingSlugs.has(slugOf(match))) continue;
    lost.push(d);
  }
  return lost;
}

/** The operator-facing failure text. Names every casualty and how to recover. */
export function publishRegressionMessage(date: string, lost: readonly DroppedStudy[]): string {
  const lines = lost.map((d) => `    - ${d.name} (${d.slug}): ${d.reason}`);
  return [
    `refusing to publish ${date}: this rebuild would REMOVE ${lost.length} already-published ` +
      `study(ies) that Phase 2 failed to produce:`,
    ...lines,
    `  The previously published artifact is left untouched. Re-run to retry:`,
    `    npm run build:day -- --date=${date}`,
    `  If the removal is intended, suppress the card explicitly:`,
    `    npm run override -- --date=${date} --suppress=<slug>`,
  ].join('\n');
}
