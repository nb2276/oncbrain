// Lancet-family middle-dot decimals ("2·80") read as two integers by every
// grounding tokenizer, so a card quoting the paper's own numbers was withheld.
// TORPEdO (2026-09-09) lost its primary endpoint (OR 2·80, p=0·079) and two
// results tables this way.
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeDecimalSeparators,
  normalizeItemDecimals,
} from '../src/lib/decimal-separator.ts';
import {
  buildDigest,
  validatePrimaryEndpoint,
  paperIdToSyntheticTweetId,
  sourceTierOf,
  type DigestInputPaper,
  type DigestStudy,
  type DigestDetail,
} from '../src/lib/llm-pipeline.ts';
import { markFigureSourcedDetails } from '../src/lib/source-tier.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';

describe('normalizeDecimalSeparators', () => {
  it('rewrites a middle dot between two digits', () => {
    expect(normalizeDecimalSeparators('adjusted OR 2·80 [0·75–10·41]; p=0·079')).toBe(
      'adjusted OR 2.80 [0.75–10.41]; p=0.079',
    );
    expect(normalizeDecimalSeparators('p<0·0001, D0·1 cc, 1507 (68·0%)')).toBe(
      'p<0.0001, D0.1 cc, 1507 (68.0%)',
    );
    // The other dot-like glyphs PDF extraction produces for the same thing.
    expect(normalizeDecimalSeparators('0∙44 and 0⋅86')).toBe('0.44 and 0.86');
  });

  it('leaves separators and bullets alone', () => {
    const prose = 'ESTRO 2026 · Day 2 · 3 talks\n• 70 Gy · 33 fx\nDay 1 · 2';
    expect(normalizeDecimalSeparators(prose)).toBe(prose);
  });
});

describe('normalizeItemDecimals', () => {
  it('covers every source-text field and leaves identifiers alone', () => {
    const paper: DigestInputPaper = {
      source_type: 'paper',
      id: 85,
      pmid: null,
      doi: '10.1016/s0140-6736(26)00314-4',
      title: 'Trial of 0·5 mg',
      abstract: 'OR 2·80',
      fulltext_excerpt_md: 'p=0·079',
      figure_ocr_md: '78·3',
      figure_structured_md: '77·1',
    };
    expect(normalizeItemDecimals(paper)).toMatchObject({
      title: 'Trial of 0.5 mg',
      abstract: 'OR 2.80',
      fulltext_excerpt_md: 'p=0.079',
      figure_ocr_md: '78.3',
      figure_structured_md: '77.1',
      doi: '10.1016/s0140-6736(26)00314-4',
    });
    expect(
      normalizeItemDecimals({ id: 1, author: null, text: 'HR 0·62', image_ocr_texts: ['0·45'] }),
    ).toMatchObject({ text: 'HR 0.62', image_ocr_texts: ['0.45'] });
    expect(
      normalizeItemDecimals({ source_type: 'slide', id: 2, file_path: 'x.png', ocr_text: '1·4' }),
    ).toMatchObject({ ocr_text: '1.4' });
  });
});

describe('grounding a Lancet paper', () => {
  const abstract =
    'Event rates were 21 of 119 (18%) in the IMPT group versus four of 59 (7%) in the IMRT group ' +
    '(adjusted OR 2·80 [97·5% CI 0·75–10·41]; p=0·079). UW-QoL 78·3 versus 77·1 (p=0·56).';

  it('the gate on its own still reads the raw spelling as two integers', () => {
    // Why the normalization has to happen before the gate, not inside one caller.
    const study = {
      name: 'TORPEdO',
      tldr: 't',
      details: [],
      nct: null,
      tweet_ids: [1],
      primary_endpoint: { name: 'Composite', klass: 'surrogate', stat_value: 'OR 2.80', stat_detail: 'p=0.079' },
    } as unknown as DigestStudy;
    const out = validatePrimaryEndpoint(study, [{ id: 1, author: null, text: abstract }]);
    expect(out.primary_endpoint).toBeNull();
  });

  const endpointStudy = (stat_value: string) =>
    ({
      name: 'STAMPEDE',
      tldr: 't',
      details: [],
      nct: null,
      tweet_ids: [1],
      primary_endpoint: { name: 'OS', klass: 'overall-survival', stat_value, stat_detail: null },
    }) as unknown as DigestStudy;
  const normalizedSource = (text: string) => [
    normalizeItemDecimals({ id: 1, author: null, text }) as { id: number; author: null; text: string },
  ];

  it('accepts a card that echoes the middle-dot spelling of a real number', () => {
    const out = validatePrimaryEndpoint(endpointStudy('HR 0·53'), normalizedSource('HR 0·53 (0·44–0·65)'));
    expect(out.primary_endpoint?.stat_value).toBe('HR 0·53');
  });

  it('no longer passes a middle-dot number on two unrelated integers', () => {
    // Raw, "0·53" was checked as "0" and "53"; a source with 0 events and 53
    // patients vouched for a hazard ratio it never reported.
    const src = normalizedSource('53 patients, 0 deaths, HR 0·71');
    expect(validatePrimaryEndpoint(endpointStudy('HR 0·53'), src).primary_endpoint).toBeNull();
  });

  it('keeps the primary endpoint and the results table through buildDigest', async () => {
    const tid = paperIdToSyntheticTweetId(85);
    const responses = [
      JSON.stringify({
        studies: [{ slug: 'torpedo', name: 'TORPEdO', disease_site: 'head-neck', tweet_ids: [tid] }],
      }),
      JSON.stringify({
        name: 'TORPEdO',
        tldr: 'IMPT vs IMRT: tube dependence or severe weight loss 18% vs 7% (p=0.079).',
        details: [
          {
            text: '📊 Co-primary endpoints, IMPT vs IMRT',
            table: {
              columns: ['Endpoint', 'IMPT', 'IMRT', 'p'],
              rows: [
                ['Tube dependence or weight loss', '18%', '7%', '0.079'],
                ['UW-QoL physical composite', '78.3', '77.1', '0.56'],
              ],
            },
          },
        ],
        nct: null,
        primary_endpoint: {
          name: 'Tube dependence or severe weight loss',
          klass: 'surrogate',
          stat_value: 'OR 2.80',
          stat_detail: '97.5% CI 0.75-10.41; p=0.079',
        },
      }),
      JSON.stringify({
        top_line: 'TORPEdO',
        tldr: 'TORPEdO.',
        site_meta: [{ disease_site: 'head-neck', intro: null, open_questions: null }],
      }),
    ];
    const complete = vi.fn(async () => responses.shift()!);
    const client: LlmClient = { complete };
    const paper: DigestInputPaper = {
      source_type: 'paper',
      id: 85,
      pmid: null,
      doi: '10.1016/s0140-6736(26)00314-4',
      title: 'Proton beam therapy for oropharyngeal cancer (TORPEdO)',
      abstract,
    };

    const result = await buildDigest([paper], { conferenceName: '', conferenceDay: '', client });
    const study = result.sites[0]!.studies[0]!;
    expect(study.primary_endpoint?.stat_value).toBe('OR 2.80');
    expect(study.details.some((d) => typeof d === 'object' && 'table' in d && d.table)).toBe(true);

    // The study agent was shown the normalized spelling too, so it quotes it.
    const prompts = JSON.stringify(complete.mock.calls);
    expect(prompts).toContain('2.80');
    expect(prompts).not.toContain('2·80');
  });
});

describe('figure-sourced marking on raw DB text', () => {
  it('does not mark a number the abstract states in middle-dot form', () => {
    const details: DigestDetail[] = ['📊 HR 0.62'];
    const [d] = markFigureSourcedDetails(details, {
      figureText: 'Figure 2: HR 0.62',
      abstractText: 'hazard ratio 0·62',
    });
    expect(sourceTierOf(d!)).toBeNull();
  });

  it('marks a figure-only number the OCR printed in middle-dot form', () => {
    const details: DigestDetail[] = ['📊 5-yr OS 71.4%'];
    const [d] = markFigureSourcedDetails(details, {
      figureText: 'Figure 2: 71·4%',
      abstractText: 'Overall survival did not differ.',
    });
    expect(sourceTierOf(d!)).toBe('figure');
  });
});
