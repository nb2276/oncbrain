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
import {
  listResolutions,
  listPapers,
  savePaper,
  getPaperByPmid,
  markPaperReviewResolved,
  type Paper,
} from './db.ts';
import type { PubMedPaper } from './pubmed-client.ts';

export type IngestDeps = {
  // Injectable so tests run without the network; production passes fetchPubMedPaper.
  fetchPaper: (pmid: string) => Promise<PubMedPaper>;
  log?: (msg: string) => void;
};

export type IngestResult = {
  ingested: number; // newly added as a same-date source (fetched or copied from another date)
  skipped: number; // already a same-date source (benign — provenance re-tagged)
  failed: number; // fetch errored (transient) — NOT consumed; retried on the next build
};

export async function ingestApprovedResolutions(
  db: Database.Database,
  date: string,
  deps: IngestDeps,
): Promise<IngestResult> {
  const log = deps.log ?? (() => {});
  const approved = listResolutions(db, { date, status: 'approved' }).filter((r) => r.chosen_pmid);
  if (approved.length === 0) return { ingested: 0, skipped: 0, failed: 0 };

  // PMIDs already a source for THIS date (codex #12: dedup by PMID, not acronym).
  const sameDate = new Map(
    listPapers(db, { bookmark_date: date })
      .filter((p) => p.pmid)
      .map((p) => [p.pmid as string, p]),
  );
  const handled = new Set<string>(); // within-run dedup (two acronyms → same PMID)

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of approved) {
    const pmid = r.chosen_pmid as string;
    if (handled.has(pmid)) {
      skipped += 1;
      continue;
    }
    handled.add(pmid);
    const note = `Auto-resolved from a review's discussed trials (${r.acronym_display}).`;

    // (a) Already a same-date source → re-tag for the provenance pill (review fix
    //     #6b), then skip. The trial is already on the page.
    const here = sameDate.get(pmid);
    if (here) {
      if (here.fetched_via !== 'review-resolved') {
        markPaperReviewResolved(db, here.id);
        log(`  [resolve-ingest] PMID ${pmid} (${r.acronym_display}) already a source today; tagged review-resolved`);
      }
      skipped += 1;
      continue;
    }

    // (b) Exists on ANOTHER date → don't duplicate the row (`papers.pmid` is
    //     UNIQUE, one row = one date). The build surfaces it on THIS date via
    //     crossDateResolvedPapers (v0.17 P3 manifest-as-date-association), so the
    //     trial DOES get a card here; we just skip re-fetching/re-creating it.
    const elsewhere = getPaperByPmid(db, pmid);
    if (elsewhere) {
      log(`  [resolve-ingest] PMID ${pmid} (${r.acronym_display}) already a source on ${elsewhere.bookmark_date}; build will surface it cross-date on ${date} (no row duplicated)`);
      skipped += 1;
      continue;
    }

    // (c) Not in the DB → fetch + savePaper. A fetch error is TRANSIENT: it is
    //     NOT consumed (the approved row stays approved), so the next build
    //     retries it (review fix #5). It is counted as `failed`, surfaced by the
    //     builder, never silently dropped.
    let fetched: PubMedPaper;
    try {
      fetched = await deps.fetchPaper(pmid);
    } catch (err) {
      log(`  [resolve-ingest] PMID ${pmid} (${r.acronym_display}) fetch failed (will retry next build): ${(err as Error).message}`);
      failed += 1;
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
      curator_note: note,
    });
    if (!created) {
      // savePaper matched an existing row by DOI/content-hash (NOT by PMID — the
      // getPaperByPmid check above already covered that) and attached the PMID,
      // so re-look-up by PMID now resolves which date that row belongs to.
      // - same date → re-tag it review-resolved so the provenance pill renders
      //   (review fix #6b applied to the DOI-race path — without this the study
      //   would publish today with no pill).
      // - another date → can't surface here (one date per paper); loud-skip like
      //   branch (b) above.
      const matched = getPaperByPmid(db, pmid);
      if (matched && matched.bookmark_date === date) {
        if (matched.fetched_via !== 'review-resolved') markPaperReviewResolved(db, matched.id);
        log(`  [resolve-ingest] PMID ${pmid} (${r.acronym_display}) matched an existing same-date paper by DOI; tagged review-resolved`);
      } else {
        log(`  ⚠ [resolve-ingest] PMID ${pmid} (${r.acronym_display}) matched an existing paper on ${matched?.bookmark_date ?? 'another date'} by DOI; can't surface on ${date} — acronym stays plain text here`);
      }
      skipped += 1;
      continue;
    }
    ingested += 1;
    log(`  [resolve-ingest] ingested ${r.acronym_display} → PMID ${pmid}`);
  }
  return { ingested, skipped, failed };
}

// v0.17 P3 (cross-date surfacing): a review on `date` may discuss a trial whose
// primary paper is already a source on an EARLIER date. `papers.pmid` is UNIQUE
// (one row = one date), so ingestApprovedResolutions can't duplicate the row
// onto this date — instead the manifest is the many-to-many review-date↔paper
// link, and the builder injects these papers into THIS date's build inputs so
// the trial gets a card here too.
//
// Returns the approved-resolution papers for `date` that live on ANOTHER date
// (so a card can be surfaced here), de-duped against the PMIDs already a source
// for this date (those need no injection — they're built normally). The caller
// marks them resolved_from_review for the provenance pill (their stored
// fetched_via reflects their ORIGINAL date's ingestion, which may not be
// 'review-resolved', so the pill can't key on fetched_via for these).
export function crossDateResolvedPapers(
  db: Database.Database,
  date: string,
  sameDatePmids: Set<string>,
): Paper[] {
  const approved = listResolutions(db, { date, status: 'approved' }).filter((r) => r.chosen_pmid);
  if (approved.length === 0) return [];
  const out: Paper[] = [];
  const seen = new Set<string>();
  for (const r of approved) {
    const pmid = r.chosen_pmid as string;
    if (sameDatePmids.has(pmid) || seen.has(pmid)) continue;
    const p = getPaperByPmid(db, pmid);
    if (p && p.bookmark_date !== date) {
      out.push(p);
      seen.add(pmid);
    }
  }
  return out;
}
