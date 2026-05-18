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
import { createLlmClient, type LlmClient } from './llm-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DigestInputTweet = {
  id: number;
  author: string | null;
  text: string;
  note?: string | null;
};

export type DigestCluster = {
  topic: string;
  emoji: string; // one emoji prefix from the prompt's emoji guide
  intro: string; // clinical context — 1-2 sentences
  methods: string | null; // trial design — 1-2 sentences when applicable
  results: string[]; // short bullets, effect sizes verbatim
  discussion: string[] | null; // implications/open questions, bullets
  tweet_ids: number[];
};

export type DigestOutput = {
  top_line: string; // one-sentence lede — the single most impactful finding
  tldr: string; // 2-3 sentence synthesis across topics
  clusters: DigestCluster[];
};

export type BuildOptions = {
  conferenceName: string;
  conferenceDay: number | string;
  promptPath?: string;
  model?: string;
  client?: LlmClient; // injected for tests; defaults to createLlmClient()
  maxRetries?: number;
};

const DEFAULT_PROMPT_PATH = resolve(__dirname, '../../prompts/digest-v2.txt');

export async function buildDigest(
  tweets: DigestInputTweet[],
  opts: BuildOptions,
): Promise<DigestOutput> {
  if (tweets.length === 0) {
    return {
      top_line: 'No bookmarks for this day.',
      tldr: 'No bookmarks for this day.',
      clusters: [],
    };
  }

  const promptTemplate = readFileSync(opts.promptPath ?? DEFAULT_PROMPT_PATH, 'utf-8');
  const prompt = promptTemplate
    .replace('{{CONFERENCE_NAME}}', opts.conferenceName)
    .replace('{{CONFERENCE_DAY}}', `Day ${opts.conferenceDay}`)
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

    let raw: string;
    try {
      raw = await client.complete([{ role: 'user', content: userPrompt }], {
        model: opts.model,
        maxTokens: 4096,
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

  if (!Array.isArray(obj.clusters)) {
    throw new DigestParseError('Missing or non-array clusters', raw);
  }

  const clusters: DigestCluster[] = [];
  for (const c of obj.clusters) {
    if (!c || typeof c !== 'object') continue;
    const cluster = c as Record<string, unknown>;
    const topic = typeof cluster.topic === 'string' ? cluster.topic.trim() : '';
    const intro = typeof cluster.intro === 'string' ? cluster.intro.trim() : '';
    const emoji = typeof cluster.emoji === 'string' ? cluster.emoji.trim() : '🩺';
    const methods =
      typeof cluster.methods === 'string' && cluster.methods.trim() ? cluster.methods.trim() : null;
    const results = Array.isArray(cluster.results)
      ? cluster.results
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
      : [];
    const discussion =
      Array.isArray(cluster.discussion) && cluster.discussion.length > 0
        ? cluster.discussion
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => s.trim())
        : null;
    const tweet_ids = Array.isArray(cluster.tweet_ids)
      ? cluster.tweet_ids.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];
    // A cluster needs topic + intro + at least one results bullet to be useful.
    if (!topic || !intro || results.length === 0) continue;
    clusters.push({ topic, emoji, intro, methods, results, discussion, tweet_ids });
  }

  if (clusters.length === 0) {
    throw new DigestParseError('No valid clusters in response', raw);
  }

  return { top_line, tldr, clusters };
}
