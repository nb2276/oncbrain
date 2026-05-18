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

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DigestInputTweet = {
  id: number;
  author: string | null;
  text: string;
  note?: string | null;
  image_urls?: string[];
  // Apple Vision OCR text, aligned by index to image_urls.
  // Empty string = OCR not available / failed for that image.
  image_ocr_texts?: string[];
};

export type DigestStudy = {
  name: string;
  tldr: string;
  details: string[];
  key_figure_url: string | null;
  key_figure_caption: string | null;
  nct: string | null;
  tweet_ids: number[];
};

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
  tweets: DigestInputTweet[],
  opts: BuildOptions,
): Promise<DigestOutput> {
  const ocrAvailable = isOcrAvailable();

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
  const clusters = await runGroupingPhase(client, tweets, opts, maxRetries);
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

  return {
    top_line: synthesis.top_line,
    tldr: synthesis.tldr,
    sites: Array.from(sitesMap.values()),
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

  const prompt = template
    .replace('{{CONFERENCE_NAME}}', opts.conferenceName)
    .replace('{{CONFERENCE_DAY}}', `Day ${opts.conferenceDay}`)
    .replace('{{SITE_SLUGS}}', diseaseSiteSlugList())
    .replace('{{IMAGE_MANIFEST}}', manifest.text)
    .replace('{{TWEETS_JSON}}', JSON.stringify(tweetsForPrompt, null, 2));

  const content: LlmContentBlock[] = [];
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
    .replace('{{STUDY_NAME}}', cluster.name)
    .replace('{{STUDY_SLUG}}', cluster.slug)
    .replace('{{DISEASE_SITE}}', cluster.disease_site)
    .replace('{{IMAGE_MANIFEST}}', manifest.text)
    .replace('{{TWEETS_JSON}}', JSON.stringify(tweetsForPrompt, null, 2))
    .replace('{{PRIOR_CONTEXT_BLOCK}}', priorContextBlock);

  const content: LlmContentBlock[] = [];
  for (const url of manifest.urls) content.push({ type: 'image', url });
  content.push({ type: 'text', text: prompt });

  const study = await completeAndParse(
    client,
    content,
    { model: opts.model, maxTokens: 4096, temperature: 0 },
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
  return {
    ...study,
    key_figure_url: validated.figureUrl,
    key_figure_caption: validated.caption,
  };
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
  const details = Array.isArray(root.details)
    ? root.details
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => d.trim())
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
  const key_figure_caption =
    typeof root.key_figure_caption === 'string' && root.key_figure_caption.trim()
      ? root.key_figure_caption.trim()
      : null;

  return {
    name,
    tldr,
    details,
    key_figure_url,
    key_figure_caption,
    nct,
    tweet_ids: cluster.tweet_ids,
  };
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
  caption: string | null,
  figureUrl: string | null,
  tweets: DigestInputTweet[],
  ocrAvailable: boolean,
): { caption: string | null; figureUrl: string | null; reason?: string } {
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
  // Drop the figure too: rendering an uncaptioned figure looks like editorial
  // choice rather than a technical limit and over-weights model selection.
  // Claude #26.
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
  // Tokenize both sides into the same numeric grammar, then require set
  // membership (not substring). "0.6" no longer matches "0.62" — they're
  // distinct tokens. The pattern matches ".62" (Vision-style without leading
  // zero), "0.62" (with leading zero), and "62" (integer) so OCR ↔ caption
  // can canonicalize across either convention.
  const tokenRe = /\d+\.\d+|\.\d+|\d+/g;
  const captionTokens = caption.match(tokenRe) ?? [];

  // Claude #2: a caption with zero numeric anchors can't be validated.
  // The validator's purpose is to check numbers, so a caption without any
  // is rejected outright.
  if (captionTokens.length === 0) {
    return {
      caption: null,
      figureUrl,
      reason: 'caption has no numeric tokens to validate → dropping (figure kept)',
    };
  }
  const ocrTokenSet = new Set((ocrText.match(tokenRe) ?? []).map(normalizeNumericToken));
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

  const prompt = template.replace('{{STUDIES_JSON}}', JSON.stringify(studiesForPrompt, null, 2));

  const content: LlmContentBlock[] = [{ type: 'text', text: prompt }];

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
