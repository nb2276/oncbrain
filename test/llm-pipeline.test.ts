import { describe, it, expect, vi } from 'vitest';
import { buildDigest, parseDigest, DigestParseError } from '../src/lib/llm-pipeline.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';

function mockLlmClient(responseText: string | string[]): LlmClient {
  const queue = Array.isArray(responseText) ? [...responseText] : [responseText];
  const complete = vi.fn(async () => queue.shift() ?? queue[queue.length - 1] ?? '');
  return { complete };
}

const sampleTweets = [
  { id: 1, author: '@drfoo', text: 'NCT04567890 OS HR 0.62 in mCRPC.', note: null },
  { id: 2, author: '@drbar', text: 'ARANOTE rPFS 21mo with enza+ADT.', note: null },
  { id: 3, author: '@drbaz', text: 'Datopotamab TNBC ORR 41% 2L.', note: null },
];

const goodResponse = JSON.stringify({
  top_line: 'NCT04567890 delivers OS HR 0.62 in mCRPC — first-line indication imminent.',
  tldr: 'mCRPC OS endpoint hit. mHSPC ADT intensification supported. TROP2 ADC momentum in TNBC.',
  clusters: [
    {
      topic: 'Metastatic Castration-Resistant Prostate Cancer',
      emoji: '🍇',
      intro: 'mCRPC remains a setting with significant unmet need for OS-prolonging therapies.',
      methods: 'NCT04567890: phase III, randomized, ARPI + agent X vs ARPI alone, primary endpoint OS.',
      results: [
        'NCT04567890 met primary OS endpoint, HR 0.62',
        'Median OS not yet reached in experimental arm',
      ],
      discussion: ['Sequencing vs taxanes remains open', 'Awaiting full publication for QoL data'],
      tweet_ids: [1],
    },
    {
      topic: 'TROP2-Directed ADCs in Triple-Negative Breast Cancer',
      emoji: '🎯',
      intro: 'TROP2-targeted ADCs continue to mature as a second-line option in mTNBC.',
      methods: null,
      results: ['Datopotamab deruxtecan ORR 41% in 2L mTNBC'],
      discussion: null,
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
    expect(result.top_line).toContain('NCT04567890');
    expect(result.tldr).toContain('mCRPC');
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]!.emoji).toBe('🍇');
    expect(result.clusters[0]!.results).toHaveLength(2);
    expect(result.clusters[1]!.methods).toBeNull();
    expect(result.clusters[1]!.discussion).toBeNull();
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
    expect(result.top_line).toMatch(/no bookmarks/i);
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
  it('parses well-formed JSON with IMRD schema', () => {
    const result = parseDigest(goodResponse);
    expect(result.top_line).toContain('NCT04567890');
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

  it('throws when top_line is missing', () => {
    const broken = JSON.parse(goodResponse);
    delete broken.top_line;
    expect(() => parseDigest(JSON.stringify(broken))).toThrow(/top_line/);
  });

  it('throws when tldr is missing', () => {
    const broken = JSON.parse(goodResponse);
    delete broken.tldr;
    expect(() => parseDigest(JSON.stringify(broken))).toThrow(/tldr/);
  });

  it('throws when clusters is missing', () => {
    expect(() =>
      parseDigest(JSON.stringify({ top_line: 'x', tldr: 'y' })),
    ).toThrow(/clusters/);
  });

  it('throws when clusters array yields no valid cluster', () => {
    expect(() =>
      parseDigest(
        JSON.stringify({
          top_line: 'x',
          tldr: 'y',
          clusters: [{ topic: '', intro: 'has intro', results: ['r'] }],
        }),
      ),
    ).toThrow(/no valid clusters/i);
  });

  it('drops clusters with missing intro or empty results', () => {
    const mixed = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      clusters: [
        {
          topic: 'valid',
          emoji: '🎯',
          intro: 'has all required fields',
          methods: null,
          results: ['effect size N'],
          discussion: null,
          tweet_ids: [1],
        },
        { topic: 'no intro', intro: '', results: ['r1'] },
        { topic: 'empty results', intro: 'x', results: [] },
      ],
    });
    const result = parseDigest(mixed);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.topic).toBe('valid');
  });

  it('defaults emoji to 🩺 when missing', () => {
    const noEmoji = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      clusters: [
        { topic: 't', intro: 'i', results: ['r'], tweet_ids: [1] },
      ],
    });
    const result = parseDigest(noEmoji);
    expect(result.clusters[0]!.emoji).toBe('🩺');
  });

  it('normalizes methods="" to null', () => {
    const empty = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      clusters: [
        { topic: 't', emoji: '🩺', intro: 'i', methods: '', results: ['r'], tweet_ids: [1] },
      ],
    });
    const result = parseDigest(empty);
    expect(result.clusters[0]!.methods).toBeNull();
  });

  it('filters non-string entries from results array', () => {
    const noisy = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      clusters: [
        {
          topic: 't',
          emoji: '🩺',
          intro: 'i',
          results: ['real bullet', 42, null, '  ', 'another'],
          tweet_ids: [1],
        },
      ],
    });
    const result = parseDigest(noisy);
    expect(result.clusters[0]!.results).toEqual(['real bullet', 'another']);
  });
});
