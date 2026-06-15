// clinicaltrials.gov v2 API client for the v0.13 "trials to watch" feature.
//
// One entry point: fetchCandidateTrials(term, opts). Given a free-text query
// term (drug name, RT modality, condition + line, etc.), returns up to 20
// open clinical trials currently RECRUITING, NOT_YET_RECRUITING,
// ACTIVE_NOT_RECRUITING, or ENROLLING_BY_INVITATION. Caller (the Phase 2
// orchestrator) feeds the candidates to the rerank LLM which picks the top
// 5 and pairs each to a study.open_questions entry.
//
// Design notes:
//   - query.term (free-text) covers drug, RT, surgery, biomarker, and
//     methodology queries equally. drug+condition (the v1 plan) silently
//     failed on non-drug questions.
//   - 10s timeout via AbortController.
//   - 5xx → retry max 3 with exponential backoff via opts.sleep.
//   - 429 → fail immediately, no retry (the global semaphore is the
//     enforcement layer; a 429 means we hit ct.gov-side throttling and
//     should yield).
//   - Global concurrency semaphore (limit 3) so a per-study fan-out of N
//     queries across M studies cannot stampede the API (codex round-2 #14).
//   - Failures are NEVER cached: the in-run cache lives in llm-pipeline.ts
//     and stores resolved results only (codex round-2 #13).
//
// Test seam: every external (fetch, clock, sleep) is injectable so unit
// tests run against fixtures without touching the network.

import type { CandidateTrial, RelatedTrialStatus } from './digest-data.ts';
import { RELATED_TRIAL_STATUSES } from './digest-data.ts';

const CTGOV_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CONCURRENCY = 3;
const BRIEF_SUMMARY_CAP = 500;
const ELIGIBILITY_CAP = 300;

// CT.gov v2 field selectors. We request whole protocolSection modules
// (documented v2 selector form) instead of individual leaf names. This
// avoids the v1-to-v2 leaf-name migration trap where some legacy names
// like `Conditions` no longer resolve (the v2 selector is singular
// `Condition` even though the JSON property stays `conditions`). Module
// selectors are slightly larger payloads but immune to that drift.
// parseOneStudy walks protocolSection.* by module so it consumes either
// shape interchangeably.
const CTGOV_FIELDS = [
  'IdentificationModule',
  'StatusModule',
  'DesignModule',
  'ConditionsModule',
  'ArmsInterventionsModule',
  'EligibilityModule',
  'DescriptionModule',
].join(',');

// CT.gov v2 filter.overallStatus uses PIPE separation, not comma. Comma
// returns HTTP 400. See https://clinicaltrials.gov/data-api/about-api .
const STATUS_FILTER = RELATED_TRIAL_STATUSES.join('|');

export type FetchCandidateTrialsDeps = {
  fetchImpl?: typeof fetch;
  // Wall clock for the fetched_at provenance timestamp. Defaults to Date.
  clock?: () => Date;
  // Sleep for retry backoff. Tests inject a no-op or fast-forward.
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
  pageSize?: number;
};

export type FetchCandidateTrialsError =
  | 'empty'        // ct.gov returned 0 matching studies
  | 'rate_limit'   // ct.gov returned 429
  | 'timeout'      // AbortController fired
  | 'network';     // 5xx after retries OR any non-2xx other than 404/429

export type FetchCandidateTrialsResult =
  | { ok: true; candidates: CandidateTrial[] }
  | { ok: false; error: FetchCandidateTrialsError; message: string };

// Global concurrency semaphore. Caps in-flight ct.gov requests at
// DEFAULT_CONCURRENCY so a per-study fan-out of N queries by M studies
// cannot trigger 429 rate-limit cascades.
//
// The semaphore is module-level (lives for the lifetime of the build
// process), but tests can reset/configure it via the _setConcurrency
// helpers below.
//
// Ownership-transfer semantics: releaseSlot does NOT decrement inFlight
// when waking a waiter. Instead it transfers the slot directly: the
// outgoing holder's release wakes the next waiter, who already owns the
// slot. This closes the race where a concurrent newcomer could see
// inFlight < limit between a decrement and the waiter's increment,
// briefly pushing in-flight count above the cap.
let inFlight = 0;
let concurrencyLimit = DEFAULT_CONCURRENCY;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < concurrencyLimit) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  // No inFlight += 1 here: releaseSlot transferred the slot to us.
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    // Transfer the slot. inFlight stays the same; the waiter now owns it.
    next();
  } else {
    inFlight -= 1;
  }
}

// Test seam: set the semaphore limit. NOT for production callers.
export function _setConcurrencyLimitForTests(limit: number): void {
  concurrencyLimit = limit;
}

export function _resetConcurrencyForTests(): void {
  inFlight = 0;
  concurrencyLimit = DEFAULT_CONCURRENCY;
  waitQueue.length = 0;
}

// Public entry point: fetch open trials matching the free-text query term.
//
// term: a free-text CT.gov query. Caller normalizes (lowercases, trims)
// before this; we don't re-normalize here so the cache key in the
// orchestrator stays consistent.
export async function fetchCandidateTrials(
  term: string,
  opts: FetchCandidateTrialsDeps = {},
): Promise<FetchCandidateTrialsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;

  const url = buildCtgovUrl(term, pageSize);

  await acquireSlot();
  try {
    const json = await fetchWithRetry(url, fetchImpl, sleep, timeoutMs, maxRetries);
    const candidates = parseCtgovResponse(json);
    if (candidates.length === 0) {
      return { ok: false, error: 'empty', message: `ct.gov returned 0 studies for term: ${term}` };
    }
    return { ok: true, candidates };
  } catch (err) {
    if (err instanceof CtgovError) {
      return { ok: false, error: err.kind, message: err.message };
    }
    return {
      ok: false,
      error: 'network',
      message: `Unexpected error: ${(err as Error).message}`,
    };
  } finally {
    releaseSlot();
  }
}

class CtgovError extends Error {
  constructor(
    message: string,
    readonly kind: FetchCandidateTrialsError,
  ) {
    super(message);
    this.name = 'CtgovError';
  }
}

export function buildCtgovUrl(term: string, pageSize: number): string {
  const params = new URLSearchParams({
    'query.term': term,
    'filter.overallStatus': STATUS_FILTER,
    pageSize: String(pageSize),
    fields: CTGOV_FIELDS,
    format: 'json',
  });
  return `${CTGOV_BASE}?${params.toString()}`;
}

async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  maxRetries: number,
): Promise<unknown> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (res.status === 429) {
        throw new CtgovError(`ct.gov rate limited (HTTP 429): ${url}`, 'rate_limit');
      }
      if (res.status >= 500 && res.status < 600) {
        lastErr = new CtgovError(`ct.gov returned ${res.status}`, 'network');
        if (attempt < maxRetries) {
          // Exponential backoff: 200ms, 400ms, 800ms.
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new CtgovError(`ct.gov returned ${res.status}`, 'network');
      }
      // Bad JSON inside a 200 response means the server returned something
      // other than JSON (intermediate CDN error page, contract break).
      // Fail fast: retrying wastes the request budget on a server that is
      // not going to start returning JSON in the next 800ms.
      try {
        return await res.json();
      } catch (parseErr) {
        throw new CtgovError(
          `ct.gov returned non-JSON body: ${(parseErr as Error).message}`,
          'network',
        );
      }
    } catch (err) {
      if (err instanceof CtgovError) throw err;
      // Timeout (AbortController) does NOT retry. A timeout means the
      // server is overwhelmed; backing off is the right move, and the
      // outer in-memory cache will not re-attempt this query for the rest
      // of the build invocation.
      const e = err as Error & { name?: string };
      if (e.name === 'AbortError') {
        throw new CtgovError(`ct.gov request timed out after ${timeoutMs}ms`, 'timeout');
      }
      lastErr = e;
      if (attempt < maxRetries) {
        await sleep(200 * 2 ** attempt);
        continue;
      }
      throw new CtgovError(`Network error: ${e.message}`, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable: the loop always either returns or throws.
  throw lastErr ?? new CtgovError('Unknown error after retries', 'network');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse the ct.gov v2 JSON envelope into CandidateTrial[]. The v2 shape:
//   {
//     studies: [
//       {
//         protocolSection: {
//           identificationModule: { nctId, briefTitle },
//           statusModule: { overallStatus, primaryCompletionDateStruct: { date } },
//           designModule: { phases, enrollmentInfo: { count } },
//           conditionsModule: { conditions },
//           armsInterventionsModule: { interventions: [{ name, type }] },
//           eligibilityModule: { eligibilityCriteria },
//           descriptionModule: { briefSummary },
//         },
//       },
//     ],
//     totalCount: N,
//     nextPageToken?: string,
//   }
//
// Forgiving: any missing optional field becomes null/empty; only NCT id,
// brief title, and overall_status are required. Status that doesn't match
// our enum is dropped (defense against ct.gov adding new statuses we
// haven't reviewed).
export function parseCtgovResponse(json: unknown): CandidateTrial[] {
  if (!isObject(json)) return [];
  const studies = (json as { studies?: unknown }).studies;
  if (!Array.isArray(studies)) return [];

  const out: CandidateTrial[] = [];
  for (const raw of studies) {
    const candidate = parseOneStudy(raw);
    if (candidate) out.push(candidate);
  }
  return out;
}

function parseOneStudy(raw: unknown): CandidateTrial | null {
  if (!isObject(raw)) return null;
  const proto = (raw as { protocolSection?: unknown }).protocolSection;
  if (!isObject(proto)) return null;
  const p = proto as Record<string, unknown>;

  const ident = isObject(p.identificationModule) ? (p.identificationModule as Record<string, unknown>) : {};
  const status = isObject(p.statusModule) ? (p.statusModule as Record<string, unknown>) : {};
  const design = isObject(p.designModule) ? (p.designModule as Record<string, unknown>) : {};
  const conds = isObject(p.conditionsModule) ? (p.conditionsModule as Record<string, unknown>) : {};
  const arms = isObject(p.armsInterventionsModule) ? (p.armsInterventionsModule as Record<string, unknown>) : {};
  const elig = isObject(p.eligibilityModule) ? (p.eligibilityModule as Record<string, unknown>) : {};
  const descr = isObject(p.descriptionModule) ? (p.descriptionModule as Record<string, unknown>) : {};

  const nct = typeof ident.nctId === 'string' ? ident.nctId.trim() : '';
  const brief_title = typeof ident.briefTitle === 'string' ? ident.briefTitle.trim() : '';
  const overall_status_raw = typeof status.overallStatus === 'string' ? status.overallStatus.trim() : '';
  if (!nct || !brief_title || !overall_status_raw) return null;
  // Validate the NCT shape before it becomes a candidates-map key, flows into the
  // rerank prompt ("copy the EXACT NCT id"), and renders as a live
  // clinicaltrials.gov/study/<id> link. A contract-drifted or garbage identifier
  // would otherwise publish a broken/garbage deep link. Mirrors the PMID guard.
  if (!/^NCT\d{8}$/.test(nct)) return null;
  if (!isAcceptedStatus(overall_status_raw)) return null;

  const phaseArr = Array.isArray(design.phases)
    ? (design.phases as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : null;
  const phase = phaseArr && phaseArr.length > 0 ? phaseArr : null;

  const enrollment = isObject(design.enrollmentInfo)
    ? (design.enrollmentInfo as Record<string, unknown>).count
    : null;
  const enrollment_count =
    typeof enrollment === 'number' && Number.isFinite(enrollment) && enrollment >= 0
      ? enrollment
      : null;

  const primaryStruct = isObject(status.primaryCompletionDateStruct)
    ? (status.primaryCompletionDateStruct as Record<string, unknown>)
    : null;
  const primaryDateRaw = primaryStruct && typeof primaryStruct.date === 'string' ? primaryStruct.date : null;
  const primary_completion_date = trimToYearMonth(primaryDateRaw);

  const brief_summary =
    typeof descr.briefSummary === 'string' ? truncate(descr.briefSummary.trim(), BRIEF_SUMMARY_CAP) : null;

  const conditions = Array.isArray(conds.conditions)
    ? (conds.conditions as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];

  const interventionsRaw = Array.isArray(arms.interventions) ? (arms.interventions as unknown[]) : [];
  const interventions: CandidateTrial['interventions'] = [];
  for (const iv of interventionsRaw) {
    if (!isObject(iv)) continue;
    const name = typeof (iv as Record<string, unknown>).name === 'string' ? ((iv as Record<string, unknown>).name as string).trim() : '';
    const type = typeof (iv as Record<string, unknown>).type === 'string' ? ((iv as Record<string, unknown>).type as string).trim() : '';
    if (name) interventions.push({ name, type: type || 'OTHER' });
  }

  const eligibilityRaw =
    typeof elig.eligibilityCriteria === 'string' ? elig.eligibilityCriteria.trim() : null;
  const eligibility_brief = eligibilityRaw ? truncate(eligibilityRaw, ELIGIBILITY_CAP) : null;

  return {
    nct,
    brief_title,
    overall_status: overall_status_raw,
    phase,
    enrollment_count,
    primary_completion_date,
    brief_summary,
    conditions,
    interventions,
    eligibility_brief,
  };
}

function isAcceptedStatus(raw: string): raw is RelatedTrialStatus {
  return (RELATED_TRIAL_STATUSES as readonly string[]).includes(raw);
}

// CT.gov primary completion date may be YYYY, YYYY-MM, or YYYY-MM-DD. We
// trim to YYYY-MM for display ("primary completion 2027-03"); year-only
// becomes "2027" (rendered as-is by the StudyCard layer).
function trimToYearMonth(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // YYYY, YYYY-MM, YYYY-MM-DD
  const m = trimmed.match(/^(\d{4})(?:-(\d{2}))?(?:-\d{2})?$/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1]!;
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  // Truncate at last whitespace before cap to avoid cutting mid-word.
  const slice = s.slice(0, cap);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > cap * 0.7 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
