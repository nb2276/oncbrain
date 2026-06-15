import { describe, it, expect, vi } from 'vitest';
import {
  buildDigest,
  parseGroupingResponse,
  parseStudyAgentResponse,
  parseSynthesisResponse,
  parseConsort,
  validateKeyFigure,
  validateFigures,
  validateStudyTables,
  dedupTablesAgainstCaption,
  capStudyImages,
  detectClusterCollisions,
  parseDiscussedTrials,
  parseVerdict,
  extractJsonSpan,
  DigestParseError,
  type DigestInputTweet,
  type DigestStudy,
} from '../src/lib/llm-pipeline.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';

// Returns a mock client that consumes responses from a queue, one per
// .complete() call. v0.4 makes 1 + N + 1 calls per build (grouping → N
// per-study agents → synthesis), so most tests need 3+ queued responses.
function mockLlmClient(responses: string[]): LlmClient {
  const queue = [...responses];
  const complete = vi.fn(async () => {
    if (queue.length === 0) throw new Error('mock client ran out of queued responses');
    return queue.shift()!;
  });
  return { complete };
}

const sampleTweets: DigestInputTweet[] = [
  { id: 1, author: '@drfoo', text: 'NCT04567890 OS HR 0.62 in mCRPC.', note: null },
  { id: 2, author: '@drbar', text: 'ARANOTE rPFS 21mo with enza+ADT.', note: null },
  { id: 3, author: '@drbaz', text: 'Datopotamab TNBC ORR 41% 2L.', note: null },
];

// Phase 1 — clusters the 3 tweets into 2 studies (prostate trial covers tweets
// 1+2; breast Dato covers tweet 3). Mirrors how the model would actually group.
const groupingResponse = JSON.stringify({
  studies: [
    {
      slug: 'prestige-psma',
      name: 'PRESTIGE-PSMA',
      disease_site: 'prostate',
      tweet_ids: [1, 2],
    },
    {
      slug: 'datopotamab-tnbc',
      name: 'Datopotamab in 2L TNBC',
      disease_site: 'breast',
      tweet_ids: [3],
    },
  ],
});

const studyAgent1 = JSON.stringify({
  name: 'PRESTIGE-PSMA',
  tldr: 'PRESTIGE-PSMA: OS HR 0.62 in mCRPC, primary endpoint met.',
  details: ['📊 HR 0.62 (95% CI 0.45-0.85)', '🔍 phase III open-label'],
  key_figure_url: null,
  key_figure_caption: null,
  nct: 'NCT04567890',
});

const studyAgent2 = JSON.stringify({
  name: 'Datopotamab in 2L TNBC',
  tldr: 'Dato-DXd: ORR 41% in 2L TNBC.',
  details: ['📊 ORR 41%, durable responses'],
  key_figure_url: null,
  key_figure_caption: null,
  nct: null,
});

const synthesisResponse = JSON.stringify({
  top_line: 'PRESTIGE-PSMA: OS HR 0.62 cements Lu-PSMA in 2L mCRPC.',
  tldr: 'Prostate Lu-PSMA primary endpoint hit; TROP2 ADC momentum continues in TNBC.',
  site_meta: [
    {
      disease_site: 'prostate',
      intro: 'One pivotal prostate trial reported.',
      open_questions: ['Sequencing vs taxanes'],
    },
    {
      disease_site: 'breast',
      intro: null,
      open_questions: null,
    },
  ],
});

describe('buildDigest (v0.4 3-pass)', () => {
  it('orchestrates grouping → per-study → synthesis on a clean run', async () => {
    const client = mockLlmClient([groupingResponse, studyAgent1, studyAgent2, synthesisResponse]);
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
    });
    expect(result.top_line).toContain('PRESTIGE-PSMA');
    expect(result.tldr).toContain('TROP2');
    expect(result.sites).toHaveLength(2);
    const prostate = result.sites.find((s) => s.disease_site === 'prostate')!;
    expect(prostate.studies).toHaveLength(1);
    expect(prostate.studies[0]!.tldr).toContain('HR 0.62');
    expect(prostate.studies[0]!.nct).toBe('NCT04567890');
    expect(prostate.intro).toContain('prostate trial');
    expect(prostate.open_questions).toEqual(['Sequencing vs taxanes']);
    expect(result.meta.clusters_total).toBe(2);
    expect(result.meta.studies_analyzed).toBe(2);
    expect(result.meta.dropped).toEqual([]);
    // 1 grouping + 2 agents + 1 synthesis
    // @ts-expect-error inspecting the mock
    expect(client.complete.mock.calls).toHaveLength(4);
  });

  it('returns empty digest for zero tweets without calling LLM', async () => {
    const client = mockLlmClient([]);
    const result = await buildDigest([], {
      conferenceName: 'ASCO 2026',
      conferenceDay: 1,
      client,
    });
    expect(result.sites).toEqual([]);
    expect(result.top_line).toMatch(/no bookmarks/i);
    expect(result.meta.clusters_total).toBe(0);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('drops a failed Phase 2 study and continues', async () => {
    const client = mockLlmClient([
      groupingResponse,
      'totally not json',
      'still not json', // schema-repair retry also fails
      studyAgent2,
      synthesisResponse,
    ]);
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      studyAgentConcurrency: 1, // serialize so the queue order is deterministic
    });
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]!.disease_site).toBe('breast');
    expect(result.meta.clusters_total).toBe(2);
    expect(result.meta.studies_analyzed).toBe(1);
    expect(result.meta.dropped).toHaveLength(1);
    expect(result.meta.dropped[0]!.slug).toBe('prestige-psma');
    expect(result.meta.dropped[0]!.reason).toContain('JSON');
  });

  it('throws when ALL Phase 2 studies fail', async () => {
    const client = mockLlmClient([
      groupingResponse,
      'bad', 'bad', // study 1: parse fail + repair retry fail
      'bad', 'bad', // study 2: parse fail + repair retry fail
    ]);
    await expect(
      buildDigest(sampleTweets, {
        conferenceName: 'ASCO 2026',
        conferenceDay: 2,
        client,
        studyAgentConcurrency: 1,
      }),
    ).rejects.toBeInstanceOf(DigestParseError);
  });

  it('retries Phase 1 on malformed JSON', async () => {
    const client = mockLlmClient([
      'not valid json',
      groupingResponse,
      studyAgent1,
      studyAgent2,
      synthesisResponse,
    ]);
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      maxRetries: 1,
    });
    expect(result.sites).toHaveLength(2);
  });

  it('handles code-fence-wrapped JSON in all phases', async () => {
    const wrap = (s: string) => '```json\n' + s + '\n```';
    const client = mockLlmClient([
      wrap(groupingResponse),
      wrap(studyAgent1),
      wrap(studyAgent2),
      wrap(synthesisResponse),
    ]);
    const result = await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
    });
    expect(result.sites).toHaveLength(2);
  });

  it('passes temperature=0 to every LLM call', async () => {
    const client = mockLlmClient([groupingResponse, studyAgent1, studyAgent2, synthesisResponse]);
    await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      model: 'claude-test-model',
    });
    // @ts-expect-error inspecting the mock
    for (const call of client.complete.mock.calls) {
      expect(call[1].temperature).toBe(0);
      expect(call[1].model).toBe('claude-test-model');
    }
  });

  it('routes each phase to its own model override (grouping / study / synthesis)', async () => {
    const client = mockLlmClient([groupingResponse, studyAgent1, studyAgent2, synthesisResponse]);
    await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      model: 'base-model',
      groupingModel: 'grouping-model',
      studyModel: 'study-model',
      synthesisModel: 'synthesis-model',
    });
    // @ts-expect-error inspecting the mock
    const calls = client.complete.mock.calls;
    // Grouping is always first, synthesis always last; the per-study agents are
    // every call in between (order between the two agents is concurrency-dependent).
    expect(calls[0][1].model).toBe('grouping-model');
    expect(calls[calls.length - 1][1].model).toBe('synthesis-model');
    for (let i = 1; i < calls.length - 1; i++) {
      expect(calls[i][1].model).toBe('study-model');
    }
  });

  it('per-phase models fall back to `model` when their override is unset', async () => {
    const client = mockLlmClient([groupingResponse, studyAgent1, studyAgent2, synthesisResponse]);
    await buildDigest(sampleTweets, {
      conferenceName: 'ASCO 2026',
      conferenceDay: 2,
      client,
      model: 'base-model',
      studyModel: 'study-model', // only Phase 2 overridden
    });
    // @ts-expect-error inspecting the mock
    const calls = client.complete.mock.calls;
    expect(calls[0][1].model).toBe('base-model'); // grouping -> fallback
    expect(calls[calls.length - 1][1].model).toBe('base-model'); // synthesis -> fallback
    for (let i = 1; i < calls.length - 1; i++) {
      expect(calls[i][1].model).toBe('study-model'); // study -> its override
    }
  });
});

describe('parseGroupingResponse', () => {
  it('parses a valid clustering response', () => {
    const result = parseGroupingResponse(groupingResponse, sampleTweets);
    expect(result).toHaveLength(2);
    expect(result[0]!.slug).toBe('prestige-psma');
    expect(result[0]!.disease_site).toBe('prostate');
    expect(result[0]!.tweet_ids).toEqual([1, 2]);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseGroupingResponse('{not json}', sampleTweets)).toThrow(DigestParseError);
  });

  it('strips code fences', () => {
    const wrapped = '```json\n' + groupingResponse + '\n```';
    expect(parseGroupingResponse(wrapped, sampleTweets)).toHaveLength(2);
  });

  it('drops clusters with no valid tweet_ids (single-tweet partition)', () => {
    // Use a 1-tweet input so the partition is satisfied with one cluster.
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [
        { slug: 'a', name: 'A', disease_site: 'breast', tweet_ids: [] },
        { slug: 'b', name: 'B', disease_site: 'breast', tweet_ids: [99] }, // nonexistent
        { slug: 'c', name: 'C', disease_site: 'breast', tweet_ids: [1] },
      ],
    });
    const result = parseGroupingResponse(raw, oneTweet);
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('c');
  });

  it('deduplicates clusters with the same slug (uses 1-tweet partition)', () => {
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [
        { slug: 'dup', name: 'first', disease_site: 'breast', tweet_ids: [1] },
        { slug: 'dup', name: 'second', disease_site: 'prostate', tweet_ids: [1] },
      ],
    });
    // The first cluster wins; partition-wise tweet 1 appears in only one
    // cluster after dedup, so the partition rule is satisfied.
    const result = parseGroupingResponse(raw, oneTweet);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('first');
  });

  it('defaults content_type to study_report when the field is absent (v0.16)', () => {
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [{ slug: 'c', name: 'C', disease_site: 'breast', tweet_ids: [1] }],
    });
    expect(parseGroupingResponse(raw, oneTweet)[0]!.content_type).toBe('study_report');
  });

  it('parses an explicit content_type=review (v0.16)', () => {
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [
        { slug: 'c', name: 'C', disease_site: 'breast', content_type: 'review', tweet_ids: [1] },
      ],
    });
    expect(parseGroupingResponse(raw, oneTweet)[0]!.content_type).toBe('review');
  });

  it('falls back to study_report on an invalid content_type rather than dropping the cluster', () => {
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [
        { slug: 'c', name: 'C', disease_site: 'breast', content_type: 'editorial', tweet_ids: [1] },
      ],
    });
    const result = parseGroupingResponse(raw, oneTweet);
    expect(result).toHaveLength(1);
    expect(result[0]!.content_type).toBe('study_report');
  });

  it('rejects unsafe slugs (path traversal) — partition violation surfaces', () => {
    // With unsafe slug rejected and no other cluster, tweet 1 is orphaned.
    // The partition check throws — that's the right surface for an
    // adversarial input.
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [
        { slug: '../etc/passwd', name: 'evil', disease_site: 'breast', tweet_ids: [1] },
      ],
    });
    expect(() => parseGroupingResponse(raw, oneTweet)).toThrow(/partition violation|unassigned/);
  });

  it('maps unknown disease_site to "other" (uses 1-tweet partition)', () => {
    const oneTweet = [sampleTweets[0]!];
    const raw = JSON.stringify({
      studies: [
        { slug: 'x', name: 'X', disease_site: 'fictional-tumor', tweet_ids: [1] },
      ],
    });
    const result = parseGroupingResponse(raw, oneTweet);
    expect(result[0]!.disease_site).toBe('other');
  });

  // Partition enforcement: explicit tests for the new invariant.
  it('throws when a tweet id is dropped from all clusters (unassigned)', () => {
    const raw = JSON.stringify({
      studies: [
        { slug: 'a', name: 'A', disease_site: 'breast', tweet_ids: [1] },
        // Tweet ids 2 and 3 missing → unassigned
      ],
    });
    expect(() => parseGroupingResponse(raw, sampleTweets)).toThrow(/partition violation|unassigned/);
  });

  it('throws when a tweet id appears in two clusters (duplicate)', () => {
    const raw = JSON.stringify({
      studies: [
        { slug: 'a', name: 'A', disease_site: 'breast', tweet_ids: [1, 2] },
        { slug: 'b', name: 'B', disease_site: 'prostate', tweet_ids: [1, 3] }, // 1 duplicated
      ],
    });
    expect(() => parseGroupingResponse(raw, sampleTweets)).toThrow(/partition violation|duplicated/);
  });
});

describe('parseStudyAgentResponse', () => {
  const cluster = {
    slug: 'prestige-psma',
    name: 'PRESTIGE-PSMA',
    disease_site: 'prostate',
    tweet_ids: [1, 2],
    content_type: 'study_report' as const,
  };

  it('parses a valid response', () => {
    const result = parseStudyAgentResponse(studyAgent1, cluster);
    expect(result.name).toBe('PRESTIGE-PSMA');
    expect(result.tldr).toContain('HR 0.62');
    expect(result.nct).toBe('NCT04567890');
    expect(result.tweet_ids).toEqual([1, 2]);
  });

  it('throws if tldr missing', () => {
    const broken = JSON.stringify({ name: 'X', details: [] });
    expect(() => parseStudyAgentResponse(broken, cluster)).toThrow(/tldr/);
  });

  it('normalizes bare 8-digit nct', () => {
    const raw = JSON.stringify({ name: 'X', tldr: 'y', details: [], nct: '04567890' });
    expect(parseStudyAgentResponse(raw, cluster).nct).toBe('NCT04567890');
  });

  it('rejects malformed nct', () => {
    const raw = JSON.stringify({ name: 'X', tldr: 'y', details: [], nct: 'NCT123' });
    expect(parseStudyAgentResponse(raw, cluster).nct).toBeNull();
  });

  it('forces nct null for a review even if the model emits a valid one', () => {
    // Boundary: a review names trials as plain text and must never render an
    // inferred clinicaltrials.gov link (StudyCard's shared head links study.nct).
    const reviewCluster = {
      slug: 'r',
      name: 'R',
      disease_site: 'breast',
      tweet_ids: [1],
      content_type: 'review' as const,
    };
    const raw = JSON.stringify({ name: 'X', tldr: 'y', details: [], nct: 'NCT04567890' });
    expect(parseStudyAgentResponse(raw, reviewCluster).nct).toBeNull();
    // A study report with the same nct keeps it.
    expect(parseStudyAgentResponse(raw, cluster).nct).toBe('NCT04567890');
  });

  it('filters non-string details', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: ['real', 42, null, '  ', 'another'],
    });
    expect(parseStudyAgentResponse(raw, cluster).details).toEqual(['real', 'another']);
  });

  it('preserves structured {text, subdetails} bullets (v0.4.1 hotfix)', () => {
    const raw = JSON.stringify({
      name: 'POP-RT vs PEACE-2',
      tldr: 'WPRT divergence by PSMA staging',
      details: [
        '🔍 retrospective comparison',
        {
          text: '📊 bFFS/bPFS comparison',
          subdetails: [
            'POP-RT: HR 0.50 (0.42-0.61), p<0.001',
            'PEACE-2: HR 0.97 (0.81-1.16), p=0.73',
          ],
        },
        '⚠️ counter: era of enrollment differs (2018 vs 2024)',
      ],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.details).toHaveLength(3);
    expect(out.details[0]).toBe('🔍 retrospective comparison');
    expect(typeof out.details[1]).toBe('object');
    const bullet = out.details[1] as { text: string; subdetails: string[] };
    expect(bullet.text).toContain('bFFS/bPFS');
    expect(bullet.subdetails).toHaveLength(2);
    expect(bullet.subdetails[0]).toContain('POP-RT');
  });

  it('collapses structured bullet with empty subdetails to flat string', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [{ text: 'simple bullet', subdetails: [] }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.details).toEqual(['simple bullet']);
  });

  it('drops structured bullets with empty text', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [{ text: '', subdetails: ['sub'] }, 'kept'],
    });
    expect(parseStudyAgentResponse(raw, cluster).details).toEqual(['kept']);
  });

  it('filters non-string entries from subdetails array', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [{ text: 'parent', subdetails: ['ok', 99, null, '  ', 'also'] }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    const bullet = out.details[0] as { text: string; subdetails: string[] };
    expect(bullet.subdetails).toEqual(['ok', 'also']);
  });

  // ── Table form (v0.4.2) ──
  it('parses a well-shaped table detail', () => {
    const raw = JSON.stringify({
      name: 'POP-RT vs PEACE-2',
      tldr: 'y',
      details: [{
        text: 'WPRT HR by trial',
        table: {
          columns: ['Endpoint', 'POP-RT', 'PEACE-2'],
          rows: [
            ['bFFS', 'HR 0.50', 'HR 0.97'],
            ['MFS', 'HR 0.72', 'HR 0.93'],
          ],
        },
      }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    const d = out.details[0] as { text: string; table: { columns: string[]; rows: string[][] } };
    expect(d.text).toBe('WPRT HR by trial');
    expect(d.table.columns).toEqual(['Endpoint', 'POP-RT', 'PEACE-2']);
    expect(d.table.rows).toHaveLength(2);
    expect(d.table.rows[0]).toEqual(['bFFS', 'HR 0.50', 'HR 0.97']);
  });

  it('pads short rows and truncates long rows to match column count', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [{
        text: 'parent',
        table: {
          columns: ['A', 'B', 'C'],
          rows: [
            ['1'],            // too short
            ['1', '2', '3', '4'], // too long
            ['1', '2', '3'],  // exact
          ],
        },
      }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    const d = out.details[0] as { text: string; table: { columns: string[]; rows: string[][] } };
    expect(d.table.rows[0]).toEqual(['1', '', '']);
    expect(d.table.rows[1]).toEqual(['1', '2', '3']);
    expect(d.table.rows[2]).toEqual(['1', '2', '3']);
  });

  it('rejects tables with <2 columns (falls back to flat or subdetails)', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [{
        text: 'parent',
        table: { columns: ['only-one'], rows: [['v']] },
      }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.details[0]).toBe('parent'); // collapsed to flat string
  });

  it('rejects tables with 0 rows', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [{
        text: 'empty-table',
        table: { columns: ['A', 'B'], rows: [] },
      }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.details[0]).toBe('empty-table');
  });
});

describe('validateStudyTables', () => {
  const baseStudy: DigestStudy = {
    name: 'POP-RT vs PEACE-2',
    tldr: 'y',
    details: [],
    key_figure_url: null,
    key_figure_caption: null,
    nct: null,
    tweet_ids: [1, 2],
  };

  const tweets: DigestInputTweet[] = [
    {
      id: 1, author: '@a', text: 'POP-RT bFFS HR 0.50 0.42-0.61 p<0.001',
      image_ocr_texts: ['MFS POP-RT 0.72 0.58-0.89 0.002'],
      image_urls: ['https://pbs.twimg.com/media/x.jpg'],
    },
    {
      id: 2, author: '@b', text: 'PEACE-2 bFFS HR 0.97 0.81-1.16 p=0.73 MFS 0.93 0.74-1.17',
      image_ocr_texts: [''],
      image_urls: [],
    },
  ];

  it('preserves a table whose cell numbers all appear in source text/OCR', () => {
    const study: DigestStudy = {
      ...baseStudy,
      details: [{
        text: 'HRs',
        table: {
          columns: ['Endpoint', 'POP-RT', 'PEACE-2'],
          rows: [
            ['bFFS', 'HR 0.50 (0.42-0.61) p<0.001', 'HR 0.97 (0.81-1.16) p=0.73'],
            ['MFS', 'HR 0.72 (0.58-0.89) p=0.002', 'HR 0.93 (0.74-1.17)'],
          ],
        },
      }],
    };
    const out = validateStudyTables(study, tweets);
    expect(out.details[0]).toEqual(study.details[0]);
  });

  it('drops a table when any cell has an unverified number', () => {
    const study: DigestStudy = {
      ...baseStudy,
      details: [{
        text: 'HRs',
        table: {
          columns: ['Endpoint', 'POP-RT'],
          rows: [['bFFS', 'HR 0.50 (0.42-0.61)'], ['fake-EP', 'HR 0.99 (0.88-1.11)']],
        },
      }],
    };
    const out = validateStudyTables(study, tweets);
    expect(typeof out.details[0]).toBe('string');
    expect(out.details[0] as string).toContain('comparison values omitted');
    expect(out.details[0] as string).toContain('0.99');
  });

  it('passes through non-table details unchanged', () => {
    const study: DigestStudy = {
      ...baseStudy,
      details: [
        'flat bullet',
        { text: 'sub', subdetails: ['a', 'b'] },
      ],
    };
    const out = validateStudyTables(study, tweets);
    expect(out.details).toEqual(study.details);
  });

  // v0.15 hardening: a fabricated CI whose two bounds each appear in source but
  // NOT adjacent. The per-token check alone would wave it through.
  it('drops a table CI whose bounds appear in source but never adjacent (fabricated interval)', () => {
    const study: DigestStudy = {
      ...baseStudy,
      details: [{
        text: 'HRs',
        // 0.50 and 0.97 both appear in source, but in different tweets — never
        // as an adjacent pair, so "0.50-0.97" is an invented interval.
        table: { columns: ['EP', 'Arm'], rows: [['OS', 'HR 0.50 (0.50-0.97)']] },
      }],
    };
    const out = validateStudyTables(study, tweets);
    expect(typeof out.details[0]).toBe('string');
    expect(out.details[0] as string).toContain('comparison values omitted');
  });

  // The flip side: a real CI the model writes with a dash, where source spaced
  // the bounds. Adjacency (not the delimiter) is the signal, so it must survive.
  it('preserves a dash-written CI when source has the bounds space-separated', () => {
    const localTweets: DigestInputTweet[] = [{
      id: 1, author: '@a', text: 'OS HR 0.62 95% CI 0.48 0.79 median 14.2',
      image_ocr_texts: [''], image_urls: [],
    }];
    const study: DigestStudy = {
      ...baseStudy,
      details: [{ text: 'OS', table: { columns: ['EP', 'Arm'], rows: [['OS', 'HR 0.62 (0.48-0.79)']] } }],
    };
    const out = validateStudyTables(study, localTweets);
    expect(out.details[0]).toEqual(study.details[0]);
  });

  // Parenthetical-comma CI form ("(2.2, 4.0)") — the exact shape figure OCR
  // emits for KM medians. Verified against source adjacency like any range.
  it('preserves a parenthetical-comma CI whose bounds are adjacent in source', () => {
    const localTweets: DigestInputTweet[] = [{
      id: 1, author: '@a', text: 'Median OS 3.0 (2.2, 4.0) and DFS 1.5',
      image_ocr_texts: [''], image_urls: [],
    }];
    const study: DigestStudy = {
      ...baseStudy,
      details: [{ text: 'mOS', table: { columns: ['EP', 'Arm'], rows: [['OS', '3.0 yr (2.2, 4.0)']] } }],
    };
    expect(validateStudyTables(study, localTweets).details[0]).toEqual(study.details[0]);
  });

  // codex P1: adjacency must be per-source-fragment. 0.50 is the only number in
  // tweet 1, 0.97 the only one in tweet 2 — joining the sources would make them a
  // spurious adjacent pair; a fabricated "(0.50-0.97)" must still be rejected.
  it('rejects a CI pairing one source\'s number with another source\'s (cross-source)', () => {
    const localTweets: DigestInputTweet[] = [
      { id: 1, author: '@a', text: 'POP-RT primary HR 0.50', image_ocr_texts: [''], image_urls: [] },
      { id: 2, author: '@b', text: 'PEACE-2 primary HR 0.97', image_ocr_texts: [''], image_urls: [] },
    ];
    const study: DigestStudy = {
      ...baseStudy,
      details: [{ text: 'HR', table: { columns: ['EP', 'Arm'], rows: [['OS', 'HR 0.50 (0.50-0.97)']] } }],
    };
    const out = validateStudyTables(study, localTweets);
    expect(typeof out.details[0]).toBe('string');
    expect(out.details[0] as string).toContain('comparison values omitted');
  });

  // codex P2: a bracketed CI "[lo, hi]" is validated as a unit, like "(lo, hi)".
  it('validates a bracketed CI "[lo, hi]" as a range unit', () => {
    const localTweets: DigestInputTweet[] = [
      { id: 1, author: '@a', text: 'OS HR 0.62 95% CI 0.48 0.79', image_ocr_texts: [''], image_urls: [] },
    ];
    // real: bounds adjacent in source → kept
    const ok: DigestStudy = {
      ...baseStudy,
      details: [{ text: 'OS', table: { columns: ['EP', 'Arm'], rows: [['OS', 'HR 0.62 [0.48, 0.79]']] } }],
    };
    expect(validateStudyTables(ok, localTweets).details[0]).toEqual(ok.details[0]);
    // fabricated: 0.48 and 0.62 both in source but NOT adjacent (95 between) → dropped via the range gate
    const bad: DigestStudy = {
      ...baseStudy,
      details: [{ text: 'OS', table: { columns: ['EP', 'Arm'], rows: [['OS', 'HR 0.79 [0.48, 0.62]']] } }],
    };
    expect(typeof validateStudyTables(bad, localTweets).details[0]).toBe('string');
  });

  // "to"-connector range, and the fabrication catch on it.
  it('drops a "X to Y" range whose bounds are not adjacent in source', () => {
    const localTweets: DigestInputTweet[] = [{
      id: 1, author: '@a', text: 'dose 2 Gy in 35 sessions to 70 Gy total then 5 boost',
      image_ocr_texts: [''], image_urls: [],
    }];
    const study: DigestStudy = {
      ...baseStudy,
      // 2 and 70 both appear but never adjacent → "2 to 70" is fabricated
      details: [{ text: 'dose', table: { columns: ['EP', 'Arm'], rows: [['RT', '2 to 70 fractions']] } }],
    };
    const out = validateStudyTables(study, localTweets);
    expect(typeof out.details[0]).toBe('string');
    expect(out.details[0] as string).toContain('comparison values omitted');
  });

  it('falls back to cluster name if model omits name', () => {
    const localCluster = { slug: 'foo', name: 'PRESTIGE-PSMA', disease_site: 'prostate', tweet_ids: [1], content_type: 'study_report' as const };
    const raw = JSON.stringify({ tldr: 'y', details: [] });
    expect(parseStudyAgentResponse(raw, localCluster).name).toBe('PRESTIGE-PSMA');
  });

  // v0.16: content_type is inherited from the Phase 1 cluster (not re-classified
  // by Phase 2), and only a review carries discussed_trials.
  it('omits content_type + discussed_trials for a study_report cluster (back-compat)', () => {
    const c = { slug: 'foo', name: 'Foo', disease_site: 'prostate', tweet_ids: [1], content_type: 'study_report' as const };
    const raw = JSON.stringify({ tldr: 'y', details: [], discussed_trials: ['STOMP'] });
    const out = parseStudyAgentResponse(raw, c);
    // Absent === study_report; a study report never renders an acronym list,
    // even when the model spuriously emits one.
    expect(out.content_type).toBeUndefined();
    expect(out.discussed_trials).toBeUndefined();
  });

  it('inherits content_type=review and attaches the discussed_trials list', () => {
    const c = { slug: 'oligomet-sbrt', name: 'Oligomet SBRT review', disease_site: 'prostate', tweet_ids: [1], content_type: 'review' as const };
    const raw = JSON.stringify({
      tldr: 'Landscape of SBRT in oligometastatic prostate cancer.',
      details: [],
      discussed_trials: ['STOMP', 'ORIOLE', 'RADIOSA'],
    });
    const out = parseStudyAgentResponse(raw, c);
    expect(out.content_type).toBe('review');
    expect(out.discussed_trials).toEqual(['STOMP', 'ORIOLE', 'RADIOSA']);
  });

  it('a review with no extractable acronyms leaves discussed_trials undefined (not [])', () => {
    const c = { slug: 'topic', name: 'Topic review', disease_site: 'breast', tweet_ids: [1], content_type: 'review' as const };
    const raw = JSON.stringify({ tldr: 'A general overview.', details: [], discussed_trials: [] });
    expect(parseStudyAgentResponse(raw, c).discussed_trials).toBeUndefined();
  });
});

describe('parseDiscussedTrials (v0.16)', () => {
  it('returns [] for a non-array', () => {
    expect(parseDiscussedTrials(undefined)).toEqual([]);
    expect(parseDiscussedTrials(null)).toEqual([]);
    expect(parseDiscussedTrials('STOMP')).toEqual([]);
  });

  it('keeps verbatim acronyms in order, dropping non-strings', () => {
    expect(parseDiscussedTrials(['STOMP', 7, 'ORIOLE', null, 'RADIOSA'])).toEqual([
      'STOMP',
      'ORIOLE',
      'RADIOSA',
    ]);
  });

  it('trims, drops empties + single-char fragments + sentence-length blobs', () => {
    const longBlob = 'A'.repeat(41);
    expect(
      parseDiscussedTrials(['  ARTO  ', '', '   ', 'X', longBlob, '!!', 'STAMPEDE2']),
    ).toEqual(['ARTO', 'STAMPEDE2']);
  });

  it('keeps cooperative-group names that are 1 letter + digits (S1207, E2112)', () => {
    expect(parseDiscussedTrials(['S1207', 'E2112'])).toEqual(['S1207', 'E2112']);
  });

  it('dedupes case-insensitively, first spelling wins', () => {
    expect(parseDiscussedTrials(['STOMP', 'stomp', 'Stomp', 'ORIOLE'])).toEqual([
      'STOMP',
      'ORIOLE',
    ]);
  });

  it('caps at 8 (M0 found ~14 on the exemplar review)', () => {
    const many = Array.from({ length: 14 }, (_, i) => `TRIAL${i}`);
    const out = parseDiscussedTrials(many);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('TRIAL0');
  });

  it('keeps the inclusive length boundaries (2 and 40), drops 41 (pins off-by-one)', () => {
    const max = 'A'.repeat(40);
    const over = 'A'.repeat(41);
    // 'A2' is exactly 2 chars + alphanumeric → kept; 40-char → kept; 41 → dropped.
    expect(parseDiscussedTrials(['A2', max, over])).toEqual(['A2', max]);
  });
});

describe('parseConsort', () => {
  it('parses a complete CONSORT flow', () => {
    const r = parseConsort({
      enrolled: 1240,
      excluded: 74,
      randomized: 1166,
      arms: [
        { label: 'PPN-SBRT', allocated: 583, analyzed: 560 },
        { label: 'P-SBRT', allocated: 583, analyzed: 571 },
      ],
    });
    expect(r).toEqual({
      enrolled: 1240,
      excluded: 74,
      randomized: 1166,
      arms: [
        { label: 'PPN-SBRT', allocated: 583, analyzed: 560 },
        { label: 'P-SBRT', allocated: 583, analyzed: 571 },
      ],
    });
  });

  it('keeps minimal flow (randomized + 2 arms, optional fields null)', () => {
    const r = parseConsort({
      randomized: 200,
      arms: [
        { label: 'A', allocated: 100 },
        { label: 'B', allocated: 100 },
      ],
    });
    expect(r).toEqual({
      enrolled: null,
      excluded: null,
      randomized: 200,
      arms: [
        { label: 'A', allocated: 100, analyzed: null },
        { label: 'B', allocated: 100, analyzed: null },
      ],
    });
  });

  it('rejects fewer than 2 valid arms', () => {
    expect(parseConsort({ randomized: 100, arms: [{ label: 'A', allocated: 100 }] })).toBeNull();
  });

  it('rejects missing/invalid total randomized', () => {
    expect(
      parseConsort({ arms: [{ label: 'A', allocated: 50 }, { label: 'B', allocated: 50 }] }),
    ).toBeNull();
    expect(parseConsort({ randomized: 0, arms: [] })).toBeNull();
  });

  it('drops arms without a label or positive allocated count', () => {
    const r = parseConsort({
      randomized: 150,
      arms: [
        { label: 'A', allocated: 75 },
        { label: '', allocated: 75 },
        { label: 'C', allocated: 0 },
        { label: 'D', allocated: 75 },
      ],
    });
    expect(r?.arms.map((a) => a.label)).toEqual(['A', 'D']);
  });

  it('returns null for non-objects', () => {
    expect(parseConsort(null)).toBeNull();
    expect(parseConsort('x')).toBeNull();
    expect(parseConsort(undefined)).toBeNull();
  });
});

describe('parseSynthesisResponse', () => {
  it('parses a valid response', () => {
    const result = parseSynthesisResponse(synthesisResponse);
    expect(result.top_line).toContain('PRESTIGE-PSMA');
    expect(result.site_meta).toHaveLength(2);
    expect(result.site_meta[0]!.open_questions).toEqual(['Sequencing vs taxanes']);
  });

  it('throws if top_line missing', () => {
    const broken = JSON.stringify({ tldr: 'y', site_meta: [] });
    expect(() => parseSynthesisResponse(broken)).toThrow(/top_line/);
  });

  it('normalizes empty open_questions to null', () => {
    const raw = JSON.stringify({
      top_line: 'x',
      tldr: 'y',
      site_meta: [{ disease_site: 'breast', open_questions: [] }],
    });
    expect(parseSynthesisResponse(raw).site_meta[0]!.open_questions).toBeNull();
  });
});

describe('validateKeyFigure', () => {
  const tweets: DigestInputTweet[] = [
    {
      id: 1,
      author: '@drfoo',
      text: 'PRESTIGE results',
      image_urls: ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'],
      image_ocr_texts: [
        'PRESTIGE-PSMA Overall Survival HR 0.62 95% CI 0.48 0.79 Median 14.2 vs 9.8 mo',
        'study schema phase III randomization',
      ],
    },
  ];

  it('passes a caption whose numbers all appear in OCR', () => {
    const r = validateKeyFigure(
      'OS: HR 0.62 (95% CI 0.48-0.79). Medians 14.2 vs 9.8 mo.',
      'https://pbs.twimg.com/media/a.jpg',
      tweets,
      true,
    );
    expect(r.caption).toBe('OS: HR 0.62 (95% CI 0.48-0.79). Medians 14.2 vs 9.8 mo.');
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
  });

  it('drops caption when a number is absent from OCR (keeps figure)', () => {
    const r = validateKeyFigure(
      'OS HR 0.42 — hallucinated number!',
      'https://pbs.twimg.com/media/a.jpg',
      tweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(r.reason).toContain('0.42');
  });

  it('drops both fields when figure URL not in any cluster tweet', () => {
    const r = validateKeyFigure(
      'HR 0.62',
      'https://pbs.twimg.com/media/HALLUCINATED.jpg',
      tweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBeNull();
    expect(r.reason).toContain('hallucinated');
  });

  // v0.15 hardening: a caption CI whose bounds each appear in the figure OCR but
  // are not adjacent (a number sits between them) is a fabricated interval.
  it('drops a caption CI whose bounds are not adjacent in OCR (fabricated interval)', () => {
    const localTweets: DigestInputTweet[] = [{
      id: 1, author: '@a', text: 'x',
      image_urls: ['https://pbs.twimg.com/media/a.jpg'],
      image_ocr_texts: ['HR 0.48 then 0.62 then 0.79 median 14.2 vs 9.8'],
    }];
    const r = validateKeyFigure(
      'OS HR 0.62 (95% CI 0.48-0.79)',
      'https://pbs.twimg.com/media/a.jpg',
      localTweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(r.reason).toContain('not traceable');
  });

  it('drops BOTH figure and caption when OCR is unavailable globally (Claude #26)', () => {
    const r = validateKeyFigure(
      'HR 0.62 (95% CI 0.48-0.79)',
      'https://pbs.twimg.com/media/a.jpg',
      tweets,
      false, // OCR unavailable env
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBeNull(); // figure also dropped to prevent uncaptioned-figure-looks-editorial
    expect(r.reason).toContain('OCR unavailable');
  });

  it('drops caption when target image has empty OCR text', () => {
    const tweetsEmptyOcr: DigestInputTweet[] = [
      {
        id: 1,
        author: null,
        text: 't',
        image_urls: ['https://pbs.twimg.com/media/a.jpg'],
        image_ocr_texts: [''],
      },
    ];
    const r = validateKeyFigure('HR 0.62', 'https://pbs.twimg.com/media/a.jpg', tweetsEmptyOcr, true);
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
  });

  it('allows abstention (caption null) without complaint', () => {
    const r = validateKeyFigure(null, 'https://pbs.twimg.com/media/a.jpg', tweets, true);
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(r.reason).toBeUndefined();
  });

  it('returns null/null when no figure was selected', () => {
    const r = validateKeyFigure('HR 0.62', null, tweets, true);
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBeNull();
  });

  // ── Substring false-positive prevention (Testing Gap 1 / Claude #1) ──
  it('rejects substring-only match: caption "0.6" should NOT pass against OCR "0.62"', () => {
    const r = validateKeyFigure(
      'HR 0.6 (rounded down)',
      'https://pbs.twimg.com/media/a.jpg',
      tweets, // OCR for image a has "0.62", "0.48", "0.79", "14.2", "9.8"
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
  });

  // ── Zero numeric token rejection (Claude #2) ──
  it('rejects caption with zero numeric anchors', () => {
    const r = validateKeyFigure(
      'Overall survival favoring experimental arm with sustained separation',
      'https://pbs.twimg.com/media/a.jpg',
      tweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(r.reason).toContain('no numeric tokens');
  });

  // ── Leading-zero variants (Claude #3) ──
  it('accepts caption "0.62" against OCR ".62" (leading zero stripped by Vision)', () => {
    const tweetsLeadZero: DigestInputTweet[] = [
      {
        id: 1, author: null, text: 't',
        image_urls: ['https://pbs.twimg.com/media/a.jpg'],
        image_ocr_texts: ['HR .62 95% CI .48-.79'], // Vision-style without leading zeros
      },
    ];
    const r = validateKeyFigure(
      'HR 0.62 (95% CI 0.48-0.79)',
      'https://pbs.twimg.com/media/a.jpg',
      tweetsLeadZero,
      true,
    );
    expect(r.caption).toBe('HR 0.62 (95% CI 0.48-0.79)');
  });

  it('accepts caption ".62" against OCR "0.62" (reverse direction)', () => {
    const r = validateKeyFigure(
      'HR .62',
      'https://pbs.twimg.com/media/a.jpg',
      tweets, // OCR has "0.62"
      true,
    );
    expect(r.caption).toBe('HR .62');
  });

  // ── Host allowlist (Security P1-2) ──
  it('drops both fields when figure URL is not on the host allowlist', () => {
    const tweetsHostile: DigestInputTweet[] = [
      {
        id: 1, author: null, text: 't',
        image_urls: ['https://attacker.example.com/x.jpg'],
        image_ocr_texts: ['some text'],
      },
    ];
    const r = validateKeyFigure(
      'HR 0.62',
      'https://attacker.example.com/x.jpg',
      tweetsHostile,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBeNull();
    expect(r.reason).toContain('host allowlist');
  });

  it('drops both fields when figure URL uses http:// scheme', () => {
    const tweetsInsecure: DigestInputTweet[] = [
      {
        id: 1, author: null, text: 't',
        image_urls: ['http://pbs.twimg.com/media/a.jpg'],
        image_ocr_texts: ['some text'],
      },
    ];
    const r = validateKeyFigure(
      'HR 0.62',
      'http://pbs.twimg.com/media/a.jpg',
      tweetsInsecure,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBeNull();
    expect(r.reason).toContain('host allowlist');
  });

  it('drops both fields when figure URL is unparseable', () => {
    const tweetsBroken: DigestInputTweet[] = [
      {
        id: 1, author: null, text: 't',
        image_urls: ['not a url'],
        image_ocr_texts: ['text'],
      },
    ];
    const r = validateKeyFigure('HR 0.62', 'not a url', tweetsBroken, true);
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBeNull();
  });

  // ── Table-form captions (v0.4.3) ──
  it('passes a table caption whose cell numbers all appear in OCR', () => {
    const r = validateKeyFigure(
      {
        columns: ['Arm', 'Median', 'HR'],
        rows: [
          ['Exp', '14.2', '0.62'],
          ['Ctrl', '9.8', '—'],
        ],
      },
      'https://pbs.twimg.com/media/a.jpg',
      tweets, // OCR has "0.62", "0.48", "0.79", "14.2", "9.8"
      true,
    );
    expect(r.caption).not.toBeNull();
    expect(typeof r.caption).toBe('object');
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
  });

  it('drops a table caption when any cell number not in OCR (keeps figure)', () => {
    const r = validateKeyFigure(
      {
        columns: ['Arm', 'HR'],
        rows: [
          ['Exp', '0.62'],
          ['Ctrl', '0.99'], // not in OCR
        ],
      },
      'https://pbs.twimg.com/media/a.jpg',
      tweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(r.reason).toContain('0.99');
  });

  // v0.15: the multi-token range check also runs on TABLE-form caption cells.
  // OCR has 0.48 and 0.79 but separated by 0.62 → "0.48-0.79" is fabricated.
  it('drops a table caption whose CI cell bounds are not adjacent in OCR', () => {
    const localTweets: DigestInputTweet[] = [{
      id: 1, author: '@a', text: 't',
      image_urls: ['https://pbs.twimg.com/media/a.jpg'],
      image_ocr_texts: ['HR 0.48 then 0.62 then 0.79'],
    }];
    const r = validateKeyFigure(
      { columns: ['Arm', 'HR (95% CI)'], rows: [['Exp', '0.62 (0.48-0.79)']] },
      'https://pbs.twimg.com/media/a.jpg',
      localTweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.figureUrl).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(r.reason).toContain('not traceable');
  });

  it('drops a table caption with zero numeric tokens (all-text cells)', () => {
    const r = validateKeyFigure(
      {
        columns: ['Arm', 'Direction'],
        rows: [['Exp', 'favorable'], ['Ctrl', 'reference']],
      },
      'https://pbs.twimg.com/media/a.jpg',
      tweets,
      true,
    );
    expect(r.caption).toBeNull();
    expect(r.reason).toContain('no numeric tokens');
  });
});

describe('dedupTablesAgainstCaption', () => {
  const base: DigestStudy = {
    name: 'X',
    tldr: 'y',
    details: [],
    key_figure_url: 'https://pbs.twimg.com/media/a.jpg',
    key_figure_caption: {
      columns: ['Primary', '1-year LF', '3-year LF'],
      rows: [['Prostate', '2.7%', '8.1%'], ['NSCLC', '6.0%', '9.8%']],
    },
    nct: null,
    tweet_ids: [1],
  };

  it('drops a detail-table that has identical columns to caption-table', () => {
    const study: DigestStudy = {
      ...base,
      details: [
        'flat methodology bullet',
        {
          text: '📊 LF by primary',
          table: {
            columns: ['Primary', '1-year LF', '3-year LF'],
            rows: [['Prostate', '2.7%', '8.1%']],
          },
        },
      ],
    };
    const out = dedupTablesAgainstCaption(study);
    expect(out.details).toEqual(['flat methodology bullet', '📊 LF by primary']);
  });

  it('drops with 2-column overlap (partial column match)', () => {
    const study: DigestStudy = {
      ...base,
      details: [{
        text: 'shared 2 of 3',
        table: {
          columns: ['Primary', '1-year LF', 'note'], // 2/3 overlap
          rows: [['Prostate', '2.7%', '—']],
        },
      }],
    };
    const out = dedupTablesAgainstCaption(study);
    expect(out.details[0]).toBe('shared 2 of 3');
  });

  it('keeps a detail-table with <2 column overlap (different comparison)', () => {
    const study: DigestStudy = {
      ...base,
      details: [{
        text: 'AE table',
        table: {
          columns: ['Toxicity', 'Grade 2+'],
          rows: [['GU', '5%'], ['GI', '3%']],
        },
      }],
    };
    const out = dedupTablesAgainstCaption(study);
    expect(typeof out.details[0]).toBe('object');
  });

  it('is a no-op when caption is a string (only table↔table dedup)', () => {
    const study: DigestStudy = {
      ...base,
      key_figure_caption: 'flat caption',
      details: [{
        text: 't',
        table: { columns: ['Primary', '1-year LF'], rows: [['Prostate', '2.7%']] },
      }],
    };
    const out = dedupTablesAgainstCaption(study);
    expect(typeof out.details[0]).toBe('object');
  });

  it('is a no-op when caption is null', () => {
    const study: DigestStudy = {
      ...base,
      key_figure_caption: null,
      details: [{ text: 't', table: { columns: ['A', 'B'], rows: [['1', '2']] } }],
    };
    const out = dedupTablesAgainstCaption(study);
    expect(typeof out.details[0]).toBe('object');
  });
});

describe('capStudyImages', () => {
  const t = (id: number, urls: string[]): DigestInputTweet => ({
    id,
    author: null,
    text: 't',
    image_urls: urls,
    image_ocr_texts: urls.map(() => ''),
  });

  it('returns input unchanged when total images under cap', () => {
    const tweets = [t(1, ['a', 'b']), t(2, ['c'])];
    const out = capStudyImages(tweets, 6);
    expect(out[0]!.image_urls).toEqual(['a', 'b']);
    expect(out[1]!.image_urls).toEqual(['c']);
  });

  it('truncates first tweet that exceeds the cap', () => {
    const tweets = [t(1, ['a', 'b', 'c', 'd']), t(2, ['e', 'f'])];
    const out = capStudyImages(tweets, 3);
    expect(out[0]!.image_urls).toEqual(['a', 'b', 'c']);
    expect(out[1]!.image_urls).toEqual([]);
  });

  it('handles cap = 0 by returning empty images for all', () => {
    const tweets = [t(1, ['a', 'b'])];
    const out = capStudyImages(tweets, 0);
    expect(out[0]!.image_urls).toEqual([]);
  });

  it('preserves ocr text alignment when truncating', () => {
    const tweets = [
      { id: 1, author: null, text: 't', image_urls: ['a', 'b', 'c'], image_ocr_texts: ['A', 'B', 'C'] },
    ];
    const out = capStudyImages(tweets, 2);
    expect(out[0]!.image_urls).toEqual(['a', 'b']);
    expect(out[0]!.image_ocr_texts).toEqual(['A', 'B']);
  });
});

describe('detectClusterCollisions', () => {
  it('warns when 2+ clusters share an NCT', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tweets: DigestInputTweet[] = [
      { id: 1, author: null, text: 'first half NCT04567890 result A', note: null },
      { id: 2, author: null, text: 'second half NCT04567890 result B', note: null },
    ];
    detectClusterCollisions(
      [
        { slug: 'a', name: 'TrialA', disease_site: 'prostate', tweet_ids: [1], content_type: 'study_report' as const },
        { slug: 'b', name: 'TrialB', disease_site: 'prostate', tweet_ids: [2], content_type: 'study_report' as const },
      ],
      tweets,
    );
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain('NCT04567890');
    warn.mockRestore();
  });

  it('does not warn when each NCT belongs to a single cluster', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    detectClusterCollisions(
      [
        { slug: 'a', name: 'TrialA', disease_site: 'prostate', tweet_ids: [1], content_type: 'study_report' as const },
      ],
      [{ id: 1, author: null, text: 'NCT04567890 result', note: null }],
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // v0.16: a review legitimately shares NCTs with the single-trial cluster it
  // sits beside (the standalone-review rule). That overlap must NOT warn.
  it('does not warn when a review shares an NCT with a single-trial cluster', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    detectClusterCollisions(
      [
        { slug: 'review', name: 'SBRT landscape review', disease_site: 'prostate', tweet_ids: [1], content_type: 'review' as const },
        { slug: 'stomp', name: 'STOMP', disease_site: 'prostate', tweet_ids: [2], content_type: 'study_report' as const },
      ],
      [
        { id: 1, author: null, text: 'Review discussing STOMP NCT01558427.', note: null },
        { id: 2, author: null, text: 'STOMP primary result NCT01558427.', note: null },
      ],
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── v0.10: figure gallery (figures[]) ──
describe('parseStudyAgentResponse — figures[]', () => {
  const cluster = {
    slug: 'prestige-psma',
    name: 'PRESTIGE-PSMA',
    disease_site: 'prostate',
    tweet_ids: [1, 2],
    content_type: 'study_report' as const,
  };

  it('parses a figures array with mixed caption shapes', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [],
      figures: [
        { url: 'https://pbs.twimg.com/media/km.jpg', caption: 'OS HR 0.62' },
        {
          url: 'https://pbs.twimg.com/media/tbl.jpg',
          caption: { columns: ['Arm', 'OS'], rows: [['Lu', '14.2']] },
        },
        { url: 'https://pbs.twimg.com/media/schema.jpg', caption: null },
      ],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.figures).toHaveLength(3);
    expect(out.figures![0]).toEqual({ url: 'https://pbs.twimg.com/media/km.jpg', caption: 'OS HR 0.62' });
    expect(typeof out.figures![1]!.caption).toBe('object');
    expect(out.figures![2]!.caption).toBeNull();
  });

  it('dedupes repeated figure urls and caps at 4', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [],
      figures: [
        { url: 'https://pbs.twimg.com/media/a.jpg', caption: null },
        { url: 'https://pbs.twimg.com/media/a.jpg', caption: 'dupe' }, // dropped
        { url: 'https://pbs.twimg.com/media/b.jpg', caption: null },
        { url: 'https://pbs.twimg.com/media/c.jpg', caption: null },
        { url: 'https://pbs.twimg.com/media/d.jpg', caption: null },
        { url: 'https://pbs.twimg.com/media/e.jpg', caption: null }, // over cap
      ],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.figures!.map((f) => f.url)).toEqual([
      'https://pbs.twimg.com/media/a.jpg',
      'https://pbs.twimg.com/media/b.jpg',
      'https://pbs.twimg.com/media/c.jpg',
      'https://pbs.twimg.com/media/d.jpg',
    ]);
  });

  it('drops figure entries without a usable url', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [],
      figures: [{ caption: 'no url' }, { url: '   ' }, { url: 'https://pbs.twimg.com/media/a.jpg', caption: null }],
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.figures).toEqual([{ url: 'https://pbs.twimg.com/media/a.jpg', caption: null }]);
  });

  it('back-compat: wraps a v0.4 single key_figure_url into figures[]', () => {
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [],
      key_figure_url: 'https://pbs.twimg.com/media/a.jpg',
      key_figure_caption: 'OS HR 0.62',
    });
    const out = parseStudyAgentResponse(raw, cluster);
    expect(out.figures).toEqual([
      { url: 'https://pbs.twimg.com/media/a.jpg', caption: 'OS HR 0.62' },
    ]);
  });

  it('emits an empty figures[] when none provided', () => {
    const raw = JSON.stringify({ name: 'X', tldr: 'y', details: [] });
    expect(parseStudyAgentResponse(raw, cluster).figures).toEqual([]);
  });
});

describe('validateFigures', () => {
  const tweets: DigestInputTweet[] = [
    {
      id: 1,
      author: '@drfoo',
      text: 'PRESTIGE results',
      image_urls: ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'],
      image_ocr_texts: [
        'PRESTIGE-PSMA Overall Survival HR 0.62 95% CI 0.48 0.79',
        'AE table G3 22 vs 14',
      ],
    },
  ];

  it('keeps valid figures, drops a caption with an unverifiable number', () => {
    const out = validateFigures(
      [
        { url: 'https://pbs.twimg.com/media/a.jpg', caption: 'OS HR 0.62' },
        { url: 'https://pbs.twimg.com/media/b.jpg', caption: 'G3 99 vs 14' }, // 99 not in OCR
      ],
      tweets,
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.caption).toBe('OS HR 0.62');
    expect(out[1]!.url).toBe('https://pbs.twimg.com/media/b.jpg');
    expect(out[1]!.caption).toBeNull(); // caption dropped, figure kept
  });

  it('drops a figure whose url is not in the cluster', () => {
    const out = validateFigures(
      [
        { url: 'https://pbs.twimg.com/media/a.jpg', caption: 'OS HR 0.62' },
        { url: 'https://pbs.twimg.com/media/HALLUCINATED.jpg', caption: null },
      ],
      tweets,
      true,
    );
    expect(out.map((f) => f.url)).toEqual(['https://pbs.twimg.com/media/a.jpg']);
  });

  it('drops all figures when OCR is globally unavailable (env-skew safety)', () => {
    const out = validateFigures(
      [{ url: 'https://pbs.twimg.com/media/a.jpg', caption: 'OS HR 0.62' }],
      tweets,
      false,
    );
    expect(out).toEqual([]);
  });
});

describe('dedupTablesAgainstCaption — figures[]', () => {
  it('drops a detail-table duplicating any figure caption-table', () => {
    const study: DigestStudy = {
      name: 'X',
      tldr: 'y',
      nct: null,
      tweet_ids: [1],
      figures: [
        { url: 'https://pbs.twimg.com/media/a.jpg', caption: 'OS HR 0.62' },
        {
          url: 'https://pbs.twimg.com/media/b.jpg',
          caption: { columns: ['Primary', '1yr LF', '3yr LF'], rows: [['Prostate', '2.7%', '8.1%']] },
        },
      ],
      details: [
        'flat bullet',
        {
          text: 'LF by primary',
          table: { columns: ['Primary', '1yr LF', '3yr LF'], rows: [['Prostate', '2.7%', '8.1%']] },
        },
      ],
    };
    const out = dedupTablesAgainstCaption(study);
    expect(out.details).toEqual(['flat bullet', 'LF by primary']);
  });
});

describe('parseVerdict', () => {
  it('accepts a canonical enum value', () => {
    const v = parseVerdict({ soc_implication: 'practice-changing', rationale: 'OS benefit' });
    expect(v?.soc_implication).toBe('practice-changing');
  });

  it('normalizes spacing/underscore/case to the canonical slug', () => {
    expect(parseVerdict({ soc_implication: 'Practice Changing', rationale: 'r' })?.soc_implication).toBe(
      'practice-changing',
    );
    expect(parseVerdict({ soc_implication: 'practice_changing', rationale: 'r' })?.soc_implication).toBe(
      'practice-changing',
    );
  });

  it('DROPS the verdict on a non-empty unrecognized value (no contradictory pill)', () => {
    // Was silently coerced to 'unclear' while keeping a strong rationale →
    // "Unclear" beside a practice-changing rationale. Now drop the whole verdict.
    expect(
      parseVerdict({ soc_implication: 'likely-practice-changing', rationale: 'definitive phase III' }),
    ).toBeUndefined();
  });

  it('defaults a MISSING soc to unclear (kept)', () => {
    expect(parseVerdict({ rationale: 'some context' })?.soc_implication).toBe('unclear');
  });

  it('returns undefined without a rationale', () => {
    expect(parseVerdict({ soc_implication: 'practice-changing' })).toBeUndefined();
  });
});

describe('extractJsonSpan (prose-wrapped LLM JSON)', () => {
  it('returns clean JSON unchanged', () => {
    expect(extractJsonSpan('{"a":1}')).toBe('{"a":1}');
  });

  it('strips leading prose ("Here is the JSON: ...")', () => {
    expect(JSON.parse(extractJsonSpan('Here is the JSON:\n{"a":1}'))).toEqual({ a: 1 });
  });

  it('strips a trailing sentence after the object', () => {
    expect(JSON.parse(extractJsonSpan('{"a":1}\n\nLet me know if you want changes.'))).toEqual({
      a: 1,
    });
  });

  it('is not fooled by braces inside string values', () => {
    expect(JSON.parse(extractJsonSpan('prefix {"a":"}{"} suffix'))).toEqual({ a: '}{' });
  });

  it('handles a top-level array', () => {
    expect(JSON.parse(extractJsonSpan('result: [1,2,3] done'))).toEqual([1, 2, 3]);
  });

  it('returns from the first brace to EOF when unbalanced (truncated) — parse still fails', () => {
    const truncated = extractJsonSpan('{"a":1, "b":');
    expect(truncated).toBe('{"a":1, "b":');
    expect(() => JSON.parse(truncated)).toThrow();
  });

  it('returns input unchanged when there is no JSON', () => {
    expect(extractJsonSpan('no json here')).toBe('no json here');
  });
});
