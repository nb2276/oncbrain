// Guards the "same number, bolded twice, one line apart" fix.
//
// The risk here is asymmetric: leaving a duplicate emphasized costs the reader
// a moment of redundancy, but un-emphasizing the WRONG token silently demotes a
// real result. So most of these cases are about what the helper must REFUSE.

import { describe, it, expect } from 'vitest';
import { normalizeStat, statAtoms, isDuplicateStat } from '../src/lib/stat-dedupe.ts';

describe('normalizeStat', () => {
  it('folds the ways the same quantity gets typeset across two fields', () => {
    expect(normalizeStat('HR 0.62')).toBe('hr 0.62');
    expect(normalizeStat('  HR   0.62  ')).toBe('hr 0.62');
    expect(normalizeStat('HR 0.62.')).toBe('hr 0.62');
    expect(normalizeStat('HR 0.62,')).toBe('hr 0.62');
  });

  it('does NOT strip the CI or the operator — those change the information', () => {
    expect(normalizeStat('HR 0.62 (95% CI 0.48-0.79)')).toBe('hr 0.62 (95% ci 0.48-0.79)');
    expect(normalizeStat('p<0.001')).toBe('p<0.001');
  });
});

describe('isDuplicateStat', () => {
  it('matches the same statistic written the same way', () => {
    expect(isDuplicateStat('HR 0.62', 'HR 0.62')).toBe(true);
    expect(isDuplicateStat('hr 0.62', 'HR 0.62')).toBe(true);
    expect(isDuplicateStat('HR  0.62', 'HR 0.62')).toBe(true);
  });

  it('matches when one field carries the fuller form of the other', () => {
    // the endpoint slot shows it bare, the TL;DR spells out the interval
    expect(isDuplicateStat('HR 0.62 (95% CI 0.48-0.79)', 'HR 0.62')).toBe(true);
    // and the reverse, which is just as common
    expect(isDuplicateStat('HR 0.62', 'HR 0.62 (95% CI 0.48-0.79)')).toBe(true);
    expect(isDuplicateStat('92%', '92% vs 85%')).toBe(true);
  });

  it('does NOT match a DIFFERENT effect size', () => {
    expect(isDuplicateStat('HR 0.55', 'HR 0.62')).toBe(false);
    expect(isDuplicateStat('OR 0.62', 'HR 0.62')).toBe(false);
    expect(isDuplicateStat('85%', '92%')).toBe(false);
  });

  it('refuses a bare decimal — too weak an identity to demote a number on', () => {
    // "0.62" alone would collide with an unrelated 0.62 elsewhere in the
    // sentence; un-emphasizing the wrong number is worse than a live duplicate
    expect(isDuplicateStat('0.62', 'HR 0.62')).toBe(false);
    expect(isDuplicateStat('HR 0.62', '0.62')).toBe(false);
    expect(isDuplicateStat('0.62', '0.62')).toBe(false);
  });

  it('is inert when there is no endpoint stat to de-duplicate against', () => {
    expect(isDuplicateStat('HR 0.62', null)).toBe(false);
    expect(isDuplicateStat('HR 0.62', undefined)).toBe(false);
    expect(isDuplicateStat('HR 0.62', '')).toBe(false);
    expect(isDuplicateStat('', 'HR 0.62')).toBe(false);
    expect(isDuplicateStat('  ', 'HR 0.62')).toBe(false);
  });

  it('never matches THROUGH a number — a shorter decimal is a different result', () => {
    // plain `includes` reports "HR 0.6" inside "HR 0.62"; suppressing on that
    // would demote a genuinely different effect size
    expect(isDuplicateStat('HR 0.6', 'HR 0.62')).toBe(false);
    expect(isDuplicateStat('HR 0.62', 'HR 0.6')).toBe(false);
    expect(isDuplicateStat('9%', '92%')).toBe(false);
    expect(isDuplicateStat('14.2 mo', '4.2 mo')).toBe(false);
    expect(isDuplicateStat('mPFS 14.2 mo', 'HR 0.62')).toBe(false);
  });

  it('still matches when the boundary is a real one', () => {
    expect(isDuplicateStat('HR 0.62 (95% CI 0.48-0.79)', 'HR 0.62')).toBe(true);
  });

  // The shapes that actually occur in the corpus, and that whole-string
  // containment got WRONG. Both were still double-bolded after the first
  // implementation; they are why this compares atoms.
  it('sees one component of a COMPOUND endpoint stat restated in the TL;DR', () => {
    // 2026-05-17: endpoint carries both the medians and the ratio
    expect(isDuplicateStat('HR 0.48 (0.25-0.91)', '35.8 vs 20.4 mo, HR 0.48')).toBe(true);
    expect(isDuplicateStat('35.8 vs 20.4mo', '35.8 vs 20.4 mo, HR 0.48')).toBe(true);
    // but a genuinely different ratio in the same sentence keeps its emphasis
    expect(isDuplicateStat('HR 0.71', '35.8 vs 20.4 mo, HR 0.48')).toBe(false);
  });

  it('is not fooled by the journal "v" vs "vs" abbreviation', () => {
    // 2026-08-07: endpoint said "64.5% v 62.3%", TL;DR said "64.5% vs 62.3%"
    expect(isDuplicateStat('64.5% vs 62.3%', '64.5% v 62.3%')).toBe(true);
  });
});

describe('statAtoms', () => {
  it('anchors a number to what it measures, and ignores unanchored ones', () => {
    expect([...statAtoms('35.8 vs 20.4 mo, HR 0.48')].sort()).toEqual(['20.4 mo', 'hr 0.48']);
    expect([...statAtoms('64.5% v 62.3%')].sort()).toEqual(['62.3%', '64.5%']);
    // a naked decimal and a p-value carry no measure → no atoms → never matched
    expect(statAtoms('0.62').size).toBe(0);
    expect(statAtoms('p<0.001').size).toBe(0);
  });
});
