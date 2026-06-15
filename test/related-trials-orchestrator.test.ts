import { describe, it, expect, vi } from 'vitest';
import {
  enrichStudyWithRelatedTrials,
  createRelatedTrialsRunCache,
  deterministicDegradedFallback,
  broadenTrialQuery,
  type CandidateTrial,
  type DigestStudy,
} from '../src/lib/llm-pipeline.ts';
import type {
  FetchCandidateTrialsResult,
} from '../src/lib/clinicaltrials.ts';
import type { LlmClient, LlmMessage } from '../src/lib/llm-client.ts';

// Tiny stub LlmClient that returns whatever string we hand it (or throws if
// we hand it an Error). complete is the only method we care about.
function stubLlm(response: string | Error): LlmClient {
  return {
    complete: vi.fn(async (_messages: LlmMessage[]) => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

function makeCandidate(over: Partial<CandidateTrial> & { nct: string }): CandidateTrial {
  return {
    nct: over.nct,
    brief_title: over.brief_title ?? `Trial ${over.nct}`,
    overall_status: over.overall_status ?? 'RECRUITING',
    phase: over.phase ?? ['PHASE3'],
    enrollment_count: over.enrollment_count ?? 100,
    primary_completion_date: over.primary_completion_date ?? '2027-03',
    brief_summary: over.brief_summary ?? null,
    conditions: over.conditions ?? [],
    interventions: over.interventions ?? [],
    eligibility_brief: over.eligibility_brief ?? null,
  };
}

function makeStudy(over: Partial<DigestStudy> = {}): DigestStudy {
  return {
    name: 'PRESTIGE-PSMA',
    tldr: 'Lu-PSMA over cabazitaxel in 2L mCRPC.',
    details: [],
    nct: 'NCT01234567',
    tweet_ids: [],
    slug: 'prestige-psma',
    open_questions: ['Sequencing vs cabazitaxel', 'Durability beyond 2 years'],
    ...over,
  };
}

// A valid Phase 2 raw response with related_search emitted. The terms here
// must satisfy the parser's stop-list (>=2 specific tokens).
function rawWith(queries: Array<{ term: string; watches_question: string }>): unknown {
  return { name: 'PRESTIGE-PSMA', tldr: '...', related_search: { queries } };
}

const QUESTIONS = ['Sequencing vs cabazitaxel', 'Durability beyond 2 years'];

describe('enrichStudyWithRelatedTrials,happy path', () => {
  it('returns picked trials when rerank emits valid picks', async () => {
    const study = makeStudy();
    const raw = rawWith([
      { term: 'lutetium PSMA cabazitaxel sequencing', watches_question: QUESTIONS[0]! },
      { term: 'PSMA radioligand long-term followup mCRPC', watches_question: QUESTIONS[1]! },
    ]);
    const c1 = makeCandidate({ nct: 'NCT05000001', primary_completion_date: '2027-03' });
    const c2 = makeCandidate({ nct: 'NCT05000002', primary_completion_date: '2027-06' });

    const ctgovFetch = vi.fn(async (term: string): Promise<FetchCandidateTrialsResult> => {
      if (term.includes('cabazitaxel')) return { ok: true, candidates: [c1] };
      if (term.includes('radioligand')) return { ok: true, candidates: [c2] };
      return { ok: false, error: 'empty', message: 'no match' };
    });

    const rerank = stubLlm(
      JSON.stringify({
        picks: [
          { nct: 'NCT05000001', answers_question: QUESTIONS[0], relevance_phrase: 'head-to-head sequencing' },
          { nct: 'NCT05000002', answers_question: QUESTIONS[1], relevance_phrase: '5y followup of arm' },
        ],
      }),
    );

    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      study,
      raw,
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank, clock: () => new Date('2026-06-08T00:00:00Z') },
      log,
    );
    expect(out.related_trials).toHaveLength(2);
    expect(out.related_trials_provenance.rerank_outcome).toBe('picked_N');
    expect(out.related_trials_provenance.queries_fired).toHaveLength(2);
    expect(out.related_trials_provenance.candidates_returned).toBe(2);
    expect(out.related_trials_provenance.fetched_at).toBe('2026-06-08T00:00:00.000Z');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('passes the configured rerankModel + temperature=0 to the rerank call', async () => {
    // Was client.complete(messages, {}) → rerank ran on the client default
    // regardless of DIGEST_MODEL/DIGEST_STUDY_MODEL.
    const study = makeStudy();
    const raw = rawWith([
      { term: 'lutetium PSMA cabazitaxel sequencing', watches_question: QUESTIONS[0]! },
    ]);
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: true,
      candidates: [makeCandidate({ nct: 'NCT05000001' })],
    }));
    const rerank = stubLlm(
      JSON.stringify({ picks: [{ nct: 'NCT05000001', answers_question: QUESTIONS[0], relevance_phrase: 'x' }] }),
    );
    await enrichStudyWithRelatedTrials(study, raw, createRelatedTrialsRunCache(), {
      ctgovFetch,
      rerankClient: rerank,
      rerankModel: 'opus-test',
    });
    const completeMock = rerank.complete as unknown as ReturnType<typeof vi.fn>;
    expect(completeMock).toHaveBeenCalled();
    expect(completeMock.mock.calls[0]![1]).toEqual({ model: 'opus-test', temperature: 0 });
  });

  it('caches successful fetches across calls (cross-study dedup)', async () => {
    const ctgovFetch = vi.fn(async (term: string): Promise<FetchCandidateTrialsResult> => {
      return { ok: true, candidates: [makeCandidate({ nct: 'NCT05000001' })] };
    });
    const rerank = stubLlm(JSON.stringify({ picks: [] }));
    const cache = createRelatedTrialsRunCache();

    const study1 = makeStudy({ slug: 'study-a' });
    const study2 = makeStudy({ slug: 'study-b' });
    const raw1 = rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]);
    const raw2 = rawWith([{ term: 'Lutetium  PSMA  mCRPC', watches_question: QUESTIONS[0]! }]); // case + whitespace drift

    await enrichStudyWithRelatedTrials(study1, raw1, cache, { ctgovFetch, rerankClient: rerank });
    await enrichStudyWithRelatedTrials(study2, raw2, cache, { ctgovFetch, rerankClient: rerank });

    // Second study should hit the cache despite case + whitespace drift.
    expect(ctgovFetch).toHaveBeenCalledTimes(1);
  });
});

describe('enrichStudyWithRelatedTrials,abstention + missing inputs', () => {
  it('no_related_search when raw has no related_search field', async () => {
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      { name: 'x', tldr: 'y' },
      createRelatedTrialsRunCache(),
      {},
      log,
    );
    expect(out.related_trials).toBeNull();
    expect(out.related_trials_provenance.rerank_outcome).toBe('skipped');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no_related_search: prestige-psma/));
  });

  it('no_related_search when every query fails the parser stop-list', async () => {
    const log = vi.fn();
    const raw = rawWith([
      { term: 'cancer drug therapy', watches_question: QUESTIONS[0]! },
      { term: 'phase 3 trial', watches_question: QUESTIONS[1]! },
    ]);
    const out = await enrichStudyWithRelatedTrials(makeStudy(), raw, createRelatedTrialsRunCache(), {}, log);
    expect(out.related_trials).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no_related_search/));
  });

  it('rerank_abstained when rerank returns empty picks', async () => {
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: true,
      candidates: [makeCandidate({ nct: 'NCT05000001' })],
    }));
    const rerank = stubLlm(JSON.stringify({ picks: [] }));
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]),
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank },
      log,
    );
    expect(out.related_trials).toBeNull();
    expect(out.related_trials_provenance.rerank_outcome).toBe('abstained');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/rerank_abstained/));
  });
});

describe('enrichStudyWithRelatedTrials,fan-in + partial failure', () => {
  it('aggregates successful queries when some fail', async () => {
    const c1 = makeCandidate({ nct: 'NCT05000001' });
    const ctgovFetch = vi.fn(async (term: string): Promise<FetchCandidateTrialsResult> => {
      if (term.includes('lutetium')) return { ok: true, candidates: [c1] };
      return { ok: false, error: 'rate_limit', message: '429' };
    });
    const rerank = stubLlm(
      JSON.stringify({
        picks: [{ nct: 'NCT05000001', answers_question: QUESTIONS[0], relevance_phrase: 'fits q1' }],
      }),
    );
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([
        { term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! },
        { term: 'darolutamide nmCRPC OS', watches_question: QUESTIONS[1]! },
      ]),
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank },
      log,
    );
    expect(out.related_trials).toHaveLength(1);
    expect(out.related_trials_provenance.queries_failed).toEqual([
      { term: 'darolutamide nmCRPC OS', reason: 'rate_limit' },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ctgov_rate_limit/));
  });

  it('all_queries_failed marks rerank_outcome as failed (so the minimum-success gate counts it)', async () => {
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: false,
      error: 'timeout',
      message: 'timeout',
    }));
    const rerank = stubLlm('{"picks":[]}'); // never reached
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([
        { term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! },
        { term: 'darolutamide nmCRPC', watches_question: QUESTIONS[1]! },
      ]),
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank },
      log,
    );
    expect(out.related_trials).toBeNull();
    expect(out.related_trials_provenance.queries_failed).toHaveLength(2);
    // Codex PR-2 P2 #2: must be 'failed', not 'skipped', so the build-end
    // minimum-success gate counts this study in the denominator.
    expect(out.related_trials_provenance.rerank_outcome).toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/all_queries_failed/));
    expect(rerank.complete).not.toHaveBeenCalled();
  });

  it('cache stores in-flight promise so concurrent same-term calls share one fetch (race-safe)', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const ctgovFetch = vi.fn(async (term: string): Promise<FetchCandidateTrialsResult> => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { ok: true, candidates: [makeCandidate({ nct: 'NCT05000001' })] };
    });
    const rerank = stubLlm('{"picks":[]}');
    const cache = createRelatedTrialsRunCache();

    const sameTerm = { term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! };
    const studyA = makeStudy({ slug: 'a' });
    const studyB = makeStudy({ slug: 'b' });

    await Promise.all([
      enrichStudyWithRelatedTrials(studyA, rawWith([sameTerm]), cache, { ctgovFetch, rerankClient: rerank }),
      enrichStudyWithRelatedTrials(studyB, rawWith([sameTerm]), cache, { ctgovFetch, rerankClient: rerank }),
    ]);

    // Both studies fired the same term; cache MUST dedup. Only ONE network call.
    expect(ctgovFetch).toHaveBeenCalledTimes(1);
    expect(peakInFlight).toBe(1);
  });

  it('clock throwing inside provenance setup does not escape (codex PR-2 P2 #5)', async () => {
    const throwingClock = vi.fn(() => {
      throw new Error('clock unavailable');
    });
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]),
      createRelatedTrialsRunCache(),
      { clock: throwingClock },
    );
    expect(out.related_trials).toBeNull();
    expect(out.related_trials_provenance.rerank_outcome).toBe('failed');
  });

  it('does not cache failed fetches (retries on next study with same term)', async () => {
    let attempt = 0;
    const ctgovFetch = vi.fn(async (term: string): Promise<FetchCandidateTrialsResult> => {
      attempt += 1;
      if (attempt === 1) return { ok: false, error: 'timeout', message: 't' };
      return { ok: true, candidates: [makeCandidate({ nct: 'NCT05000001' })] };
    });
    const rerank = stubLlm(JSON.stringify({ picks: [] }));
    const cache = createRelatedTrialsRunCache();

    const study1 = makeStudy({ slug: 'a' });
    const study2 = makeStudy({ slug: 'b' });
    const raw1 = rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]);
    const raw2 = rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]);

    await enrichStudyWithRelatedTrials(study1, raw1, cache, { ctgovFetch, rerankClient: rerank });
    await enrichStudyWithRelatedTrials(study2, raw2, cache, { ctgovFetch, rerankClient: rerank });

    // Second study had to retry because the first attempt's failure was NOT cached.
    expect(ctgovFetch).toHaveBeenCalledTimes(2);
  });
});

describe('enrichStudyWithRelatedTrials,rerank failures and fallback', () => {
  it('rerank_failed_fallback_used when client throws', async () => {
    const c1 = makeCandidate({ nct: 'NCT05000001', primary_completion_date: '2027-03' });
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: true,
      candidates: [c1],
    }));
    const rerank = stubLlm(new Error('Anthropic 500'));
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]),
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank },
      log,
    );
    expect(out.related_trials).toHaveLength(1);
    expect(out.related_trials![0]!.relevance_phrase).toBe('candidate match');
    expect(out.related_trials_provenance.rerank_outcome).toBe('fallback');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/rerank_failed_fallback_used/));
  });

  it('rerank_parse_failed when client returns non-JSON', async () => {
    const c1 = makeCandidate({ nct: 'NCT05000001' });
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: true,
      candidates: [c1],
    }));
    const rerank = stubLlm('this is not json');
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]),
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank },
      log,
    );
    expect(out.related_trials_provenance.rerank_outcome).toBe('fallback');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/rerank_parse_failed_fallback_used/));
  });

  it('rerank_no_client_fallback_used when deps.rerankClient is undefined', async () => {
    const c1 = makeCandidate({ nct: 'NCT05000001' });
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: true,
      candidates: [c1],
    }));
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]),
      createRelatedTrialsRunCache(),
      { ctgovFetch }, // no rerankClient
      log,
    );
    expect(out.related_trials).toHaveLength(1);
    expect(out.related_trials![0]!.relevance_phrase).toBe('candidate match');
    expect(out.related_trials_provenance.rerank_outcome).toBe('fallback');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/rerank_no_client_fallback_used/));
  });
});

describe('enrichStudyWithRelatedTrials,never throws (codex round-2 #5)', () => {
  it('catches synthetic exception inside the fetch path', async () => {
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => {
      throw new Error('disk full');
    });
    const log = vi.fn();
    const out = await enrichStudyWithRelatedTrials(
      makeStudy(),
      rawWith([{ term: 'lutetium PSMA mCRPC', watches_question: QUESTIONS[0]! }]),
      createRelatedTrialsRunCache(),
      { ctgovFetch },
      log,
    );
    expect(out.related_trials).toBeNull();
    expect(out.related_trials_provenance.rerank_outcome).toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/orchestrator_exception/));
  });
});

describe('deterministicDegradedFallback', () => {
  it('picks one trial per question by earliest primary_completion_date', () => {
    const grouped = new Map<string, CandidateTrial[]>();
    grouped.set(QUESTIONS[0]!, [
      makeCandidate({ nct: 'NCT01', primary_completion_date: '2028-01' }),
      makeCandidate({ nct: 'NCT02', primary_completion_date: '2026-06' }),
    ]);
    grouped.set(QUESTIONS[1]!, [makeCandidate({ nct: 'NCT03', primary_completion_date: null })]);
    const out = deterministicDegradedFallback(grouped, QUESTIONS);
    expect(out).toHaveLength(2);
    expect(out[0]!.nct).toBe('NCT02');
    expect(out[0]!.answers_question).toBe(QUESTIONS[0]);
    expect(out[1]!.nct).toBe('NCT03');
    expect(out.every((t) => t.relevance_phrase === 'candidate match')).toBe(true);
  });

  it('caps at 3 picks even when more questions have candidates', () => {
    const questions = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const grouped = new Map<string, CandidateTrial[]>();
    questions.forEach((q, i) => {
      grouped.set(q, [makeCandidate({ nct: `NCT0${i + 1}`, primary_completion_date: `202${i}-01` })]);
    });
    const out = deterministicDegradedFallback(grouped, questions);
    expect(out).toHaveLength(3);
  });

  it('returns empty array when no question has candidates', () => {
    expect(deterministicDegradedFallback(new Map(), QUESTIONS)).toEqual([]);
  });
});

describe('broadenTrialQuery', () => {
  it('strips trial-design, grade, and numeric qualifiers to the clinical core', () => {
    expect(broadenTrialQuery('dose escalation meningioma WHO grade 2 radiation randomized')).toBe(
      'meningioma radiation',
    );
  });
  it('drops line-of-therapy and phase qualifiers', () => {
    expect(broadenTrialQuery('darolutamide prostate phase 3 first-line randomized')).toBe(
      'darolutamide prostate',
    );
  });
  it('returns null when nothing is stripped (already broad)', () => {
    expect(broadenTrialQuery('meningioma radiation')).toBeNull();
  });
  it('returns null when stripping leaves fewer than 2 tokens', () => {
    expect(broadenTrialQuery('phase 3 randomized trial')).toBeNull(); // 'trial' kept, only 1 token
  });
  it('returns null for an all-generic broadening (no specific clinical token)', () => {
    // strip design tokens (dose, escalation) → "radiation chemotherapy survival",
    // all ct.gov-generic stop tokens → would swamp the rerank, so reject.
    expect(broadenTrialQuery('dose escalation radiation chemotherapy survival')).toBeNull();
  });
  it('keeps a single specific token alongside a generic one', () => {
    expect(broadenTrialQuery('phase 3 prostate radiation randomized')).toBe('prostate radiation');
  });
  it('strips punctuation off kept tokens (clean ct.gov term)', () => {
    expect(broadenTrialQuery('meningioma, radiation; (phase) 3 randomized')).toBe(
      'meningioma radiation',
    );
  });
});

describe('enrichStudyWithRelatedTrials, empty-query broadening', () => {
  const Q = ['Dose escalation in grade 2 meningioma'];

  it('retries an empty query with the broadened term and uses its candidates', async () => {
    const study = makeStudy({ slug: 'firestorm', open_questions: Q });
    const raw = rawWith([
      { term: 'dose escalation meningioma WHO grade 2 radiation randomized', watches_question: Q[0]! },
    ]);
    const c = makeCandidate({ nct: 'NCT05254197', brief_title: 'Meningioma RT registry' });

    // The narrow query returns empty; only the broadened "meningioma radiation" hits.
    const ctgovFetch = vi.fn(async (term: string): Promise<FetchCandidateTrialsResult> => {
      if (term === 'meningioma radiation') return { ok: true, candidates: [c] };
      return { ok: false, error: 'empty', message: 'no match' };
    });
    const rerank = stubLlm(
      JSON.stringify({
        picks: [{ nct: 'NCT05254197', answers_question: Q[0], relevance_phrase: 'open RT dose study' }],
      }),
    );

    const out = await enrichStudyWithRelatedTrials(
      study,
      raw,
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank, clock: () => new Date('2026-06-09T00:00:00Z') },
      vi.fn(),
    );

    expect(out.related_trials).toHaveLength(1);
    expect(out.related_trials_provenance.candidates_returned).toBe(1);
    // Clean terms only (no annotation strings): the broadened term that
    // returned candidates joins queries_fired; the original empty query joins
    // queries_failed. The eval scores real query terms, not notes.
    expect(out.related_trials_provenance.queries_fired).toEqual([
      'dose escalation meningioma WHO grade 2 radiation randomized',
      'meningioma radiation',
    ]);
    expect(out.related_trials_provenance.queries_failed).toEqual([
      { term: 'dose escalation meningioma WHO grade 2 radiation randomized', reason: 'empty' },
    ]);
    expect(ctgovFetch).toHaveBeenCalledWith('meningioma radiation');
  });

  it("excludes the study's own trial from its watch-list", async () => {
    const study = makeStudy({ slug: 'prestige', nct: 'NCT04567890', open_questions: [QUESTIONS[0]!] });
    const raw = rawWith([{ term: 'lutetium PSMA mCRPC sequencing', watches_question: QUESTIONS[0]! }]);
    // ct.gov returns the study's own trial plus one other open trial.
    const own = makeCandidate({ nct: 'NCT04567890', brief_title: 'PRESTIGE-PSMA (this study)' });
    const other = makeCandidate({ nct: 'NCT09999999', brief_title: 'A different open trial' });
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: true,
      candidates: [own, other],
    }));
    const rerank = stubLlm(
      JSON.stringify({
        picks: [{ nct: 'NCT09999999', answers_question: QUESTIONS[0], relevance_phrase: 'open competitor' }],
      }),
    );
    const out = await enrichStudyWithRelatedTrials(
      study,
      raw,
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: rerank, clock: () => new Date() },
      vi.fn(),
    );
    // Own NCT dropped before rerank; only the other trial can be picked.
    expect(out.related_trials_provenance.candidates_returned).toBe(1);
    expect((out.related_trials ?? []).map((t) => t.nct)).not.toContain('NCT04567890');
  });

  it('records the failure when even the broadened query is empty', async () => {
    const study = makeStudy({ slug: 'firestorm', open_questions: Q });
    const raw = rawWith([
      { term: 'dose escalation meningioma WHO grade 2 radiation randomized', watches_question: Q[0]! },
    ]);
    const ctgovFetch = vi.fn(async (): Promise<FetchCandidateTrialsResult> => ({
      ok: false,
      error: 'empty',
      message: 'no match',
    }));
    const out = await enrichStudyWithRelatedTrials(
      study,
      raw,
      createRelatedTrialsRunCache(),
      { ctgovFetch, rerankClient: stubLlm(JSON.stringify({ picks: [] })), clock: () => new Date() },
      vi.fn(),
    );
    expect(out.related_trials).toBeNull();
    expect(out.related_trials_provenance.rerank_outcome).toBe('failed');
    expect(out.related_trials_provenance.queries_failed[0]?.reason).toBe('empty');
    expect(ctgovFetch).toHaveBeenCalledTimes(2); // original + one broadened retry
  });
});
