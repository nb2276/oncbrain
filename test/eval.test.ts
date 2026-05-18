import { describe, it, expect, vi } from 'vitest';
import {
  judgeDigest,
  parseEvalResult,
  summarize,
  EvalParseError,
  type EvalCaseReport,
  type EvalFixture,
} from '../src/lib/eval.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';
import type { DigestOutput } from '../src/lib/llm-pipeline.ts';

function mockLlmClient(responseText: string | string[]): LlmClient {
  const queue = Array.isArray(responseText) ? [...responseText] : [responseText];
  const complete = vi.fn(async () => queue.shift() ?? queue[queue.length - 1] ?? '');
  return { complete };
}

const goodResult = {
  factual_accuracy: { score: 9, notes: 'Claims match inputs.' },
  clinical_relevance: { score: 8, notes: 'TL;DR leads with strongest finding.' },
  citation_correctness: { score: 10, notes: 'All NCTs and PMIDs spelled correctly.' },
  clustering_quality: { score: 8, notes: 'Three topic clusters, well-separated.' },
  hallucinations_detected: [],
  overall_score: 8.75,
  verdict: 'Ship-quality digest.',
};

const sampleFixture: EvalFixture = {
  name: 'test',
  conference_name: 'Test Conf',
  conference_day: 1,
  tweets: [{ id: 1, author: '@x', text: 'NCT12345678 hit primary endpoint.', note: null }],
};

const sampleDigest: DigestOutput = {
  top_line: 'NCT12345678 hit primary endpoint in mCRPC.',
  tldr: 'NCT12345678 hit primary endpoint.',
  sites: [
    {
      disease_site: 'prostate',
      intro: 'mCRPC remains a high-need setting.',
      studies: [
        {
          name: 'PRESTIGE-PSMA',
          tldr: 'NCT12345678 hit primary endpoint.',
          details: ['Primary endpoint met'],
          nct: 'NCT12345678',
          tweet_ids: [1],
        },
      ],
      open_questions: null,
    },
  ],
};

describe('parseEvalResult', () => {
  it('parses a clean judge response', () => {
    const result = parseEvalResult(JSON.stringify(goodResult));
    expect(result.factual_accuracy.score).toBe(9);
    expect(result.overall_score).toBe(8.8); // rounded to 1 decimal
    expect(result.hallucinations_detected).toEqual([]);
  });

  it('caps overall_score at 5 when hallucinations are detected', () => {
    const withHall = {
      ...goodResult,
      hallucinations_detected: ['Fabricated drug name "fakelumab"'],
      overall_score: 9.0,
    };
    const result = parseEvalResult(JSON.stringify(withHall));
    expect(result.overall_score).toBe(5.0);
  });

  it('computes overall_score from dimensions when judge omits it', () => {
    const withoutOverall = { ...goodResult } as Record<string, unknown>;
    delete withoutOverall.overall_score;
    const result = parseEvalResult(JSON.stringify(withoutOverall));
    expect(result.overall_score).toBe(8.8); // (9+8+10+8)/4 = 8.75 → 8.8
  });

  it('strips code fences', () => {
    const wrapped = '```json\n' + JSON.stringify(goodResult) + '\n```';
    const result = parseEvalResult(wrapped);
    expect(result.factual_accuracy.score).toBe(9);
  });

  it('throws on missing dimension', () => {
    const broken = { ...goodResult } as Record<string, unknown>;
    delete broken.factual_accuracy;
    expect(() => parseEvalResult(JSON.stringify(broken))).toThrow(/factual_accuracy/);
  });

  it('throws on out-of-range score', () => {
    const broken = {
      ...goodResult,
      factual_accuracy: { score: 11, notes: 'too high' },
    };
    expect(() => parseEvalResult(JSON.stringify(broken))).toThrow(/invalid score/);
  });

  it('throws on score below 1', () => {
    const broken = {
      ...goodResult,
      factual_accuracy: { score: 0, notes: 'zero' },
    };
    expect(() => parseEvalResult(JSON.stringify(broken))).toThrow(/invalid score/);
  });

  it('throws on empty input', () => {
    expect(() => parseEvalResult('')).toThrow(EvalParseError);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseEvalResult('{not json}')).toThrow(EvalParseError);
  });

  it('preserves notes strings on each dimension', () => {
    const result = parseEvalResult(JSON.stringify(goodResult));
    expect(result.factual_accuracy.notes).toBe('Claims match inputs.');
    expect(result.clustering_quality.notes).toBe('Three topic clusters, well-separated.');
  });

  it('filters non-string entries from hallucinations array', () => {
    const noisy = { ...goodResult, hallucinations_detected: ['real hallucination', 42, null] };
    const result = parseEvalResult(JSON.stringify(noisy));
    expect(result.hallucinations_detected).toEqual(['real hallucination']);
  });
});

describe('judgeDigest', () => {
  it('returns parsed eval result on clean response', async () => {
    const client = mockLlmClient(JSON.stringify(goodResult));
    const result = await judgeDigest(sampleFixture, sampleDigest, { client });
    expect(result.overall_score).toBe(8.8);
  });

  it('retries on malformed JSON and succeeds', async () => {
    const client = mockLlmClient(['garbage', JSON.stringify(goodResult)]);
    const result = await judgeDigest(sampleFixture, sampleDigest, { client, maxRetries: 1 });
    expect(result.factual_accuracy.score).toBe(9);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('throws EvalParseError after exhausting retries', async () => {
    const client = mockLlmClient(['garbage1', 'garbage2']);
    await expect(
      judgeDigest(sampleFixture, sampleDigest, { client, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(EvalParseError);
  });

  it('passes temperature=0 to the judge', async () => {
    const client = mockLlmClient(JSON.stringify(goodResult));
    await judgeDigest(sampleFixture, sampleDigest, { client });
    // @ts-expect-error inspecting the mock
    const opts = client.complete.mock.calls[0][1];
    expect(opts.temperature).toBe(0);
    expect(opts.maxTokens).toBe(2048);
  });
});

describe('summarize', () => {
  function makeCase(score: number, name = 'case'): EvalCaseReport {
    return {
      fixture_name: name,
      prompt_path: 'prompts/digest-v1.txt',
      model: 'claude-sonnet-4-6',
      judge_model: 'claude-sonnet-4-6',
      digest: sampleDigest,
      result: {
        ...goodResult,
        overall_score: score,
      },
      generated_at: 0,
    };
  }

  it('computes mean of overall scores', () => {
    const summary = summarize([makeCase(8.0, 'a'), makeCase(9.0, 'b')], 8);
    expect(summary.mean_overall_score).toBe(8.5);
  });

  it('passes when mean >= threshold', () => {
    const summary = summarize([makeCase(8.0), makeCase(9.0)], 8);
    expect(summary.passed).toBe(true);
  });

  it('fails when mean below threshold', () => {
    const summary = summarize([makeCase(7.5), makeCase(7.0)], 8);
    expect(summary.passed).toBe(false);
  });

  it('fails on empty cases array', () => {
    const summary = summarize([], 8);
    expect(summary.passed).toBe(false);
    expect(summary.mean_overall_score).toBe(0);
  });

  it('rounds mean to one decimal', () => {
    const summary = summarize([makeCase(8.33), makeCase(7.77)], 8);
    expect(summary.mean_overall_score).toBe(8.1); // 8.05 → 8.1 (banker's rounding edge, but JS Math.round rounds half-away from zero for positive)
  });
});
