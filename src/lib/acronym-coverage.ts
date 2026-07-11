// Cross-day ACRONYM coverage index (v0.26, Tier 2).
//
// The NCT-only cross-day nudge (nct-coverage.ts) can't fire for a source that
// carries no NCT — exactly the conference-tweet preview that later gets a
// duplicate full-paper card. This parallel index keys prior coverage by the
// discriminating acronym derived from each published study name, so the
// enrich-time nudge can also say "ENZARAD was covered on 2026-05-31" when a
// later source names the same trial — even with no NCT on either side.
//
// Like nct-coverage.ts this is a courtesy NUDGE, never a merge: acronyms are
// ambiguous, so a false hit is a stray heads-up message, not lost data.

import { studyDedupKey } from './study-dedup.ts';

export type AcronymCoverageArtifact = {
  date: string; // YYYY-MM-DD
  digest: { sites: Array<{ studies: Array<{ name: string }> }> };
};

export type AcronymCoverageEntry = { date: string; name: string };
export type AcronymCoverageIndex = Map<string, AcronymCoverageEntry[]>;

export type PriorAcronymCoverage = { key: string; date: string; name: string };

// dedupKey → coverage entries, newest first. Studies whose name yields no
// discriminating key (bare society/group prefix, endpoint token) are skipped.
export function buildAcronymCoverageIndex(
  artifacts: AcronymCoverageArtifact[],
): AcronymCoverageIndex {
  const index: AcronymCoverageIndex = new Map();
  for (const a of artifacts) {
    for (const site of a.digest.sites) {
      for (const study of site.studies) {
        const key = studyDedupKey(study.name);
        if (!key) continue;
        const entry: AcronymCoverageEntry = { date: a.date, name: study.name };
        const list = index.get(key);
        if (list) list.push(entry);
        else index.set(key, [entry]);
      }
    }
  }
  for (const list of index.values()) {
    list.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  }
  return index;
}

// For each candidate key, the newest coverage STRICTLY BEFORE `beforeDate` (so
// re-coverage on the same publish day doesn't self-trigger). One result per
// matched key, ordered by key.
export function findPriorAcronymCoverage(
  index: AcronymCoverageIndex,
  keys: Iterable<string>,
  beforeDate: string,
): PriorAcronymCoverage[] {
  const out: PriorAcronymCoverage[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = raw.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entries = index.get(key);
    if (!entries) continue;
    const prior = entries.find((e) => e.date < beforeDate);
    if (prior) out.push({ key, date: prior.date, name: prior.name });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
