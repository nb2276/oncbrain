// The card-agrees-with-itself audit. validateStudyTables grounds every cell
// against SOURCE; nothing checked the card against ITSELF, and the v0.42
// multi-date quality-eval kept finding the gap: "contradicts its own table's 92%
// whole-group value — the single most visible number on that card isn't the one
// in its table". Both numbers are grounded, so every existing guard passes.
import { describe, it, expect } from 'vitest';
import {
  extractValues,
  findUntraceableHeadline,
  auditDigestSelfConsistency,
  formatUntraceableHeadlines,
  headlineNumbersMissingFromCards,
} from '../src/lib/self-consistency.ts';

const table = (rows: string[][]) => ({
  text: '📊 Outcomes',
  table: { columns: ['Endpoint', 'Whole group'], rows },
});

describe('extractValues', () => {
  it('takes percentages and decimals', () => {
    expect([...extractValues('RFS 92% and HR 0.54')]).toEqual(['92%', '0.54']);
  });

  it('ignores bare integers, which are years, doses and arm sizes', () => {
    // 40 Gy in 5 fractions over 10 years is four integers and zero claims.
    expect([...extractValues('40 Gy in 5 fx, 10-yr follow-up, n = 309')]).toEqual([]);
  });

  it('normalises thousands separators and spacing', () => {
    expect(extractValues('1,024 % here').has('1024%')).toBe(true);
    expect(extractValues('92 %').has('92%')).toBe(true);
  });

  it('does not split a decimal into two integers', () => {
    expect([...extractValues('p=0.0025')]).toEqual(['0.0025']);
  });
});

describe('findUntraceableHeadline', () => {
  it('catches the real failure: TL;DR says 90%, its own table says 92%', () => {
    const study = {
      slug: 'sbrt-prostate-10yr-outcomes',
      tldr: '10-yr RFS 90% overall (94% LR, 86% IR) with 40 Gy/5 fx SBRT.',
      details: [table([['Freedom from biochemical/clinical relapse', '92% (87-96)']])],
    };
    const hit = findUntraceableHeadline(study);
    expect(hit).not.toBeNull();
    expect(hit!.values).toContain('90%');
    // ...and does not complain about the values the table DOES carry.
    expect(hit!.values).not.toContain('92%');
  });

  it('stays silent when the headline is traceable to the table', () => {
    const study = {
      slug: 'ok',
      tldr: 'RFS 92% at 10 years.',
      details: [table([['Freedom from biochemical/clinical relapse', '92% (87-96)']])],
    };
    expect(findUntraceableHeadline(study)).toBeNull();
  });

  it('accepts a headline supported by a bullet rather than the table', () => {
    const study = {
      slug: 'ok2',
      tldr: 'Grade 3 GU toxicity 1.4%.',
      details: [table([['OS', '84%']]), '⚠️ Grade 3 GU toxicity 1.4% at 10 years'],
    };
    expect(findUntraceableHeadline(study)).toBeNull();
  });

  it('accepts a headline supported by an analysis section or significance', () => {
    const base = { slug: 'ok3', tldr: 'HR 0.54 for DFS.', details: [table([['OS', '84%']])] };
    expect(findUntraceableHeadline({ ...base, significance: 'The DFS HR of 0.54 moves referral.' })).toBeNull();
    expect(
      findUntraceableHeadline({ ...base, analysis_sections: [{ label: 'Results', body: 'DFS HR 0.54.' }] }),
    ).toBeNull();
  });

  it('is scoped to cards that render a table', () => {
    // Without one, a headline number legitimately appears only in the TL;DR.
    const study = { slug: 'no-table', tldr: 'RFS 90%.', details: ['🔍 A bullet with no numbers'] };
    expect(findUntraceableHeadline(study)).toBeNull();
  });

  it('says nothing about a TL;DR that states no value', () => {
    const study = { slug: 'qual', tldr: 'A consensus framework, not a trial.', details: [table([['OS', '84%']])] };
    expect(findUntraceableHeadline(study)).toBeNull();
  });

  it('does not treat a year or a dose in the TL;DR as a claim', () => {
    const study = {
      slug: 'units',
      tldr: '40 Gy in 5 fractions, 10-year follow-up, OS 84%.',
      details: [table([['OS', '84%']])],
    };
    expect(findUntraceableHeadline(study)).toBeNull();
  });
});

describe('auditDigestSelfConsistency', () => {
  const digest = (studies: unknown[]) => ({ sites: [{ studies: studies as never[] }] });

  it('reports one entry per offending card and none for the rest', () => {
    const bad = {
      slug: 'bad',
      tldr: 'RFS 90%.',
      details: [table([['RFS', '92%']])],
    };
    const good = { slug: 'good', tldr: 'RFS 92%.', details: [table([['RFS', '92%']])] };
    const hits = auditDigestSelfConsistency(digest([bad, good]));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.slug).toBe('bad');
  });

  it('formats a clean day as a positive statement, not silence', () => {
    expect(formatUntraceableHeadlines([])).toMatch(/every card's headline number is traceable/);
  });

  it('names the card and the value so the curator can go straight to it', () => {
    const out = formatUntraceableHeadlines([{ slug: 'poseidon', values: ['0.87', '0.76'] }]);
    expect(out).toContain('poseidon');
    expect(out).toContain('0.87, 0.76');
  });
});

describe('typographic normalisation', () => {
  it('treats a Lancet middle dot as a decimal point', () => {
    // Found by running the audit on a real rebuild: PEACE V-STORM's TL;DR wrote
    // "HR 0.62 ... p=0.063" while its own table wrote "0·62" and "0·063". Same
    // numbers, two typographies, and the audit called the headline untraceable.
    const study = {
      slug: 'peace-v-storm',
      tldr: '4-yr MFS 76% vs 63%, HR 0.62 (80% CI 0.44-0.86), p=0.063.',
      details: [
        {
          text: '📊 Outcomes',
          table: {
            columns: ['Endpoint', 'ENRT', 'MDT', 'HR (80% CI)', 'p'],
            rows: [['Metastasis-free survival', '76% (69-81)', '63% (56-69)', '0·62 (0·44-0·86)', '0·063']],
          },
        },
      ],
    };
    expect(findUntraceableHeadline(study)).toBeNull();
  });

  it('still reports a genuine mismatch when the typography matches', () => {
    const study = {
      slug: 'real-slip',
      tldr: 'HR 0·70 for DFS.',
      details: [{ text: 'x', table: { columns: ['Endpoint', 'HR'], rows: [['DFS', '0·62']] } }],
    };
    expect(findUntraceableHeadline(study)?.values).toEqual(['0.70']);
  });
});

// A suppression can strand the DAY'S headline. Phase 3 synthesises top_line over
// every study Phase 2 produced; durable overrides are applied afterwards by
// design, so dropping a card can leave the day led by a number no surviving card
// carries. Latent while suppression was manual and rare; trial lineage
// suppresses automatically, which makes it routine.
describe('headlineNumbersMissingFromCards', () => {
  const card = (tldr: string) => ({ slug: 's', name: 'S', tldr, details: [] });

  it('flags a headline number no surviving card carries', () => {
    // The real case: 2026-07-08 kept the GU005 quality-of-life card and lost the
    // DFS card, but the day still led with the DFS hazard ratio.
    const orphans = headlineNumbersMissingFromCards({
      top_line: 'NRG-GU005: SBRT crosses the DFS futility bound (HR 1.38).',
      sites: [{ studies: [card('MCID bowel decline 33% vs 46% at 1yr (p=0.002).')] }],
    });
    expect(orphans).toContain('1.38');
  });

  it('stays quiet when the headline is traceable to a card', () => {
    expect(
      headlineNumbersMissingFromCards({
        top_line: 'MCID bowel decline 33% vs 46% at 1yr.',
        sites: [{ studies: [card('MCID bowel decline 33% vs 46% at 1yr (p=0.002).')] }],
      }),
    ).toEqual([]);
  });

  it('stays quiet on a headline with no numbers at all', () => {
    expect(
      headlineNumbersMissingFromCards({
        top_line: 'Two consensus documents fill the guideline gaps.',
        sites: [{ studies: [card('First consensus guideline for post-op CTV delineation.')] }],
      }),
    ).toEqual([]);
  });

  it('handles an empty day without throwing', () => {
    expect(headlineNumbersMissingFromCards({ top_line: 'HR 1.38', sites: [] })).toEqual(['1.38']);
    expect(headlineNumbersMissingFromCards({ sites: [] })).toEqual([]);
  });
});
