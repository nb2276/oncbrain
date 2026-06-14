// v0.17 (T3): the review-discussed-trial RESOLVER.
//
// For each trial a review names by acronym, search PubMed, fetch candidate
// metadata, rank, and ask a rerank LLM "which candidate IS this trial, or
// NONE" — then write a `pending` (a confident suggestion) or `failed` (no
// confident match) row to the resolution manifest. The resolver NEVER
// publishes; the curator approves a manifest row before any paper enters a
// build (see docs/plans/review-trial-ingestion.md). So the rerank's calibration
// is an assist, not a clinical-safety sole-defense.
//
//   discussed_trials ──► per acronym ──► [FREEZE? skip]
//                                          │
//                        esearch title ──► broaden if empty ──► esummary
//                                          │
//                        heuristic rank ──► rerank LLM (pick PMID | NONE)
//                                          │
//                        upsertResolution(status pending | failed, candidates)
//
// Design choices forced by the codex outside-voice review:
//   #8  candidate metadata (esummary) is fetched BEFORE ranking, not after.
//   #9  the verbatim "acronym appears in the review text" check is DROPPED —
//       discussed_trials was already extracted from that text, so the check is
//       circular and proves nothing about a candidate paper.
//   #10 search the title AND a broader query (primaries often omit the acronym).
//   #11 result-count is NOT a gate (it measures popularity, not correctness).
//   #12 dedup is by PMID downstream (db), never by acronym here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  upsertResolution,
  getResolution,
  normalizeAcronym,
  type ResolutionCandidate,
} from './db.ts';
import type { PubMedSearchResult, PubMedSummary } from './pubmed-client.ts';
import type { LlmClient } from './llm-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RERANK_PROMPT = resolve(__dirname, '../../prompts/digest-v5-rerank-candidates.txt');

// Bump when the resolver's behavior changes meaningfully; reopenStaleResolutions
// (db) re-opens un-decided rows from an older version so they re-resolve.
export const RESOLVER_VERSION = 'v1';

export type ReviewToResolve = {
  reviewSourcePaperId: number; // the trade-press paper row id — the STABLE freeze key
  reviewName: string;
  diseaseSite: string; // disease-site slug (stored on the manifest row)
  bookmarkDate: string;
  discussedTrials: string[]; // verbatim acronyms the review named
  reviewContext: string; // tldr / source excerpt, given to the rerank LLM
};

export type RerankInput = {
  acronym: string;
  diseaseQuery: string;
  reviewContext: string;
  candidates: PubMedSummary[];
};
// pmid=null means NONE (no confident match). confidence is advisory (0..1).
export type RerankResult = { pmid: string | null; confidence: number };
export type RerankFn = (input: RerankInput) => Promise<RerankResult>;

export type ResolverDeps = {
  search: (term: string) => Promise<PubMedSearchResult>;
  summarize: (pmids: string[]) => Promise<PubMedSummary[]>;
  rerank: RerankFn;
  resolverVersion?: string;
  log?: (msg: string) => void;
};

// 'error' = a transient infra failure (NCBI/rerank threw); deliberately NOT
// written to the manifest, so the next run retries it (review fix #1). 'failed'
// = a definitive no-match (search succeeded with 0 hits, or rerank said NONE).
export type AcronymOutcome = 'frozen' | 'pending' | 'failed' | 'error';
export type ResolveSummary = {
  total: number;
  frozen: number;
  pending: number;
  failed: number;
  errored: number; // transient failures, left unwritten for retry
  outcomes: Array<{ acronym: string; outcome: AcronymOutcome }>;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

// A disease-site slug → a PubMed query term ("head-neck" → "head neck").
function diseaseQueryFromSlug(slug: string): string {
  return slug.replace(/-/g, ' ').trim();
}

// Heuristic pre-rank: acronym-in-title is a WEAK signal (codex #10/#11), so it
// only re-ORDERS candidates (acronym-in-title first), preserving the esearch
// relevance order within each group. It never gates — the rerank LLM judges.
export function rankCandidates(acronym: string, candidates: PubMedSummary[]): PubMedSummary[] {
  const re = new RegExp(`\\b${escapeRe(acronym.toUpperCase())}\\b`, 'i');
  const inTitle = (c: PubMedSummary) => re.test(c.title);
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(inTitle(b.c)) - Number(inTitle(a.c)) || a.i - b.i)
    .map((x) => x.c);
}

// Resolve every trial a review names into manifest rows. Idempotent per the
// freeze: an acronym already in the manifest (any status) is skipped. Returns a
// summary of outcomes. Never throws on a single acronym's failure — a search or
// rerank error becomes a `failed` row, and the acronym stays plain text until a
// curator (or a resolver-version bump) revisits it.
export async function resolveReviewTrials(
  db: Database.Database,
  review: ReviewToResolve,
  deps: ResolverDeps,
): Promise<ResolveSummary> {
  const version = deps.resolverVersion ?? RESOLVER_VERSION;
  const log = deps.log ?? (() => {});
  const diseaseQuery = diseaseQueryFromSlug(review.diseaseSite);
  const summary: ResolveSummary = {
    total: 0,
    frozen: 0,
    pending: 0,
    failed: 0,
    errored: 0,
    outcomes: [],
  };

  const seen = new Set<string>();
  for (const raw of review.discussedTrials) {
    const acronymNorm = normalizeAcronym(raw);
    if (!acronymNorm || seen.has(acronymNorm)) continue;
    seen.add(acronymNorm);
    summary.total += 1;

    // FREEZE: never re-resolve a pair already in the manifest.
    if (getResolution(db, review.reviewSourcePaperId, acronymNorm)) {
      summary.frozen += 1;
      summary.outcomes.push({ acronym: acronymNorm, outcome: 'frozen' });
      continue;
    }

    // Search title-scoped; broaden if the title query found nothing (codex #10).
    // A THROWN error here is transient (NCBI down/timeout); we must NOT write a
    // frozen `failed` row or the trial is permanently stranded (review fix #1) —
    // leave the pair unwritten so the next --date run retries it.
    let candidates: PubMedSummary[] = [];
    let transient = false;
    try {
      let res = await deps.search(`${raw}[Title] AND ${diseaseQuery}`);
      if (res.pmids.length === 0) res = await deps.search(`${raw} AND ${diseaseQuery}`);
      if (res.pmids.length > 0) candidates = await deps.summarize(res.pmids);
    } catch (err) {
      log(`  [resolve] ${acronymNorm}: search failed (transient, will retry) — ${(err as Error).message}`);
      transient = true;
    }
    if (transient) {
      summary.errored += 1;
      summary.outcomes.push({ acronym: acronymNorm, outcome: 'error' });
      continue;
    }

    let status: 'pending' | 'failed' = 'failed';
    let confidence = 0;
    let ordered = candidates;

    if (candidates.length > 0) {
      ordered = rankCandidates(raw, candidates);
      const verdict = await safeRerank(
        deps.rerank,
        { acronym: raw, diseaseQuery, reviewContext: review.reviewContext, candidates: ordered },
        log,
      );
      if (verdict.errored) {
        // A rerank LLM failure is transient too — leave it unwritten to retry
        // (review fix #1), rather than freezing a `failed` row.
        summary.errored += 1;
        summary.outcomes.push({ acronym: acronymNorm, outcome: 'error' });
        continue;
      }
      // The LLM MUST pick a PMID from the candidate set (defense vs an invented
      // PMID). A pick outside the list is treated as NONE.
      const validPick =
        verdict.pmid && ordered.some((c) => c.pmid === verdict.pmid) ? verdict.pmid : null;
      confidence = clamp01(verdict.confidence);
      if (validPick) {
        status = 'pending';
        // Put the rerank pick first so the curator + the manifest top-pick agree.
        ordered = [...ordered].sort(
          (a, b) => Number(b.pmid === validPick) - Number(a.pmid === validPick),
        );
      }
    }

    const cands: ResolutionCandidate[] = ordered.map((c, i) => ({
      pmid: c.pmid,
      title: c.title,
      journal: c.journal,
      year: c.year,
      score: ordered.length - i, // higher = ranked better
    }));
    upsertResolution(db, {
      review_source_paper_id: review.reviewSourcePaperId,
      acronym_norm: acronymNorm,
      acronym_display: raw.trim(),
      disease_site: review.diseaseSite,
      bookmark_date: review.bookmarkDate,
      status,
      candidates: cands,
      confidence,
      resolver_version: version,
    });

    if (status === 'pending') summary.pending += 1;
    else summary.failed += 1;
    summary.outcomes.push({ acronym: acronymNorm, outcome: status });
  }
  return summary;
}

async function safeRerank(
  rerank: RerankFn,
  input: RerankInput,
  log: (m: string) => void,
): Promise<RerankResult & { errored?: boolean }> {
  try {
    return await rerank(input);
  } catch (err) {
    // errored (transient) is distinct from a clean NONE so the caller can
    // leave the pair unwritten for retry instead of freezing a failed row.
    log(`  [resolve] rerank failed for ${input.acronym} (transient) — ${(err as Error).message}`);
    return { pmid: null, confidence: 0, errored: true };
  }
}

// Parse the rerank LLM's JSON. Defensive: strips fences, finds the JSON object,
// accepts a pmid ONLY when it is a numeric string present in the candidate set,
// clamps confidence. Anything malformed → NONE (the safe answer).
export function parseRerankResponse(raw: string, candidates: PubMedSummary[]): RerankResult {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { pmid: null, confidence: 0 };
  let obj: { pmid?: unknown; confidence?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return { pmid: null, confidence: 0 };
  }
  const pmid =
    typeof obj.pmid === 'string' &&
    /^\d+$/.test(obj.pmid) &&
    candidates.some((c) => c.pmid === obj.pmid)
      ? obj.pmid
      : null;
  const confidence = typeof obj.confidence === 'number' ? clamp01(obj.confidence) : 0;
  return { pmid, confidence };
}

// ────────────────────────────────────────────────────────────────────────────
// Digest → reviews orchestration (the `resolve:review-trials --date` entry).
// ────────────────────────────────────────────────────────────────────────────

// The minimal digest shape this reads — structural so the resolver lib stays
// decoupled from the heavy digest-data types.
export type DigestArtifactLike = {
  date: string;
  digest: {
    sites: Array<{
      disease_site: string;
      studies: Array<{
        name: string;
        slug?: string;
        tldr: string;
        content_type?: string;
        discussed_trials?: string[];
        source_ids?: Array<{ type: string; id: number }>;
      }>;
    }>;
  };
};

// Extract one ReviewToResolve per review study that has both discussed_trials AND
// a paper source (the stable freeze key). A review with no discussed_trials, or
// none whose source is a paper, is skipped (nothing to resolve / can't freeze).
export function reviewsFromDigest(artifact: DigestArtifactLike): ReviewToResolve[] {
  const out: ReviewToResolve[] = [];
  for (const site of artifact.digest.sites) {
    for (const study of site.studies) {
      if (study.content_type !== 'review') continue;
      const trials = (study.discussed_trials ?? []).filter(
        (t): t is string => typeof t === 'string' && t.trim().length > 0,
      );
      if (trials.length === 0) continue;
      // The stable freeze key is the review's underlying trade-press paper id.
      const paperId = study.source_ids?.find((s) => s.type === 'paper')?.id;
      if (paperId == null) continue;
      out.push({
        reviewSourcePaperId: paperId,
        reviewName: study.name,
        diseaseSite: site.disease_site,
        bookmarkDate: artifact.date,
        discussedTrials: trials,
        reviewContext: study.tldr,
      });
    }
  }
  return out;
}

// Resolve every review in a date's digest. Returns one ResolveSummary per review.
export async function resolveReviewsForDate(
  db: Database.Database,
  artifact: DigestArtifactLike,
  deps: ResolverDeps,
): Promise<ResolveSummary[]> {
  const reviews = reviewsFromDigest(artifact);
  const summaries: ResolveSummary[] = [];
  for (const review of reviews) {
    summaries.push(await resolveReviewTrials(db, review, deps));
  }
  return summaries;
}

// Build a RerankFn backed by a real LLM client + the rerank prompt. The prompt
// template can be injected (tests pass it inline to stay off the filesystem);
// production reads prompts/digest-v5-rerank-candidates.txt.
export function makeRerankFromLlm(
  client: LlmClient,
  opts: { promptTemplate?: string; promptPath?: string } = {},
): RerankFn {
  const template =
    opts.promptTemplate ?? readFileSync(opts.promptPath ?? DEFAULT_RERANK_PROMPT, 'utf-8');
  return async (input: RerankInput): Promise<RerankResult> => {
    const candidateLines = input.candidates
      .map((c) => `${c.pmid}, ${c.title}, ${c.journal ?? '?'} ${c.year ?? ''}`.trim())
      .join('\n');
    const prompt = template
      .replaceAll('{{ACRONYM}}', input.acronym)
      .replaceAll('{{DISEASE}}', input.diseaseQuery)
      .replaceAll('{{CONTEXT}}', input.reviewContext.slice(0, 1500))
      .replaceAll('{{CANDIDATES}}', candidateLines);
    const rawResp = await client.complete(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      { temperature: 0, maxTokens: 256 },
    );
    return parseRerankResponse(rawResp, input.candidates);
  };
}
