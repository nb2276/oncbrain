// v0.51: the long-form read must be reachable from the card.
//
// It shipped in v0.45 and nothing advertised it: 109 study pages carried a
// ~550-word interpretation while the DATE page — the primary daily surface —
// had no href to a study page at all, only a share URL. The analysis was
// generated, grounded, deployed, and invisible.
//
// Reads the built dist/, because this is a wiring bug of exactly the kind a
// component unit test cannot see: every piece worked, nothing connected them.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listStudyPages } from '../src/lib/digest-data.ts';

const DIST = resolve(process.cwd(), 'dist');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const hasInterp = (s: unknown) => typeof s === 'string' && s.trim().length > 0;

describe('long-form read is reachable from the card', () => {
  const withInterp = listStudyPages().filter((e) => hasInterp(e.study.interpretation));

  it('has interpretations to link to', () => {
    expect(withInterp.length).toBeGreaterThan(0);
  });

  it('links from the DATE page for every study that has one', () => {
    const missing: string[] = [];
    for (const e of withInterp) {
      const html = read(resolve(DIST, e.date, 'index.html'));
      if (!html) continue;
      // the anchor, not merely the share URL that was there all along
      if (!html.includes(`<a class="longform-link" href="/study/${e.param}/"`)) missing.push(e.param);
    }
    expect(missing, 'date page has no longer-read link for these').toEqual([]);
  });

  it('does NOT link on the study page itself — it would point at this page', () => {
    for (const e of withInterp) {
      const html = read(resolve(DIST, 'study', e.param, 'index.html'));
      if (!html) continue;
      expect(html).not.toContain('class="longform-link"');
      expect(html).toContain('class="interpretation"'); // the read itself is here
    }
  });

  it('never offers a longer read where none exists', () => {
    for (const e of listStudyPages()) {
      if (hasInterp(e.study.interpretation)) continue;
      const html = read(resolve(DIST, e.date, 'index.html'));
      if (!html) continue;
      expect(html).not.toContain(`<a class="longform-link" href="/study/${e.param}/"`);
    }
  });
});
