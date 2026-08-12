// v0.52: the Monday-clinic line rests on the card.
//
// It is the one sentence naming which patient in front of you tomorrow the
// study moves, and which it does not — and 105 of 117 cards hid it behind the
// disclosure while ~59 words of "why it matters" sat in the open. For a reader
// scanning at 90 seconds that was the wrong sentence to fold.
//
// Reads dist/ because the property is about PLACEMENT (which side of the
// <details> boundary the markup lands on), which no component-level assertion
// can see.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listStudyPages } from '../src/lib/digest-data.ts';

const has = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const pageFor = (param: string) => resolve(process.cwd(), 'dist', 'study', param, 'index.html');

/** Split a rendered card at the fold boundary. */
function split(html: string): { rest: string; fold: string } {
  const i = html.indexOf('<details class="study-depth"');
  return i < 0 ? { rest: html, fold: '' } : { rest: html.slice(0, i), fold: html.slice(i) };
}

describe('Monday-clinic line rests on the card', () => {
  const entries = listStudyPages().filter((e) => existsSync(pageFor(e.param)));
  const both = entries.filter(
    (e) => has(e.study.monday_clinic) && has((e.study as { significance?: unknown }).significance),
  );

  it('has cards carrying both surfaces to test', () => {
    expect(both.length).toBeGreaterThan(0);
  });

  it('renders it ABOVE the fold, never inside it', () => {
    const folded: string[] = [];
    for (const e of both) {
      const { rest, fold } = split(readFileSync(pageFor(e.param), 'utf8'));
      if (!rest.includes('class="clinic-block"')) folded.push(`${e.param} (absent at rest)`);
      if (fold.includes('clinic-section')) folded.push(`${e.param} (still in fold)`);
    }
    expect(folded, 'clinic line not resting').toEqual([]);
  });

  it('renders exactly once per card', () => {
    for (const e of both) {
      const html = readFileSync(pageFor(e.param), 'utf8');
      // the promoted block, plus the legacy fold section which must be gone
      expect(html.split('class="clinic-block"').length - 1).toBe(1);
      expect(html).not.toContain('clinic-section');
    }
  });

  it('still shows the line when there is NO significance, via the resting slot', () => {
    // those cards promote monday_clinic into the significance slot instead, so
    // they must NOT also get a clinic-block — that would print it twice
    const clinicOnly = entries.filter(
      (e) => has(e.study.monday_clinic) && !has((e.study as { significance?: unknown }).significance),
    );
    for (const e of clinicOnly) {
      const html = readFileSync(pageFor(e.param), 'utf8');
      expect(html).toContain('Monday clinic');
      expect(html).not.toContain('class="clinic-block"');
    }
  });

  it('never invents a clinic block where the study has no clinic line', () => {
    for (const e of entries) {
      if (has(e.study.monday_clinic)) continue;
      expect(readFileSync(pageFor(e.param), 'utf8')).not.toContain('class="clinic-block"');
    }
  });
});
