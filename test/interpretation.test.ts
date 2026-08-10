// v0.45: the long-form interpretive read.
//
// Its failure modes are the inverse of `significance`'s. A significance that
// runs long is a bloated callout; an interpretation that comes back SHORT means
// the model padded or abstained badly, and half a section is worse than none —
// so the floor is what most of these tests are about.

import { describe, it, expect } from 'vitest';
import { parseInterpretation } from '../src/lib/llm-pipeline.ts';

const para = (n: number) => 'word '.repeat(n).trim();
// comfortably over the 600-char floor, as a real 350-600 word section is
const REAL = [para(60), para(60), para(60)].join('\n\n');

describe('parseInterpretation', () => {
  it('keeps a real long-form section and its paragraph breaks', () => {
    const out = parseInterpretation(REAL);
    expect(out).toBeTruthy();
    expect(out!.split(/\n\s*\n/)).toHaveLength(3);
    expect(out!.length).toBeGreaterThan(600);
  });

  it('collapses whitespace WITHIN a paragraph but never across the break', () => {
    const out = parseInterpretation(`${para(80)}   \n   \n  ${para(80)}`);
    expect(out!.split(/\n\s*\n/)).toHaveLength(2);
    expect(out).not.toMatch(/ {2}/);
    expect(out).not.toMatch(/\n{3}/);
  });

  it('abstains on a stub — a hedging fragment is worse than no section', () => {
    expect(parseInterpretation('This trial is interesting and may change practice.')).toBeNull();
    expect(parseInterpretation(para(50))).toBeNull(); // ~300 chars, under the floor
    expect(parseInterpretation('')).toBeNull();
    expect(parseInterpretation('   \n\n   ')).toBeNull();
  });

  it('abstains on a non-string, so a malformed emission cannot render', () => {
    expect(parseInterpretation(null)).toBeNull();
    expect(parseInterpretation(undefined)).toBeNull();
    expect(parseInterpretation(42)).toBeNull();
    expect(parseInterpretation({ body: REAL })).toBeNull();
  });

  it('joins an array emission, which the model sometimes produces', () => {
    const out = parseInterpretation([para(60), para(60), para(60)]);
    expect(out).toBeTruthy();
    expect(out!.length).toBeGreaterThan(600);
  });

  it('caps runaway generation without dropping the section', () => {
    const out = parseInterpretation(para(4000));
    expect(out).toBeTruthy();
    expect(out!.length).toBeLessThanOrEqual(6000);
  });

  it('ignores non-string members of an array emission', () => {
    expect(parseInterpretation([para(60), null, para(60), 7, para(60)])!.length).toBeGreaterThan(600);
  });
});
