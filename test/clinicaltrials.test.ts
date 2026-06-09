import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchCandidateTrials,
  parseCtgovResponse,
  buildCtgovUrl,
  _setConcurrencyLimitForTests,
  _resetConcurrencyForTests,
} from '../src/lib/clinicaltrials.ts';

// Minimal Response stub. fetchImpl signature lets us simulate any status.
function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function ctgovStudy(over: Record<string, unknown> = {}): unknown {
  return {
    protocolSection: {
      identificationModule: {
        nctId: 'NCT05000001',
        briefTitle: 'A Phase 3 Study of X in Y',
      },
      statusModule: {
        overallStatus: 'RECRUITING',
        primaryCompletionDateStruct: { date: '2027-03-15' },
      },
      designModule: {
        phases: ['PHASE3'],
        enrollmentInfo: { count: 1200 },
      },
      conditionsModule: {
        conditions: ['Prostate Cancer', 'Metastatic Castration-Resistant Prostate Cancer'],
      },
      armsInterventionsModule: {
        interventions: [
          { name: 'Darolutamide', type: 'DRUG' },
          { name: 'ADT', type: 'DRUG' },
        ],
      },
      eligibilityModule: {
        eligibilityCriteria:
          'Inclusion: Histologically confirmed mCRPC.\nExclusion: Prior taxane therapy.',
      },
      descriptionModule: {
        briefSummary: 'This is a randomized phase 3 study evaluating darolutamide.',
      },
      ...over,
    },
  };
}

beforeEach(() => {
  _resetConcurrencyForTests();
});

describe('parseCtgovResponse', () => {
  it('hydrates a full study into a CandidateTrial', () => {
    const out = parseCtgovResponse({ studies: [ctgovStudy()] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      nct: 'NCT05000001',
      brief_title: 'A Phase 3 Study of X in Y',
      overall_status: 'RECRUITING',
      phase: ['PHASE3'],
      enrollment_count: 1200,
      primary_completion_date: '2027-03',
      conditions: ['Prostate Cancer', 'Metastatic Castration-Resistant Prostate Cancer'],
      interventions: [
        { name: 'Darolutamide', type: 'DRUG' },
        { name: 'ADT', type: 'DRUG' },
      ],
    });
    expect(out[0]!.brief_summary).toContain('randomized phase 3');
    expect(out[0]!.eligibility_brief).toContain('Histologically confirmed');
  });

  it('handles all four accepted statuses', () => {
    const statuses = ['RECRUITING', 'NOT_YET_RECRUITING', 'ACTIVE_NOT_RECRUITING', 'ENROLLING_BY_INVITATION'];
    for (const s of statuses) {
      const out = parseCtgovResponse({
        studies: [ctgovStudy({ statusModule: { overallStatus: s } })],
      });
      expect(out, `status=${s}`).toHaveLength(1);
      expect(out[0]!.overall_status).toBe(s);
    }
  });

  it('drops studies with statuses outside the enum (COMPLETED, TERMINATED, etc.)', () => {
    const out = parseCtgovResponse({
      studies: [
        ctgovStudy({ statusModule: { overallStatus: 'COMPLETED' } }),
        ctgovStudy({ statusModule: { overallStatus: 'TERMINATED' } }),
        ctgovStudy({ statusModule: { overallStatus: 'WITHDRAWN' } }),
      ],
    });
    expect(out).toHaveLength(0);
  });

  it('drops studies missing nctId or briefTitle', () => {
    const out = parseCtgovResponse({
      studies: [
        ctgovStudy({ identificationModule: { briefTitle: 'No NCT' } }),
        ctgovStudy({ identificationModule: { nctId: 'NCT05000002' } }),
        ctgovStudy({ identificationModule: {} }),
      ],
    });
    expect(out).toHaveLength(0);
  });

  it('null phase when phases array is missing or empty', () => {
    const noPhases = parseCtgovResponse({
      studies: [ctgovStudy({ designModule: { enrollmentInfo: { count: 50 } } })],
    });
    expect(noPhases[0]!.phase).toBeNull();

    const emptyPhases = parseCtgovResponse({
      studies: [ctgovStudy({ designModule: { phases: [], enrollmentInfo: { count: 50 } } })],
    });
    expect(emptyPhases[0]!.phase).toBeNull();
  });

  it('preserves multi-phase arrays', () => {
    const out = parseCtgovResponse({
      studies: [ctgovStudy({ designModule: { phases: ['PHASE1', 'PHASE2'], enrollmentInfo: { count: 80 } } })],
    });
    expect(out[0]!.phase).toEqual(['PHASE1', 'PHASE2']);
  });

  it('null enrollment_count when missing or non-numeric', () => {
    const noCount = parseCtgovResponse({
      studies: [ctgovStudy({ designModule: { phases: ['PHASE3'] } })],
    });
    expect(noCount[0]!.enrollment_count).toBeNull();

    const stringCount = parseCtgovResponse({
      studies: [ctgovStudy({ designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 'unknown' } } })],
    });
    expect(stringCount[0]!.enrollment_count).toBeNull();
  });

  it('trims primary_completion_date to YYYY-MM regardless of input precision', () => {
    const full = parseCtgovResponse({
      studies: [ctgovStudy({ statusModule: { overallStatus: 'RECRUITING', primaryCompletionDateStruct: { date: '2027-03-15' } } })],
    });
    expect(full[0]!.primary_completion_date).toBe('2027-03');

    const monthOnly = parseCtgovResponse({
      studies: [ctgovStudy({ statusModule: { overallStatus: 'RECRUITING', primaryCompletionDateStruct: { date: '2027-03' } } })],
    });
    expect(monthOnly[0]!.primary_completion_date).toBe('2027-03');

    const yearOnly = parseCtgovResponse({
      studies: [ctgovStudy({ statusModule: { overallStatus: 'RECRUITING', primaryCompletionDateStruct: { date: '2027' } } })],
    });
    expect(yearOnly[0]!.primary_completion_date).toBe('2027');

    const missing = parseCtgovResponse({
      studies: [ctgovStudy({ statusModule: { overallStatus: 'RECRUITING' } })],
    });
    expect(missing[0]!.primary_completion_date).toBeNull();
  });

  it('truncates brief_summary at ~500 chars on whitespace', () => {
    const longSummary = 'word '.repeat(200); // ~1000 chars
    const out = parseCtgovResponse({
      studies: [ctgovStudy({ descriptionModule: { briefSummary: longSummary } })],
    });
    expect(out[0]!.brief_summary!.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    expect(out[0]!.brief_summary).toMatch(/…$/);
  });

  it('defaults intervention type to OTHER when missing', () => {
    const out = parseCtgovResponse({
      studies: [
        ctgovStudy({
          armsInterventionsModule: {
            interventions: [
              { name: 'Some Drug' }, // no type
              { name: 'Other Thing', type: '' },
            ],
          },
        }),
      ],
    });
    expect(out[0]!.interventions).toEqual([
      { name: 'Some Drug', type: 'OTHER' },
      { name: 'Other Thing', type: 'OTHER' },
    ]);
  });

  it('returns [] for malformed input', () => {
    expect(parseCtgovResponse(null)).toEqual([]);
    expect(parseCtgovResponse(undefined)).toEqual([]);
    expect(parseCtgovResponse('not an object')).toEqual([]);
    expect(parseCtgovResponse({ studies: 'not an array' })).toEqual([]);
    expect(parseCtgovResponse({})).toEqual([]);
    expect(parseCtgovResponse({ studies: [] })).toEqual([]);
  });

  it('drops individual malformed studies, keeps good ones', () => {
    const out = parseCtgovResponse({
      studies: [
        ctgovStudy(),
        null,
        { protocolSection: 'string instead of object' },
        ctgovStudy({ identificationModule: { nctId: 'NCT05000002', briefTitle: 'Second Study' } }),
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.nct)).toEqual(['NCT05000001', 'NCT05000002']);
  });
});

describe('buildCtgovUrl', () => {
  it('URL-encodes the query term', () => {
    const url = buildCtgovUrl('darolutamide nmCRPC overall survival', 20);
    expect(url).toContain('query.term=darolutamide+nmCRPC+overall+survival');
  });

  it('encodes special chars (parens, hyphens, slashes)', () => {
    const url = buildCtgovUrl('177Lu-PSMA-617 (first-line)', 20);
    expect(url).toContain('query.term=177Lu-PSMA-617+%28first-line%29');
  });

  it('includes the four accepted statuses joined by PIPE (v2 contract)', () => {
    // CT.gov v2 filter.overallStatus requires PIPE separation, not comma.
    // Codex review caught this as a P1 — comma would return HTTP 400.
    const url = buildCtgovUrl('test', 20);
    const params = new URL(url).searchParams;
    expect(params.get('filter.overallStatus')).toBe(
      'RECRUITING|NOT_YET_RECRUITING|ACTIVE_NOT_RECRUITING|ENROLLING_BY_INVITATION',
    );
  });

  it('requests v2 module-level field selectors (codex round-2 #2 + #3)', () => {
    // Using module selectors instead of leaf names avoids the v1-to-v2
    // migration trap (e.g. legacy `Conditions` no longer resolves; the v2
    // leaf is singular `Condition`). Module selectors are stable.
    const url = buildCtgovUrl('test', 20);
    const params = new URL(url).searchParams;
    const fields = params.get('fields')!;
    expect(fields.split(',')).toEqual([
      'IdentificationModule',
      'StatusModule',
      'DesignModule',
      'ConditionsModule',
      'ArmsInterventionsModule',
      'EligibilityModule',
      'DescriptionModule',
    ]);
  });

  it('honors pageSize parameter', () => {
    expect(buildCtgovUrl('test', 5)).toContain('pageSize=5');
    expect(buildCtgovUrl('test', 50)).toContain('pageSize=50');
  });
});

describe('fetchCandidateTrials', () => {
  it('returns candidates on happy path', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ studies: [ctgovStudy()] })) as unknown as typeof fetch;
    const r = await fetchCandidateTrials('darolutamide nmCRPC', { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]!.nct).toBe('NCT05000001');
    }
  });

  it('returns empty error when ct.gov returns 0 studies', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ studies: [] })) as unknown as typeof fetch;
    const r = await fetchCandidateTrials('non-matching-term', { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('empty');
      expect(r.message).toContain('non-matching-term');
    }
  });

  it('returns empty error when every study has a non-accepted status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({
        studies: [
          ctgovStudy({ statusModule: { overallStatus: 'COMPLETED' } }),
          ctgovStudy({ statusModule: { overallStatus: 'TERMINATED' } }),
        ],
      }),
    ) as unknown as typeof fetch;
    const r = await fetchCandidateTrials('term', { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('empty');
  });

  it('rate_limit on 429 (no retry)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}, 429)) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCandidateTrials('term', { fetchImpl, sleep });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('rate_limit');
    // 429 must NOT retry: only one fetch call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries up to 3 times on 5xx with exponential backoff', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) return jsonRes({}, 503);
      return jsonRes({ studies: [ctgovStudy()] });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCandidateTrials('term', { fetchImpl, sleep });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(sleep).toHaveBeenCalledTimes(3);
    // Exponential backoff: 200, 400, 800
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([200, 400, 800]);
  });

  it('returns network error after all 5xx retries exhausted', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}, 503)) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCandidateTrials('term', { fetchImpl, sleep });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('network');
      expect(r.message).toContain('503');
    }
  });

  it('returns timeout error when fetch aborts', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      // Simulate AbortController firing.
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      // The real fetch throws AbortError when signal aborts; we just throw it.
      void init;
      throw abortErr;
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCandidateTrials('term', { fetchImpl, sleep, maxRetries: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('timeout');
  });

  it('semaphore queues calls beyond the concurrency limit', async () => {
    _setConcurrencyLimitForTests(2);
    let inFlightPeak = 0;
    let inFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      inFlightPeak = Math.max(inFlightPeak, inFlight);
      // Yield a microtask so all queued fetches can race.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return jsonRes({ studies: [ctgovStudy()] });
    }) as unknown as typeof fetch;

    await Promise.all([
      fetchCandidateTrials('a', { fetchImpl }),
      fetchCandidateTrials('b', { fetchImpl }),
      fetchCandidateTrials('c', { fetchImpl }),
      fetchCandidateTrials('d', { fetchImpl }),
      fetchCandidateTrials('e', { fetchImpl }),
    ]);

    // With limit=2, no more than 2 should be in flight at any time.
    expect(inFlightPeak).toBeLessThanOrEqual(2);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
