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
import { createLlmClient, type LlmClient, type LlmContentBlock } from './llm-client.ts';
import { diseaseSiteSlugList, isValidDiseaseSiteSlug } from './disease-sites.ts';
import { loadStudyContext, isSafeSlug } from './study-retrieval.ts';
import { isOcrAvailable, isSafeImageUrl } from './vision-ocr.ts';
import { buildAssociationGraph, renderGroupsForPrompt } from './source-association.ts';

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

export type DigestStudy = {
  name: string;
  tldr: string;
  details: DigestDetail[];
  key_figure_url: string | null;
  // v0.4.3: caption may be a flat string OR a table for comparison figures
  // (KM curves, forest plots, AE comparisons). Table form is preferred when
  // the figure has 2+ rows × 2+ columns of comparable data.
  key_figure_caption: string | DigestTable | null;
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
  // v0.8.1: unresolved questions this study raises, rendered as a separated
  // block under the study card. Phase 2 (study agent) owns these now; older
  // artifacts carry them at the site level (DigestSite.open_questions), which
  // renderers fall back to.
  open_questions?: string[] | null;
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
  // Optional model override for Phase 2 (per-study agents) only — the deep
  // analysis step. Lets you run Opus there (e.g. 'opus' on claude-cli,
  // 'claude-opus-4-7' on api) while Phase 1/3 stay on the cheaper default.
  // Falls back to `model` when unset.
  studyModel?: string;
  client?: LlmClient;
  maxRetries?: number;
  studyAgentConcurrency?: number;
  maxImagesPerStudy?: number; // cap to control Phase 2 token cost; default 6
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

type StudyCluster = {
  slug: string;
  name: string;
  disease_site: string;
  tweet_ids: number[];
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
      const study = await runStudyAgent(client, cluster, capped, opts, maxRetries, ocrAvailable);
      successful.push({ cluster, study });
    } catch (err) {
      const reason = (err as Error).message;
      dropped.push({ slug: cluster.slug, name: cluster.name, reason });
      console.warn(`  [phase2] dropped ${cluster.slug} (${cluster.name}): ${reason}`);
    }
  });

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

  return completeAndParse(
    client,
    content,
    { model: opts.model, maxTokens: 4096, temperature: 0 },
    (raw) => parseGroupingResponse(raw, tweets),
    maxRetries,
    'grouping',
  );
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
    seenSlugs.add(slugRaw);
    out.push({ slug: slugRaw, name, disease_site, tweet_ids });
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

async function runStudyAgent(
  client: LlmClient,
  cluster: StudyCluster,
  tweets: DigestInputTweet[],
  opts: BuildOptions,
  maxRetries: number,
  ocrAvailable: boolean,
): Promise<DigestStudy> {
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

  const prompt = template
    .replace('{{VOICE}}', VOICE_POINTER)
    .replace('{{STUDY_NAME}}', cluster.name)
    .replace('{{STUDY_SLUG}}', cluster.slug)
    .replace('{{DISEASE_SITE}}', cluster.disease_site)
    .replace('{{IMAGE_MANIFEST}}', manifest.text)
    .replace('{{TWEETS_JSON}}', JSON.stringify(tweetsForPrompt, null, 2))
    .replace('{{PRIOR_CONTEXT_BLOCK}}', priorContextBlock);

  const content: LlmContentBlock[] = [voiceCacheBlock()];
  for (const url of manifest.urls) content.push({ type: 'image', url });
  content.push({ type: 'text', text: prompt });

  const study = await completeAndParse(
    client,
    content,
    // Phase 2 is the deep-analysis step — honor a studyModel override (e.g. Opus).
    { model: opts.studyModel ?? opts.model, maxTokens: 4096, temperature: 0 },
    (raw) => parseStudyAgentResponse(raw, cluster),
    maxRetries,
    `phase2:${cluster.slug}`,
  );

  // Post-hoc validation of key_figure: drop caption if numeric tokens
  // aren't traceable to OCR text for that figure. Drop both if figure URL
  // isn't actually in the cluster.
  const validated = validateKeyFigure(
    study.key_figure_caption,
    study.key_figure_url,
    tweets,
    ocrAvailable,
  );
  if (validated.reason) {
    console.warn(`  [phase2:${cluster.slug}] key_figure: ${validated.reason}`);
  }

  // v0.4.2: Numbers in table cells get the same OCR/source-text validation.
  // Table is structurally regular (rows × columns), so cell-level validation
  // is straightforward. If any cell has a number not present in the union
  // of tweet text + image OCR, the whole table is replaced with a flat
  // string noting the drop. Conservative: a half-validated table is more
  // misleading than no table.
  const detailsValidated = validateStudyTables(
    { ...study, key_figure_url: validated.figureUrl, key_figure_caption: validated.caption },
    tweets,
    cluster.slug,
  );

  // v0.4.4 backstop: if the LLM emitted both a table caption AND a detail
  // table covering the same columns, drop the detail-table. Prompt-level
  // rule asks for non-duplication; this is the safety net.
  return dedupTablesAgainstCaption(detailsValidated, cluster.slug);
}

// If the caption is a table, drop any detail-table whose column set
// overlaps ≥2 headers with the caption. Replaces the detail-table with a
// flat string of just its `text` label so the reader still sees the bullet
// concept but not the duplicate matrix.
export function dedupTablesAgainstCaption(
  study: DigestStudy,
  slug?: string,
): DigestStudy {
  const cap = study.key_figure_caption;
  if (!cap || typeof cap === 'string') return study;
  const capCols = new Set(cap.columns.map((c) => c.trim().toLowerCase()));
  let dropped = 0;
  const newDetails: DigestDetail[] = study.details.map((d) => {
    if (!isTableDetail(d)) return d;
    const detailCols = d.table.columns.map((c) => c.trim().toLowerCase());
    let shared = 0;
    for (const c of detailCols) if (capCols.has(c)) shared++;
    if (shared >= 2) {
      dropped++;
      return d.text; // keep the parent label, drop the duplicate matrix
    }
    return d;
  });
  if (dropped > 0 && slug) {
    console.warn(
      `  [phase2:${slug}] dropped ${dropped} detail-table(s): duplicates caption-table columns`,
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
  const sourceText = collectStudySourceText(tweets);
  const tokenRe = /\d+\.\d+|\.\d+|\d+/g;
  const sourceTokens = new Set(
    (sourceText.match(tokenRe) ?? []).map(normalizeNumericToken),
  );

  let dropped = 0;
  const newDetails: DigestDetail[] = study.details.map((d) => {
    if (!isTableDetail(d)) return d;
    const cellTokens = d.table.rows.flat().flatMap((cell) => cell.match(tokenRe) ?? []);
    for (const t of cellTokens) {
      if (!numericTokenInSet(t, sourceTokens)) {
        dropped++;
        return `${d.text} — comparison values omitted (cell number "${t}" not verified in source)`;
      }
    }
    return d;
  });

  if (dropped > 0 && slug) {
    console.warn(`  [phase2:${slug}] dropped ${dropped} table(s): unverified numeric token(s)`);
  }
  return { ...study, details: newDetails };
}

function collectStudySourceText(tweets: DigestInputTweet[]): string {
  const parts: string[] = [];
  for (const t of tweets) {
    parts.push(t.text);
    for (const ocr of t.image_ocr_texts ?? []) parts.push(ocr);
  }
  return parts.join(' ');
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
  const key_figure_url =
    typeof root.key_figure_url === 'string' && root.key_figure_url.trim()
      ? root.key_figure_url.trim()
      : null;
  // v0.4.3: caption can be flat string OR a {columns, rows} table for
  // comparison figures. Parser collapses degenerate tables (<2 columns
  // or 0 rows) by dropping caption entirely — the LLM signaled intent
  // for a table but didn't fill it.
  let key_figure_caption: string | DigestTable | null = null;
  if (typeof root.key_figure_caption === 'string' && root.key_figure_caption.trim()) {
    key_figure_caption = root.key_figure_caption.trim();
  } else if (root.key_figure_caption && typeof root.key_figure_caption === 'object') {
    const tbl = root.key_figure_caption as Record<string, unknown>;
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
    if (columns.length >= 2 && rows.length >= 1) {
      key_figure_caption = { columns, rows };
    }
  }

  return {
    name,
    tldr,
    details,
    key_figure_url,
    key_figure_caption,
    nct,
    tweet_ids: cluster.tweet_ids,
    slug: cluster.slug,
    verdict: parseVerdict(root.verdict),
    open_questions: parseOpenQuestions(root.open_questions),
  };
}

// Parses the optional verdict block emitted by Phase 2. Forgiving: if the
// field is missing or malformed, return undefined and the renderer falls
// back to the bullet-only layout (graceful for older artifacts).
//   - soc_implication: validated against the enum; invalid/missing → 'unclear'
//   - rationale: trimmed; capped at 40 words (prompt asks for 30, allow slop)
//   - audience: trimmed string or null; capped at 120 chars (prompt asks 80)
export function parseVerdict(raw: unknown): StudyVerdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const rawSoc = typeof obj.soc_implication === 'string' ? obj.soc_implication.trim() : '';
  const soc: SocImplication = (SOC_IMPLICATIONS as readonly string[]).includes(rawSoc)
    ? (rawSoc as SocImplication)
    : 'unclear';
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

  // Table-form caption: per-cell numeric token check. Any unverified
  // number drops the whole caption. Stricter than string caption because
  // tables imply higher-trust-than-prose data presentation.
  if (typeof caption !== 'string') {
    const cellTokens = caption.rows.flat().flatMap((c) => c.match(tokenRe) ?? []);
    if (cellTokens.length === 0) {
      return {
        caption: null,
        figureUrl,
        reason: 'caption table has no numeric tokens to validate → dropping (figure kept)',
      };
    }
    for (const tok of cellTokens) {
      if (!numericTokenInSet(tok, ocrTokenSet)) {
        return {
          caption: null,
          figureUrl,
          reason: `caption-table cell number "${tok}" not in OCR token set → dropping caption (figure kept)`,
        };
      }
    }
    return { caption, figureUrl };
  }

  // String-form caption: existing v0.4 behavior.
  const captionTokens = caption.match(tokenRe) ?? [];
  if (captionTokens.length === 0) {
    return {
      caption: null,
      figureUrl,
      reason: 'caption has no numeric tokens to validate → dropping (figure kept)',
    };
  }
  for (const tok of captionTokens) {
    if (!numericTokenInSet(tok, ocrTokenSet)) {
      return {
        caption: null,
        figureUrl,
        reason: `caption number "${tok}" not in OCR token set → dropping caption (figure kept)`,
      };
    }
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
    key_figure_caption: study.key_figure_caption,
  }));

  const prompt = template
    .replace('{{VOICE}}', VOICE_POINTER)
    .replace('{{STUDIES_JSON}}', JSON.stringify(studiesForPrompt, null, 2));

  const content: LlmContentBlock[] = [voiceCacheBlock(), { type: 'text', text: prompt }];

  return completeAndParse(
    client,
    content,
    { model: opts.model, maxTokens: 2048, temperature: 0 },
    parseSynthesisResponse,
    maxRetries,
    'synthesis',
  );
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
async function completeAndParse<T>(
  client: LlmClient,
  content: LlmContentBlock[],
  opts: { model?: string; maxTokens: number; temperature: number },
  parseFn: (raw: string) => T,
  maxRetries: number,
  label: string,
): Promise<T> {
  let lastError: Error | undefined;
  let lastRaw: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptContent =
      attempt === 0
        ? content
        : [
            ...content,
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
      });
      lastRaw = raw;
      return parseFn(raw);
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

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export class DigestParseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = 'DigestParseError';
  }
}
