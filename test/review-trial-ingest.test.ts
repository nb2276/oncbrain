import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, upsertResolution, decideResolution, listPapers, listResolutions, savePaper } from '../src/lib/db.ts';
import { ingestApprovedResolutions } from '../src/lib/review-trial-ingest.ts';
import type { PubMedPaper } from '../src/lib/pubmed-client.ts';

function paper(pmid: string, title = 'The ORIOLE trial'): PubMedPaper {
  return {
    metadata: {
      pmid,
      doi: `10.1001/${pmid}`,
      pmc_id: null,
      title,
      authors: [{ name: 'Phillips R' }],
      journal: 'JAMA Oncol',
      pub_date: '2020-04-01',
      mesh_terms: ['Prostatic Neoplasms'],
    },
    abstract: 'SABR vs observation in oligometastatic prostate cancer.',
    fulltext_excerpt_md: null,
  };
}

// Seed an APPROVED manifest row (upsert pending → decide approved), as the CLI does.
function seedApproved(db: Database.Database, opts: { paperId: number; acronym: string; date: string; pmid: string }) {
  const { resolution } = upsertResolution(db, {
    review_source_paper_id: opts.paperId,
    acronym_norm: opts.acronym,
    acronym_display: opts.acronym,
    disease_site: 'prostate',
    bookmark_date: opts.date,
    status: 'pending',
    candidates: [{ pmid: opts.pmid, title: 't', journal: 'j', year: '2020', score: 1 }],
    confidence: 0.9,
    resolver_version: 'v1',
  });
  decideResolution(db, resolution.id, { status: 'approved', chosenPmid: opts.pmid });
}

describe('ingestApprovedResolutions (T5)', () => {
  let db: Database.Database;
  const date = '2026-06-12';
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('ingests an approved trial as a same-date review-resolved paper source', async () => {
    seedApproved(db, { paperId: 7, acronym: 'ORIOLE', date, pmid: '32215577' });
    const fetchPaper = vi.fn(async (pmid: string) => paper(pmid));
    const res = await ingestApprovedResolutions(db, date, { fetchPaper });
    expect(res).toEqual({ ingested: 1, skipped: 0, failed: 0 });

    const papers = listPapers(db, { bookmark_date: date });
    expect(papers).toHaveLength(1);
    expect(papers[0]!.pmid).toBe('32215577');
    expect(papers[0]!.fetched_via).toBe('review-resolved');
    expect(papers[0]!.curator_note).toContain('ORIOLE');
    expect(papers[0]!.title).toBe('The ORIOLE trial');
  });

  it('ignores pending and rejected rows (only approved ingest)', async () => {
    // pending
    upsertResolution(db, {
      review_source_paper_id: 7, acronym_norm: 'STOMP', acronym_display: 'STOMP',
      disease_site: 'prostate', bookmark_date: date, status: 'pending',
      candidates: [{ pmid: '111', title: 't', journal: null, year: null, score: 1 }],
      confidence: 0.5, resolver_version: 'v1',
    });
    // rejected
    const { resolution } = upsertResolution(db, {
      review_source_paper_id: 7, acronym_norm: 'ARTO', acronym_display: 'ARTO',
      disease_site: 'prostate', bookmark_date: date, status: 'pending', resolver_version: 'v1',
    });
    decideResolution(db, resolution.id, { status: 'rejected' });

    const fetchPaper = vi.fn(async (pmid: string) => paper(pmid));
    const res = await ingestApprovedResolutions(db, date, { fetchPaper });
    expect(res).toEqual({ ingested: 0, skipped: 0, failed: 0 });
    expect(fetchPaper).not.toHaveBeenCalled();
    expect(listPapers(db, { bookmark_date: date })).toHaveLength(0);
  });

  it('dedups a same-date source AND re-tags it review-resolved for the provenance pill (fix #6b)', async () => {
    savePaper(db, { pmid: '32215577', title: 'already here', bookmark_date: date }); // fetched_via='pending'
    seedApproved(db, { paperId: 7, acronym: 'ORIOLE', date, pmid: '32215577' });
    const fetchPaper = vi.fn(async (pmid: string) => paper(pmid));
    const res = await ingestApprovedResolutions(db, date, { fetchPaper });
    expect(res).toEqual({ ingested: 0, skipped: 1, failed: 0 });
    expect(fetchPaper).not.toHaveBeenCalled(); // skipped before fetch
    const papers = listPapers(db, { bookmark_date: date });
    expect(papers).toHaveLength(1);
    expect(papers[0]!.fetched_via).toBe('review-resolved'); // re-tagged → pill renders
  });

  it('re-tags a same-date DOI-only paper that savePaper merges the PMID into (DOI-race, P2 fix)', async () => {
    // A same-date paper exists with the trial's DOI but no PMID yet → it is in
    // neither the PMID-keyed same-date map nor getPaperByPmid, so ingest fetches,
    // and savePaper merges the PMID into the existing DOI row (created:false).
    // Without the fix it would publish today with NO provenance pill.
    savePaper(db, { doi: '10.1001/32215577', title: 'DOI-only, no pmid yet', bookmark_date: date });
    seedApproved(db, { paperId: 7, acronym: 'ORIOLE', date, pmid: '32215577' });
    const fetchPaper = vi.fn(async (pmid: string) => paper(pmid));
    const res = await ingestApprovedResolutions(db, date, { fetchPaper });
    expect(res).toEqual({ ingested: 0, skipped: 1, failed: 0 });
    expect(fetchPaper).toHaveBeenCalledTimes(1); // not in DB by PMID → fetched
    const papers = listPapers(db, { bookmark_date: date });
    expect(papers).toHaveLength(1); // merged, not duplicated
    expect(papers[0]!.pmid).toBe('32215577');
    expect(papers[0]!.fetched_via).toBe('review-resolved'); // re-tagged → pill renders
  });

  it('does NOT surface a trial whose paper is on another date (one date per paper), warns + skips (fix #4)', async () => {
    savePaper(db, { pmid: '32215577', title: 'on an earlier date', bookmark_date: '2026-06-01' });
    seedApproved(db, { paperId: 7, acronym: 'ORIOLE', date, pmid: '32215577' });
    const fetchPaper = vi.fn(async (pmid: string) => paper(pmid));
    const res = await ingestApprovedResolutions(db, date, { fetchPaper });
    expect(res).toEqual({ ingested: 0, skipped: 1, failed: 0 });
    expect(fetchPaper).not.toHaveBeenCalled(); // detected by getPaperByPmid, no fetch
    expect(listPapers(db, { bookmark_date: date })).toHaveLength(0); // stays on its first date
  });

  it('a fetch failure is counted as failed (NOT consumed → retried next build), never thrown (fix #5)', async () => {
    seedApproved(db, { paperId: 7, acronym: 'ORIOLE', date, pmid: '32215577' });
    const fetchPaper = vi.fn(async () => { throw new Error('NCBI 503'); });
    const res = await ingestApprovedResolutions(db, date, { fetchPaper });
    expect(res).toEqual({ ingested: 0, skipped: 0, failed: 1 });
    expect(listPapers(db, { bookmark_date: date })).toHaveLength(0);
    // The manifest row stays 'approved' (not consumed), so the next build retries.
    expect(listResolutions(db, { date, status: 'approved' })).toHaveLength(1);
  });

  it('is a no-op (no fetch) when the date has no approved resolutions', async () => {
    const fetchPaper = vi.fn(async (pmid: string) => paper(pmid));
    expect(await ingestApprovedResolutions(db, date, { fetchPaper })).toEqual({ ingested: 0, skipped: 0, failed: 0 });
    expect(fetchPaper).not.toHaveBeenCalled();
  });
});
