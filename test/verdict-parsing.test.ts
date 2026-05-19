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

  it('falls back to unclear for invalid soc_implication', () => {
    const v = parseVerdict({
      soc_implication: 'super-duper-changing',
      rationale: 'made-up label, should default',
    });
    expect(v?.soc_implication).toBe('unclear');
  });

  it('treats missing soc_implication as unclear', () => {
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

  it('truncates audience > 80 chars (no ellipsis at 80)', () => {
    const longAudience = 'a'.repeat(150);
    const v = parseVerdict({
      soc_implication: 'confirmatory',
      rationale: 'r',
      audience: longAudience,
    });
    expect(v?.audience?.length).toBeLessThanOrEqual(80);
    expect(v?.audience?.endsWith('…')).toBe(false);
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
