// LLM digest pipeline.
//
// Design: single LLM call per day. Input is a day's bookmarked tweets;
// output is a structured digest (TL;DR + 2-6 topic clusters). Single call
// over multi-step pipeline because (a) ~20 tweets fits in context easily,
// (b) one call is cheaper and faster, (c) clustering decisions benefit from
// seeing all tweets together, not iteratively.
//
// Reliability: temperature=0 for stable output. On JSON parse failure,
// retry once with a clarifying prompt. On second failure, throw — caller
// (build pipeline) decides how to surface that to the user.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLlmClient, type LlmClient, type LlmContentBlock } from './llm-client.ts';
import { diseaseSiteSlugList, isValidDiseaseSiteSlug } from './disease-sites.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DigestInputTweet = {
  id: number;
  author: string | null;
  text: string;
  note?: string | null;
  // Direct pbs.twimg.com URLs for photos attached to the tweet.
  // The pipeline attaches these as image content blocks so the LLM can
  // read slide screenshots, KM curves, study schemas, etc.
  image_urls?: string[];
};

// One specific finding/trial discussed in tweets. Each gets its own
// one-sentence TL;DR plus bulleted details with effect sizes verbatim.
export type DigestStudy = {
  name: string; // trial name or specific topic ("PRESTIGE-PSMA", "RCC SBRT case series")
  tldr: string; // single-sentence headline with primary effect size
  details: string[]; // bullets — secondary endpoints, subgroup signals, methodology
  nct: string | null; // primary NCT id if explicit in tweets
  tweet_ids: number[];
};

// Disease-site grouping — the curator's organizing axis. Studies for a site
// are listed together; the site itself can carry one-line intro context and
// site-level open questions.
export type DigestSite = {
  disease_site: string; // enum slug from disease-sites.ts
  intro: string | null;
  studies: DigestStudy[];
  open_questions: string[] | null;
};

export type DigestOutput = {
  top_line: string; // one-sentence lede — the single most impactful finding
  tldr: string; // 2-3 sentence synthesis across the day
  sites: DigestSite[]; // grouped by disease site
};

export type BuildOptions = {
  conferenceName: string;
  conferenceDay: number | string;
  promptPath?: string;
  model?: string;
  client?: LlmClient; // injected for tests; defaults to createLlmClient()
  maxRetries?: number;
};

const DEFAULT_PROMPT_PATH = resolve(__dirname, '../../prompts/digest-v4.txt');

export async function buildDigest(
  tweets: DigestInputTweet[],
  opts: BuildOptions,
): Promise<DigestOutput> {
  if (tweets.length === 0) {
    return {
      top_line: 'No bookmarks for this day.',
      tldr: 'No bookmarks for this day.',
      sites: [],
    };
  }

  const promptTemplate = readFileSync(opts.promptPath ?? DEFAULT_PROMPT_PATH, 'utf-8');

  // Build an image manifest so the LLM can map attached image blocks back to
  // their source tweets. Images are listed in attachment order (tweet 1's
  // images first, then tweet 2's, etc.) — the same order they appear as
  // LlmImageBlocks in the user message below.
  const imageManifest: { tweet_id: number; image_index: number; global_index: number }[] = [];
  let globalIdx = 0;
  for (const t of tweets) {
    const urls = t.image_urls ?? [];
    urls.forEach((_, idx) => {
      globalIdx++;
      imageManifest.push({ tweet_id: t.id, image_index: idx + 1, global_index: globalIdx });
    });
  }
  const imageManifestText =
    imageManifest.length === 0
      ? 'No images attached.'
      : imageManifest
          .map((m) => `  Image ${m.global_index}: tweet id ${m.tweet_id}, attached image #${m.image_index}`)
          .join('\n');

  const prompt = promptTemplate
    .replace('{{CONFERENCE_NAME}}', opts.conferenceName)
    .replace('{{CONFERENCE_DAY}}', `Day ${opts.conferenceDay}`)
    .replace('{{SITE_SLUGS}}', diseaseSiteSlugList())
    .replace('{{IMAGE_MANIFEST}}', imageManifestText)
    .replace('{{TWEETS_JSON}}', JSON.stringify(tweets, null, 2));

  const client = opts.client ?? createLlmClient();
  const maxRetries = opts.maxRetries ?? 1;

  let lastError: Error | undefined;
  let lastRaw: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const userPrompt =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous response could not be parsed as JSON. Re-emit ONLY the JSON object, no other text. Previous response was:\n${lastRaw}`;

    // Build multimodal message: image content blocks (in manifest order) then
    // the text prompt. Anthropic API ignores order within a user message but
    // we keep images-first for the LLM's "context-loading" pattern.
    const content: LlmContentBlock[] = [];
    for (const t of tweets) {
      for (const url of t.image_urls ?? []) content.push({ type: 'image', url });
    }
    content.push({ type: 'text', text: userPrompt });

    let raw: string;
    try {
      raw = await client.complete([{ role: 'user', content }], {
        model: opts.model,
        // v4 outputs are longer (per-study bullets including comparison +
        // critique). Headroom matters more than tight budgeting for a side
        // project digest.
        maxTokens: 8192,
        temperature: 0,
      });
    } catch (err) {
      lastError = err as Error;
      continue;
    }

    lastRaw = raw;
    try {
      return parseDigest(raw);
    } catch (err) {
      lastError = err as Error;
      // fall through to retry
    }
  }

  throw new DigestParseError(
    `Failed to produce parseable digest after ${maxRetries + 1} attempts: ${lastError?.message ?? 'unknown'}`,
    lastRaw,
  );
}

export class DigestParseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = 'DigestParseError';
  }
}

export function parseDigest(raw: string): DigestOutput {
  if (!raw) throw new DigestParseError('Empty LLM response');

  // Strip code-fence wrappers if the model added them.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new DigestParseError(`Not valid JSON: ${(err as Error).message}`, raw);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new DigestParseError('Parsed value is not an object', raw);
  }
  const obj = parsed as Record<string, unknown>;

  const top_line = typeof obj.top_line === 'string' ? obj.top_line.trim() : '';
  if (!top_line) throw new DigestParseError('Missing or empty top_line', raw);

  const tldr = typeof obj.tldr === 'string' ? obj.tldr.trim() : '';
  if (!tldr) throw new DigestParseError('Missing or empty tldr', raw);

  if (!Array.isArray(obj.sites)) {
    throw new DigestParseError('Missing or non-array sites', raw);
  }

  const sites: DigestSite[] = [];
  for (const s of obj.sites) {
    if (!s || typeof s !== 'object') continue;
    const site = s as Record<string, unknown>;
    const slugRaw = typeof site.disease_site === 'string' ? site.disease_site.trim() : '';
    if (!slugRaw) continue;
    // Unknown slugs map to 'other' rather than dropping the whole site —
    // the curator still has data worth showing.
    const disease_site = isValidDiseaseSiteSlug(slugRaw) ? slugRaw : 'other';
    const intro =
      typeof site.intro === 'string' && site.intro.trim() ? site.intro.trim() : null;
    const open_questions =
      Array.isArray(site.open_questions) && site.open_questions.length > 0
        ? site.open_questions
            .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
            .map((q) => q.trim())
        : null;
    const studies = parseStudies(Array.isArray(site.studies) ? site.studies : []);
    if (studies.length === 0) continue; // a site without studies has nothing to display
    sites.push({ disease_site, intro, studies, open_questions });
  }

  if (sites.length === 0) {
    throw new DigestParseError('No valid sites in response', raw);
  }

  return { top_line, tldr, sites };
}

function parseStudies(input: unknown[]): DigestStudy[] {
  const out: DigestStudy[] = [];
  for (const s of input) {
    if (!s || typeof s !== 'object') continue;
    const study = s as Record<string, unknown>;
    const name = typeof study.name === 'string' ? study.name.trim() : '';
    const studyTldr = typeof study.tldr === 'string' ? study.tldr.trim() : '';
    const details = Array.isArray(study.details)
      ? study.details
          .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
          .map((d) => d.trim())
      : [];
    const nctRaw =
      typeof study.nct === 'string' && study.nct.trim() ? study.nct.trim().toUpperCase() : null;
    // Normalize: accept "NCT12345678" or bare "12345678"; emit canonical form
    // or null on failure to match.
    const nct =
      nctRaw && /^NCT\d{8}$/.test(nctRaw)
        ? nctRaw
        : nctRaw && /^\d{8}$/.test(nctRaw)
          ? `NCT${nctRaw}`
          : null;
    const tweet_ids = Array.isArray(study.tweet_ids)
      ? study.tweet_ids.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];
    // A study needs a name + tldr + at least one source tweet to be useful.
    if (!name || !studyTldr || tweet_ids.length === 0) continue;
    out.push({ name, tldr: studyTldr, details, nct, tweet_ids });
  }
  return out;
}
