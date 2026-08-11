// A CONSORT diagram that exists in the data must reach the page.
//
// THE BUG THIS CATCHES. The diagram's markup lived inline in StudyCard's legacy
// emoji-IMRD fold, which is gated behind `!hasAnalysisSections`. v0.30 made
// Phase 2 emit `analysis_sections` for 94% of cards, so that branch — and the
// only CONSORT render path with it — silently switched off. 36 studies carried
// a renderable consort object and ZERO drew one, for eight releases. Nothing
// failed: the parser still parsed, the field still shipped in the artifact, and
// the styles still shipped in every page's CSS bundle with no markup to match.
//
// So this asserts the END of the chain, not the middle. A unit test on
// parseConsort would have stayed green throughout.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listStudyPages } from '../src/lib/digest-data.ts';

type ConsortLike = { randomized?: number; arms?: Array<{ label?: string }> } | null | undefined;
const renderable = (c: ConsortLike) => Boolean(c && Array.isArray(c.arms) && c.arms.length >= 2);
const pageFor = (param: string) => resolve(process.cwd(), 'dist', 'study', param, 'index.html');

describe('CONSORT diagram rendering', () => {
  const withConsort = listStudyPages().filter((e) => renderable(e.study.consort as ConsortLike));

  it('has studies carrying consort data to test against', () => {
    expect(withConsort.length).toBeGreaterThan(0);
  });

  it('renders the diagram for EVERY study whose data supports one', () => {
    const missing: string[] = [];
    for (const e of withConsort) {
      if (!existsSync(pageFor(e.param))) continue;
      const html = readFileSync(pageFor(e.param), 'utf8');
      if (!/class="consort-flow/.test(html)) missing.push(e.param);
    }
    // Before the v0.47 fix this listed all 36 — the regression the test exists for.
    expect(missing, `consort data present but no diagram rendered`).toEqual([]);
  });

  it('renders it regardless of which fold the card uses', () => {
    // The whole bug was one fold path having it and the other not, so assert
    // coverage across BOTH populations rather than trusting an aggregate count.
    const structured = withConsort.filter((e) => (e.study.analysis_sections ?? []).length > 0);
    const legacy = withConsort.filter((e) => (e.study.analysis_sections ?? []).length === 0);
    for (const group of [structured, legacy]) {
      for (const e of group) {
        if (!existsSync(pageFor(e.param))) continue;
        expect(readFileSync(pageFor(e.param), 'utf8')).toMatch(/class="consort-flow/);
      }
    }
    // the structured fold is the one that was broken; make sure it is exercised
    expect(structured.length).toBeGreaterThan(0);
  });

  it('never renders a one-arm "flow"', () => {
    for (const e of listStudyPages()) {
      const c = e.study.consort as ConsortLike;
      if (!c || renderable(c)) continue;
      if (!existsSync(pageFor(e.param))) continue;
      expect(readFileSync(pageFor(e.param), 'utf8')).not.toMatch(/class="consort-flow/);
    }
  });
});
