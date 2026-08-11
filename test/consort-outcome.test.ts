// v0.48: the per-arm outcome node — the last link in the CONSORT chain.
//
// This is the one consort field that ATTRIBUTES a number to a patient group, so
// the tests are weighted toward what must be REFUSED. Printing the experimental
// arm's result under the control arm is a clinical error, not a layout bug.

import { describe, it, expect } from 'vitest';
import { parseConsort } from '../src/lib/llm-pipeline.ts';

const base = {
  enrolled: 629,
  excluded: 30,
  randomized: 599,
  arms: [
    { label: 'TNT', allocated: 302, analyzed: 302, outcome: '3yr DFS 64.5%' },
    { label: 'CRT', allocated: 297, analyzed: 297, outcome: '3yr DFS 62.3%' },
  ],
};

describe('parseConsort — per-arm outcome', () => {
  it('keeps a short result label on each arm', () => {
    const c = parseConsort(base)!;
    expect(c.arms.map((a) => a.outcome)).toEqual(['3yr DFS 64.5%', '3yr DFS 62.3%']);
  });

  it('collapses whitespace so a wrapped emission still fits one node', () => {
    const c = parseConsort({
      ...base,
      arms: [
        { ...base.arms[0], outcome: '3yr  DFS\n 64.5%' },
        base.arms[1],
      ],
    })!;
    expect(c.arms[0].outcome).toBe('3yr DFS 64.5%');
  });

  it('drops prose rather than truncating it mid-number', () => {
    // >48 chars means the model wrote a sentence, not a result. Truncating could
    // cut "64.5%" to "64." and print a different number than the paper reports.
    const long = 'disease-free survival at three years was 64.5% versus 62.3% in the comparator';
    const c = parseConsort({ ...base, arms: [{ ...base.arms[0], outcome: long }, base.arms[1]] })!;
    expect(c.arms[0].outcome ?? null).toBeNull();
    expect(c.arms[0].allocated).toBe(302); // the rest of the arm survives
  });

  it('treats a non-string or empty outcome as absent', () => {
    for (const bad of [null, undefined, 42, '', '   ', {}]) {
      const c = parseConsort({ ...base, arms: [{ ...base.arms[0], outcome: bad }, base.arms[1]] })!;
      expect(c.arms[0].outcome ?? null).toBeNull();
    }
  });

  it('still parses a consort object that omits outcomes entirely', () => {
    // the whole back catalogue, and every study whose source gives only a
    // combined HR
    const c = parseConsort({
      randomized: 100,
      arms: [
        { label: 'A', allocated: 50 },
        { label: 'B', allocated: 50 },
      ],
    })!;
    expect(c.arms).toHaveLength(2);
    expect(c.arms[0].outcome ?? null).toBeNull();
    expect('outcome' in c.arms[0]).toBe(false); // omitted, not null
  });

  it('does not let an outcome rescue an otherwise invalid arm', () => {
    // an arm with no allocated count is still dropped, outcome or not; two arms
    // are required, so the whole diagram goes
    expect(
      parseConsort({
        randomized: 100,
        arms: [
          { label: 'A', allocated: 50, outcome: 'OS 70%' },
          { label: 'B', outcome: 'OS 60%' },
        ],
      }),
    ).toBeNull();
  });
});
