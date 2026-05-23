import { describe, it, expect } from 'vitest';
import { stripStudyNamePrefix } from '../src/lib/digest-data.ts';

describe('stripStudyNamePrefix', () => {
  it('strips a plain "NAME:" label', () => {
    expect(stripStudyNamePrefix('PIVOTALboost: focal boost + pelvic nodal RT safe at 2 yrs', 'PIVOTALboost')).toBe(
      'focal boost + pelvic nodal RT safe at 2 yrs',
    );
  });

  it('keeps a meaningful qualifier as the new lead', () => {
    expect(
      stripStudyNamePrefix('EORTC IM-MS 20yr: OS neutral HR 1.00, BCM reduction HR 0.82', 'EORTC IM-MS (22922/10925)'),
    ).toBe('20yr: OS neutral HR 1.00, BCM reduction HR 0.82');
    expect(
      stripStudyNamePrefix('HypoG-01 secondary analysis: LRR 16% of 118 events', 'HypoG-01'),
    ).toBe('secondary analysis: LRR 16% of 118 events');
  });

  it('matches across separator/punctuation differences', () => {
    expect(stripStudyNamePrefix('PEACE-2: pelvic RT adds no significant cPFS benefit', 'PEACE 2')).toBe(
      'pelvic RT adds no significant cPFS benefit',
    );
  });

  it('leaves a name used as a sentence subject (no label colon)', () => {
    const t = 'PRIME showed G3+ tox under 1% in both arms with 5-fraction SBRT';
    expect(stripStudyNamePrefix(t, 'PRIME')).toBe(t);
  });

  it('does not swallow a full sentence that merely contains a later colon', () => {
    const t = 'PRIME showed no benefit and the authors note one caveat: small sample';
    expect(stripStudyNamePrefix(t, 'PRIME')).toBe(t);
  });

  it('returns the original when stripping would leave too little', () => {
    expect(stripStudyNamePrefix('OLIGOMA: done', 'OLIGOMA')).toBe('OLIGOMA: done');
  });

  it('is a no-op for empty inputs', () => {
    expect(stripStudyNamePrefix('', 'NAME')).toBe('');
    expect(stripStudyNamePrefix('some tldr text here', '')).toBe('some tldr text here');
  });
});
