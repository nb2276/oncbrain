import { describe, it, expect } from 'vitest';
import {
  parseRelatedSearch,
  parseRelatedTrials,
  type CandidateTrial,
  type RelatedSearch,
} from '../src/lib/llm-pipeline.ts';

// Reusable candidate factory — the smallest valid CandidateTrial.
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

function candidateMap(...c: CandidateTrial[]): Map<string, CandidateTrial> {
  return new Map(c.map((x) => [x.nct, x]));
}

describe('parseRelatedSearch', () => {
  it('parses a valid 2-query payload', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: 'darolutamide nmCRPC overall survival', watches_question: 'Does deeper AR blockade extend OS?' },
        { term: 'stereotactic body radiotherapy prostate fractionation', watches_question: 'Is 5-fraction SBRT effective?' },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.queries).toHaveLength(2);
    expect(out!.queries[0]!.term).toBe('darolutamide nmCRPC overall survival');
    expect(out!.queries[0]!.watches_question).toBe('Does deeper AR blockade extend OS?');
  });

  it('caps at 3 queries', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: 'aaa bbb ccc', watches_question: 'q1' },
        { term: 'ddd eee fff', watches_question: 'q2' },
        { term: 'ggg hhh iii', watches_question: 'q3' },
        { term: 'jjj kkk lll', watches_question: 'q4' },
        { term: 'mmm nnn ooo', watches_question: 'q5' },
      ],
    });
    expect(out!.queries).toHaveLength(3);
  });

  it('trims whitespace on term and watches_question', () => {
    const out = parseRelatedSearch({
      queries: [{ term: '  abc def ghi  ', watches_question: '  Question?  ' }],
    });
    expect(out!.queries[0]!.term).toBe('abc def ghi');
    expect(out!.queries[0]!.watches_question).toBe('Question?');
  });

  it('rejects single-token queries; accepts 2+ specific-token queries', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: 'darolutamide', watches_question: 'q1' },           // 1 token, fails
        { term: 'darolutamide nmCRPC', watches_question: 'q2' },    // 2 specific, passes (drug + condition is a common real shape)
        { term: 'darolutamide nmCRPC OS', watches_question: 'q3' }, // 3 specific, passes
      ],
    });
    expect(out!.queries).toHaveLength(2);
    expect(out!.queries.map((q) => q.term)).toEqual(['darolutamide nmCRPC', 'darolutamide nmCRPC OS']);
  });

  it('rejects queries with fewer than 2 specific (non-stop, non-numeric) tokens', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: 'cancer drug treatment', watches_question: 'q1' },   // 0 specific
        { term: 'phase 3 trial', watches_question: 'q2' },           // 0 specific (3 is numeric)
        { term: 'RT therapy radiation', watches_question: 'q3' },    // 0 specific
        { term: 'advanced cancer treatment', watches_question: 'q4' }, // advanced is now stop; 0 specific
        { term: 'survival combination therapy', watches_question: 'q5' }, // codex round-2: all stop, 0 specific
        { term: 'darolutamide nmCRPC', watches_question: 'q6' },     // 2 specific, passes
      ],
    });
    expect(out!.queries).toHaveLength(1);
  });

  it('splits hyphenated tokens so "phase-3 trial study" is rejected', () => {
    // phase-3 → ["phase", "3"]; phase is stop, 3 is numeric → 0 specific in
    // the whole query. Without hyphen splitting, "phase3" would be a
    // novel-looking specific token and would slip through.
    const out = parseRelatedSearch({
      queries: [{ term: 'phase-3 trial study', watches_question: 'q' }],
    });
    expect(out).toBeNull();
  });

  it('keeps real hyphenated drug names intact at the specific-token level', () => {
    // 177Lu-PSMA-617 → ["177lu", "psma", "617"]; psma is specific
    // (not stop, not numeric), 177lu is specific. 2 specific tokens.
    const out = parseRelatedSearch({
      queries: [{ term: '177Lu-PSMA-617 first-line', watches_question: 'q' }],
    });
    expect(out).not.toBeNull();
    expect(out!.queries[0]!.term).toBe('177Lu-PSMA-617 first-line');
  });

  it('accepts queries that mix stop-list with 2+ specific tokens', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: 'darolutamide trial nmCRPC', watches_question: 'q1' },
        { term: 'sotorasib phase 3 NSCLC', watches_question: 'q2' },
      ],
    });
    expect(out!.queries).toHaveLength(2);
  });

  it('drops entries with empty term or watches_question', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: '', watches_question: 'q' },
        { term: 'abc def ghi', watches_question: '' },
        { term: '   ', watches_question: 'q' },
        { term: 'abc def ghi', watches_question: 'q' },
      ],
    });
    expect(out!.queries).toHaveLength(1);
  });

  it('drops duplicate (term, watches_question) tuples (case-insensitive on term)', () => {
    const out = parseRelatedSearch({
      queries: [
        { term: 'darolutamide nmCRPC OS', watches_question: 'q1' },
        { term: 'DAROLUTAMIDE nmCRPC OS', watches_question: 'q1' },
        { term: 'darolutamide nmCRPC OS', watches_question: 'q2' }, // same term, different q — kept
      ],
    });
    expect(out!.queries).toHaveLength(2);
    expect(out!.queries.map((q) => q.watches_question)).toEqual(['q1', 'q2']);
  });

  it('returns null when input is not an object', () => {
    expect(parseRelatedSearch(null)).toBeNull();
    expect(parseRelatedSearch(undefined)).toBeNull();
    expect(parseRelatedSearch('queries')).toBeNull();
    expect(parseRelatedSearch([])).toBeNull();
  });

  it('returns null when queries is missing or not an array', () => {
    expect(parseRelatedSearch({})).toBeNull();
    expect(parseRelatedSearch({ queries: 'not an array' })).toBeNull();
    expect(parseRelatedSearch({ queries: null })).toBeNull();
  });

  it('returns null when every query fails validation', () => {
    expect(
      parseRelatedSearch({
        queries: [
          { term: 'cancer', watches_question: 'q' },
          { term: '', watches_question: 'q' },
        ],
      }),
    ).toBeNull();
  });

  it('returns null when queries is an empty array', () => {
    expect(parseRelatedSearch({ queries: [] })).toBeNull();
  });
});

describe('parseRelatedTrials', () => {
  const openQuestions = [
    'Does deeper AR blockade extend OS in nmCRPC?',
    'Is 5-fraction SBRT as effective as 3-fraction for oligo prostate?',
    'Does adjuvant immunotherapy improve EFS in melanoma stage III?',
  ];
  const c1 = makeCandidate({ nct: 'NCT05000001', primary_completion_date: '2027-03' });
  const c2 = makeCandidate({ nct: 'NCT05000002', primary_completion_date: '2026-10' });
  const c3 = makeCandidate({ nct: 'NCT05000003', primary_completion_date: '2028-01' });
  const c4 = makeCandidate({ nct: 'NCT05000004', primary_completion_date: null });

  it('hydrates valid picks from the candidate pool', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'tests AR intensification' },
        ],
      },
      candidateMap(c1, c2),
      openQuestions,
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      nct: 'NCT05000001',
      brief_title: 'Trial NCT05000001',
      overall_status: 'RECRUITING',
      answers_question: openQuestions[0],
      relevance_phrase: 'tests AR intensification',
    });
  });

  it('INVARIANT 1 violated: drops picks whose nct is not in the candidate set', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'tests' }, // valid
          { nct: 'NCT99999999', answers_question: openQuestions[1], relevance_phrase: 'fake' },  // fabricated
        ],
      },
      candidateMap(c1),
      openQuestions,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.nct).toBe('NCT05000001');
  });

  it('INVARIANT 2: curly-quote drift survives; case drift still fails (codex PR-2 #4)', () => {
    // The LLM commonly normalizes apostrophes to curly quotes. Without
    // normalization the invariant would drop legitimate picks.
    const studyQuestions = [
      "Does deeper AR blockade extend OS in patient's nmCRPC?", // ascii
      'Sequencing vs cabazitaxel',
    ];
    const out = parseRelatedTrials(
      {
        picks: [
          // curly apostrophe → matches via NFC + smart-quote fold
          { nct: 'NCT05000001', answers_question: 'Does deeper AR blockade extend OS in patient’s nmCRPC?', relevance_phrase: 'a' },
          // case drift → drops
          { nct: 'NCT05000002', answers_question: 'sequencing vs cabazitaxel', relevance_phrase: 'b' },
        ],
      },
      candidateMap(c1, c2),
      studyQuestions,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.nct).toBe('NCT05000001');
    // Persisted answers_question is the CANONICAL ascii form, not the
    // LLM's curly-quote version.
    expect(out![0]!.answers_question).toBe(studyQuestions[0]);
  });

  it('INVARIANT 2: case drift drops; whitespace drift survives (parser trims)', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          // byte-identical → kept
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'a' },
          // case drift → dropped (case-sensitive match)
          { nct: 'NCT05000002', answers_question: openQuestions[1]!.toLowerCase(), relevance_phrase: 'b' },
          // whitespace drift → kept after trim (legitimate LLM sloppiness, not invention)
          { nct: 'NCT05000003', answers_question: openQuestions[2] + ' ', relevance_phrase: 'c' },
        ],
      },
      candidateMap(c1, c2, c3),
      openQuestions,
    );
    expect(out).toHaveLength(2);
    expect(out!.map((t) => t.nct)).toEqual(['NCT05000001', 'NCT05000003']);
  });

  it('INVARIANT 2 violated: drops fabricated questions', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          { nct: 'NCT05000001', answers_question: 'A question the LLM made up', relevance_phrase: 'a' },
        ],
      },
      candidateMap(c1),
      openQuestions,
    );
    expect(out).toBeNull();
  });

  it('dedupes (nct, answers_question) tuples', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'a' },
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'b' }, // duplicate
        ],
      },
      candidateMap(c1),
      openQuestions,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.relevance_phrase).toBe('a'); // first one wins
  });

  it('keeps same nct under different questions (legitimate cross-question coverage)', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'a' },
          { nct: 'NCT05000001', answers_question: openQuestions[1], relevance_phrase: 'b' },
        ],
      },
      candidateMap(c1),
      openQuestions,
    );
    expect(out).toHaveLength(2);
  });

  it('caps at 5 picks total', () => {
    const candidates: CandidateTrial[] = [];
    const picks: unknown[] = [];
    for (let i = 1; i <= 8; i += 1) {
      const nct = `NCT0500000${i}`;
      candidates.push(makeCandidate({ nct, primary_completion_date: `202${i}-01` }));
      picks.push({ nct, answers_question: openQuestions[0], relevance_phrase: `p${i}` });
    }
    const out = parseRelatedTrials({ picks }, candidateMap(...candidates), openQuestions);
    expect(out).toHaveLength(5);
  });

  it('sorts picks: by question order first, then primary_completion_date ascending, nulls last', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          // q3 (idx 2)
          { nct: 'NCT05000003', answers_question: openQuestions[2], relevance_phrase: 'c' },
          // q1 (idx 0), late date
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'a' },
          // q1 (idx 0), early date
          { nct: 'NCT05000002', answers_question: openQuestions[0], relevance_phrase: 'b' },
          // q1 (idx 0), null date — should sort last in its group
          { nct: 'NCT05000004', answers_question: openQuestions[0], relevance_phrase: 'd' },
        ],
      },
      candidateMap(c1, c2, c3, c4),
      openQuestions,
    );
    expect(out!.map((t) => t.nct)).toEqual([
      'NCT05000002', // q1, 2026-10
      'NCT05000001', // q1, 2027-03
      'NCT05000004', // q1, null (last in group)
      'NCT05000003', // q3, 2028-01
    ]);
  });

  it('caps relevance_phrase at 60 chars on whitespace boundary', () => {
    const longPhrase = 'phase 3 head-to-head test of darolutamide vs enzalutamide intensification in nmCRPC';
    const out = parseRelatedTrials(
      {
        picks: [
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: longPhrase },
        ],
      },
      candidateMap(c1),
      openQuestions,
    );
    expect(out![0]!.relevance_phrase.length).toBeLessThanOrEqual(61); // 60 + ellipsis
    expect(out![0]!.relevance_phrase).toMatch(/…$/);
  });

  it('returns null when picks array is empty', () => {
    expect(parseRelatedTrials({ picks: [] }, candidateMap(c1), openQuestions)).toBeNull();
  });

  it('returns null when every pick violates an invariant', () => {
    expect(
      parseRelatedTrials(
        {
          picks: [
            { nct: 'NCT99999999', answers_question: openQuestions[0], relevance_phrase: 'a' },
            { nct: 'NCT05000001', answers_question: 'fabricated', relevance_phrase: 'b' },
          ],
        },
        candidateMap(c1),
        openQuestions,
      ),
    ).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseRelatedTrials(null, candidateMap(c1), openQuestions)).toBeNull();
    expect(parseRelatedTrials({}, candidateMap(c1), openQuestions)).toBeNull();
    expect(parseRelatedTrials({ picks: 'not an array' }, candidateMap(c1), openQuestions)).toBeNull();
  });

  it('drops picks with missing nct, answers_question, or relevance_phrase', () => {
    const out = parseRelatedTrials(
      {
        picks: [
          { answers_question: openQuestions[0], relevance_phrase: 'a' },          // missing nct
          { nct: 'NCT05000001', relevance_phrase: 'b' },                          // missing answers_question
          { nct: 'NCT05000001', answers_question: openQuestions[0] },             // missing relevance_phrase
          { nct: 'NCT05000001', answers_question: openQuestions[0], relevance_phrase: 'd' }, // valid
        ],
      },
      candidateMap(c1),
      openQuestions,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.relevance_phrase).toBe('d');
  });

  it('preserves CandidateTrial fields exactly when hydrating', () => {
    const richCandidate = makeCandidate({
      nct: 'NCT05000001',
      brief_title: 'STARLIGHT-1: Phase 3 ARSi Intensification',
      overall_status: 'ACTIVE_NOT_RECRUITING',
      phase: ['PHASE3'],
      enrollment_count: 1200,
      primary_completion_date: '2027-Q2'.slice(0, 7),
      brief_summary: 'A randomized phase 3 study evaluating darolutamide.',
      conditions: ['nmCRPC'],
      interventions: [{ name: 'Darolutamide', type: 'DRUG' }],
      eligibility_brief: 'Inclusion: nmCRPC. Exclusion: prior taxane.',
    });
    const out = parseRelatedTrials(
      {
        picks: [
          {
            nct: 'NCT05000001',
            answers_question: openQuestions[0],
            relevance_phrase: 'direct AR intensification head-to-head',
          },
        ],
      },
      candidateMap(richCandidate),
      openQuestions,
    );
    expect(out![0]).toMatchObject({
      brief_title: 'STARLIGHT-1: Phase 3 ARSi Intensification',
      overall_status: 'ACTIVE_NOT_RECRUITING',
      conditions: ['nmCRPC'],
      interventions: [{ name: 'Darolutamide', type: 'DRUG' }],
      eligibility_brief: 'Inclusion: nmCRPC. Exclusion: prior taxane.',
    });
  });
});

// Type-only sanity: RelatedSearch is exported and usable from this side of the
// import boundary. If this fails to compile, the export went wrong.
describe('exports', () => {
  it('exports RelatedSearch as a usable type', () => {
    const _s: RelatedSearch = { queries: [{ term: 'abc def ghi', watches_question: 'q' }] };
    expect(_s.queries[0]!.term).toBe('abc def ghi');
  });
});
