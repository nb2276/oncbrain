// LLM-as-judge eval for the digest pipeline.
//
// Inputs: a fixture (recorded set of tweets) + the digest the pipeline produced.
// Output: a structured score from a judge LLM across factual accuracy,
// clinical relevance, citation correctness, clustering quality, and a
// hallucination check. Any hallucination caps the overall score at 5.0.
//
// Used as a quality gate before shipping a prompt change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { DigestInputTweet, DigestOutput } from './llm-pipeline.ts';
import { createLlmClient, type LlmClient } from './llm-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type EvalFixture = {
  name: string;
  conference_name: string;
  conference_day: number | string;
  tweets: DigestInputTweet[];
};

export type DimensionScore = {
  score: number;
  notes: string;
};

export type EvalResult = {
  factual_accuracy: DimensionScore;
  clinical_relevance: DimensionScore;
  citation_correctness: DimensionScore;
  clustering_quality: DimensionScore;
  hallucinations_detected: string[];
  overall_score: number;
  verdict: string;
};

export type JudgeOptions = {
  promptPath?: string;
  model?: string;
  client?: LlmClient;
  maxRetries?: number;
};

export class EvalParseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = 'EvalParseError';
  }
}

const DEFAULT_JUDGE_PROMPT_PATH = resolve(__dirname, '../../prompts/eval-judge-v1.txt');

export async function judgeDigest(
  fixture: EvalFixture,
  digest: DigestOutput,
  opts: JudgeOptions = {},
): Promise<EvalResult> {
  const promptTemplate = readFileSync(opts.promptPath ?? DEFAULT_JUDGE_PROMPT_PATH, 'utf-8');
  const prompt = promptTemplate
    .replace('{{TWEETS_JSON}}', JSON.stringify(fixture.tweets, null, 2))
    .replace('{{DIGEST_JSON}}', JSON.stringify(digest, null, 2));

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
        maxTokens: 2048,
        temperature: 0,
      });
    } catch (err) {
      lastError = err as Error;
      continue;
    }

    lastRaw = raw;
    try {
      return parseEvalResult(raw);
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw new EvalParseError(
    `Failed to produce parseable eval result after ${maxRetries + 1} attempts: ${lastError?.message ?? 'unknown'}`,
    lastRaw,
  );
}

export function parseEvalResult(raw: string): EvalResult {
  if (!raw) throw new EvalParseError('Empty judge response');

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new EvalParseError(`Judge response not valid JSON: ${(err as Error).message}`, raw);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new EvalParseError('Judge response is not an object', raw);
  }
  const obj = parsed as Record<string, unknown>;

  const dimension = (key: string): DimensionScore => {
    const v = obj[key];
    if (!v || typeof v !== 'object') throw new EvalParseError(`Missing dimension: ${key}`, raw);
    const dim = v as Record<string, unknown>;
    const score = typeof dim.score === 'number' ? dim.score : NaN;
    const notes = typeof dim.notes === 'string' ? dim.notes : '';
    if (!Number.isFinite(score) || score < 1 || score > 10) {
      throw new EvalParseError(`Dimension ${key} has invalid score: ${dim.score}`, raw);
    }
    return { score, notes };
  };

  const factual_accuracy = dimension('factual_accuracy');
  const clinical_relevance = dimension('clinical_relevance');
  const citation_correctness = dimension('citation_correctness');
  const clustering_quality = dimension('clustering_quality');

  const hallucinations_detected = Array.isArray(obj.hallucinations_detected)
    ? obj.hallucinations_detected.filter((s): s is string => typeof s === 'string')
    : [];

  let overall_score =
    typeof obj.overall_score === 'number' && Number.isFinite(obj.overall_score)
      ? obj.overall_score
      : NaN;

  if (!Number.isFinite(overall_score)) {
    // The judge sometimes omits or miscomputes overall_score — compute it ourselves
    // as a defensive fallback. Use the same rule: mean of 4 dimensions, cap at 5 if
    // hallucinations exist.
    overall_score =
      (factual_accuracy.score +
        clinical_relevance.score +
        citation_correctness.score +
        clustering_quality.score) /
      4;
  }

  if (hallucinations_detected.length > 0 && overall_score > 5) {
    overall_score = 5;
  }

  const verdict = typeof obj.verdict === 'string' ? obj.verdict : '';

  return {
    factual_accuracy,
    clinical_relevance,
    citation_correctness,
    clustering_quality,
    hallucinations_detected,
    overall_score: Math.round(overall_score * 10) / 10,
    verdict,
  };
}

export type EvalCaseReport = {
  fixture_name: string;
  prompt_path: string;
  model: string;
  judge_model: string;
  digest: DigestOutput;
  result: EvalResult;
  generated_at: number;
};

export type EvalSummary = {
  pass_threshold: number;
  passed: boolean;
  cases: EvalCaseReport[];
  mean_overall_score: number;
};

export function summarize(cases: EvalCaseReport[], threshold: number): EvalSummary {
  const mean =
    cases.length === 0
      ? 0
      : cases.reduce((sum, c) => sum + c.result.overall_score, 0) / cases.length;
  return {
    pass_threshold: threshold,
    passed: cases.length > 0 && mean >= threshold,
    cases,
    mean_overall_score: Math.round(mean * 10) / 10,
  };
}
