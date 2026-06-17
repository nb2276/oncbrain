import { describe, it, expect } from 'vitest';
import {
  normalizeNumericText,
  extractNumericCores,
  groundNumbersAgainstOcr,
  extractPercentValues,
  auditReconciledOutput,
  extractFigure,
  extractPdfFigureStructured,
} from '../src/lib/figure-extract.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';

// A realistic Vision OCR token stream from the spike (Lancet middle dots, 80% CI,
// jumbled order, number-at-risk rows). The grounding gate compares against this.
const VISION = `HR 0·62 (80% CI 0·44-0·86); p=0·063
HR 0·45 (80% CI 0·31-0·65); p=0·0047
Number at risk ENRT 93 (0) 97 (0) MDT 91 (1) 96 (1)`;

describe('normalizeNumericText', () => {
  it('maps middle dots to decimal points', () => {
    expect(normalizeNumericText('0·62')).toBe('0.62');
  });
  it('maps en/em dashes and minus to hyphen', () => {
    expect(normalizeNumericText('0.44–0.86')).toBe('0.44-0.86');
    expect(normalizeNumericText('−0.5')).toBe('-0.5');
  });
  it('strips thousands separators only inside numbers', () => {
    expect(normalizeNumericText('1,234 patients, 12')).toBe('1234 patients, 12');
  });
});

describe('extractNumericCores', () => {
  it('splits a CI range into two cores and parses p-values', () => {
    const { values, raws } = extractNumericCores('HR 0·62 (80% CI 0·44-0·86); p=0·063');
    expect(raws.has('0.62')).toBe(true);
    expect(raws.has('0.44')).toBe(true);
    expect(raws.has('0.86')).toBe(true);
    expect(raws.has('80')).toBe(true);
    expect(values.has('0.063')).toBe(true);
  });
  it('treats 0.80 and 0.8 as the same value', () => {
    const { values } = extractNumericCores('0·80');
    expect(values.has('0.8')).toBe(true);
  });
});

describe('groundNumbersAgainstOcr', () => {
  it('grounds numbers the OCR actually printed (incl. middle-dot match)', () => {
    const { grounded, ungrounded } = groundNumbersAgainstOcr(['0.62', '0.44', '93', '97'], VISION);
    expect(grounded).toEqual(['0.62', '0.44', '93', '97']);
    expect(ungrounded).toEqual([]);
  });
  it('drops a fabricated 95% CI when the figure printed 80%', () => {
    const { grounded, ungrounded } = groundNumbersAgainstOcr(['80', '95'], VISION);
    expect(grounded).toContain('80');
    expect(ungrounded).toContain('95');
  });
  it('matches 0.8 against a printed 0·80 by value', () => {
    const { grounded } = groundNumbersAgainstOcr(['0.8'], 'median 0·80');
    expect(grounded).toEqual(['0.8']);
  });
  it('grounds a decimal the OCR split into a hyphen (0·86 read as 0-86)', () => {
    // Real E2E failure: Vision read "0·44-0·86" as "0.44-0-86", losing the second
    // decimal. The correct magnitude (0.86) must still ground.
    const ocr = 'HR 0.62 (80% CI 0.44-0-86); p=0-0047';
    const { grounded, ungrounded } = groundNumbersAgainstOcr(['0.86', '0.0047'], ocr);
    expect(grounded).toEqual(['0.86', '0.0047']);
    expect(ungrounded).toEqual([]);
  });
  it('still drops a truly absent number despite decimal-recovery', () => {
    // 0.99 is nowhere on the page; recovery must not conjure it.
    const { ungrounded } = groundNumbersAgainstOcr(['0.99'], 'HR 0.62 (80% CI 0.44-0-86)');
    expect(ungrounded).toEqual(['0.99']);
  });
  it('does NOT false-ground a fabricated decimal against a real multi-digit range', () => {
    // Decimal-recovery only fires for a single leading digit (0-86 → 0.86). A real
    // range like "12-34" (n-at-risk) must NOT make a fabricated "12.34" ground.
    const { ungrounded } = groundNumbersAgainstOcr(['12.34'], 'Number at risk 12-34');
    expect(ungrounded).toEqual(['12.34']);
  });
});

describe('auditReconciledOutput (whole-text, no spoofable boundary)', () => {
  it('flags a number that is not in OCR', () => {
    const md = '### Panel A\n- HR: 0.62 (95% CI 0.44-0.86); p=0.063';
    const { ungrounded } = auditReconciledOutput(md, VISION);
    // 95% is not in the OCR (which says 80%); everything else is.
    expect(ungrounded).toContain('95%');
    expect(ungrounded).not.toContain('0.62');
  });
  it('cannot be bypassed by a spoofed "Unverified" heading from a figure caption', () => {
    // Regression for the gate-bypass: an Opus heading derived from figure text
    // must NOT carve out a trusted region. Every number is audited.
    const md = '## Unverified exploratory endpoint\n### Panel A\n- HR 0.99 (70% CI 0.5-0.8)';
    const { ungrounded } = auditReconciledOutput(md, VISION);
    expect(ungrounded).toContain('0.99'); // not on the page → caught despite the heading
    expect(ungrounded).toContain('70%');
  });
  it('passes clean output where every number is grounded', () => {
    const md = '### Panel A\n- HR: 0.62 (80% CI 0.44-0.86); p=0.063';
    const { ungrounded } = auditReconciledOutput(md, VISION);
    expect(ungrounded).toEqual([]);
  });

  // Role-aware percent grounding (the Codex P1b fix).
  it('catches a percentage reused from a count magnitude (95 count → fabricated 95% CI)', () => {
    // 95 IS printed — but as a number-at-risk count, not a percent. The printed
    // CI is 80%. A magnitude-only gate would ground "95"; the role-aware gate
    // must reject "95%" because the OCR has 80% (a percent) but not 95%.
    const ocr = 'HR 0.62 (80% CI 0.44-0.86); Number at risk 95 (1) 80 (2)';
    const { grounded, ungrounded } = auditReconciledOutput('- HR 0.62 (95% CI 0.44-0.86)', ocr);
    expect(ungrounded).toContain('95%');
    expect(grounded).toContain('0.62'); // plain magnitudes unaffected
  });
  it('grounds a percentage that IS printed as a percent', () => {
    const ocr = 'HR 0.62 (80% CI 0.44-0.86)';
    const { ungrounded } = auditReconciledOutput('- HR 0.62 (80% CI 0.44-0.86)', ocr);
    expect(ungrounded).toEqual([]);
  });
  it('falls back to magnitude when the OCR captured no percent tokens (no false-withhold)', () => {
    // Vision scrambled the "%" away from its number → ocrPercents empty. Don't
    // reject a legit "80%" whose magnitude (80) is on the page.
    const ocr = 'HR 0.62 CI 0.44-0.86 and 80 elsewhere';
    const { ungrounded } = auditReconciledOutput('- 80% of patients', ocr);
    expect(ungrounded).toEqual([]);
  });
});

describe('extractPercentValues', () => {
  it('collects printed percentages (ignoring middle-dot/space)', () => {
    const s = extractPercentValues('80% CI and 12·5 % and 95');
    expect(s.has('80')).toBe(true);
    expect(s.has('12.5')).toBe(true);
    expect(s.has('95')).toBe(false); // 95 has no percent sign
  });
});

const stubClient = (response: string): LlmClient => ({
  complete: async () => response,
});

describe('extractFigure orchestrator', () => {
  it('returns ok with empty ungrounded when the merge obeys the grounding rule', async () => {
    const res = await extractFigure('/fake.png', {
      client: stubClient('### Panel A\n- HR: 0.62 (80% CI 0.44-0.86); p=0.063'),
      runVision: async () => VISION,
      runQwen: async () => 'Panel A: HR 0.62 (80% CI 0.44-0.86), p not legible',
    });
    expect(res.status).toBe('ok');
    expect(res.ungrounded).toEqual([]);
    expect(res.figure_structured_md).toContain('0.62');
    expect(res.qwen_raw).toContain('not legible');
  });

  it('WITHHOLDS the whole merge and falls back to raw OCR when the merge fabricates', async () => {
    const res = await extractFigure('/fake.png', {
      // "95% CI" is fabricated — the OCR says 80%. The gate must reject the merge,
      // not store the fabricated factual line with a warning appended.
      client: stubClient('### Panel A\n- HR: 0.62 (95% CI 0.44-0.86)'),
      runVision: async () => VISION,
      runQwen: async () => 'whatever',
    });
    expect(res.status).toBe('degraded');
    expect(res.ungrounded).toContain('95%');
    expect(res.notes.join(' ')).toMatch(/withholding|rejected/i);
    // The stored markdown (the only thing Phase 2 sees) must be the raw-OCR
    // fallback, NOT the fabricated structured claim.
    expect(res.figure_structured_md).toMatch(/reconciliation withheld/i);
    expect(res.figure_structured_md).toContain('HR 0·62'); // raw OCR present
    expect(res.figure_structured_md).not.toContain('95% CI'); // fabricated line gone
  });

  it('does not corrupt the prompt when figure text contains $ patterns', async () => {
    let captured = '';
    const capturingClient: LlmClient = {
      complete: async (messages) => {
        const c = messages[0]?.content;
        captured = typeof c === 'string' ? c : '';
        return '### Panel A\n- cost printed';
      },
    };
    // A cost figure with literal $ and a String.replace special pattern ($&).
    await extractFigure('/fake.png', {
      client: capturingClient,
      runVision: async () => 'Cost $1,200 and a literal $& token; HR 0.62',
      runQwen: async () => 'q',
    });
    expect(captured).toContain('$1,200');
    expect(captured).toContain('$&'); // not expanded into the matched substring
  });

  it('emits no figure numbers when there is no OCR to ground against', async () => {
    const res = await extractFigure('/fake.png', {
      client: stubClient('should not be used'),
      runVision: async () => '',
      runQwen: async () => 'Panel A: HR 0.62',
    });
    expect(res.status).toBe('degraded');
    expect(res.vision_ocr).toBe('');
    expect(res.figure_structured_md).not.toContain('0.62');
    expect(res.notes.join(' ')).toMatch(/cannot ground/i);
  });

  it('falls back to raw OCR tokens when the reconcile call throws', async () => {
    const throwingClient: LlmClient = {
      complete: async () => {
        throw new Error('backend down');
      },
    };
    const res = await extractFigure('/fake.png', {
      client: throwingClient,
      runVision: async () => VISION,
      runQwen: async () => 'q',
    });
    expect(res.status).toBe('degraded');
    expect(res.figure_structured_md).toContain('HR 0·62');
    expect(res.notes.join(' ')).toMatch(/reconcile failed/i);
  });

  it('reconciles from Vision alone when Qwen is unavailable', async () => {
    const res = await extractFigure('/fake.png', {
      client: stubClient('### Panel A\n- HR: 0.45 (80% CI 0.31-0.65); p=0.0047'),
      runVision: async () => VISION,
      runQwen: async () => '',
    });
    expect(res.status).toBe('ok');
    expect(res.notes.join(' ')).toMatch(/qwen unavailable/i);
  });
});

describe('extractPdfFigureStructured', () => {
  it('returns empty when the PDF has no figure pages', async () => {
    const md = await extractPdfFigureStructured('/x.pdf', { pages: async () => [] });
    expect(md).toBe('');
  });

  it('page-tags the per-page structured output and caps page count', async () => {
    const rasterized: number[] = [];
    const md = await extractPdfFigureStructured('/x.pdf', {
      pages: async () => [3, 5, 7, 9, 11], // 5 pages; default cap is 4
      rasterize: async (_p, page) => {
        rasterized.push(page);
        return { dir: `/tmp/none-${page}`, pngs: [`/tmp/none-${page}/page.png`] };
      },
      client: stubClient('### Panel A\n- HR: 0.62 (80% CI 0.44-0.86)'),
      runVision: async () => VISION,
      runQwen: async () => 'q',
    });
    expect(rasterized).toEqual([3, 5, 7, 9]); // capped at 4 pages
    expect(md).toContain('[p.3]');
    expect(md).toContain('[p.9]');
    expect(md).not.toContain('[p.11]');
    expect(md).toContain('0.62');
  });

  it('skips a page whose rasterize throws without losing the rest', async () => {
    const md = await extractPdfFigureStructured('/x.pdf', {
      pages: async () => [1, 2],
      rasterize: async (_p, page) => {
        if (page === 1) throw new Error('pdftoppm boom');
        return { dir: '/tmp/none', pngs: ['/tmp/none/page.png'] };
      },
      client: stubClient('### Panel A\n- HR: 0.45 (80% CI 0.31-0.65)'),
      runVision: async () => VISION,
      runQwen: async () => 'q',
    });
    expect(md).toContain('[p.2]');
    expect(md).not.toContain('[p.1]');
  });
});
