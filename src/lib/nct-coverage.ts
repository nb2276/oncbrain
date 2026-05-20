// Cross-day NCT coverage index (v0.8 PR3, E6).
//
// Built from the published digest artifacts: which clinical trial (NCT) was
// covered on which date. Used at enrich time to nudge the curator ("NCT… was
// covered on <date>") when they bookmark a source for a trial that already
// appeared in an earlier digest — preventing redundant re-coverage.
//
// Pure + structural input so it's testable without full DigestArtifacts.

export type CoverageArtifact = {
  date: string; // YYYY-MM-DD
  digest: { sites: Array<{ studies: Array<{ nct: string | null; name: string }> }> };
};

export type CoverageEntry = { date: string; name: string };
export type NctCoverageIndex = Map<string, CoverageEntry[]>;

export type PriorCoverage = { nct: string; date: string; name: string };

// NCT → coverage entries, newest first. Keyed by uppercase NCT id. Pass
// listDigests() (date-desc), so entries land newest-first naturally; we sort
// defensively in case the caller's order differs.
export function buildNctCoverageIndex(artifacts: CoverageArtifact[]): NctCoverageIndex {
  const index: NctCoverageIndex = new Map();
  for (const a of artifacts) {
    for (const site of a.digest.sites) {
      for (const study of site.studies) {
        if (!study.nct) continue;
        const key = study.nct.toUpperCase();
        const list = index.get(key);
        const entry: CoverageEntry = { date: a.date, name: study.name };
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

// For each NCT in `ncts`, the newest coverage STRICTLY BEFORE `beforeDate`
// (so re-bookmarking on the same day a digest published doesn't self-trigger).
// One result per matched NCT; deduped + ordered by the NCT id.
export function findPriorCoverage(
  index: NctCoverageIndex,
  ncts: string[],
  beforeDate: string,
): PriorCoverage[] {
  const out: PriorCoverage[] = [];
  const seen = new Set<string>();
  for (const raw of ncts) {
    const nct = raw.toUpperCase();
    if (seen.has(nct)) continue;
    seen.add(nct);
    const entries = index.get(nct);
    if (!entries) continue;
    const prior = entries.find((e) => e.date < beforeDate);
    if (prior) out.push({ nct, date: prior.date, name: prior.name });
  }
  return out.sort((a, b) => (a.nct < b.nct ? -1 : a.nct > b.nct ? 1 : 0));
}
