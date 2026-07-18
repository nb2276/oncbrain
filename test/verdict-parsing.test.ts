import { describe, it, expect } from 'vitest';
import { parseVerdict, SOC_IMPLICATIONS } from '../src/lib/llm-pipeline.ts';

describe('parseVerdict', () => {
  it('returns undefined when the field is missing', () => {
    expect(parseVerdict(undefined)).toBeUndefined();
    expect(parseVerdict(null)).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(parseVerdict('confirmatory')).toBeUndefined();
    expect(parseVerdict(123)).toBeUndefined();
    expect(parseVerdict([])).toBeUndefined();
  });

  it('returns undefined when rationale is missing or empty', () => {
    expect(parseVerdict({ soc_implication: 'confirmatory' })).toBeUndefined();
    expect(parseVerdict({ soc_implication: 'confirmatory', rationale: '' })).toBeUndefined();
    expect(parseVerdict({ soc_implication: 'confirmatory', rationale: '   ' })).toBeUndefined();
  });

  it('parses a well-formed verdict', () => {
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: 'Single-arm phase 2, no randomised comparator. Consistent with prior SAFIR signals.',
      audience: 'Inoperable primary RCC, T1b-dominant',
    });
    expect(v).toEqual({
      soc_implication: 'confirmatory',
      rationale: 'Single-arm phase 2, no randomised comparator. Consistent with prior SAFIR signals.',
      audience: 'Inoperable primary RCC, T1b-dominant',
    });
  });

  it('accepts every enum value in SOC_IMPLICATIONS', () => {
    for (const soc of SOC_IMPLICATIONS) {
      const v = parseVerdict({
        soc_implication: soc,
        rationale: 'test rationale',
      });
      expect(v?.soc_implication).toBe(soc);
    }
  });

  it('DROPS the verdict for a non-empty invalid soc_implication (no contradictory pill)', () => {
    // Was coerced to 'unclear' while keeping the rationale, rendering "Unclear"
    // beside an off-taxonomy rationale. Now drop the whole verdict instead.
    const v = parseVerdict({
      soc_implication: 'super-duper-changing',
      rationale: 'made-up label, should not mislabel as unclear',
    });
    expect(v).toBeUndefined();
  });

  it('normalizes case/space/underscore to the canonical slug', () => {
    expect(parseVerdict({ soc_implication: 'Practice Changing', rationale: 'r' })?.soc_implication).toBe(
      'practice-changing',
    );
  });

  it('treats missing soc_implication as unclear (kept)', () => {
    const v = parseVerdict({ rationale: 'no soc field' });
    expect(v?.soc_implication).toBe('unclear');
  });

  it('truncates rationale > 40 words with ellipsis', () => {
    const longRationale = 'word '.repeat(50).trim();
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: longRationale,
    });
    expect(v?.rationale.split(' ').length).toBeLessThanOrEqual(41); // 40 words + the ellipsis token
    expect(v?.rationale.endsWith('…')).toBe(true);
  });

  it('keeps rationale ≤ 40 words intact', () => {
    const r = 'twenty word rationale '.repeat(5).trim();
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: r,
    });
    expect(v?.rationale).toBe(r);
  });

  it('treats empty audience as null', () => {
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: 'r',
      audience: '',
    });
    expect(v?.audience).toBeNull();
  });

  it('truncates audience > 80 chars at a WORD boundary with an ellipsis', () => {
    // was a raw slice(0,80) that cut mid-word ("...2012-2016 coho"); now cuts at
    // the last whole word so the always-visible eligibility gate stays readable.
    const longAudience =
      'Localized intermediate-risk prostate cancer after radical prostatectomy with rising PSA and adverse pathology';
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: 'r',
      audience: longAudience,
    });
    expect(v?.audience?.length).toBeLessThanOrEqual(81); // ≤80 at a word boundary + ellipsis
    expect(v?.audience?.endsWith('…')).toBe(true);
    // pre-ellipsis text is a whole-word prefix of the original (no mid-word fragment)
    expect(longAudience).toContain(v!.audience!.replace(/…$/, '').trimEnd());
  });

  it('keeps audience ≤ 80 chars intact', () => {
    const a = 'Localized intermediate-risk prostate, post-RP biochemical failure';
    const v = parseVerdict({ soc_implication: 'confirmatory', rationale: 'r', audience: a });
    expect(v?.audience).toBe(a);
  });

  it('coerces missing audience to null', () => {
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: 'r',
    });
    expect(v?.audience).toBeNull();
  });
});
