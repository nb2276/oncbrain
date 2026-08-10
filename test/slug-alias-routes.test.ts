// v0.46: retired per-study paths must redirect, and must never shadow a real one.
//
// Reads the built dist/, because the failure this guards is a ROUTING one: a
// retired slug and a live study both resolve under /study/<param>/, and if an
// alias ever won, a published study would be replaced by a redirect away from
// itself. The unit tests cover the matching; this covers what actually shipped.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { listStudyPages, listRetiredStudyPaths } from '../src/lib/digest-data.ts';

const DIST = resolve(process.cwd(), 'dist', 'study');
const pageFor = (param: string) => resolve(DIST, param, 'index.html');
const isRedirect = (html: string) => /http-equiv="refresh"/.test(html);

describe('retired study-slug routes', () => {
  it('emits a redirect page for every retired path', () => {
    const retired = listRetiredStudyPaths();
    expect(retired.length).toBeGreaterThan(0); // the corpus has renames on record
    for (const r of retired) {
      expect(existsSync(pageFor(r.param)), `missing redirect for ${r.param}`).toBe(true);
      const html = readFileSync(pageFor(r.param), 'utf8');
      expect(isRedirect(html), `${r.param} is not a redirect`).toBe(true);
      // points at its own date, and tells crawlers not to index the duplicate
      expect(html).toContain(`url=/${r.date}/`);
      expect(html).toContain(`<link rel="canonical" href="/${r.date}/"`);
      expect(html).toMatch(/name="robots" content="noindex/);
    }
  });

  it('never turns a LIVE study page into a redirect', () => {
    for (const e of listStudyPages()) {
      const html = readFileSync(pageFor(e.param), 'utf8');
      expect(isRedirect(html), `${e.param} was shadowed by an alias`).toBe(false);
    }
  });

  it('keeps retired and live paths disjoint', () => {
    const live = new Set(listStudyPages().map((e) => e.param));
    for (const r of listRetiredStudyPaths()) expect(live.has(r.param)).toBe(false);
  });

  it('accounts for every emitted study path as exactly one of the two', () => {
    const live = listStudyPages().length;
    const retired = listRetiredStudyPaths().length;
    expect(readdirSync(DIST).length).toBe(live + retired);
  });
});
