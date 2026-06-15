import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, getResolution, parseResolutionCandidates } from '../src/lib/db.ts';
import {
  resolveReviewTrials,
  resolveReviewsForDate,
  reviewsFromDigest,
  rankCandidates,
  parseRerankResponse,
  makeRerankFromLlm,
  type ReviewToResolve,
  type ResolverDeps,
  type DigestArtifactLike,
} from '../src/lib/review-trial-resolver.ts';
import type { PubMedSummary } from '../src/lib/pubmed-client.ts';

const sum = (pmid: string, title: string, journal = 'JAMA Oncol', year = '2020'): PubMedSummary => ({
  pmid,
  title,
  journal,
  year,
  pub_date: `${year} Jan`,
});

describe('rankCandidates', () => {
  it('puts acronym-in-title candidates first, preserving relevance order within groups', () => {
    const cands = [
      sum('1', 'A pooled analysis of oligometastatic disease'),
      sum('2', 'The ORIOLE trial of SABR'),
      sum('3', 'Another oligomet study'),
      sum('4', 'ORIOLE long-term follow-up'),
    ];
    const ranked = rankCandidates('ORIOLE', cands);
    expect(ranked.map((c) => c.pmid)).toEqual(['2', '4', '1', '3']);
  });

  it('is word-boundary + case-insensitive (does not match a substring)', () => {
    const cands = [sum('1', 'ORIOLESTONE cohort'), sum('2', 'the oriole trial')];
    // 'ORIOLE' should match #2 (word) but NOT #1 (substring of ORIOLESTONE).
    expect(rankCandidates('ORIOLE', cands).map((c) => c.pmid)).toEqual(['2', '1']);
  });
});

describe('parseRerankResponse', () => {
  const cands = [sum('32215577', 'ORIOLE'), sum('36001857', 'pooled')];
  it('accepts a pmid present in the candidate set', () => {
    expect(parseRerankResponse('{"pmid":"32215577","confidence":0.9}', cands)).toEqual({
      pmid: '32215577',
      confidence: 0.9,
    });
  });
  it('strips code fences', () => {
    expect(parseRerankResponse('```json\n{"pmid":"36001857","confidence":0.5}\n```', cands).pmid).toBe('36001857');
  });
  it('treats null / NONE as no match', () => {
    expect(parseRerankResponse('{"pmid":null,"confidence":0}', cands).pmid).toBeNull();
  });
  it('rejects a pmid NOT in the candidate set (defense vs an invented PMID)', () => {
    expect(parseRerankResponse('{"pmid":"99999999","confidence":0.9}', cands).pmid).toBeNull();
  });
  it('clamps confidence and survives malformed JSON', () => {
    expect(parseRerankResponse('{"pmid":"32215577","confidence":5}', cands).confidence).toBe(1);
    expect(parseRerankResponse('not json at all', cands)).toEqual({ pmid: null, confidence: 0 });
  });
});

describe('resolveReviewTrials', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  const review: ReviewToResolve = {
    reviewSourcePaperId: 7,
    reviewName: 'Oligomet SBRT review',
    diseaseSite: 'prostate',
    bookmarkDate: '2026-06-12',
    discussedTrials: ['ORIOLE'],
    reviewContext: 'Review of SABR in oligometastatic prostate cancer.',
  };

  function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
    return {
      search: vi.fn(async () => ({ pmids: ['32215577', '36001857'], total: 2 })),
      summarize: vi.fn(async () => [sum('32215577', 'The ORIOLE trial'), sum('36001857', 'pooled')]),
      rerank: vi.fn(async () => ({ pmid: '32215577', confidence: 0.9 })),
      ...over,
    };
  }

  it('writes a pending row with the rerank pick first when the LLM matches', async () => {
    const s = await resolveReviewTrials(db, review, deps());
    expect(s).toMatchObject({ total: 1, pending: 1, failed: 0, frozen: 0 });
    const row = getResolution(db, 7, 'ORIOLE')!;
    expect(row.status).toBe('pending');
    expect(row.confidence).toBe(0.9);
    expect(parseResolutionCandidates(row.candidates_json)[0]!.pmid).toBe('32215577'); // pick first
  });

  it('writes a failed row (but keeps candidates) when the rerank says NONE', async () => {
    const s = await resolveReviewTrials(db, review, deps({ rerank: vi.fn(async () => ({ pmid: null, confidence: 0.2 })) }));
    expect(s).toMatchObject({ pending: 0, failed: 1 });
    const row = getResolution(db, 7, 'ORIOLE')!;
    expect(row.status).toBe('failed');
    expect(parseResolutionCandidates(row.candidates_json)).toHaveLength(2); // curator can still look
  });

  it('treats an LLM pick outside the candidate set as NONE (failed)', async () => {
    const s = await resolveReviewTrials(db, review, deps({ rerank: vi.fn(async () => ({ pmid: '99999999', confidence: 0.9 })) }));
    expect(s.failed).toBe(1);
    expect(getResolution(db, 7, 'ORIOLE')!.status).toBe('failed');
  });

  it('broadens the search when the title query returns nothing (codex #10)', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ pmids: [], total: 0 }) // title query: empty
      .mockResolvedValueOnce({ pmids: ['32215577'], total: 1 }); // broader query: hit
    const summarize = vi.fn(async () => [sum('32215577', 'ORIOLE')]);
    await resolveReviewTrials(db, review, deps({ search, summarize }));
    expect(search).toHaveBeenCalledTimes(2);
    expect((search.mock.calls[0]![0] as string)).toContain('[Title]');
    expect((search.mock.calls[1]![0] as string)).not.toContain('[Title]');
    expect(getResolution(db, 7, 'ORIOLE')!.status).toBe('pending');
  });

  it('quotes a multi-word acronym so [Title] binds to the whole phrase', async () => {
    const search = vi.fn(async (_q: string) => ({ pmids: ['32215577'], total: 1 }));
    const multiWord: ReviewToResolve = { ...review, discussedTrials: ['CheckMate 274'] };
    await resolveReviewTrials(db, multiWord, deps({ search, summarize: vi.fn(async () => [sum('32215577', 'CheckMate 274')]) }));
    // The verbatim phrase is quoted: "CheckMate 274"[Title], not CheckMate 274[Title]
    // (which would title-scope only "274").
    expect(search.mock.calls[0]![0]).toContain('"CheckMate 274"[Title]');
  });

  it('neutralizes embedded double-quotes in the acronym', async () => {
    const search = vi.fn(async (_q: string) => ({ pmids: [], total: 0 }));
    const weird: ReviewToResolve = { ...review, discussedTrials: ['A"B'] };
    await resolveReviewTrials(db, weird, deps({ search }));
    // The embedded quote is stripped so it can't break out of the quoted phrase.
    expect(search.mock.calls[0]![0]).toContain('"A B"[Title]');
  });

  it('writes a failed row with no candidates when both searches are empty', async () => {
    const search = vi.fn(async () => ({ pmids: [], total: 0 }));
    const summarize = vi.fn();
    const rerank = vi.fn();
    const s = await resolveReviewTrials(db, review, deps({ search, summarize, rerank }));
    expect(s.failed).toBe(1);
    expect(summarize).not.toHaveBeenCalled();
    expect(rerank).not.toHaveBeenCalled();
    expect(parseResolutionCandidates(getResolution(db, 7, 'ORIOLE')!.candidates_json)).toEqual([]);
  });

  it('a transient search error is left UNWRITTEN (errored), so the next run retries', async () => {
    const search = vi.fn(async () => { throw new Error('NCBI 503'); });
    const s = await resolveReviewTrials(db, review, deps({ search }));
    expect(s.errored).toBe(1);
    expect(s.failed).toBe(0);
    // No frozen row → re-running --date retries it (review fix #1).
    expect(getResolution(db, 7, 'ORIOLE')).toBeUndefined();
  });

  it('a transient rerank error is also left unwritten (errored), not frozen', async () => {
    const rerank = vi.fn(async () => { throw new Error('LLM 529'); });
    const s = await resolveReviewTrials(db, review, deps({ rerank }));
    expect(s.errored).toBe(1);
    expect(getResolution(db, 7, 'ORIOLE')).toBeUndefined();
  });

  it('a definitive no-match (search empty) DOES write a frozen failed row', async () => {
    const search = vi.fn(async () => ({ pmids: [], total: 0 }));
    const s = await resolveReviewTrials(db, review, deps({ search }));
    expect(s.failed).toBe(1);
    expect(s.errored).toBe(0);
    expect(getResolution(db, 7, 'ORIOLE')!.status).toBe('failed'); // frozen — a real no-match
  });

  it('FREEZE: a second resolve of the same review skips and does not re-search', async () => {
    await resolveReviewTrials(db, review, deps());
    const d2 = deps();
    const s2 = await resolveReviewTrials(db, review, d2);
    expect(s2).toMatchObject({ total: 1, frozen: 1, pending: 0, failed: 0 });
    expect(d2.search).not.toHaveBeenCalled();
  });

  it('dedups repeated/aliased acronyms within one review', async () => {
    const d = deps();
    const s = await resolveReviewTrials(db, { ...review, discussedTrials: ['ORIOLE', ' oriole ', 'ORIOLE'] }, d);
    expect(s.total).toBe(1); // deduped to one
    expect(d.search).toHaveBeenCalledTimes(1);
  });
});

describe('reviewsFromDigest', () => {
  const artifact: DigestArtifactLike = {
    date: '2026-06-12',
    digest: {
      sites: [
        {
          disease_site: 'prostate',
          studies: [
            { name: 'Oligomet review', tldr: 'SBRT landscape', content_type: 'review', discussed_trials: ['STOMP', 'ORIOLE'], source_ids: [{ type: 'paper', id: 7 }] },
            { name: 'A primary study', tldr: 'HR 0.62', source_ids: [{ type: 'paper', id: 9 }] }, // not a review
          ],
        },
        {
          disease_site: 'breast',
          studies: [
            { name: 'Review no trials', tldr: 'x', content_type: 'review', discussed_trials: [], source_ids: [{ type: 'paper', id: 8 }] },
            { name: 'Review no paper', tldr: 'y', content_type: 'review', discussed_trials: ['T'], source_ids: [{ type: 'tweet', id: 5 }] },
          ],
        },
      ],
    },
  };

  it('extracts only review studies that have discussed_trials AND a paper source', () => {
    const reviews = reviewsFromDigest(artifact);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      reviewSourcePaperId: 7,
      diseaseSite: 'prostate',
      bookmarkDate: '2026-06-12',
      reviewName: 'Oligomet review',
      reviewContext: 'SBRT landscape',
      discussedTrials: ['STOMP', 'ORIOLE'],
    });
  });
});

describe('resolveReviewsForDate', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('resolves every review in a date and returns one summary per review', async () => {
    const artifact: DigestArtifactLike = {
      date: '2026-06-12',
      digest: {
        sites: [
          { disease_site: 'prostate', studies: [{ name: 'R1', tldr: 'a', content_type: 'review', discussed_trials: ['ORIOLE'], source_ids: [{ type: 'paper', id: 7 }] }] },
          { disease_site: 'breast', studies: [{ name: 'R2', tldr: 'b', content_type: 'review', discussed_trials: ['X', 'Y'], source_ids: [{ type: 'paper', id: 8 }] }] },
        ],
      },
    };
    const deps: ResolverDeps = {
      search: vi.fn(async () => ({ pmids: ['111'], total: 1 })),
      summarize: vi.fn(async () => [sum('111', 'a trial')]),
      rerank: vi.fn(async () => ({ pmid: '111', confidence: 0.8 })),
    };
    const summaries = await resolveReviewsForDate(db, artifact, deps);
    expect(summaries).toHaveLength(2);
    expect(getResolution(db, 7, 'ORIOLE')!.status).toBe('pending');
    expect(getResolution(db, 8, 'X')!.status).toBe('pending');
    expect(getResolution(db, 8, 'Y')!.status).toBe('pending');
  });
});

describe('makeRerankFromLlm', () => {
  const cands = [sum('32215577', 'The ORIOLE trial'), sum('36001857', 'pooled')];
  const template =
    'Acronym: {{ACRONYM}}\nDisease: {{DISEASE}}\nContext: {{CONTEXT}}\nCandidates:\n{{CANDIDATES}}';

  it('fills the prompt and parses the JSON the client returns', async () => {
    const complete = vi.fn(
      async (_messages: Array<{ content: Array<{ text: string }> }>) =>
        '{"pmid":"32215577","confidence":0.88}',
    );
    const rerank = makeRerankFromLlm({ complete } as never, { promptTemplate: template });
    const out = await rerank({ acronym: 'ORIOLE', diseaseQuery: 'prostate', reviewContext: 'ctx', candidates: cands });
    expect(out).toEqual({ pmid: '32215577', confidence: 0.88 });
    const sent = complete.mock.calls[0]![0][0]!.content[0]!.text;
    expect(sent).toContain('ORIOLE');
    expect(sent).toContain('prostate');
    expect(sent).toContain('32215577'); // the candidate list was rendered
  });

  it('returns NONE when the client returns garbage', async () => {
    const complete = vi.fn(async () => 'I think it is probably ORIOLE');
    const rerank = makeRerankFromLlm({ complete } as never, { promptTemplate: template });
    expect(await rerank({ acronym: 'ORIOLE', diseaseQuery: 'prostate', reviewContext: '', candidates: cands })).toEqual({
      pmid: null,
      confidence: 0,
    });
  });
});
