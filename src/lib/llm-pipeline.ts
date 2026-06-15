// LLM digest pipeline.
//
// v0.4 three-pass design (was single-call in v0.3):
//   Phase 1 — Grouping: one LLM call clusters all tweets into study groups.
//   Phase 2 — Per-study agents: N parallel LLM calls, one per cluster.
//   Phase 3 — Synthesis: one LLM call over SUCCESSFUL Phase 2 outputs.
//
// Hardenings from codex's amended-plan review:
//   - Schema-repair retry on parse error (was: only retry on network error)
//   - 6-image cap per Phase 2 agent (cost / token control)
//   - Caption validator: every numeric token in key_figure_caption must
//     appear verbatim in OCR text for that figure. Otherwise caption + URL
//     are dropped. Codex finding #1.
//   - Figure dropped entirely when OCR unavailable (Linux/no Vision binary).
//     Prevents env-skew where same input yields different captions. Codex #9.
//   - Cluster-collision warnings: if 2+ Phase 1 clusters share an NCT, log.
//     Codex #6.
//   - DigestOutput.meta: clusters_total, studies_analyzed, dropped list,
//     ocr_available. Surfaces incompleteness instead of silent omission.
//     Codex #3.
//
// External shape additions (DigestOutput.meta) are render-time disclosures;
// the existing sites[] structure is unchanged, so Astro pages and Obsidian
// export continue to work without conditional logic.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createLlmClient,
  type LlmClient,
  type LlmContentBlock,
  type LlmMessage,
} from './llm-client.ts';
import {
  fetchCandidateTrials,
  type FetchCandidateTrialsResult,
} from './clinicaltrials.ts';
import { diseaseSiteSlugList, isValidDiseaseSiteSlug } from './disease-sites.ts';
import {
  isValidModality,
  isValidIntent,
  isValidMethodology,
  type ModalityTag,
  type IntentTag,
  type MethodologyTag,
} from './tags.ts';
import {
  type ContentType,
  parseContentType,
  DEFAULT_CONTENT_TYPE,
} from './content-type.ts';
import { loadStudyContext, isSafeSlug } from './study-retrieval.ts';
import { isOcrAvailable, isSafeImageUrl } from './vision-ocr.ts';
import { buildAssociationGraph, renderGroupsForPrompt } from './source-association.ts';
import { isPreprintSource, clampPreprintVerdict } from './preprint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// v0.5 Phase D: pipeline accepts a union of source types. Tweets keep their
// existing shape (with source_type discriminator added for type narrowing);
// papers carry abstract + fulltext excerpt; slides carry OCR text + source
// label. Phase 1-3 prompts know about source_type and treat each item
// appropriately. Back-compat: callers that only pass tweets continue to work.
export type DigestInputTweet = {
  source_type?: 'tweet'; // default; optional for v0.4 callers
  id: number;
  author: string | null;
  text: string;
  note?: string | null;
  image_urls?: string[];
  // Apple Vision OCR text, aligned by index to image_urls.
  // Empty string = OCR not available / failed for that image.
  image_ocr_texts?: string[];
};

export type DigestInputPaper = {
  source_type: 'paper';
  id: number; // papers.id
  pmid: string | null; // v0.8: DOI-only papers have no PMID
  title: string;
  authors?: string[] | null;
  journal?: string | null;
  pub_date?: string | null;
  abstract?: string | null;
  fulltext_excerpt_md?: string | null;
  // v0.15: Vision OCR of the paper's figure pages — numbers printed inside
  // figures (KM medians, forest-plot estimates, image-rendered tables) the text
  // layer can't see. Fed to Phase 2 as labeled, lower-confidence source context.
  figure_ocr_md?: string | null;
  doi?: string | null;
  mesh_terms?: string[];
  note?: string | null;
};

export type DigestInputSlide = {
  source_type: 'slide';
  id: number; // slide_uploads.id
  file_path: string;
  source_label?: string | null;
  ocr_text?: string | null;
  note?: string | null;
  width?: number | null;
  height?: number | null;
};

export type DigestInputItem = DigestInputTweet | DigestInputPaper | DigestInputSlide;

// Reference to a source for rendering. The Astro layer (Phase E) resolves
// these back to bookmarks / papers / slide_uploads rows via the artifact.
export type DigestSourceRef =
  | { type: 'tweet'; id: number }
  | { type: 'paper'; id: number }
  | { type: 'slide'; id: number };

function isTweet(i: DigestInputItem): i is DigestInputTweet {
  return !i.source_type || i.source_type === 'tweet';
}
function isPaper(i: DigestInputItem): i is DigestInputPaper {
  return i.source_type === 'paper';
}
function isSlide(i: DigestInputItem): i is DigestInputSlide {
  return i.source_type === 'slide';
}

// Normalize any DigestInputItem to a "tweet-shaped" payload for the
// existing pipeline machinery (image_urls + image_ocr_texts arrays,
// text-only body). The pipeline doesn't care about deep type differences;
// the prompt is what reads source_type for editorial framing.
function itemToTweetShape(item: DigestInputItem): DigestInputTweet {
  if (isTweet(item)) return { ...item, source_type: 'tweet' };
  if (isPaper(item)) {
    const parts: string[] = [];
    parts.push(`[PAPER ${item.pmid ? `PMID:${item.pmid}` : item.doi ? `doi:${item.doi}` : '?'}]`);
    parts.push(`Title: ${item.title}`);
    if (item.authors && item.authors.length > 0) {
      parts.push(`Authors: ${item.authors.slice(0, 6).join('; ')}${item.authors.length > 6 ? ' et al.' : ''}`);
    }
    if (item.journal) parts.push(`Journal: ${item.journal}${item.pub_date ? ` (${item.pub_date})` : ''}`);
    if (item.abstract) parts.push(`\nAbstract:\n${item.abstract}`);
    if (item.fulltext_excerpt_md)
      parts.push(`\nMethods/Results excerpt:\n${item.fulltext_excerpt_md}`);
    if (item.figure_ocr_md)
      parts.push(
        // OCR of figure pages: recovers numbers printed inside figures (subgroup
        // medians, forest-plot 5-yr estimates, n-at-risk, image-rendered tables)
        // that the text layer omits. It is OCR — may carry character errors and
        // may duplicate body text. Treat as groundable source for a figure-locked
        // value, but prefer the body text when the two disagree.
        `\nFigure OCR (Apple Vision over figure/image pages; numbers printed inside figures, lower confidence than body text):\n${item.figure_ocr_md}`,
      );
    if (item.mesh_terms && item.mesh_terms.length > 0)
      parts.push(`\nMeSH: ${item.mesh_terms.slice(0, 8).join(', ')}`);
    return {
      source_type: 'tweet', // pipeline plumbing treats it as text
      id: paperIdToSyntheticTweetId(item.id),
      author: item.authors?.[0] ?? null,
      text: parts.join('\n'),
      note: item.note ?? null,
      image_urls: [],
      image_ocr_texts: [],
    };
  }
  // slide
  const slideParts: string[] = [];
  slideParts.push(`[SLIDE${item.source_label ? `: ${item.source_label}` : ''}]`);
  if (item.ocr_text) slideParts.push(`OCR text:\n${item.ocr_text}`);
  else slideParts.push('(no OCR text available)');
  return {
    source_type: 'tweet',
    id: slideIdToSyntheticTweetId(item.id),
    author: item.source_label ?? null,
    text: slideParts.join('\n'),
    note: item.note ?? null,
    image_urls: [],
    image_ocr_texts: [],
  };
}

// Synthetic id namespacing so paper/slide ids don't collide with tweet ids
// inside the pipeline's internal maps. Reverse-mapped at render time.
// Tweet ids stay as-is. Papers occupy 1e9-2e9. Slides occupy 2e9-3e9.
const PAPER_ID_OFFSET = 1_000_000_000;
const SLIDE_ID_OFFSET = 2_000_000_000;
export function paperIdToSyntheticTweetId(id: number): number {
  return PAPER_ID_OFFSET + id;
}
export function slideIdToSyntheticTweetId(id: number): number {
  return SLIDE_ID_OFFSET + id;
}
export function syntheticIdToSourceRef(id: number): DigestSourceRef {
  if (id >= SLIDE_ID_OFFSET) return { type: 'slide', id: id - SLIDE_ID_OFFSET };
  if (id >= PAPER_ID_OFFSET) return { type: 'paper', id: id - PAPER_ID_OFFSET };
  return { type: 'tweet', id };
}

// A detail bullet. v0.4.x form evolves:
//   - v0.4.0: flat string
//   - v0.4.1: + `subdetails: string[]` for 1D nested comparison rows
//   - v0.4.2: + `table: {columns, rows}` for 2D matrix comparisons
//     (multi-trial × multi-endpoint). Renderers handle all three forms.
export type DigestTable = {
  columns: string[]; // header labels; first column is row label by convention
  rows: string[][]; // each row matches columns.length cells
};
export type DigestDetail =
  | string
  | { text: string; subdetails: string[] }
  | { text: string; table: DigestTable };

// v0.10: one promoted figure. caption is numeric-only OCR text (string) or a
// comparison matrix (table), or null when the model abstains on a caption.
export type DigestFigure = {
  url: string;
  caption: string | DigestTable | null;
};

export type DigestStudy = {
  name: string;
  tldr: string;
  details: DigestDetail[];
  // v0.10: gallery of promoted figures (KM curve, forest plot, results/AE
  // table…), ordered by importance. Supersedes the single key_figure_* pair.
  // Empty/absent = the agent abstained on all figures.
  figures?: DigestFigure[];
  // v0.4 back-compat: older artifacts carry a single promoted figure here.
  // Renderers/exporters normalize via studyFigures(); new builds leave these
  // unset and populate `figures` instead.
  key_figure_url?: string | null;
  // v0.4.3: caption may be a flat string OR a table for comparison figures
  // (KM curves, forest plots, AE comparisons). Table form is preferred when
  // the figure has 2+ rows × 2+ columns of comparable data.
  key_figure_caption?: string | DigestTable | null;
  nct: string | null;
  // Back-compat: synthetic ids the pipeline uses internally. Renderers MAY
  // use this directly (v0.4 path), or prefer source_ids for typed refs.
  tweet_ids: number[];
  // v0.5+: typed references to source items. Resolves to bookmarks (tweet),
  // papers (paper), or slide_uploads (slide). Older v0.4 artifacts won't
  // have this — consumers should fall back to tweet_ids.
  source_ids?: DigestSourceRef[];
  // v0.6+: stable per-study slug from Phase 1 clustering. Used by the search
  // index and as the anchor id on the [date] page. Older artifacts won't
  // have this — consumers should fall back to deriveSlug(name).
  slug?: string;
  // v0.7+ analyst verdict: 5-second SOC-implication triage signal at top
  // of each rendered study card. See VOICE.md "SOC-implication verdict"
  // section for taxonomy and assignment rules. Older artifacts won't have
  // this; renderers should fall back to the bullet-only layout.
  verdict?: StudyVerdict;
  // v0.14.5 (E5): set true when any source is a preprint (medRxiv / bioRxiv /
  // Research Square, by DOI prefix or host). Drives the "not peer-reviewed"
  // badge and a deterministic verdict cap at build (see lib/preprint.ts). Older
  // artifacts won't have it; absent === not a preprint.
  is_preprint?: boolean;
  // v0.8.1: unresolved questions this study raises, rendered as a separated
  // block under the study card. Phase 2 (study agent) owns these now; older
  // artifacts carry them at the site level (DigestSite.open_questions), which
  // renderers fall back to.
  open_questions?: string[] | null;
  // v0.9: optional CONSORT flow for randomized trials — only when per-arm
  // patient counts are reported in the source. Rendered as a dropdown diagram.
  // Null/absent for single-arm, retrospective, or meta-analytic studies.
  consort?: ConsortDiagram | null;
  // v0.10: cross-cutting tag fields. Phase 2 emits one value per namespace
  // from the enums in src/lib/tags.ts (or null when uncertain). Drives
  // /tags/<slug>/ landing pages via the build-time derive in tag-index.ts.
  //
  // Types imported from tags.ts so the enum definitions live in one place.
  // (digest-data.ts:DigestStudy uses the SAME imported types — the field
  // shape is now identical across both parallel definitions. Adversarial
  // review surfaced the drift hazard of an inline-union triplicate.)
  modality?: ModalityTag | null;
  intent?: IntentTag | null;
  methodology?: MethodologyTag | null;
  // v0.16: study_report (default) vs review. Inherited from the Phase 1
  // cluster, not emitted by Phase 2. A `review` carries no verdict (forced
  // null at build, after overrides) and renders `discussed_trials` instead of
  // a numbers-first card. Older artifacts won't have this; renderers fall back
  // to the study-report layout (absent === study_report).
  content_type?: ContentType;
  // v0.16: trial acronyms a `review` discusses, lifted VERBATIM from the source
  // text (e.g. ["STOMP", "ORIOLE", "RADIOSA"]). Plain text, NOT linked — the
  // conservative no-inference rule forbids guessing an NCT for a bare acronym.
  // Capped + noise-filtered at parse. Empty/absent for study reports.
  //
  // Both v0.16 fields are mirrored in src/lib/digest-data.ts:DigestStudy — the
  // build emits the artifact JSON and the Astro pages re-read it through that
  // definition, so the two MUST keep these shapes in lockstep.
  discussed_trials?: string[];
  // v0.17 (T6): on a `review`, maps a discussed-trial acronym (normalized,
  // upper-case) → the slug of the same-date study auto-resolved from it, so the
  // "Trials discussed" list can link to the resolved card. Computed at build
  // time from the resolution manifest; absent when nothing resolved. Mirrored in
  // digest-data.ts — keep in lockstep.
  discussed_trial_links?: Record<string, string>;
  // v0.13: trials watching each open question. Phase 2 emits per-question
  // search queries internally (consumed by the orchestrator, not retained
  // on this object); the build-time orchestrator hits clinicaltrials.gov
  // per query and reranks to pair each pick with the question it answers.
  // Null when Phase 2 abstained, every query failed, or the rerank produced
  // 0 valid picks. Older artifacts won't have this; renderers fall back to
  // no nested trials. See plan v0.13 D10.
  //
  // Mirrored in src/lib/digest-data.ts: the build emits the artifact JSON
  // and the Astro pages re-read it through the digest-data definitions, so
  // both files MUST keep these shapes in lockstep.
  related_trials?: RelatedTrial[] | null;
  related_trials_provenance?: RelatedTrialsProvenance | null;
};

// v0.13: CT.gov status subset we surface. See plan D8.
export type RelatedTrialStatus =
  | 'RECRUITING'
  | 'NOT_YET_RECRUITING'
  | 'ACTIVE_NOT_RECRUITING'
  | 'ENROLLING_BY_INVITATION';

export const RELATED_TRIAL_STATUSES: readonly RelatedTrialStatus[] = [
  'RECRUITING',
  'NOT_YET_RECRUITING',
  'ACTIVE_NOT_RECRUITING',
  'ENROLLING_BY_INVITATION',
] as const;

// v0.13: Pre-rerank candidate. Returned by the CT.gov client; cached
// in-run; fed to the rerank LLM. NOT persisted in the artifact.
//
// The richer codex-round-2 #3 fields (brief_summary, conditions,
// interventions, eligibility_brief) are required so the rerank LLM has
// real content to judge fit, not just titles.
export type CandidateTrial = {
  nct: string;
  brief_title: string;
  overall_status: RelatedTrialStatus;
  phase: string[] | null;
  enrollment_count: number | null;
  primary_completion_date: string | null; // YYYY-MM
  brief_summary: string | null;
  conditions: string[];
  interventions: Array<{ name: string; type: string }>;
  eligibility_brief: string | null;
};

// v0.13: Post-rerank. Paired to a specific open question via byte-identical
// match against study.open_questions[i]. INVARIANTS (enforced in
// parseRelatedTrials):
//   1. nct ∈ aggregated candidate set
//   2. answers_question ∈ study.open_questions (byte-identical)
export type RelatedTrial = CandidateTrial & {
  answers_question: string;
  relevance_phrase: string; // ≤ 60 chars
};

// v0.13: Auditable provenance (codex round-2 #36).
export type RelatedTrialsProvenance = {
  queries_fired: string[];
  queries_failed: Array<{ term: string; reason: string }>;
  candidates_returned: number;
  fetched_at: string; // ISO 8601
  rerank_outcome: 'picked_N' | 'abstained' | 'failed' | 'skipped' | 'fallback' | 'pinned_by_curator';
};

// One trial arm in the CONSORT flow.
export type ConsortArm = {
  label: string; // arm name, e.g. "PPN-SBRT"
  allocated: number; // randomized/allocated to this arm
  analyzed?: number | null; // analyzed for the primary outcome, if reported
};

// CONSORT participant flow. Every number must come from the source — the study
// agent emits this only when per-arm counts are explicitly reported.
export type ConsortDiagram = {
  enrolled?: number | null; // assessed/enrolled before randomization, if reported
  excluded?: number | null; // excluded before randomization, if reported
  randomized: number; // total randomized
  arms: ConsortArm[]; // >= 2 arms
};

export type SocImplication =
  | 'practice-changing'
  | 'challenges-soc'
  | 'confirmatory'
  | 'early-signal'
  | 'methodologically-limited'
  | 'unclear';

export const SOC_IMPLICATIONS: readonly SocImplication[] = [
  'practice-changing',
  'challenges-soc',
  'confirmatory',
  'early-signal',
  'methodologically-limited',
  'unclear',
] as const;

export type StudyVerdict = {
  soc_implication: SocImplication;
  rationale: string; // ≤ 30 words, explains the verdict choice (not the trial)
  audience: string | null; // ≤ 80 chars eligibility gate, or null when too broad
};

// Type guards used by parser, validator, and renderers.
export function isStringDetail(d: DigestDetail): d is string {
  return typeof d === 'string';
}
export function isSubdetailDetail(
  d: DigestDetail,
): d is { text: string; subdetails: string[] } {
  return typeof d === 'object' && Array.isArray((d as { subdetails?: unknown }).subdetails);
}
export function isTableDetail(
  d: DigestDetail,
): d is { text: string; table: DigestTable } {
  return typeof d === 'object' && (d as { table?: unknown }).table !== undefined;
}

// Returns every text fragment inside a detail (header, subdetails, table
// cells). Used by the OCR validator to walk numeric tokens across all
// forms uniformly.
export function detailAllText(d: DigestDetail): string[] {
  if (isStringDetail(d)) return [d];
  if (isTableDetail(d)) {
    return [d.text, ...d.table.columns, ...d.table.rows.flat()];
  }
  return [d.text, ...d.subdetails];
}

export type DigestSite = {
  disease_site: string;
  intro: string | null;
  studies: DigestStudy[];
  open_questions: string[] | null;
};

// Build disclosure metadata. Surfaces incompleteness/missing data so the
// rendered page can show "X/Y studies analyzed" rather than silently omit.
export type DigestMeta = {
  clusters_total: number; // count from Phase 1
  studies_analyzed: number; // successful Phase 2 outputs (== sites.flatMap(s=>s.studies).length)
  dropped: Array<{ slug: string; name: string; reason: string }>;
  ocr_available: boolean; // false → no key figures, no captions, env-portable build
};

export type DigestOutput = {
  top_line: string;
  tldr: string;
  sites: DigestSite[];
  meta: DigestMeta;
};

export type BuildOptions = {
  conferenceName: string;
  conferenceDay: number | string;
  promptPaths?: {
    grouping?: string;
    studyAgent?: string;
    synthesis?: string;
  };
  model?: string;
  // Per-phase model overrides, each falling back to `model` when unset, so the
  // three phases are independently selectable (e.g. a cheaper model for grouping
  // + synthesis, Opus for the deep per-study analysis). Wired from DIGEST_MODEL /
  // DIGEST_GROUPING_MODEL / DIGEST_STUDY_MODEL / DIGEST_SYNTHESIS_MODEL.
  groupingModel?: string; // Phase 1 (clustering)
  // Phase 2 (per-study agents) — the deep analysis step. Lets you run Opus there
  // (e.g. 'opus' on claude-cli, 'claude-opus-4-7' on api) while the other phases
  // stay cheaper. Falls back to `model` when unset.
  studyModel?: string;
  synthesisModel?: string; // Phase 3 (lede + cross-site TL;DR + open questions)
  // Optional extended-thinking budget (tokens) for Phase 2 only — deeper
  // reasoning before the study agent answers. api backend only (ignored on
  // claude-cli). 0/undefined = off.
  studyThinkingBudget?: number;
  // Specialty-perspective profile name (e.g. 'radonc', 'medonc'). Resolved to
  // prompts/perspectives/<name>.md and injected into the Phase 2 study-agent
  // prompt's {{PERSPECTIVE}} slot, so the per-study analysis is framed for one
  // subspecialty's decision needs (a radiation oncologist foregrounds RT impact,
  // a med-onc foregrounds regimen). Unset / unknown = no bias (current default).
  // Wired from DIGEST_PERSPECTIVE. Phase 2 only; Phases 1 + 3 stay neutral.
  perspectiveName?: string;
  client?: LlmClient;
  maxRetries?: number;
  studyAgentConcurrency?: number;
  maxImagesPerStudy?: number; // cap to control Phase 2 token cost; default 6

  // v0.13: related-trials orchestrator wiring. Optional; nothing about it
  // is required for a basic build. When provided:
  //   - relatedTrialsRunCache: in-memory cache for ct.gov fetches. When
  //     omitted, buildDigest allocates a fresh cache scoped to this
  //     invocation. runBackfill passes the same cache across dates so
  //     overlapping drug+condition queries dedup across the run.
  //   - relatedTrialsDeps: injectable seams for tests (ctgovFetch, clock,
  //     sleep, rerankClient, promptPath). In production this is undefined
  //     and the orchestrator uses real implementations.
  //
  // The orchestrator NEVER throws, so omitting either of these does not
  // affect Phase 2 success accounting.
  relatedTrialsRunCache?: RelatedTrialsRunCache;
  relatedTrialsDeps?: EnrichRelatedTrialsDeps;
};

const PROMPTS_DIR = resolve(__dirname, '../../prompts');
const DEFAULT_PROMPTS = {
  grouping: resolve(PROMPTS_DIR, 'digest-v5-grouping.txt'),
  studyAgent: resolve(PROMPTS_DIR, 'digest-v5-study-agent.txt'),
  synthesis: resolve(PROMPTS_DIR, 'digest-v5-synthesis.txt'),
};

// VOICE.md is the canonical voice + framing doc, substituted into every phase
// prompt's {{VOICE}} block at build time. Both Claude Code (when writing UI
// copy) and the analyst LLM (here) read the same file — edit one place, both
// follow. Lazy-loaded + cached so each digest build reads from disk once.
const VOICE_PATH = resolve(__dirname, '../../VOICE.md');
let _voiceCached: string | null = null;
export function loadVoice(): string {
  if (_voiceCached !== null) return _voiceCached;
  _voiceCached = readFileSync(VOICE_PATH, 'utf-8').trim();
  return _voiceCached;
}

// VOICE is sent on every phase + study-agent call, byte-identical each time. We
// send it once as a leading, cache-flagged content block (api prompt caching:
// ~10% billing on cache hits) and leave a pointer where {{VOICE}} sat in the
// template. On a busy day that's one VOICE block reused across ~20 calls instead
// of re-billed each time. The claude-cli backend just sees it as text at the top.
const VOICE_POINTER = '(Follow the VOICE & FRAMING RULES provided at the top of this message.)';
function voiceCacheBlock(): LlmContentBlock {
  return {
    type: 'text',
    text: `═══ VOICE & FRAMING RULES (follow exactly) ═══\n\n${loadVoice()}`,
    cache: true,
  };
}

// Specialty-perspective lens (v0.15): an optional subspecialty bias applied to
// Phase 2 (per-study) analysis only. The profile name (e.g. 'radonc') resolves
// to prompts/perspectives/<name>.md and is substituted into the study-agent
// prompt's {{PERSPECTIVE}} slot, wrapped in its own labelled section. Lets a
// radiation oncologist foreground RT impact, a med-onc foreground regimen, etc.,
// from the same pipeline. Selected by DIGEST_PERSPECTIVE; see prompts/perspectives/.
//
// Unset / blank / unknown / unsafe name returns '' so the {{PERSPECTIVE}} slot
// collapses and an unconfigured build is byte-identical to pre-perspective
// behavior. The name is constrained to one safe path segment (no traversal),
// and a missing file degrades to '' with a warning rather than throwing.
const PERSPECTIVES_DIR = resolve(PROMPTS_DIR, 'perspectives');
const _perspectiveCache = new Map<string, string>();
export function loadPerspective(name: string | undefined | null): string {
  const slug = (name ?? '').trim().toLowerCase();
  if (!slug) return '';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    console.warn(
      `  [perspective] ignoring invalid DIGEST_PERSPECTIVE="${name}" (allowed: letters, digits, '-', '_')`,
    );
    return '';
  }
  const cached = _perspectiveCache.get(slug);
  if (cached !== undefined) return cached;
  let block = '';
  try {
    const body = readFileSync(resolve(PERSPECTIVES_DIR, `${slug}.md`), 'utf-8').trim();
    if (body) block = `═══ SPECIALTY PERSPECTIVE (apply throughout this analysis) ═══\n\n${body}\n\n`;
  } catch {
    console.warn(
      `  [perspective] DIGEST_PERSPECTIVE="${slug}" not found at prompts/perspectives/${slug}.md — building with no specialty bias`,
    );
  }
  _perspectiveCache.set(slug, block);
  return block;
}

type StudyCluster = {
  slug: string;
  name: string;
  disease_site: string;
  tweet_ids: number[];
  // v0.16: Phase 1 classifies each cluster as a single-study report or a
  // multi-trial / topic review. Set at grouping time so a review is recognized
  // as its own standalone cluster before Phase 2. The study inherits this.
  content_type: ContentType;
};

type SiteMeta = {
  disease_site: string;
  intro: string | null;
  open_questions: string[] | null;
};

export async function buildDigest(
  items: DigestInputItem[],
  opts: BuildOptions,
): Promise<DigestOutput> {
  const ocrAvailable = isOcrAvailable();

  // v0.5 Phase D: accept the typed union. Internal pipeline still operates
  // on tweet-shaped items (text + image arrays); papers and slides are
  // converted to tweet-shape with synthetic ids that round-trip to typed
  // source refs on output.
  const tweets: DigestInputTweet[] = items.map(itemToTweetShape);
  // v0.14.5 (E5): map each synthetic id back to its ORIGINAL typed item so a
  // cluster's preprint sources can be detected at the verdict-clamp point
  // (the tweet-shape conversion drops doi/journal). tweets[i] <-> items[i].
  const itemById = new Map<number, DigestInputItem>();
  tweets.forEach((t, i) => {
    const original = items[i];
    if (original) itemById.set(t.id, original);
  });
  // Association hints from NCT + acronym matching across original items.
  // Passed to Phase 1 as a soft prompt addendum.
  const associationGroups = buildAssociationGraph(items);

  if (tweets.length === 0) {
    return {
      top_line: 'No bookmarks for this day.',
      tldr: 'No bookmarks for this day.',
      sites: [],
      meta: {
        clusters_total: 0,
        studies_analyzed: 0,
        dropped: [],
        ocr_available: ocrAvailable,
      },
    };
  }

  const client = opts.client ?? createLlmClient();
  const maxRetries = opts.maxRetries ?? 1;

  // Phase 1
  const clusters = await runGroupingPhase(client, tweets, opts, maxRetries, associationGroups);
  if (clusters.length === 0) {
    throw new DigestParseError('Phase 1 produced no clusters. Cannot continue.');
  }
  detectClusterCollisions(clusters, tweets);

  // Phase 2: agents in parallel, bounded concurrency. Track drops.
  const concurrency = opts.studyAgentConcurrency ?? 4;
  const maxImagesPerStudy = opts.maxImagesPerStudy ?? 6;
  const tweetById = new Map(tweets.map((t) => [t.id, t]));
  const successful: { cluster: StudyCluster; study: DigestStudy }[] = [];
  const dropped: DigestMeta['dropped'] = [];

  // v0.13: shared in-run cache for ct.gov fetches across all studies in this
  // build. runBackfill may pass one in via opts so the same cache is reused
  // across dates (cross-date dedup on overlapping drug+condition queries).
  const relatedRunCache = opts.relatedTrialsRunCache ?? createRelatedTrialsRunCache();

  // v0.13: track studies eligible for related-trials (had a non-null
  // related_search) and how many got populated; emitted as a minimum-
  // success warn banner at end of build. Codex round-2 #15.
  let relatedEligible = 0;
  let relatedPopulated = 0;

  await runConcurrent(clusters, concurrency, async (cluster) => {
    const allClusterTweets = cluster.tweet_ids
      .map((id) => tweetById.get(id))
      .filter((t): t is DigestInputTweet => Boolean(t));
    if (allClusterTweets.length === 0) {
      dropped.push({ slug: cluster.slug, name: cluster.name, reason: 'no matching tweets' });
      console.warn(`  [phase2] dropped ${cluster.slug}: no matching tweets`);
      return;
    }
    const capped = capStudyImages(allClusterTweets, maxImagesPerStudy);
    try {
      const { study, raw } = await runStudyAgent(client, cluster, capped, opts, maxRetries, ocrAvailable);
      // v0.13: re-parse the raw Phase 2 response so the orchestrator can
      // read auxiliary fields (related_search) that parseStudyAgentResponse
      // intentionally strips from DigestStudy. JSON.parse here only fails
      // if the response shape is unrepresentable; runStudyAgent already
      // successfully parsed once, so this is defensive.
      let rawParsed: unknown = null;
      try {
        rawParsed = JSON.parse(stripFences(raw));
      } catch {
        // Orchestrator handles null by logging no_related_search and
        // returning a skipped provenance.
      }
      // v0.13: enrich the study with related trials. Orchestrator never
      // throws; even total failure just leaves related_trials null and
      // logs a differentiated tag. Study itself is unaffected on failure.
      //
      // Default the rerank client to the same Phase 2 client unless the
      // caller (tests) overrides it. Without this, production builds
      // silently take the deterministic-fallback path on every study
      // (caught by both PR-2 outside-voice reviews as the primary P1).
      const baseDeps = opts.relatedTrialsDeps ?? {};
      const resolvedDeps: EnrichRelatedTrialsDeps = {
        ...baseDeps,
        rerankClient: baseDeps.rerankClient ?? client,
      };
      const enriched = await enrichStudyWithRelatedTrials(
        study,
        rawParsed,
        relatedRunCache,
        resolvedDeps,
      );
      if (enriched.related_trials_provenance.rerank_outcome !== 'skipped') {
        relatedEligible += 1;
        if (enriched.related_trials && enriched.related_trials.length > 0) {
          relatedPopulated += 1;
        }
      }
      // v0.14.5 (E5): if any PAPER source in this cluster is a preprint, flag
      // the study and deterministically cap an over-confident verdict (the clamp
      // also rewrites the rationale so it can't argue past the capped verdict).
      // Scope: paper sources only — medRxiv/bioRxiv/Research Square links enter
      // as papers (paper-url.ts), carrying the 10.1101/10.21203 DOI. A tweet
      // merely *mentioning* a preprint (no paper link) is NOT caught here; the
      // VOICE.md preprint rule is the LLM-side guard for that case.
      const isPreprint = cluster.tweet_ids.some((id) => {
        const it = itemById.get(id);
        return it?.source_type === 'paper' && isPreprintSource({ doi: it.doi, journal: it.journal });
      });
      successful.push({
        cluster,
        study: {
          ...study,
          verdict: isPreprint ? (clampPreprintVerdict(study.verdict) ?? undefined) : study.verdict,
          is_preprint: isPreprint || undefined,
          related_trials: enriched.related_trials,
          related_trials_provenance: enriched.related_trials_provenance,
        },
      });
    } catch (err) {
      const reason = (err as Error).message;
      dropped.push({ slug: cluster.slug, name: cluster.name, reason });
      console.warn(`  [phase2] dropped ${cluster.slug} (${cluster.name}): ${reason}`);
    }
  });

  // v0.13: end-of-Phase-2 minimum-success gate. Cron stays green; total
  // retrieval-wide outages become loud. Codex round-2 #15.
  if (relatedEligible > 0) {
    const pct = Math.round((relatedPopulated / relatedEligible) * 100);
    const skipped = clusters.length - relatedEligible - dropped.length;
    console.warn(
      `[v0.13] related_trials populated: ${relatedPopulated} of ${relatedEligible} eligible (${pct}%) · skipped: ${skipped} (no_related_search)`,
    );
    if (pct < 50) {
      console.warn(
        `[v0.13] WARN: related_trials populated rate ${pct}% is below 50%. ` +
          `Possible CT.gov outage or rerank degradation. Build continues.`,
      );
    }
  }

  if (successful.length === 0) {
    throw new DigestParseError('All Phase 2 study agents failed. Cannot continue to synthesis.');
  }

  // Phase 3
  const synthesis = await runSynthesisPhase(client, successful, opts, maxRetries);

  // Assemble final shape.
  const sitesMap = new Map<string, DigestSite>();
  for (const { cluster, study } of successful) {
    const site = sitesMap.get(cluster.disease_site) ?? {
      disease_site: cluster.disease_site,
      intro: null,
      studies: [],
      open_questions: null,
    };
    site.studies.push(study);
    sitesMap.set(cluster.disease_site, site);
  }
  for (const meta of synthesis.site_meta) {
    const site = sitesMap.get(meta.disease_site);
    if (site) {
      site.intro = meta.intro;
      site.open_questions = meta.open_questions;
    }
  }

  // v0.5 Phase D: attach typed source_ids to each study by reverse-mapping
  // synthetic tweet_ids back to {type, id} refs. Older v0.4 artifacts still
  // get rendered via tweet_ids fallback; new ones prefer source_ids.
  const attachSourceIds = (study: DigestStudy): DigestStudy => ({
    ...study,
    source_ids: study.tweet_ids.map((id) => syntheticIdToSourceRef(id)),
  });
  const sitesWithSourceIds = Array.from(sitesMap.values()).map((site) => ({
    ...site,
    studies: site.studies.map(attachSourceIds),
  }));

  return {
    top_line: synthesis.top_line,
    tldr: synthesis.tldr,
    sites: sitesWithSourceIds,
    meta: {
      clusters_total: clusters.length,
      studies_analyzed: successful.length,
      dropped,
      ocr_available: ocrAvailable,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 1 — grouping
// ────────────────────────────────────────────────────────────────────────────

async function runGroupingPhase(
  client: LlmClient,
  tweets: DigestInputTweet[],
  opts: BuildOptions,
  maxRetries: number,
  associationGroups: ReturnType<typeof buildAssociationGraph> = [],
): Promise<StudyCluster[]> {
  const promptPath = opts.promptPaths?.grouping ?? DEFAULT_PROMPTS.grouping;
  const template = readFileSync(promptPath, 'utf-8');

  const manifest = buildImageManifest(tweets);
  const tweetsForPrompt = tweets.map((t) => ({
    id: t.id,
    author: t.author,
    text: t.text,
    note: t.note ?? null,
  }));

  const associationHints = renderGroupsForPrompt(associationGroups);

  const prompt = template
    .replace('{{VOICE}}', VOICE_POINTER)
    .replace('{{CONFERENCE_NAME}}', opts.conferenceName)
    .replace('{{CONFERENCE_DAY}}', `Day ${opts.conferenceDay}`)
    .replace('{{SITE_SLUGS}}', diseaseSiteSlugList())
    .replace('{{IMAGE_MANIFEST}}', manifest.text)
    .replace('{{ASSOCIATION_HINTS}}', associationHints)
    .replace('{{TWEETS_JSON}}', JSON.stringify(tweetsForPrompt, null, 2));

  const content: LlmContentBlock[] = [voiceCacheBlock()];
  for (const url of manifest.urls) content.push({ type: 'image', url });
  content.push({ type: 'text', text: prompt });

  const { value } = await completeAndParse(
    client,
    content,
    { model: opts.groupingModel ?? opts.model, maxTokens: 4096, temperature: 0 },
    (raw) => parseGroupingResponse(raw, tweets),
    maxRetries,
    'grouping',
  );
  return value;
}

export function parseGroupingResponse(raw: string, tweets: DigestInputTweet[]): StudyCluster[] {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new DigestParseError(`Phase 1 not valid JSON: ${(err as Error).message}`, raw);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DigestParseError('Phase 1 root is not an object', raw);
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.studies)) {
    throw new DigestParseError('Phase 1 missing studies array', raw);
  }

  const validTweetIds = new Set(tweets.map((t) => t.id));
  const seenSlugs = new Set<string>();
  const out: StudyCluster[] = [];

  for (const s of root.studies) {
    if (!s || typeof s !== 'object') continue;
    const c = s as Record<string, unknown>;
    const slugRaw = typeof c.slug === 'string' ? c.slug.trim().toLowerCase() : '';
    if (!isSafeSlug(slugRaw) || seenSlugs.has(slugRaw)) continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const siteRaw = typeof c.disease_site === 'string' ? c.disease_site.trim() : '';
    const disease_site = isValidDiseaseSiteSlug(siteRaw) ? siteRaw : 'other';
    const tweet_ids = Array.isArray(c.tweet_ids)
      ? c.tweet_ids.filter(
          (id): id is number =>
            typeof id === 'number' && Number.isFinite(id) && validTweetIds.has(id),
        )
      : [];
    if (tweet_ids.length === 0) continue;
    // v0.16: study_report (default) vs review. parseContentType falls back to
    // the default for a missing/invalid value — back-compat for the corpus
    // of clusters emitted before this field existed.
    const content_type = parseContentType(c.content_type);
    seenSlugs.add(slugRaw);
    out.push({ slug: slugRaw, name, disease_site, tweet_ids, content_type });
  }

  // Partition enforcement: every input tweet must appear in exactly one
  // cluster. Codex P1 + Claude #20: the grouping prompt says this is
  // required but the parser previously didn't enforce. Silent omission
  // means clinically important source tweets vanish from the digest with
  // no disclosure. Duplicates mean the same tweet gets analyzed in two
  // studies, inflating the day's apparent breadth.
  const assignmentCounts = new Map<number, number>();
  for (const c of out) {
    for (const id of c.tweet_ids) {
      assignmentCounts.set(id, (assignmentCounts.get(id) ?? 0) + 1);
    }
  }
  const missing: number[] = [];
  const duplicated: number[] = [];
  for (const id of validTweetIds) {
    const count = assignmentCounts.get(id) ?? 0;
    if (count === 0) missing.push(id);
    else if (count > 1) duplicated.push(id);
  }
  if (missing.length > 0 || duplicated.length > 0) {
    // Throw a parse error so the schema-repair retry asks the model to
    // emit a valid partition. If retry also fails, the orchestrator
    // catches it and the build emits a clear failure.
    throw new DigestParseError(
      `Phase 1 partition violation: ${missing.length} unassigned tweet(s) (${missing.slice(0, 5).join(',')}${missing.length > 5 ? '…' : ''}), ${duplicated.length} duplicated tweet(s) (${duplicated.slice(0, 5).join(',')}${duplicated.length > 5 ? '…' : ''}). Every tweet must appear in exactly one cluster.`,
      raw,
    );
  }

  return out;
}

// Codex amended-plan #6: warn when 2+ clusters share an NCT — likely
// over-cluster or wrongful split. Doesn't auto-merge; just surfaces.
export function detectClusterCollisions(
  clusters: StudyCluster[],
  tweets: DigestInputTweet[],
): void {
  const tweetById = new Map(tweets.map((t) => [t.id, t]));
  const nctMap = new Map<string, string[]>(); // nct → slugs
  for (const c of clusters) {
    // v0.16: a `review` cluster is a multi-trial round-up that DELIBERATELY
    // names (and may share NCTs with) the single-trial clusters it sits beside
    // — the grouping prompt forces it to stay standalone even when it names a
    // trial. That overlap is the designed state, not a split/over-cluster, so
    // excluding reviews here prevents false-positive warnings that would mask
    // genuine ones.
    if (c.content_type === 'review') continue;
    const text =
      c.name +
      ' ' +
      c.tweet_ids
        .map((id) => tweetById.get(id))
        .filter((t): t is DigestInputTweet => !!t)
        .map((t) => t.text)
        .join(' ');
    const matches = text.match(/NCT\d{8}/g) ?? [];
    for (const m of new Set(matches)) {
      const existing = nctMap.get(m) ?? [];
      if (!existing.includes(c.slug)) existing.push(c.slug);
      nctMap.set(m, existing);
    }
  }
  for (const [nct, slugs] of nctMap) {
    if (slugs.length > 1) {
      console.warn(
        `  [phase1] WARNING: NCT ${nct} appears in ${slugs.length} clusters (${slugs.join(', ')}) — possible split / over-cluster`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 — per-study agent
// ────────────────────────────────────────────────────────────────────────────

// v0.13 refactor: returns BOTH the validated DigestStudy AND the raw Phase 2
// JSON response string. The raw is consumed by enrichStudyWithRelatedTrials
// to read the internal `related_search` field that parseStudyAgentResponse
// deliberately omits from DigestStudy. Codex round-2 #18.
async function runStudyAgent(
  client: LlmClient,
  cluster: StudyCluster,
  tweets: DigestInputTweet[],
  opts: BuildOptions,
  maxRetries: number,
  ocrAvailable: boolean,
): Promise<{ study: DigestStudy; raw: string }> {
  const promptPath = opts.promptPaths?.studyAgent ?? DEFAULT_PROMPTS.studyAgent;
  const template = readFileSync(promptPath, 'utf-8');

  const manifest = buildImageManifest(tweets);
  const tweetsForPrompt = tweets.map((t) => ({
    id: t.id,
    author: t.author,
    text: t.text,
    note: t.note ?? null,
    images: (t.image_urls ?? []).map((url, idx) => ({
      url,
      ocr_text: (t.image_ocr_texts ?? [])[idx] ?? '',
    })),
  }));

  const priorContext = loadStudyContext(cluster.slug);
  const priorContextBlock = priorContext
    ? `═══ PRIOR CONTEXT (read-only curator notes for ${cluster.slug}) ═══\n\n${priorContext}\n\nUse these as anchor context only. The current tweets are still the primary source of truth.`
    : '';

  // v0.16 (codex review P2): pass the AUTHORITATIVE Phase-1 classification down
  // so Phase 2 doesn't independently re-decide review-ness and silently emit an
  // empty discussed_trials for a review. Only a review gets a directive; a
  // study report gets a blank line (byte-stable for the legacy corpus).
  const contentTypeBlock =
    cluster.content_type === 'review'
      ? 'Classification: REVIEW (set by Phase 1). This item is a multi-trial / topic round-up, NOT a single-study report. You MUST populate `discussed_trials` with the trial acronyms it names, copied verbatim. Do not fabricate a single-result analysis.'
      : '';

  const prompt = template
    .replace('{{VOICE}}', VOICE_POINTER)
    .replace('{{PERSPECTIVE}}', loadPerspective(opts.perspectiveName))
    .replace('{{STUDY_NAME}}', cluster.name)
    .replace('{{STUDY_SLUG}}', cluster.slug)
    .replace('{{DISEASE_SITE}}', cluster.disease_site)
    .replace('{{CONTENT_TYPE_BLOCK}}', contentTypeBlock)
    .replace('{{IMAGE_MANIFEST}}', manifest.text)
    .replace('{{TWEETS_JSON}}', JSON.stringify(tweetsForPrompt, null, 2))
    .replace('{{PRIOR_CONTEXT_BLOCK}}', priorContextBlock);

  const content: LlmContentBlock[] = [voiceCacheBlock()];
  for (const url of manifest.urls) content.push({ type: 'image', url });
  content.push({ type: 'text', text: prompt });

  const { value: study, raw } = await completeAndParse(
    client,
    content,
    // Phase 2 is the deep-analysis step; honor the studyModel override (e.g.
    // Opus) and the optional extended-thinking budget.
    {
      model: opts.studyModel ?? opts.model,
      maxTokens: 4096,
      temperature: 0,
      thinkingBudget: opts.studyThinkingBudget,
    },
    (rawResp) => parseStudyAgentResponse(rawResp, cluster),
    maxRetries,
    `phase2:${cluster.slug}`,
  );

  // Post-hoc validation of each promoted figure: drop a figure whose URL isn't
  // in the cluster / not on the host allowlist; for survivors, drop the caption
  // when its numbers aren't traceable to that image's OCR (figure kept). When
  // OCR is globally unavailable, all figures are dropped (env-skew safety).
  const validatedFigures = validateFigures(
    study.figures ?? [],
    tweets,
    ocrAvailable,
    cluster.slug,
  );

  // v0.4.2: Numbers in table cells get the same OCR/source-text validation.
  // Table is structurally regular (rows × columns), so cell-level validation
  // is straightforward. If any cell has a number not present in the union
  // of tweet text + image OCR, the whole table is replaced with a flat
  // string noting the drop. Conservative: a half-validated table is more
  // misleading than no table.
  const detailsValidated = validateStudyTables(
    { ...study, figures: validatedFigures },
    tweets,
    cluster.slug,
  );

  // v0.4.4 backstop: if the LLM emitted both a table caption AND a detail
  // table covering the same columns, drop the detail-table. Prompt-level
  // rule asks for non-duplication; this is the safety net.
  const finalStudy = dedupTablesAgainstCaption(detailsValidated, cluster.slug);
  return { study: finalStudy, raw };
}

// Validate every promoted figure against its own OCR, reusing the single-figure
// validator (validateKeyFigure). A figure is dropped entirely when its URL fails
// the host allowlist, isn't present in the cluster, or when OCR is unavailable;
// otherwise it's kept and its caption is dropped if any caption number isn't
// OCR-traceable. Figures stay in input order (most-informative first).
export function validateFigures(
  figures: DigestFigure[],
  tweets: DigestInputTweet[],
  ocrAvailable: boolean,
  slug?: string,
): DigestFigure[] {
  const out: DigestFigure[] = [];
  for (const fig of figures) {
    const v = validateKeyFigure(fig.caption, fig.url, tweets, ocrAvailable);
    if (v.reason && slug) {
      console.warn(`  [phase2:${slug}] figure ${fig.url}: ${v.reason}`);
    }
    if (!v.figureUrl) continue; // dropped: bad URL / not in cluster / OCR off
    out.push({ url: v.figureUrl, caption: v.caption });
  }
  return out;
}

// Drop any detail-table whose column set overlaps ≥2 headers with ANY table-form
// figure caption. Replaces the detail-table with a flat string of just its
// `text` label so the reader still sees the bullet concept but not the duplicate
// matrix. Reads captions from v0.10 `figures` and the v0.4 legacy single pair.
export function dedupTablesAgainstCaption(
  study: DigestStudy,
  slug?: string,
): DigestStudy {
  const captionTables: DigestTable[] = [];
  for (const f of study.figures ?? []) {
    if (f.caption && typeof f.caption !== 'string') captionTables.push(f.caption);
  }
  if (study.key_figure_caption && typeof study.key_figure_caption !== 'string') {
    captionTables.push(study.key_figure_caption);
  }
  if (captionTables.length === 0) return study;
  const capColSets = captionTables.map(
    (t) => new Set(t.columns.map((c) => c.trim().toLowerCase())),
  );
  let dropped = 0;
  const newDetails: DigestDetail[] = study.details.map((d) => {
    if (!isTableDetail(d)) return d;
    const detailCols = d.table.columns.map((c) => c.trim().toLowerCase());
    const isDuplicate = capColSets.some((capCols) => {
      let shared = 0;
      for (const c of detailCols) if (capCols.has(c)) shared++;
      return shared >= 2;
    });
    if (isDuplicate) {
      dropped++;
      return d.text; // keep the parent label, drop the duplicate matrix
    }
    return d;
  });
  if (dropped > 0 && slug) {
    console.warn(
      `  [phase2:${slug}] dropped ${dropped} detail-table(s): duplicates a figure caption-table`,
    );
  }
  return { ...study, details: newDetails };
}

// Validate numeric tokens in table cells against the study's source text
// (union of tweet bodies + image OCR). Tables with any unverified number
// are replaced with a flat-string fallback so the reader knows the
// comparison was redacted, not silently corrupted.
export function validateStudyTables(
  study: DigestStudy,
  tweets: DigestInputTweet[],
  slug?: string,
): DigestStudy {
  // Token membership is order-free, so the joined text is fine for the loose
  // check. Adjacency pairs, though, must be computed PER FRAGMENT: joining
  // sources first would make the last number of one tweet/paper adjacent to the
  // first number of an unrelated one, minting a spurious pair that a fabricated
  // cross-source CI could ride through (codex P1). Union the per-fragment sets.
  const fragments = collectStudySourceFragments(tweets);
  const tokenRe = /\d+\.\d+|\.\d+|\d+/g;
  const sourceTokens = new Set(
    (fragments.join(' ').match(tokenRe) ?? []).map(normalizeNumericToken),
  );
  const sourcePairs = new Set<string>();
  for (const frag of fragments) {
    for (const key of sourceAdjacentNumberPairs(frag)) sourcePairs.add(key);
  }

  let dropped = 0;
  const newDetails: DigestDetail[] = study.details.map((d) => {
    if (!isTableDetail(d)) return d;
    for (const cell of d.table.rows.flat()) {
      const bad = firstUnverifiedCellValue(cell, sourceTokens, sourcePairs);
      if (bad !== null) {
        dropped++;
        return `${d.text} — comparison values omitted (cell value "${bad}" not verified in source)`;
      }
    }
    return d;
  });

  if (dropped > 0 && slug) {
    console.warn(`  [phase2:${slug}] dropped ${dropped} table(s): unverified numeric token(s)`);
  }
  return { ...study, details: newDetails };
}

// Each source's text + each image's OCR as a SEPARATE fragment. Adjacency is
// computed within a fragment so a number from tweet A and a number from paper B
// never form a spurious "pair" across the boundary.
function collectStudySourceFragments(tweets: DigestInputTweet[]): string[] {
  const parts: string[] = [];
  for (const t of tweets) {
    parts.push(t.text);
    for (const ocr of t.image_ocr_texts ?? []) parts.push(ocr);
  }
  return parts;
}

export function parseStudyAgentResponse(raw: string, cluster: StudyCluster): DigestStudy {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new DigestParseError(`Phase 2 not valid JSON: ${(err as Error).message}`, raw);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DigestParseError('Phase 2 root is not an object', raw);
  }
  const root = parsed as Record<string, unknown>;

  const name = typeof root.name === 'string' && root.name.trim() ? root.name.trim() : cluster.name;
  const tldr = typeof root.tldr === 'string' ? root.tldr.trim() : '';
  if (!tldr) throw new DigestParseError('Phase 2 missing tldr', raw);
  // v0.4.2: accept flat strings, {text, subdetails[]} objects, OR
  // {text, table:{columns, rows}} for 2D matrix comparisons. The parser
  // collapses degenerate cases (empty subdetails, empty table, mismatched
  // row width) back to the simpler form so renderers can trust shape.
  const details: DigestDetail[] = Array.isArray(root.details)
    ? root.details
        .map((d): DigestDetail | null => {
          if (typeof d === 'string') {
            const trimmed = d.trim();
            return trimmed.length > 0 ? trimmed : null;
          }
          if (d && typeof d === 'object') {
            const obj = d as Record<string, unknown>;
            const text = typeof obj.text === 'string' ? obj.text.trim() : '';
            if (!text) return null;

            // Table form takes priority if present and well-shaped.
            if (obj.table && typeof obj.table === 'object') {
              const tbl = obj.table as Record<string, unknown>;
              const columns = Array.isArray(tbl.columns)
                ? tbl.columns
                    .filter((c): c is string => typeof c === 'string')
                    .map((c) => c.trim())
                : [];
              const rawRows = Array.isArray(tbl.rows) ? tbl.rows : [];
              const rows: string[][] = [];
              for (const r of rawRows) {
                if (!Array.isArray(r)) continue;
                const cells = r
                  .filter((c): c is string => typeof c === 'string')
                  .map((c) => c.trim());
                // Pad short rows with empty strings; truncate long ones to
                // column count. Better than dropping malformed rows.
                while (cells.length < columns.length) cells.push('');
                if (cells.length > columns.length) cells.length = columns.length;
                rows.push(cells);
              }
              // Need at least 2 columns and 1 row for a table to be useful.
              // Otherwise fall through and treat as flat or subdetails.
              if (columns.length >= 2 && rows.length >= 1) {
                return { text, table: { columns, rows } };
              }
            }

            const subdetails = Array.isArray(obj.subdetails)
              ? obj.subdetails
                  .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                  .map((s) => s.trim())
              : [];
            // If neither table nor subdetails, collapse to flat string.
            return subdetails.length === 0 ? text : { text, subdetails };
          }
          return null;
        })
        .filter((d): d is DigestDetail => d !== null)
    : [];
  const nctRaw =
    typeof root.nct === 'string' && root.nct.trim() ? root.nct.trim().toUpperCase() : null;
  const nct =
    nctRaw && /^NCT\d{8}$/.test(nctRaw)
      ? nctRaw
      : nctRaw && /^\d{8}$/.test(nctRaw)
        ? `NCT${nctRaw}`
        : null;
  // v0.10: a `figures` array, each {url, caption}. v0.4 back-compat: a model
  // that still emits the single key_figure_url/caption pair is wrapped into a
  // one-element array. URLs are deduped (a model may cite the same image twice)
  // and capped at MAX_FIGURES. Captions are parsed but NOT yet validated —
  // runStudyAgent validates each against the figure's OCR after parsing.
  const figures = parseFigures(root);

  // v0.10: cross-cutting tag fields. Phase 2 picks ONE value per namespace
  // from the enums in src/lib/tags.ts. Invalid enum values are dropped to null
  // and logged (the study still appears on its other tag landings; only that
  // namespace's landing skips it). Codex review (PR #11) recommended dropping
  // silently was a bad failure mode — logEnumDrop emits a warning the build
  // CLI surfaces. Missing fields → null without a warning (conservative
  // abstention is encouraged by the prompt).
  const modality = parseEnumTag(root.modality, isValidModality, 'modality', name);
  const intent = parseEnumTag(root.intent, isValidIntent, 'intent', name);
  const methodology = parseEnumTag(root.methodology, isValidMethodology, 'methodology', name);

  // v0.16: content_type is decided at Phase 1 (grouping) and inherited here —
  // Phase 2 does NOT re-classify. discussed_trials is the one trade-press field
  // Phase 2 owns (it reads the full source text), and only a review carries it;
  // a study report never renders an acronym list even if the model emits one.
  const content_type = cluster.content_type;
  const discussedTrials =
    content_type === 'review' ? parseDiscussedTrials(root.discussed_trials) : [];

  return {
    name,
    tldr,
    details,
    figures,
    // v0.16 boundary: a review names trials as plain text and must NEVER carry
    // an inferred single-study NCT (it would render a clinicaltrials.gov link on
    // the review card via StudyCard's shared head). Phase 2 inherits the cluster
    // content_type but parses `nct` ungated, so force it null for reviews here —
    // the same enforcement posture as stripReviewVerdicts at build time.
    nct: content_type === 'review' ? null : nct,
    tweet_ids: cluster.tweet_ids,
    slug: cluster.slug,
    verdict: parseVerdict(root.verdict),
    open_questions: parseOpenQuestions(root.open_questions),
    consort: parseConsort(root.consort),
    modality,
    intent,
    methodology,
    // Omit the default so the committed study-report corpus stays unchanged;
    // absent === study_report. Only a review records the field.
    content_type: content_type === DEFAULT_CONTENT_TYPE ? undefined : content_type,
    discussed_trials: discussedTrials.length > 0 ? discussedTrials : undefined,
  };
}

// v0.16: parse a review's "trials discussed" acronym list. Lifts trial names
// the model copied VERBATIM from the source (we never link or infer an NCT for
// a bare acronym — the dato-DXd lesson). Defensive against the model returning
// noise: trims, drops empties / single chars / sentence-length fragments,
// dedupes case-insensitively (first spelling wins), and caps the list so a
// runaway extraction can't flood the card. M0 found ~14 acronyms on the
// exemplar incl. a "PP3"-type fragment; the cap is the main control.
const MAX_DISCUSSED_TRIALS = 8;
export function parseDiscussedTrials(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    // 2..40 chars, must contain ≥1 alphanumeric. Upper bound rejects a
    // sentence the model pasted instead of an acronym; lower bound rejects a
    // stray single char. We do NOT require ≥3 letters — cooperative-group
    // trials (S1207, E2112) are 1 letter + digits and are real names.
    if (name.length < 2 || name.length > 40) continue;
    if (!/[A-Za-z0-9]/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_DISCUSSED_TRIALS) break;
  }
  return out;
}

const MAX_FIGURES = 4;

// Parse the `figures` array (v0.10) with v0.4 single-figure back-compat. Keeps
// only entries with a non-empty string url; dedupes repeated urls; caps the
// count. Caption shape is normalized by parseCaption.
export function parseFigures(root: Record<string, unknown>): DigestFigure[] {
  const out: DigestFigure[] = [];
  const seen = new Set<string>();
  const push = (urlRaw: unknown, captionRaw: unknown) => {
    if (typeof urlRaw !== 'string') return;
    const url = urlRaw.trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, caption: parseCaption(captionRaw) });
  };
  if (Array.isArray(root.figures)) {
    for (const f of root.figures) {
      if (!f || typeof f !== 'object') continue;
      const fo = f as Record<string, unknown>;
      push(fo.url, fo.caption);
    }
  } else {
    // v0.4 single-figure shape.
    push(root.key_figure_url, root.key_figure_caption);
  }
  return out.slice(0, MAX_FIGURES);
}

// v0.4.3: a caption is a flat string OR a {columns, rows} table for comparison
// figures. Degenerate tables (<2 columns or 0 rows) collapse to null — the LLM
// signaled table intent but didn't fill it. Short rows are padded, long rows
// truncated to the column count.
export function parseCaption(raw: unknown): string | DigestTable | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    const tbl = raw as Record<string, unknown>;
    const columns = Array.isArray(tbl.columns)
      ? tbl.columns.filter((c): c is string => typeof c === 'string').map((c) => c.trim())
      : [];
    const rawRows = Array.isArray(tbl.rows) ? tbl.rows : [];
    const rows: string[][] = [];
    for (const r of rawRows) {
      if (!Array.isArray(r)) continue;
      const cells = r.filter((c): c is string => typeof c === 'string').map((c) => c.trim());
      while (cells.length < columns.length) cells.push('');
      if (cells.length > columns.length) cells.length = columns.length;
      rows.push(cells);
    }
    if (columns.length >= 2 && rows.length >= 1) return { columns, rows };
  }
  return null;
}

// Parses the optional CONSORT flow. Strict: returns null unless the model gave a
// positive total randomized and >= 2 arms each with a label + positive allocated
// count. Drops the whole diagram on any shortfall rather than render a partial /
// invented flow — every count must be real (no estimation).
export function parseConsort(raw: unknown): ConsortDiagram | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : null;

  const randomized = posInt(obj.randomized);
  if (randomized === null) return null;

  const armsRaw = Array.isArray(obj.arms) ? obj.arms : [];
  const arms: ConsortArm[] = [];
  for (const a of armsRaw) {
    if (!a || typeof a !== 'object') continue;
    const ao = a as Record<string, unknown>;
    const label = typeof ao.label === 'string' ? ao.label.trim() : '';
    const allocated = posInt(ao.allocated);
    if (!label || allocated === null) continue;
    arms.push({ label, allocated, analyzed: posInt(ao.analyzed) });
  }
  if (arms.length < 2) return null;

  return { enrolled: posInt(obj.enrolled), excluded: posInt(obj.excluded), randomized, arms };
}

// Parses the optional verdict block emitted by Phase 2. Forgiving: if the
// field is missing or malformed, return undefined and the renderer falls
// back to the bullet-only layout (graceful for older artifacts).
//   - soc_implication: normalized then validated against the enum. MISSING →
//     'unclear' (kept). A non-empty but UNRECOGNIZED value → drop the whole
//     verdict (see below) rather than mislabel a strong rationale as 'unclear'.
//   - rationale: trimmed; capped at 40 words (prompt asks for 30, allow slop)
//   - audience: trimmed string or null; capped at 120 chars (prompt asks 80)
export function parseVerdict(raw: unknown): StudyVerdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  // Normalize before validating (mirror parseEnumTag): lowercase + collapse
  // whitespace/underscores to hyphens, so "Practice Changing" / "practice_changing"
  // match the canonical 'practice-changing' slug instead of being mislabeled.
  const rawSoc =
    typeof obj.soc_implication === 'string'
      ? obj.soc_implication.trim().toLowerCase().replace(/[\s_]+/g, '-')
      : '';
  const isValidSoc = (SOC_IMPLICATIONS as readonly string[]).includes(rawSoc);
  // A non-empty value that still fails the enum means the model emitted an
  // off-taxonomy verdict. Coercing it to 'unclear' while keeping the rationale
  // renders a self-contradictory pill ("Unclear" beside a practice-changing
  // rationale), so drop the whole verdict and fall back to the bullet-only
  // layout. Only a MISSING/empty soc defaults to 'unclear'.
  if (rawSoc && !isValidSoc) return undefined;
  const soc: SocImplication = isValidSoc ? (rawSoc as SocImplication) : 'unclear';
  const rationaleRaw = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';
  if (!rationaleRaw) return undefined; // verdict without rationale isn't useful
  const rationaleWords = rationaleRaw.split(/\s+/);
  const rationale =
    rationaleWords.length > 40
      ? rationaleWords.slice(0, 40).join(' ') + '…'
      : rationaleRaw;
  // VOICE.md mandates audience ≤ 80 chars. Truncate at 80 cleanly (no
  // ellipsis: at 80 chars there isn't room for the marker and any
  // information it would replace). Codex review flagged the previous
  // 120-char slop as allowing the LLM to drift; keep the cap honest.
  const audienceRaw = typeof obj.audience === 'string' ? obj.audience.trim() : '';
  const audience: string | null = audienceRaw.length === 0
    ? null
    : audienceRaw.length > 80
      ? audienceRaw.slice(0, 80).trimEnd()
      : audienceRaw;
  return { soc_implication: soc, rationale, audience };
}

// Parse the optional per-study open_questions (v0.8.1). Forgiving: trims, drops
// empties, caps at 5. Returns null when absent/empty so renderers fall back to
// the site-level list for older artifacts.
export function parseOpenQuestions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    .map((q) => q.trim())
    .slice(0, 5);
  return out.length > 0 ? out : null;
}

// v0.13: internal Phase 2 output shape. NOT persisted on DigestStudy. The
// orchestrator reads this off the raw Phase 2 response and uses it to drive
// per-question ct.gov fetches.
export type RelatedSearch = {
  queries: Array<{
    term: string;            // free-text CT.gov query.term value
    watches_question: string; // EXACT text from study.open_questions[i]
  }>;
};

// v0.13: stop-list applied to emitted query terms. Designed to catch the
// failure mode where Phase 2 hallucinates a too-generic term ("the drug",
// "cancer", "RT") that CT.gov would match against thousands of trials.
// Lowercased single-token lookup; per-token (not substring).
//
// Extended list catches common oncology generics flagged by codex round-2:
// efficacy, safety, survival, dose, response, regimen, combination,
// outcome (and plural). A query like "survival combination therapy" passes
// the old 3-token check but is still useless for CT.gov; the extended
// stop-list plus the "2 specific tokens required" bar rejects it.
const QUERY_STOP_TOKENS = new Set([
  'cancer',
  'tumor',
  'tumour',
  'oncology',
  'drug',
  'drugs',
  'medication',
  'treatment',
  'therapy',
  'trial',
  'study',
  'rt',
  'radiation',
  'chemo',
  'chemotherapy',
  'phase',
  'placebo',
  'arm',
  'efficacy',
  'safety',
  'survival',
  'dose',
  'response',
  'regimen',
  'combination',
  'outcome',
  'outcomes',
  'advanced',
]);

// Forgiving structural parser for Phase 2's `related_search` field. Returns
// null when the field is absent, malformed, or all queries fail the
// stop-list. The orchestrator treats null as "no_related_search" and skips
// trial enrichment for that study.
//
// Rules (mirror prompt instructions in prompts/digest-v5-study-agent.txt):
//   - queries must be an array; cap at 3
//   - each entry must have term (string) and watches_question (string)
//   - both must be non-empty after trim
//   - term must have ≥ 3 whitespace-separated tokens (rejects "darolutamide",
//     "prostate cancer", and other under-specified queries)
//   - term must not consist entirely of stop-list tokens
//   - duplicate term-and-question pairs are deduped (LLM repeats happen)
//   - watches_question is NOT validated against study.open_questions here;
//     that's the orchestrator's job once it has the study object
export function parseRelatedSearch(raw: unknown): RelatedSearch | null {
  if (!isPlainObject(raw)) return null;
  const queriesRaw = (raw as { queries?: unknown }).queries;
  if (!Array.isArray(queriesRaw)) return null;

  const seen = new Set<string>();
  const out: RelatedSearch['queries'] = [];

  for (const entry of queriesRaw) {
    if (out.length >= 3) break;
    if (!isPlainObject(entry)) continue;
    const e = entry as Record<string, unknown>;
    const termRaw = typeof e.term === 'string' ? e.term.trim() : '';
    const wqRaw = typeof e.watches_question === 'string' ? e.watches_question.trim() : '';
    if (!termRaw || !wqRaw) continue;

    if (!passesQueryStopList(termRaw)) continue;

    const dedupKey = `${termRaw.toLowerCase()}|${wqRaw}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({ term: termRaw, watches_question: wqRaw });
  }

  return out.length > 0 ? { queries: out } : null;
}

function passesQueryStopList(term: string): boolean {
  // Split on whitespace AND hyphens before regex strip so "phase-3 trial"
  // becomes ["phase", "3", "trial"] and the "phase" token gets caught by
  // the stop-list; without splitting on hyphens, "phase-3" would collapse
  // to "phase3" (non-stop, non-numeric) and pass.
  const tokens = term
    .toLowerCase()
    .split(/[\s\-]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length < 2) return false;
  // The query must contain at least 2 SPECIFIC tokens: not in the stop-list
  // AND not a pure number. A drug-plus-condition pair like "darolutamide
  // nmCRPC" passes. "advanced cancer treatment" fails because only
  // "treatment" is meaningful and it is in the stop-list.
  const specificTokens = tokens.filter(
    (t) => !QUERY_STOP_TOKENS.has(t) && !/^\d+$/.test(t),
  );
  return specificTokens.length >= 2;
}

// v0.13: parse the rerank LLM's pick list into RelatedTrial[]. Enforces
// BOTH invariants:
//   1. nct ∈ candidate set (provided as candidatesByNct)
//   2. answers_question ∈ study.open_questions (byte-identical)
//
// Then:
//   - dedup (nct, answers_question) tuples
//   - cap at 5 total
//   - re-hydrate full CandidateTrial fields by nct (rerank only emits
//     nct + answers_question + relevance_phrase; everything else is
//     pulled from the candidate)
//   - trim relevance_phrase, cap at 60 chars
//   - sort displayed list: group by question (preserving study.open_questions
//     order); within group, primary_completion_date ascending, nulls last
//
// Returns null when no valid picks survived (treat as "rerank_abstained"
// per the orchestrator's failure-mode policy).
export function parseRelatedTrials(
  raw: unknown,
  candidatesByNct: Map<string, CandidateTrial>,
  studyOpenQuestions: string[],
): RelatedTrial[] | null {
  if (!isPlainObject(raw)) return null;
  const picksRaw = (raw as { picks?: unknown }).picks;
  if (!Array.isArray(picksRaw)) return null;

  // Build a normalization map from normalized form back to the original
  // study.open_questions string. The LLM's `answers_question` is normalized
  // (Unicode NFC + smart-quote-to-ascii) for the comparison ONLY; the
  // value persisted on the artifact is the canonical original string from
  // study.open_questions. Codex PR-2 P2 #4: protects against legitimate
  // curly-quote / NBSP drift without opening a path to LLM invention.
  const canonicalByNormalized = new Map<string, string>();
  for (const q of studyOpenQuestions) {
    canonicalByNormalized.set(normalizeQuestionForMatch(q), q);
  }

  const seenTuples = new Set<string>();
  const accepted: RelatedTrial[] = [];

  for (const entry of picksRaw) {
    if (accepted.length >= 5) break;
    if (!isPlainObject(entry)) continue;
    const e = entry as Record<string, unknown>;
    const nct = typeof e.nct === 'string' ? e.nct.trim() : '';
    const aqRaw = typeof e.answers_question === 'string' ? e.answers_question.trim() : '';
    const phraseRaw = typeof e.relevance_phrase === 'string' ? e.relevance_phrase.trim() : '';
    if (!nct || !aqRaw || !phraseRaw) continue;

    // INVARIANT 1: nct must be in the candidate set we just fetched.
    const candidate = candidatesByNct.get(nct);
    if (!candidate) continue;

    // INVARIANT 2: answers_question must match (after Unicode/quote
    // normalization) one of the study's open questions. We persist the
    // CANONICAL source string, never the LLM's normalized form, so the
    // artifact field stays byte-identical to study.open_questions.
    const aq = canonicalByNormalized.get(normalizeQuestionForMatch(aqRaw));
    if (!aq) continue;

    const tupleKey = `${nct}|${aq}`;
    if (seenTuples.has(tupleKey)) continue;
    seenTuples.add(tupleKey);

    accepted.push({
      ...candidate,
      answers_question: aq,
      relevance_phrase: capRelevancePhrase(phraseRaw),
    });
  }

  if (accepted.length === 0) return null;

  // Sort: preserve study.open_questions order across groups, primary
  // completion date ascending within each group (nulls last).
  const questionOrder = new Map<string, number>();
  studyOpenQuestions.forEach((q, idx) => questionOrder.set(q, idx));

  accepted.sort((a, b) => {
    const qa = questionOrder.get(a.answers_question) ?? Number.MAX_SAFE_INTEGER;
    const qb = questionOrder.get(b.answers_question) ?? Number.MAX_SAFE_INTEGER;
    if (qa !== qb) return qa - qb;
    return compareCompletionDates(a.primary_completion_date, b.primary_completion_date);
  });

  return accepted;
}

function capRelevancePhrase(s: string): string {
  if (s.length <= 60) return s;
  // Truncate at last whitespace before 60 chars to avoid mid-word cuts.
  const slice = s.slice(0, 60);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

// Sort helper: nulls go LAST regardless of direction. YYYY-MM and YYYY
// strings compare lexicographically (correct because both are
// zero-padded).
function compareCompletionDates(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// v0.13: Normalize an open-question string for INVARIANT 2 matching.
// Unicode NFC + smart-quote / NBSP folding. Used ONLY to compare the LLM's
// emitted `answers_question` against study.open_questions; the canonical
// string from study.open_questions is what gets persisted on the artifact,
// so a curly-quote-drifted match still produces byte-identical artifact
// output. Does not lowercase or trim, so case drift still fails.
function normalizeQuestionForMatch(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/ /g, ' ');
}

// v0.13: In-memory cache for ct.gov fetches. Lives across one build
// invocation (and across all dates of a backfill once T6 plumbs it through
// runBackfill). Stores RESULTS only, never failures, so a transient
// ct.gov error on one study does not poison the same query for the next
// study (codex round-2 #13). Key: sha1(normalize(query.term)).
//
// The cache holds an in-flight promise during the fetch window, so
// concurrent Phase 2 workers issuing the same query share one ct.gov
// call instead of racing two duplicate fetches. Codex PR-2 P2 #3.
export type RelatedTrialsRunCache = Map<string, Promise<FetchCandidateTrialsResult>>;

export function createRelatedTrialsRunCache(): RelatedTrialsRunCache {
  return new Map();
}

// v0.13: Injectable dependencies for the orchestrator. Production callers
// pass nothing (real ct.gov fetch, real LLM client, real clock); tests
// inject stubs.
export type EnrichRelatedTrialsDeps = {
  ctgovFetch?: (term: string) => Promise<FetchCandidateTrialsResult>;
  rerankClient?: LlmClient;
  clock?: () => Date;
  promptPath?: string;
  // Cap on candidates surfaced into the rerank prompt per query. Default
  // 20 (matches ct.gov pageSize). Tests may shrink for fixture clarity.
  maxCandidatesPerQuery?: number;
};

export type EnrichRelatedTrialsResult = {
  related_trials: RelatedTrial[] | null;
  related_trials_provenance: RelatedTrialsProvenance;
};

const RERANK_PROMPT_PATH = resolve(PROMPTS_DIR, 'digest-v5-rerank-trials.txt');
const DETERMINISTIC_FALLBACK_CAP = 3;

// ct.gov free-text ANDs every token, so an over-specific query ("dose
// escalation meningioma WHO grade 2 radiation randomized") returns nothing
// while its clinical core ("meningioma radiation") returns a full set. When a
// query comes back empty we retry once with this broadened form: trial-design,
// tumor-grade, line-of-therapy, and bare numeric qualifiers stripped, leaving
// the condition + intervention. Returns null when stripping leaves fewer than 2
// tokens or changes nothing (no useful retry).
const TERM_DESIGN_STOPWORDS = new Set([
  'randomized', 'randomised', 'randomization', 'randomisation', 'phase', 'dose',
  'escalation', 'de-escalation', 'deescalation', 'who', 'grade', 'high-grade',
  'low-grade', 'placebo', 'controlled', 'double-blind', 'single-blind', 'blinded',
  'blind', 'open-label', 'open', 'label', 'prospective', 'retrospective',
  'multicenter', 'multicentre', 'single-center', 'single-centre', 'single-arm',
  'two-arm', 'pilot', 'feasibility', 'non-inferiority', 'noninferiority',
  'superiority', 'first-line', 'second-line', 'third-line', 'frontline', 'first',
  'second', 'third', 'line', '1l', '2l', '3l', 'adaptive', 'crossover',
]);

export function broadenTrialQuery(term: string): string | null {
  const kept: string[] = [];
  for (const raw of term.trim().split(/\s+/)) {
    const cleaned = raw.replace(/[.,;:()"']/g, ''); // strip surrounding punctuation, keep case + hyphens
    if (cleaned.length === 0) continue;
    const w = cleaned.toLowerCase();
    if (/^\d+$/.test(w) || TERM_DESIGN_STOPWORDS.has(w)) continue;
    kept.push(cleaned);
  }
  if (kept.length < 2) return null;
  // Reject an all-generic broadening ("radiation chemotherapy", "survival
  // outcomes") that would swamp the rerank: keep only when at least one token
  // is a specific clinical noun (a real condition/drug/intervention), not a
  // ct.gov-generic stop token. One specific token is enough for a best-effort
  // retry (e.g. "meningioma radiation"); the rerank still filters per question.
  const hasSpecific = kept.some((t) => !QUERY_STOP_TOKENS.has(t.toLowerCase()) && !/^\d+$/.test(t));
  if (!hasSpecific) return null;
  const broadened = kept.join(' ');
  return broadened.toLowerCase() === term.trim().toLowerCase() ? null : broadened;
}

// v0.13: Per-study orchestrator. Reads `related_search` off the raw Phase
// 2 response, fan-outs ct.gov fetches per query (deduped through the run
// cache), aggregates candidates by question, sends a single rerank LLM
// call, parses with the structural invariants. Returns the trials + a
// provenance record. NEVER THROWS (codex round-2 #5): orchestrator
// failures must never drop the underlying study from Phase 2.
export async function enrichStudyWithRelatedTrials(
  study: DigestStudy,
  rawStudyAgentResponse: unknown,
  runCache: RelatedTrialsRunCache,
  deps: EnrichRelatedTrialsDeps = {},
  log?: (line: string) => void,
): Promise<EnrichRelatedTrialsResult> {
  const slug = study.slug ?? 'unknown';

  const emit = (line: string): void => {
    if (log) log(line);
    else console.warn(line);
  };

  // Provenance is initialized inside the try so a throwing clock cannot
  // escape the catch-all (codex PR-2 P2 #5).
  let provenance: RelatedTrialsProvenance = {
    queries_fired: [],
    queries_failed: [],
    candidates_returned: 0,
    fetched_at: '',
    rerank_outcome: 'skipped',
  };

  try {
    const clock = deps.clock ?? (() => new Date());
    provenance = { ...provenance, fetched_at: clock().toISOString() };
    // 1. Parse related_search off the raw Phase 2 response.
    const rawSearch = isPlainObject(rawStudyAgentResponse)
      ? (rawStudyAgentResponse as Record<string, unknown>).related_search
      : null;
    const relatedSearch = parseRelatedSearch(rawSearch);

    if (!relatedSearch) {
      emit(`[v0.13] no_related_search: ${slug}`);
      return { related_trials: null, related_trials_provenance: provenance };
    }

    // 2. Fetch candidates per query (cache hit short-circuits ct.gov call).
    const openQuestions = study.open_questions ?? [];
    const candidatesByNct = new Map<string, CandidateTrial>();
    const ownNct = (study.nct ?? '').toUpperCase(); // exclude the study's own trial from its watch-list
    const groupedByQuestion = new Map<string, CandidateTrial[]>();
    const fetchFn = deps.ctgovFetch ?? fetchCandidateTrials;
    const maxPerQuery = deps.maxCandidatesPerQuery ?? 20;

    for (const q of relatedSearch.queries) {
      provenance.queries_fired.push(q.term);
      const cacheKey = sha1Hex(normalizeTermForCache(q.term));
      // Race-safe dedup: store the in-flight promise so a concurrent worker
      // issuing the same query awaits the same call. After settle, if the
      // result was a failure we evict the promise so the NEXT study retries
      // (matches the "cache results only, never failures" rule from PR-1).
      let promise = runCache.get(cacheKey);
      if (!promise) {
        promise = fetchFn(q.term);
        runCache.set(cacheKey, promise);
        // Schedule eviction of failures; succeed-cache stays. Use the awaited
        // value to decide; do NOT block the cache set on it.
        void promise.then(
          (res) => {
            if (!res.ok) runCache.delete(cacheKey);
          },
          () => {
            // Rejected promise: also evict so retries are possible.
            runCache.delete(cacheKey);
          },
        );
      }
      let result = await promise;

      // An empty result usually means the query ANDed too many qualifiers.
      // Retry once with a broadened term (design/grade/numeric tokens stripped)
      // before recording the failure. broadenTrialQuery already rejects an
      // all-generic strip ("radiation chemotherapy"), so a non-null result is
      // safe to fire. Reuses the run cache so a broadened term shared across
      // studies hits ct.gov once.
      if (!result.ok && result.error === 'empty') {
        const broad = broadenTrialQuery(q.term);
        if (broad) {
          const broadKey = sha1Hex(normalizeTermForCache(broad));
          let bp = runCache.get(broadKey);
          if (!bp) {
            bp = fetchFn(broad);
            runCache.set(broadKey, bp);
            void bp.then(
              (res) => {
                if (!res.ok) runCache.delete(broadKey);
              },
              () => runCache.delete(broadKey),
            );
          }
          const broadResult = await bp;
          if (broadResult.ok) {
            // The original was fired and came back empty; the broadened term
            // returned the candidates. Record both truthfully (clean terms, no
            // annotation strings) so the eval scores real queries: the
            // broadened term joins queries_fired, the original joins
            // queries_failed.
            provenance.queries_fired.push(broad);
            provenance.queries_failed.push({ term: q.term, reason: 'empty' });
            emit(`[v0.13] ctgov_broadened: ${slug} · "${q.term}" → "${broad}"`);
            result = broadResult;
          }
        }
      }

      if (!result.ok) {
        provenance.queries_failed.push({ term: q.term, reason: result.error });
        emit(`[v0.13] ctgov_${result.error}: ${slug} · ${q.term}`);
        continue;
      }

      // Cap per-query and aggregate. Drop the study's OWN trial: "trials to
      // watch" means OTHER open trials, not the one this study reports.
      const group: CandidateTrial[] = [];
      for (const c of result.candidates.slice(0, maxPerQuery)) {
        if (ownNct && c.nct.toUpperCase() === ownNct) continue;
        candidatesByNct.set(c.nct, c);
        group.push(c);
      }
      // If two queries watch the same open question (rare but possible),
      // concatenate their candidates under that question.
      const existing = groupedByQuestion.get(q.watches_question);
      if (existing) {
        existing.push(...group);
      } else {
        groupedByQuestion.set(q.watches_question, group);
      }
    }

    provenance.candidates_returned = candidatesByNct.size;

    if (groupedByQuestion.size === 0) {
      // Codex PR-2 P2 #2: when every query failed (vs Phase 2 not emitting
      // any), the study WAS eligible. Mark provenance as 'failed' so the
      // build-end minimum-success gate counts this study in the denominator
      // and a total CT.gov outage becomes visible.
      provenance.rerank_outcome = 'failed';
      emit(`[v0.13] all_queries_failed: ${slug}`);
      return { related_trials: null, related_trials_provenance: provenance };
    }

    // 3. Rerank LLM call (or deterministic fallback if no client).
    const rerankClient = deps.rerankClient;
    if (!rerankClient) {
      emit(`[v0.13] rerank_no_client_fallback_used: ${slug}`);
      const fallback = deterministicDegradedFallback(groupedByQuestion, openQuestions);
      provenance.rerank_outcome = fallback.length > 0 ? 'fallback' : 'abstained';
      return {
        related_trials: fallback.length > 0 ? fallback : null,
        related_trials_provenance: provenance,
      };
    }

    let rerankRaw: string;
    try {
      rerankRaw = await runRerankTrialsPhase(
        rerankClient,
        study,
        openQuestions,
        groupedByQuestion,
        deps,
      );
    } catch (err) {
      emit(`[v0.13] rerank_failed_fallback_used: ${slug} · ${(err as Error).message}`);
      const fallback = deterministicDegradedFallback(groupedByQuestion, openQuestions);
      provenance.rerank_outcome = fallback.length > 0 ? 'fallback' : 'failed';
      return {
        related_trials: fallback.length > 0 ? fallback : null,
        related_trials_provenance: provenance,
      };
    }

    // 4. Parse rerank picks and enforce the invariants via parseRelatedTrials.
    const cleaned = stripFences(rerankRaw);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      emit(`[v0.13] rerank_parse_failed_fallback_used: ${slug}`);
      const fallback = deterministicDegradedFallback(groupedByQuestion, openQuestions);
      provenance.rerank_outcome = fallback.length > 0 ? 'fallback' : 'failed';
      return {
        related_trials: fallback.length > 0 ? fallback : null,
        related_trials_provenance: provenance,
      };
    }

    const trials = parseRelatedTrials(parsed, candidatesByNct, openQuestions);
    if (!trials) {
      emit(`[v0.13] rerank_abstained: ${slug}`);
      provenance.rerank_outcome = 'abstained';
      return { related_trials: null, related_trials_provenance: provenance };
    }

    // 'picked_N' is the structural tag; codex PR-2 #8 flagged that callers
    // wanting the count should read trials.length. Keeping the enum value
    // stable across schema versions; trial count is on the array itself.
    provenance.rerank_outcome = 'picked_N';
    return { related_trials: trials, related_trials_provenance: provenance };
  } catch (err) {
    // Catch-all so the orchestrator never propagates an exception to the
    // Phase 2 try block. Codex round-2 #5.
    emit(`[v0.13] orchestrator_exception: ${slug} · ${(err as Error).message}`);
    provenance.rerank_outcome = 'failed';
    return { related_trials: null, related_trials_provenance: provenance };
  }
}

// v0.13: Deterministic fallback. Picks top 1 trial per open question by
// primary_completion_date ascending (nulls last). Cap of
// DETERMINISTIC_FALLBACK_CAP total picks. Relevance phrase is the literal
// string "candidate match" so the renderer can show something without
// pretending the LLM judged fit. Codex round-2 #17.
export function deterministicDegradedFallback(
  groupedByQuestion: Map<string, CandidateTrial[]>,
  studyOpenQuestions: string[],
): RelatedTrial[] {
  const out: RelatedTrial[] = [];
  for (const question of studyOpenQuestions) {
    if (out.length >= DETERMINISTIC_FALLBACK_CAP) break;
    const candidates = groupedByQuestion.get(question);
    if (!candidates || candidates.length === 0) continue;
    const sorted = [...candidates].sort((a, b) =>
      compareCompletionDates(a.primary_completion_date, b.primary_completion_date),
    );
    const best = sorted[0];
    if (!best) continue;
    out.push({
      ...best,
      answers_question: question,
      relevance_phrase: 'candidate match',
    });
  }
  return out;
}

// Build the rerank LLM message: VOICE cache block + the rendered prompt
// template with the study context and grouped candidates injected.
async function runRerankTrialsPhase(
  client: LlmClient,
  study: DigestStudy,
  openQuestions: string[],
  groupedByQuestion: Map<string, CandidateTrial[]>,
  deps: EnrichRelatedTrialsDeps,
): Promise<string> {
  const promptPath = deps.promptPath ?? RERANK_PROMPT_PATH;
  const template = readFileSync(promptPath, 'utf-8');

  const grouped: Record<string, CandidateTrial[]> = {};
  for (const [q, candidates] of groupedByQuestion.entries()) {
    grouped[q] = candidates;
  }

  const rendered = template
    .replace('{{VOICE}}', VOICE_POINTER)
    .replace('{{STUDY_NAME}}', study.name)
    .replace('{{STUDY_TLDR}}', study.tldr)
    .replace('{{OPEN_QUESTIONS_JSON}}', JSON.stringify(openQuestions, null, 2))
    .replace('{{CANDIDATES_BY_QUESTION_JSON}}', JSON.stringify(grouped, null, 2));

  const content: LlmContentBlock[] = [voiceCacheBlock(), { type: 'text', text: rendered }];
  const messages: LlmMessage[] = [{ role: 'user', content }];
  return client.complete(messages, {});
}

// Normalize a query term for cache key purposes: trim, lowercase, collapse
// runs of whitespace. Survives LLM whitespace drift across studies that
// happen to extract the same drug+condition.
function normalizeTermForCache(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

// v0.10: parse a single-valued enum tag (modality, intent, methodology) from
// Phase 2 output. Returns the validated value if the LLM picked one in the
// enum, null when the field is absent / null / non-string, and null with a
// build-log warning when the field is a string but NOT in the enum (an
// out-of-enum hallucination). The warning surfaces in build/digest-builder.ts
// log so the curator can spot semantic drift without the build failing.
//
// Codex review (PR #11) flagged that silent dropping is a bad failure mode;
// the warning meets the spirit of that critique without requiring a hard
// build-fail (the rest of the study's data is still useful).
export function parseEnumTag<T extends string>(
  raw: unknown,
  validator: (s: string) => s is T,
  namespace: string,
  studyName: string,
): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  // Lowercase before validating: the prompt LABELS in tags.ts (e.g. "Radiation",
  // "Phase 3 RCT") differ from the SLUGS (radiation, phase-3-rct) by case, and
  // an LLM reading the rules block + example may emit either form. Without this
  // normalization, every "Radiation" / "Curative" / "Phase-3-RCT" emission
  // becomes a warn-and-drop and the study is silently missing from its
  // landing — the single most likely production failure mode given the prompt's
  // label/slug mix. Lowercasing pre-validate keeps the enum strict (no
  // "radiation " with a trailing space) while accepting the common drift.
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (validator(normalized)) return normalized;
  // Out-of-enum: log + drop. Build CLI surfaces this in its summary.
  // eslint-disable-next-line no-console
  console.warn(
    `[llm-pipeline] dropped invalid ${namespace} tag "${raw}" on study "${studyName}"`,
  );
  return null;
}

// Caption validator. Multiple findings shape this:
//   - Codex amended #1 / Testing Gap 1 / Claude #1: substring matching can be
//     fooled (caption "0.6" passes against OCR "0.62"). Fix: tokenize OCR and
//     require set-membership equality, not String.includes().
//   - Claude #2: a caption with ZERO numeric tokens (pure adjectival prose)
//     trivially passed. Fix: reject captions without at least one numeric
//     anchor — the whole point of the validator is to verify numbers.
//   - Claude #3: Vision often drops the leading zero on small floats (".62"
//     instead of "0.62"). Fix: include leading-zero variants in match set.
//   - Claude #26: when OCR is unavailable, captions can't be validated AND
//     figure shouldn't be promoted either (uncaptioned figure looks editorial
//     not technical). Fix: drop BOTH fields, not just caption.
//   - Security P1-2 / Claude #15: figure URL must be on the host allowlist
//     before any rendering happens.
//   - Codex #2 / earlier: drop both fields when figure URL isn't in the
//     cluster (model hallucinated).
export function validateKeyFigure(
  caption: string | DigestTable | null,
  figureUrl: string | null,
  tweets: DigestInputTweet[],
  ocrAvailable: boolean,
): {
  caption: string | DigestTable | null;
  figureUrl: string | null;
  reason?: string;
} {
  if (!figureUrl) {
    return { caption: null, figureUrl: null };
  }
  // Host allowlist before any further trust. Security P1-2.
  if (!isSafeImageUrl(figureUrl)) {
    return {
      caption: null,
      figureUrl: null,
      reason: `figure URL not on host allowlist (${figureUrl})`,
    };
  }
  // Find which tweet owns the figure URL.
  let ocrText = '';
  let found = false;
  for (const t of tweets) {
    const urls = t.image_urls ?? [];
    const idx = urls.indexOf(figureUrl);
    if (idx >= 0) {
      ocrText = (t.image_ocr_texts ?? [])[idx] ?? '';
      found = true;
      break;
    }
  }
  if (!found) {
    return { caption: null, figureUrl: null, reason: 'figure URL not in cluster (hallucinated)' };
  }
  // When OCR is unavailable globally, captions can't be validated AT ALL.
  // Drop the figure too. Claude #26.
  if (!ocrAvailable) {
    return {
      caption: null,
      figureUrl: null,
      reason: 'OCR unavailable → dropping both figure and caption (env-skew safety)',
    };
  }
  // OCR available but this image has no recognized text. Caption can't be
  // verified. Keep figure (it's the source image, no fabrication risk), drop
  // caption.
  if (!ocrText) {
    return {
      caption: null,
      figureUrl,
      reason: 'no OCR text for figure → caption cannot be validated, dropping caption',
    };
  }
  // Caption abstention is fine: model surfaced an image but didn't risk a
  // numeric caption. Keep figure, no caption.
  if (!caption) {
    return { caption: null, figureUrl };
  }

  const tokenRe = /\d+\.\d+|\.\d+|\d+/g;
  const ocrTokenSet = new Set((ocrText.match(tokenRe) ?? []).map(normalizeNumericToken));
  // v0.15: also verify CI/range groups as units (adjacency in the figure OCR),
  // so a fabricated interval built from two unrelated OCR numbers is caught.
  const ocrPairs = sourceAdjacentNumberPairs(ocrText);

  // Table-form caption: per-cell value check. Any unverified token OR range
  // drops the whole caption. Stricter than string caption because tables imply
  // higher-trust-than-prose data presentation.
  if (typeof caption !== 'string') {
    const cells = caption.rows.flat();
    if (cells.flatMap((c) => c.match(tokenRe) ?? []).length === 0) {
      return {
        caption: null,
        figureUrl,
        reason: 'caption table has no numeric tokens to validate → dropping (figure kept)',
      };
    }
    for (const cell of cells) {
      const bad = firstUnverifiedCellValue(cell, ocrTokenSet, ocrPairs);
      if (bad !== null) {
        return {
          caption: null,
          figureUrl,
          reason: `caption-table cell value "${bad}" not traceable to figure OCR → dropping caption (figure kept)`,
        };
      }
    }
    return { caption, figureUrl };
  }

  // String-form caption: same token + range check over the whole string.
  if ((caption.match(tokenRe) ?? []).length === 0) {
    return {
      caption: null,
      figureUrl,
      reason: 'caption has no numeric tokens to validate → dropping (figure kept)',
    };
  }
  const badCaptionValue = firstUnverifiedCellValue(caption, ocrTokenSet, ocrPairs);
  if (badCaptionValue !== null) {
    return {
      caption: null,
      figureUrl,
      reason: `caption value "${badCaptionValue}" not traceable to figure OCR → dropping caption (figure kept)`,
    };
  }
  return { caption, figureUrl };
}

// Normalize a numeric token to canonical form for set-equality.
// - Lowercase (irrelevant for digits but consistent)
// - Convert European decimal comma to period: "1,5" → "1.5"
// - Strip leading zero on small floats: "0.62" → ".62" (Vision often drops
//   the zero, so we canonicalize both ways)
function normalizeNumericToken(t: string): string {
  let v = t.toLowerCase().replace(/,/g, '.');
  if (/^0\.\d+$/.test(v)) v = v.slice(1); // "0.62" → ".62"
  return v;
}

function numericTokenInSet(captionToken: string, ocrSet: Set<string>): boolean {
  const c = normalizeNumericToken(captionToken);
  if (ocrSet.has(c)) return true;
  // If caption has a leading zero we stripped, also try with leading-zero
  // restored — covers OCR text that DID include the leading zero where the
  // caption didn't, or vice versa.
  if (c.startsWith('.')) {
    if (ocrSet.has('0' + c)) return true;
  } else if (/^0\./.test(c)) {
    if (ocrSet.has(c.slice(1))) return true;
  }
  return false;
}

// ── v0.15 hardening: verify multi-token cell VALUES, not just loose tokens ──
//
// The per-token check waves through a fabricated CI/range whose two bounds each
// happen to appear SOMEWHERE in source (the digest mixes thousands of numbers).
// These helpers add a second gate: a range/CI a cell writes WITH a connector
// ("0.48-0.79", "(2.2, 4.0)", "2 to 5") must match two numbers that sit ADJACENT
// in the source's numeric-token stream. Adjacency (not the literal delimiter) is
// the signal: a real CI's bounds are next to each other however source spaced
// them ("0.48 0.79", "0.48–0.79", "0.48, 0.79" all qualify), while two numbers
// glued from unrelated parts of the source never become an adjacent pair. A
// cross-arm juxtaposition ("28.6 vs 48.1") is NOT a range group, so it stays
// token-only — combining two separately-sourced arm values is the table's job.
//
// Deliberately CONSERVATIVE, in this order of preference for a clinical product:
// the worst failure is passing a fabricated number (a hallucinated CI shown as
// real), so the gate errs toward redaction. Two known imperfections, both
// acceptable under that priority:
//   - False positive: a real CI whose bounds have another NUMBER between them in
//     source (e.g. a forest-plot reference line "0.48 1.00 0.79") fails adjacency
//     and the table redacts to a flat fallback. That's the SAFE failure — omit,
//     don't hallucinate (VOICE rule) — not silent corruption.
//   - False negative: two unrelated numbers that happen to sit adjacent in prose
//     ("OS 28.6 mo and PFS 4.0 mo") can still back a fabricated "28.6-4.0". This
//     is no weaker than the pre-v0.15 token-only check; adjacency only ADDS a
//     constraint, never removes one. Fully closing it needs semantic grounding.
// Number sub-pattern for range extraction. Written so there is exactly ONE way
// to match a numeric token (`\d+` optionally `.\d+`, OR a bare `.\d+`). The
// ambiguous `\d*\.?\d+` form lets a long digit run backtrack super-linearly
// (catastrophic on a garbled OCR cell). The two range regexes are module-scoped
// (compiled once) and consumed via matchAll, which clones lastIndex per call.
const RANGE_NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;
const DASH_RANGE_RE = new RegExp(`(${RANGE_NUM})\\s*(?:[-–—]|to)\\s*(${RANGE_NUM})`, 'g');
// Comma-separated CI inside () OR [] brackets: "(2.2, 4.0)", "[0.48, 0.79]".
// (codex P2 — bracketed CIs were only loose-token checked.) Signed bounds are
// intentionally NOT matched: the source tokenizer drops the sign, so a signed
// cell pair could never match a source pair and would false-redact; signed CIs
// fall through to the token check, same as pre-v0.15.
const PAREN_COMMA_RE = new RegExp(`[([]\\s*(${RANGE_NUM})\\s*,\\s*(${RANGE_NUM})\\s*[)\\]]`, 'g');

// Canonical key for an unordered number pair: normalized + numerically sorted so
// "0.48-0.79", "0.79 0.48", and "(0.48, 0.79)" all collapse to one key.
function numberPairKey(a: string, b: string): string {
  const na = normalizeNumericToken(a);
  const nb = normalizeNumericToken(b);
  return [na, nb].sort((x, y) => parseFloat(x) - parseFloat(y)).join('~');
}

// Every adjacent pair of numeric tokens in source (non-numeric words ignored).
function sourceAdjacentNumberPairs(text: string): Set<string> {
  const tokenRe = /\d+\.\d+|\.\d+|\d+/g;
  const toks = text.match(tokenRe) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 1 < toks.length; i++) out.add(numberPairKey(toks[i], toks[i + 1]));
  return out;
}

// Range/CI pairs a cell binds with a connector (dash, "to", or a parenthetical
// comma). Returns canonical pair keys to check against source adjacency.
function cellRangeGroupKeys(cell: string): string[] {
  const out: string[] = [];
  for (const m of cell.matchAll(DASH_RANGE_RE)) out.push(numberPairKey(m[1], m[2]));
  for (const m of cell.matchAll(PAREN_COMMA_RE)) out.push(numberPairKey(m[1], m[2]));
  return out;
}

// First numeric value in a cell that can't be traced to source: a loose token
// absent from the token set, OR a CI/range whose bounds aren't adjacent in
// source. Returns the offending value for the redaction message, or null when
// every value verifies.
function firstUnverifiedCellValue(
  cell: string,
  sourceTokens: Set<string>,
  sourcePairs: Set<string>,
): string | null {
  const tokenRe = /\d+\.\d+|\.\d+|\d+/g;
  for (const tok of cell.match(tokenRe) ?? []) {
    if (!numericTokenInSet(tok, sourceTokens)) return tok;
  }
  for (const key of cellRangeGroupKeys(cell)) {
    if (!sourcePairs.has(key)) return key.replace('~', '-');
  }
  return null;
}

// Cap total images sent to a single Phase 2 agent. Spreads the cap across
// tweets in order — first tweets' images fill up first. Codex amended-plan
// finding #8: token cost can explode on big meeting days; the concurrency
// cap only controls rate, not total spend.
export function capStudyImages(tweets: DigestInputTweet[], maxImages: number): DigestInputTweet[] {
  if (maxImages <= 0) return tweets.map((t) => ({ ...t, image_urls: [], image_ocr_texts: [] }));
  let count = 0;
  const out: DigestInputTweet[] = [];
  for (const t of tweets) {
    const urls = t.image_urls ?? [];
    const ocrs = t.image_ocr_texts ?? [];
    if (count >= maxImages) {
      out.push({ ...t, image_urls: [], image_ocr_texts: [] });
      continue;
    }
    const remaining = maxImages - count;
    if (urls.length <= remaining) {
      count += urls.length;
      out.push(t);
    } else {
      count = maxImages;
      out.push({ ...t, image_urls: urls.slice(0, remaining), image_ocr_texts: ocrs.slice(0, remaining) });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 3 — synthesis
// ────────────────────────────────────────────────────────────────────────────

type SynthesisOutput = {
  top_line: string;
  tldr: string;
  site_meta: SiteMeta[];
};

async function runSynthesisPhase(
  client: LlmClient,
  studies: { cluster: StudyCluster; study: DigestStudy }[],
  opts: BuildOptions,
  maxRetries: number,
): Promise<SynthesisOutput> {
  const promptPath = opts.promptPaths?.synthesis ?? DEFAULT_PROMPTS.synthesis;
  const template = readFileSync(promptPath, 'utf-8');

  const studiesForPrompt = studies.map(({ cluster, study }) => ({
    slug: cluster.slug,
    name: study.name,
    disease_site: cluster.disease_site,
    tldr: study.tldr,
    details: study.details,
    nct: study.nct,
    figure_captions: (study.figures ?? []).map((f) => f.caption),
  }));

  const prompt = template
    .replace('{{VOICE}}', VOICE_POINTER)
    .replace('{{PERSPECTIVE}}', loadPerspective(opts.perspectiveName))
    .replace('{{STUDIES_JSON}}', JSON.stringify(studiesForPrompt, null, 2));

  const content: LlmContentBlock[] = [voiceCacheBlock(), { type: 'text', text: prompt }];

  const { value } = await completeAndParse(
    client,
    content,
    { model: opts.synthesisModel ?? opts.model, maxTokens: 2048, temperature: 0 },
    parseSynthesisResponse,
    maxRetries,
    'synthesis',
  );
  return value;
}

export function parseSynthesisResponse(raw: string): SynthesisOutput {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new DigestParseError(`Phase 3 not valid JSON: ${(err as Error).message}`, raw);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DigestParseError('Phase 3 root is not an object', raw);
  }
  const root = parsed as Record<string, unknown>;
  const top_line = typeof root.top_line === 'string' ? root.top_line.trim() : '';
  if (!top_line) throw new DigestParseError('Phase 3 missing top_line', raw);
  const tldr = typeof root.tldr === 'string' ? root.tldr.trim() : '';
  if (!tldr) throw new DigestParseError('Phase 3 missing tldr', raw);

  const site_meta: SiteMeta[] = [];
  if (Array.isArray(root.site_meta)) {
    for (const m of root.site_meta) {
      if (!m || typeof m !== 'object') continue;
      const meta = m as Record<string, unknown>;
      const slugRaw = typeof meta.disease_site === 'string' ? meta.disease_site.trim() : '';
      if (!slugRaw) continue;
      const disease_site = isValidDiseaseSiteSlug(slugRaw) ? slugRaw : 'other';
      const intro =
        typeof meta.intro === 'string' && meta.intro.trim() ? meta.intro.trim() : null;
      const open_questions =
        Array.isArray(meta.open_questions) && meta.open_questions.length > 0
          ? meta.open_questions
              .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
              .map((q) => q.trim())
          : null;
      site_meta.push({ disease_site, intro, open_questions });
    }
  }

  return { top_line, tldr, site_meta };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildImageManifest(tweets: DigestInputTweet[]): { text: string; urls: string[] } {
  const lines: string[] = [];
  const urls: string[] = [];
  let globalIdx = 0;
  for (const t of tweets) {
    const tweetUrls = t.image_urls ?? [];
    const ocrTexts = t.image_ocr_texts ?? [];
    tweetUrls.forEach((url, idx) => {
      globalIdx++;
      urls.push(url);
      const ocr = (ocrTexts[idx] ?? '').replace(/\s+/g, ' ').trim();
      const ocrSnippet = ocr ? ` | OCR: "${ocr.slice(0, 400)}${ocr.length > 400 ? '…' : ''}"` : '';
      lines.push(
        `  Image ${globalIdx}: tweet id ${t.id}, attached image #${idx + 1}, url=${url}${ocrSnippet}`,
      );
    });
  }
  const text = lines.length === 0 ? 'No images attached.' : lines.join('\n');
  return { text, urls };
}

// One LLM call + parse, with one schema-repair retry on parse failure or
// network error. Codex amended-plan finding #7: deterministic malformed JSON
// often comes from prompt pressure / truncation, not randomness — repair is
// cheap and beats dropping the study.
// v0.13: returns BOTH the parsed value AND the raw response string. The
// raw is needed by callers that read auxiliary fields the parseFn discarded
// (currently: runStudyAgent surfaces the raw to the related-trials
// orchestrator so it can read `related_search`). Existing callers that
// don't need the raw destructure { value } and ignore raw.
async function completeAndParse<T>(
  client: LlmClient,
  content: LlmContentBlock[],
  opts: { model?: string; maxTokens: number; temperature: number; thinkingBudget?: number },
  parseFn: (raw: string) => T,
  maxRetries: number,
  label: string,
): Promise<{ value: T; raw: string }> {
  let lastError: Error | undefined;
  let lastRaw: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptContent =
      attempt === 0
        ? content
        : [
            // Repair only needs to fix JSON shape; the model already saw the
            // images on attempt 0. Re-sending image blocks re-bills them (images
            // aren't prompt-cached) and bloats what is already the most expensive
            // call in the build (a truncation-driven failure means a long prompt).
            // Keep only the text blocks + the feedback.
            ...content.filter((b) => b.type === 'text'),
            {
              type: 'text' as const,
              text: `\n\nYour previous response could not be parsed. The error was: ${lastError?.message ?? 'unknown'}\n\nRe-emit ONLY the JSON object exactly as specified by the schema. No code fences, no explanation, no leading or trailing text. Your previous response was:\n${lastRaw ?? '(empty)'}`,
            },
          ];
    try {
      const raw = await client.complete([{ role: 'user', content: attemptContent }], {
        model: opts.model,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        thinkingBudget: opts.thinkingBudget,
      });
      lastRaw = raw;
      return { value: parseFn(raw), raw };
    } catch (err) {
      lastError = err as Error;
      // Continue retrying on network OR parse errors.
    }
  }
  throw new DigestParseError(
    `${label} failed after ${maxRetries + 1} attempts: ${lastError?.message ?? 'unknown'}`,
    lastRaw,
  );
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < n; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) break;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

// Extract the first balanced top-level JSON value ({...} or [...]) from a string
// the model may have wrapped in prose. Brace-counts with string/escape awareness
// so a brace inside a string literal doesn't skew the depth. Returns the input
// unchanged when there's no opening brace, and from the first brace to EOF when
// the value is unbalanced (truncated) — both leave JSON.parse to fail and the
// caller's repair retry to fire, as before.
export function extractJsonSpan(s: string): string {
  let start = -1;
  let open = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') {
      start = i;
      open = s[i]!;
      break;
    }
  }
  if (start === -1) return s;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

function stripFences(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  // Fence-stripping only handles the well-behaved fenced case. The model
  // (especially the claude-cli backend, which has no JSON mode) often wraps the
  // object in prose ("Here is the JSON: {...}") or appends a trailing sentence
  // after the closing fence — the anchored regexes miss both and JSON.parse
  // throws, dropping the study after one repair retry. Fall back to the first
  // balanced { } / [ ] span so the common offending shapes still parse.
  return extractJsonSpan(stripped);
}

export class DigestParseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = 'DigestParseError';
  }
}
