// What a publish would REMOVE from what is already live.
//
// The in-builder guard (publish-regression.ts) is mechanism-specific: it asks
// which Phase 2 casualties correspond to published cards. That only sees losses
// that go through `meta.dropped`, and there are at least three routes that do
// not:
//
//   · The cron running on a FEATURE BRANCH rebuilds a past date against that
//     branch's stale artifact. A card main published after the branch was cut is
//     in neither the baseline nor the output, so nothing looks lost — and the
//     branch guard then copies the result over main and pushes.
//   · Phase 1 MERGES two published cards into one cluster. Partition validation
//     accepts it (every source appears exactly once), Phase 2 succeeds, so
//     `meta.dropped` is empty and there is nothing for the guard to inspect.
//   · A Phase 1 rename plus a Phase 2 failure where BOTH names yield a null
//     dedup key. The casualty matches the published card by neither slug nor key.
//
// One symptom, three mechanisms. So this asks the question at the publish
// boundary instead, where it is answerable without knowing how the loss
// happened: compare the artifact about to be written to main against the one
// main currently has. Mechanism-independent by construction, which is the point
// — it also covers the fourth route nobody has found yet.
//
// DigitalOcean's `catchall_document: index.html` is why this has to be caught
// before the push rather than noticed after: a removed card's URL returns HTTP
// 200 with the home page, so a deletion is invisible from outside.

export type PublishedStudyRef = { slug: string; name: string };

type SourceRef = { type?: unknown; id?: unknown };

export type PublishDiff = {
  /** Published studies absent from the incoming artifact and not deliberately suppressed. */
  lost: PublishedStudyRef[];
  /**
   * How many studies short the incoming artifact is of what the baseline had,
   * after accounting for deliberate suppressions.
   *
   * Separate from `lost` because a MERGE hides behind `slug_aliases`: two cards
   * become one, the retired slug is recorded as an alias, and every individual
   * slug therefore looks accounted for. Only the count reveals it.
   */
  countShortfall: number;
  /**
   * Published studies whose sources were ABSORBED into another card.
   *
   * The count check catches a merge only when nothing else changed. Add one new
   * study the same night and the arithmetic balances — two cards became one,
   * one card appeared, total unchanged — while the retired slug sits in
   * `slug_aliases` looking like an ordinary rename. From slugs and counts alone
   * a merge and a rename are genuinely indistinguishable.
   *
   * Provenance distinguishes them: a merged card carries BOTH originals'
   * `source_ids`, a renamed card carries only its own. Every study in the corpus
   * records them, so this is checkable at the publish boundary.
   */
  merged: PublishedStudyRef[];
};

type ArtifactLike = {
  digest?: { sites?: Array<{ studies?: Array<{ slug?: string; name?: string }> }> };
  slug_aliases?: unknown;
};

function studiesOf(artifact: unknown): Array<PublishedStudyRef & { sources: Set<string> }> {
  const a = artifact as ArtifactLike | null | undefined;
  const out: Array<PublishedStudyRef & { sources: Set<string> }> = [];
  for (const site of a?.digest?.sites ?? []) {
    for (const st of site?.studies ?? []) {
      const slug = typeof st?.slug === 'string' ? st.slug.trim() : '';
      if (slug) {
        out.push({
          slug,
          name: typeof st?.name === 'string' ? st.name : slug,
          sources: sourceKeys(st as { source_ids?: unknown }),
        });
      }
    }
  }
  return out;
}

/**
 * A study's substantive sources, as `type:id` keys.
 *
 * Slides are excluded on both sides, matching what the override identity check
 * and lineage already treat as non-substantive: a conference photo can arrive
 * for a past date long after the card was built, and that must not read as the
 * card having changed.
 */
function sourceKeys(st: { source_ids?: unknown }): Set<string> {
  const raw = Array.isArray(st?.source_ids) ? (st.source_ids as SourceRef[]) : [];
  return new Set(
    raw
      .filter((r) => r && typeof r.type === 'string' && r.type !== 'slide' && Number.isInteger(r.id))
      .map((r) => `${String(r.type)}:${String(r.id)}`),
  );
}

/**
 * Baseline studies absorbed into some incoming card.
 *
 * A baseline study is absorbed when its (non-empty) source set is wholly
 * contained in one incoming study's. That alone is just a rename, so it counts
 * as a MERGE only where one incoming card absorbs two or more baseline studies —
 * and the survivor of that group is not reported, because it is still on the
 * page. Abstains entirely when provenance is missing on either side.
 */
function mergedAway(
  baseline: Array<PublishedStudyRef & { sources: Set<string> }>,
  incoming: Array<PublishedStudyRef & { sources: Set<string> }>,
): PublishedStudyRef[] {
  const out: PublishedStudyRef[] = [];
  for (const inc of incoming) {
    if (inc.sources.size === 0) continue;
    const absorbed = baseline.filter(
      (b) => b.sources.size > 0 && [...b.sources].every((k) => inc.sources.has(k)),
    );
    if (absorbed.length < 2) continue;
    // The one keeping its slug survived as itself; the others were folded in.
    const survivor = absorbed.find((b) => b.slug === inc.slug);
    for (const b of absorbed) {
      if (survivor && b.slug === survivor.slug) continue;
      out.push({ slug: b.slug, name: b.name });
    }
  }
  return out;
}

function aliasesOf(artifact: unknown): Set<string> {
  const raw = (artifact as ArtifactLike | null | undefined)?.slug_aliases;
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
}

/**
 * Compare what is about to be published against what is already live.
 *
 * `suppressed` is the date's override suppress list. A slug there is a curator
 * decision, not a loss. Note that a slug suppressed on an EARLIER run is already
 * absent from the baseline, so intersecting the baseline with this list yields
 * exactly the suppressions this publish is introducing.
 */
export function studiesLostInPublish(opts: {
  baseline: unknown;
  incoming: unknown;
  suppressed?: readonly string[];
}): PublishDiff {
  const baseline = studiesOf(opts.baseline);
  const incoming = studiesOf(opts.incoming);
  if (baseline.length === 0) return { lost: [], countShortfall: 0, merged: [] };

  const suppressed = new Set(opts.suppressed ?? []);
  const incomingSlugs = new Set(incoming.map((s) => s.slug));
  const incomingAliases = aliasesOf(opts.incoming);

  const intentional = baseline.filter((s) => suppressed.has(s.slug));
  const lost = baseline.filter(
    (s) =>
      !suppressed.has(s.slug) &&
      !incomingSlugs.has(s.slug) &&
      // A retired slug recorded as an alias is a RENAME — the study still
      // exists under a new slug. That is the common, legitimate case.
      !incomingAliases.has(s.slug),
  );

  const expected = baseline.length - intentional.length;
  const countShortfall = Math.max(0, expected - incoming.length);

  // Reported separately from `lost`: these cards are not missing so much as
  // swallowed, and the operator message has to say which.
  const merged = mergedAway(
    baseline.filter((b) => !suppressed.has(b.slug)),
    incoming,
  );

  return { lost, countShortfall, merged };
}

/** True when this publish would remove something live. */
export function publishRemovesContent(d: PublishDiff): boolean {
  return d.lost.length > 0 || d.countShortfall > 0 || d.merged.length > 0;
}

/** Operator-facing explanation for a refused date. */
export function describePublishDiff(date: string, d: PublishDiff): string {
  const lines: string[] = [];
  if (d.lost.length > 0) {
    lines.push(`  ${date}: would remove ${d.lost.length} published study(ies):`);
    for (const s of d.lost) lines.push(`    - ${s.name} (${s.slug})`);
  }
  if (d.countShortfall > 0 && d.lost.length === 0) {
    // The merge signature: every slug is accounted for, the count is not.
    lines.push(
      `  ${date}: carries ${d.countShortfall} fewer study(ies) than the published version, ` +
        `with every slug accounted for — a Phase 1 merge collapsing two cards into one.`,
    );
  } else if (d.countShortfall > 0) {
    lines.push(`  ${date}: also ${d.countShortfall} short on total study count.`);
  }
  if (d.merged.length > 0) {
    lines.push(
      `  ${date}: ${d.merged.length} published card(s) absorbed into another card's sources ` +
        `(a Phase 1 merge; the slug is retired as an alias, so only provenance shows it):`,
    );
    for (const s of d.merged) lines.push(`    - ${s.name} (${s.slug})`);
  }
  return lines.join('\n');
}
