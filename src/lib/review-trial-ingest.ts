// v0.17 (T5): ingest CURATOR-APPROVED review-trial resolutions as ordinary paper
// sources, so the normal build clusters them into study cards.
//
// This runs at the START of buildOneDate, BEFORE papersForDate is read — so an
// approved trial's primary paper is already a same-date source by the time
// Phase 1 clusters. It reuses the entire existing pipeline (savePaper → cluster
// → Phase 2 → verdict); there is NO second pass and NO mid-build mutation (the
// curator-gated design that replaced the rejected automatic-in-build approach,
// see docs/plans/review-trial-ingestion.md).
//
//   approved manifest rows (chosen_pmid) ──► fetchPubMedPaper ──► savePaper
//       (fetched_via='review-resolved', bookmark_date=date)  ──► papersForDate
//
// Freeze + idempotency: a paper ingested on a prior build is already a same-date
// source, so it is skipped (no re-fetch) on rebuild. savePaper is globally keyed
// by PMID with one bookmark_date, so a trial already ingested for ANOTHER date
// is NOT duplicated here (it surfaces on its first date only) — logged, not
// silently dropped.

import type Database from 'better-sqlite3';
import { listResolutions, listPapers, savePaper } from './db.ts';
import type { PubMedPaper } from './pubmed-client.ts';

export type IngestDeps = {
  // Injectable so tests run without the network; production passes fetchPubMedPaper.
  fetchPaper: (pmid: string) => Promise<PubMedPaper>;
  log?: (msg: string) => void;
};

export type IngestResult = {
  ingested: number; // newly added as a same-date source
  skipped: number; // already a source / fetch failed / pre-existing on another date
};

export async function ingestApprovedResolutions(
  db: Database.Database,
  date: string,
  deps: IngestDeps,
): Promise<IngestResult> {
  const log = deps.log ?? (() => {});
  const approved = listResolutions(db, { date, status: 'approved' }).filter((r) => r.chosen_pmid);
  if (approved.length === 0) return { ingested: 0, skipped: 0 };

  // PMIDs already a source for THIS date — dedup (codex #12: by PMID, not acronym).
  const existingPmids = new Set(
    listPapers(db, { bookmark_date: date })
      .map((p) => p.pmid)
      .filter((p): p is string => !!p),
  );

  let ingested = 0;
  let skipped = 0;
  for (const r of approved) {
    const pmid = r.chosen_pmid as string;
    if (existingPmids.has(pmid)) {
      skipped += 1; // already a source today
      continue;
    }

    let fetched: PubMedPaper;
    try {
      fetched = await deps.fetchPaper(pmid);
    } catch (err) {
      log(`  [resolve-ingest] PMID ${pmid} (${r.acronym_display}) fetch failed: ${(err as Error).message}`);
      skipped += 1;
      continue;
    }

    const { created } = savePaper(db, {
      pmid: fetched.metadata.pmid,
      doi: fetched.metadata.doi,
      pmc_id: fetched.metadata.pmc_id,
      title: fetched.metadata.title,
      authors_json: JSON.stringify(fetched.metadata.authors),
      journal: fetched.metadata.journal,
      pub_date: fetched.metadata.pub_date,
      abstract: fetched.abstract,
      fulltext_excerpt_md: fetched.fulltext_excerpt_md,
      mesh_terms_json: JSON.stringify(fetched.metadata.mesh_terms),
      bookmark_date: date,
      fetched_via: 'review-resolved',
      curator_note: `Auto-resolved from a review's discussed trials (${r.acronym_display}).`,
    });

    if (!created) {
      // Matched an existing paper from another date — won't surface today.
      log(`  [resolve-ingest] PMID ${pmid} (${r.acronym_display}) already ingested on another date; not duplicated to ${date}`);
      skipped += 1;
      continue;
    }
    existingPmids.add(pmid);
    ingested += 1;
    log(`  [resolve-ingest] ingested ${r.acronym_display} → PMID ${pmid}`);
  }
  return { ingested, skipped };
}
