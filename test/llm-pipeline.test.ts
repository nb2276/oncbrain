import { describe, it, expect, vi } from 'vitest';
import { buildDigest, parseDigest, DigestParseError } from '../src/lib/llm-pipeline.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';

function mockLlmClient(responseText: string | string[]): LlmClient {
  const queue = Array.isArray(responseText) ? [...responseText] : [responseText];
  const complete = vi.fn(async () => queue.shift() ?? queue[queue.length - 1] ?? '');
  return { complete };
}

const sampleTweets = [
  {
    id: 1,
    author: '@drfoo',
    text: 'NCT04567890 met its primary endpoint with HR 0.62 for OS in mCRPC.',
    note: 'practice-changing',
  },
  {
    id: 2,
    author: '@drbar',
    text: 'ARANOTE: enzalutamide + ADT shows 21mo improvement in rPFS.',
  },
  {
    id: 3,
    author: '@drbaz',
    text: 'TROP2 ADC datopotamab promising for triple-negative breast cancer.',
  },
];

const goodResponse = JSON.stringify({
  tldr: 'Two major mCRPC updates from oral session and a TROP2 ADC signal in TNBC.',
  clusters: [
    {
      topic: 'Metastatic Castration-Resistant Prostate Cancer',
      summary: 'NCT04567890 hit primary OS endpoint (HR 0.62). ARANOTE shows rPFS benefit with enza + ADT.',
      tweet_ids: [1, 2],
    },
    {
      topic: 'Triple-Negative Breast Cancer',
      summary: 'TROP2-targeting datopotamab shows promising activity.',
      tweet_ids: [3],
    },
  ],
});

describe('buildDigest', () => {
  it('returns parsed digest on a clean LLM response', async () => {
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client: mockLlmClient(goodResponse),
    });
    expect(result.tldr).toContain('mCRPC');
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]!.tweet_ids).toEqual([1, 2]);
  });

  it('returns empty digest for zero tweets without calling LLM', async () => {
    const client = mockLlmClient('SHOULD NOT BE CALLED');
    const result = await buildDigest([], {
      conferenceName: 'ASCO 2026',
      conferenceDay: 1,
      client,
    });
    expect(result.clusters).toEqual([]);
    expect(result.tldr).toMatch(/no bookmarks/i);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('retries once on malformed JSON and succeeds', async () => {
    const client = mockLlmClient(['not valid json {{', goodResponse]);
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      maxRetries: 1,
    });
    expect(result.clusters).toHaveLength(2);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('throws DigestParseError after exhausting retries', async () => {
    const client = mockLlmClient(['garbage 1', 'garbage 2']);
    await expect(
      buildDigest(sampleTweets, {
        conferenceName: 'ASCO 2026',
        conferenceDay: 2,
        client,
        maxRetries: 1,
      }),
    ).rejects.toBeInstanceOf(DigestParseError);
  });

  it('handles code-fence-wrapped JSON', async () => {
    const wrapped = '```json\n' + goodResponse + '\n```';
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client: mockLlmClient(wrapped),
    });
    expect(result.clusters).toHaveLength(2);
  });

  it('passes temperature=0 and the requested model to the client', async () => {
    const client = mockLlmClient(goodResponse);
    await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      model: 'claude-test-model',
    });
    // @ts-expect-error inspecting the mock
    const opts = client.complete.mock.calls[0][1];
    expect(opts.temperature).toBe(0);
    expect(opts.model).toBe('claude-test-model');
    expect(opts.maxTokens).toBe(4096);
  });
});

describe('parseDigest', () => {
  it('parses well-formed JSON', () => {
    const result = parseDigest(goodResponse);
    expect(result.tldr).toContain('mCRPC');
    expect(result.clusters).toHaveLength(2);
  });

  it('strips code fences before parsing', () => {
    const wrapped = '```json\n' + goodResponse + '\n```';
    const result = parseDigest(wrapped);
    expect(result.clusters).toHaveLength(2);
  });

  it('strips bare code fences', () => {
    const wrapped = '```\n' + goodResponse + '\n```';
    const result = parseDigest(wrapped);
    expect(result.clusters).toHaveLength(2);
  });

  it('throws on empty input', () => {
    expect(() => parseDigest('')).toThrow(DigestParseError);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseDigest('{not json}')).toThrow(DigestParseError);
  });

  it('throws when tldr is missing', () => {
    expect(() => parseDigest(JSON.stringify({ clusters: [{ topic: 't', summary: 's', tweet_ids: [] }] }))).toThrow(/tldr/);
  });

  it('throws when clusters is missing', () => {
    expect(() => parseDigest(JSON.stringify({ tldr: 'x' }))).toThrow(/clusters/);
  });

  it('throws when clusters array yields no valid cluster', () => {
    expect(() =>
      parseDigest(
        JSON.stringify({
          tldr: 'x',
          clusters: [{ topic: '', summary: 's' }, { topic: 't', summary: '' }],
        }),
      ),
    ).toThrow(/no valid clusters/i);
  });

  it('drops malformed clusters but keeps valid ones', () => {
    const mixed = JSON.stringify({
      tldr: 'mixed',
      clusters: [
        { topic: 'valid', summary: 'has both', tweet_ids: [1] },
        { topic: '', summary: 'invalid no topic' },
        { topic: 'also valid', summary: 'good', tweet_ids: ['not a number', 2] },
      ],
    });
    const result = parseDigest(mixed);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[1]!.tweet_ids).toEqual([2]); // string filtered out
  });
});
