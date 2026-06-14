import { describe, it, expect } from 'vitest';
import { scoreResolverEval, type CaseResult, type EvalCase } from '../build/eval-resolver.ts';

const c = (expected: string | null): EvalCase => ({
  acronym: 'X',
  disease: 'prostate',
  expected,
  candidates: [],
});

describe('scoreResolverEval (T7 precision-first gate)', () => {
  it('passes when every positive is correct and no collision is mis-picked', () => {
    const results: CaseResult[] = [
      { case: c('111'), picked: '111' }, // correct pick
      { case: c('222'), picked: '222' }, // correct pick
      { case: c(null), picked: null }, // correct NONE
    ];
    const r = scoreResolverEval(results);
    expect(r).toMatchObject({ correct: 3, falsePositives: 0, precision: 1, recall: 1, pass: true });
  });

  it('FAILS on a single collision false-positive regardless of recall (precision-first)', () => {
    const results: CaseResult[] = [
      { case: c('111'), picked: '111' },
      { case: c('222'), picked: '222' },
      { case: c('333'), picked: '333' },
      { case: c(null), picked: '999' }, // a collision mis-picked → disqualifying
    ];
    const r = scoreResolverEval(results);
    expect(r.recall).toBe(1); // perfect recall…
    expect(r.falsePositives).toBe(1);
    expect(r.pass).toBe(false); // …but a false positive still fails
  });

  it('FAILS when recall falls below the threshold (too many missed)', () => {
    const results: CaseResult[] = [
      { case: c('111'), picked: '111' },
      { case: c('222'), picked: null }, // missed
      { case: c('333'), picked: null }, // missed
      { case: c('444'), picked: null }, // missed
    ];
    const r = scoreResolverEval(results, 0.75);
    expect(r.falsePositives).toBe(0);
    expect(r.recall).toBe(0.25);
    expect(r.falseNegatives).toBe(3);
    expect(r.pass).toBe(false);
  });

  it('counts a wrong-pick (picked a different candidate) separately, hurting precision', () => {
    const results: CaseResult[] = [
      { case: c('111'), picked: '111' },
      { case: c('222'), picked: '888' }, // wrong candidate
    ];
    const r = scoreResolverEval(results, 0);
    expect(r.wrongPicks).toBe(1);
    expect(r.picksMade).toBe(2);
    expect(r.precision).toBe(0.5); // 1 correct of 2 picks
  });

  it('a missed positive does NOT count as a false positive (recall vs precision are distinct)', () => {
    const r = scoreResolverEval([{ case: c('111'), picked: null }], 0);
    expect(r.falsePositives).toBe(0);
    expect(r.falseNegatives).toBe(1);
    expect(r.precision).toBe(1); // no bad picks were made
  });
});
