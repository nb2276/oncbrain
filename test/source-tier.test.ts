import { describe, it, expect } from 'vitest';
import { numericTokens, markFigureSourcedDetails } from '../src/lib/source-tier.ts';
import { sourceTierOf, type DigestDetail } from '../src/lib/llm-pipeline.ts';

describe('numericTokens', () => {
  it('extracts decimals and 2+ digit integers, drops bare single digits', () => {
    expect(numericTokens('mPFS 8.7mo vs 5.4, HR 0.62, n=340, 95% CI, 2 arms')).toEqual([
      '8.7',
      '5.4',
      '0.62',
      '340',
      '95',
    ]);
    expect(numericTokens(null)).toEqual([]);
  });
});

describe('markFigureSourcedDetails', () => {
  const abstract = 'Median PFS was 5.4 months in the control arm.';
  const figure = 'Figure 2: experimental 8.7, control 5.4, HR 0.62';

  it("marks a bullet whose number is in the figure but NOT the abstract", () => {
    const details: DigestDetail[] = ['Experimental arm mPFS 8.7mo (HR 0.62)'];
    const [d] = markFigureSourcedDetails(details, { figureText: figure, abstractText: abstract });
    expect(sourceTierOf(d)).toBe('figure'); // 8.7 and 0.62 are figure-exclusive
  });

  it('does NOT mark a bullet whose only number is also in the abstract', () => {
    const details: DigestDetail[] = ['Control arm mPFS 5.4mo'];
    const [d] = markFigureSourcedDetails(details, { figureText: figure, abstractText: abstract });
    expect(sourceTierOf(d)).toBeNull(); // 5.4 is in the abstract too — not figure-exclusive
  });

  it('returns everything untagged when the study has no figure OCR (nothing to vouch for)', () => {
    const details: DigestDetail[] = ['mPFS 8.7mo'];
    const [d] = markFigureSourcedDetails(details, { figureText: '', abstractText: abstract });
    expect(sourceTierOf(d)).toBeNull();
  });

  it('CLEARS a stale tier on rebuild when the number is no longer figure-exclusive', () => {
    const stale: DigestDetail[] = [{ text: 'Control arm mPFS 5.4mo', source_tier: 'figure' }];
    const [d] = markFigureSourcedDetails(stale, { figureText: figure, abstractText: abstract });
    expect(sourceTierOf(d)).toBeNull(); // reclassification only ever REMOVES an unsupported mark
  });

  it('promotes a plain string detail to an object when it earns the mark', () => {
    const details: DigestDetail[] = ['HR 0.62 favoring experimental'];
    const [d] = markFigureSourcedDetails(details, { figureText: figure, abstractText: abstract });
    expect(typeof d).toBe('object');
    expect(sourceTierOf(d)).toBe('figure');
  });

  it('preserves subdetails/table shape while attaching the tier', () => {
    const details: DigestDetail[] = [
      { text: 'Subgroup medians', subdetails: ['high-volume 8.7mo', 'low-volume 5.4mo'] },
    ];
    const [d] = markFigureSourcedDetails(details, { figureText: figure, abstractText: abstract });
    expect(sourceTierOf(d)).toBe('figure');
    expect((d as { subdetails: string[] }).subdetails).toEqual(['high-volume 8.7mo', 'low-volume 5.4mo']);
  });
});
