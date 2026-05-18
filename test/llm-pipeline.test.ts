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
  top_line: 'NCT04567890 delivers OS HR 0.62 in mCRPC.',
  tldr: 'mCRPC OS endpoint hit. TROP2 ADC momentum in TNBC.',
  sites: [
    {
      disease_site: 'prostate',
      intro: 'Two trials reported new prostate data.',
      studies: [
        {
          name: 'PRESTIGE-PSMA',
          tldr: 'OS HR 0.62 in mCRPC, primary endpoint met.',
          details: ['HR 0.62 (95% CI 0.45-0.85)', 'Median OS not yet reached'],
          nct: 'NCT04567890',
          tweet_ids: [1],
        },
        {
          name: 'ARANOTE',
          tldr: 'rPFS improvement of 21 months with enzalutamide + ADT.',
          details: ['rPFS gain 21 months vs placebo'],
          nct: null,
          tweet_ids: [2],
        },
      ],
      open_questions: ['Sequencing vs taxanes'],
    },
    {
      disease_site: 'breast',
      intro: null,
      studies: [
        {
          name: 'Datopotamab in 2L TNBC',
          tldr: 'ORR 41% in second-line triple-negative breast cancer.',
          details: ['ORR 41%, durable responses ongoing'],
          nct: null,
          tweet_ids: [3],
        },
      ],
      open_questions: null,
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
    expect(result.sites).toHaveLength(2);
    expect(result.sites[0]!.disease_site).toBe('prostate');
    expect(result.sites[0]!.studies).toHaveLength(2);
    expect(result.sites[0]!.studies[0]!.tldr).toContain('HR 0.62');
    expect(result.sites[0]!.studies[0]!.nct).toBe('NCT04567890');
    expect(result.sites[1]!.disease_site).toBe('breast');
    expect(result.sites[1]!.studies[0]!.nct).toBeNull();
  });

  it('returns empty digest for zero tweets without calling LLM', async () => {
    const client = mockLlmClient('SHOULD NOT BE CALLED');
    const result = await buildDigest([], {
      conferenceName: 'ASCO 2026',
      conferenceDay: 1,
      client,
    });
    expect(result.sites).toEqual([]);
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
    expect(result.sites).toHaveLength(2);
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
    expect(result.sites).toHaveLength(2);
  });

  it('passes temperature=0 and requested model to the client', async () => {
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
  it('parses well-formed JSON with sites/studies schema', () => {
    const result = parseDigest(goodResponse);
    expect(result.top_line).toContain('NCT04567890');
    expect(result.sites).toHaveLength(2);
    expect(result.sites[0]!.studies).toHaveLength(2);
  });

  it('strips code fences', () => {
    const result = parseDigest('```json\n' + goodResponse + '\n```');
    expect(result.sites).toHaveLength(2);
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

  it('throws when sites is missing', () => {
    expect(() =>
      parseDigest(JSON.stringify({ top_line: 'x', tldr: 'y' })),
    ).toThrow(/sites/);
  });

  it('throws when no sites have valid studies', () => {
    expect(() =>
      parseDigest(
        JSON.stringify({
          top_line: 'x',
          tldr: 'y',
          sites: [{ disease_site: 'breast', studies: [] }],
        }),
      ),
    ).toThrow(/no valid sites/i);
  });

  it('maps unknown disease_site slugs to "other"', () => {
    const wonky = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'nasal-cavity-superhero',
          studies: [
            { name: 'X', tldr: 'y', details: [], nct: null, tweet_ids: [1] },
          ],
        },
      ],
    });
    const result = parseDigest(wonky);
    expect(result.sites[0]!.disease_site).toBe('other');
  });

  it('drops studies missing name/tldr/tweet_ids', () => {
    const mixed = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'breast',
          studies: [
            { name: 'valid', tldr: 'has all required', details: [], nct: null, tweet_ids: [1] },
            { name: '', tldr: 'no name', tweet_ids: [1] },
            { name: 'no tweets', tldr: 'no tweets attached', tweet_ids: [] },
            { name: 'no tldr', tldr: '', tweet_ids: [1] },
          ],
        },
      ],
    });
    const result = parseDigest(mixed);
    expect(result.sites[0]!.studies).toHaveLength(1);
    expect(result.sites[0]!.studies[0]!.name).toBe('valid');
  });

  it('drops sites whose studies are all invalid', () => {
    const broken = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'breast',
          studies: [{ name: '', tldr: '', tweet_ids: [] }],
        },
        {
          disease_site: 'prostate',
          studies: [
            { name: 'valid', tldr: 'OK', details: [], nct: null, tweet_ids: [1] },
          ],
        },
      ],
    });
    const result = parseDigest(broken);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.disease_site).toBe('prostate');
  });

  it('accepts bare 8-digit nct and normalizes to NCT-prefixed form', () => {
    const raw = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'breast',
          studies: [
            { name: 'X', tldr: 'y', details: [], nct: '04567890', tweet_ids: [1] },
          ],
        },
      ],
    });
    const result = parseDigest(raw);
    expect(result.sites[0]!.studies[0]!.nct).toBe('NCT04567890');
  });

  it('discards malformed nct strings (not 8 digits)', () => {
    const raw = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'breast',
          studies: [
            { name: 'X', tldr: 'y', details: [], nct: 'NCT123', tweet_ids: [1] },
          ],
        },
      ],
    });
    const result = parseDigest(raw);
    expect(result.sites[0]!.studies[0]!.nct).toBeNull();
  });

  it('normalizes empty open_questions array to null', () => {
    const raw = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'breast',
          intro: null,
          studies: [{ name: 'X', tldr: 'y', details: [], nct: null, tweet_ids: [1] }],
          open_questions: [],
        },
      ],
    });
    const result = parseDigest(raw);
    expect(result.sites[0]!.open_questions).toBeNull();
  });

  it('filters non-string details', () => {
    const noisy = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'breast',
          studies: [
            {
              name: 'X',
              tldr: 'y',
              details: ['real bullet', 42, null, '  ', 'another'],
              nct: null,
              tweet_ids: [1],
            },
          ],
        },
      ],
    });
    const result = parseDigest(noisy);
    expect(result.sites[0]!.studies[0]!.details).toEqual(['real bullet', 'another']);
  });
});
