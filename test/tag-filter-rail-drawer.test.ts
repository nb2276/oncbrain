// v0.11 PR-3: structural assertions on the built HTML to pin the
// mobile-drawer WAI-ARIA dialog contract.
//
// Vitest is node-only — we can't exercise the click handlers or focus
// management here. Instead we read the built HTML produced by
// `npm run build` and assert that:
//   1. Every page that ships the filter rail also ships the drawer
//      trigger + backdrop + close button + the ARIA attrs that wire
//      them together.
//   2. The desktop-only rules don't accidentally suppress the markup
//      on mobile (HTML always renders; CSS controls visibility).
//
// The actual interaction behavior is verified by the manual QA in the
// PR description; PR-6 will add Playwright + axe-core for end-to-end
// coverage when those devDeps land.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGES_WITH_RAIL = [
  'dist/index.html',
  'dist/sites/breast/index.html',
  'dist/2026-05-29/index.html',
  'dist/tags/radiation/index.html',
];

describe('PR-3 mobile drawer structural contract', () => {
  const root = resolve(process.cwd());

  for (const page of PAGES_WITH_RAIL) {
    const path = resolve(root, page);
    if (!existsSync(path)) {
      it(`${page} exists (skipped — run \`npm run build\` first)`, () => {
        // Build artifact missing → the build hasn't run. Skip the rest
        // of this page's assertions rather than throw an unhelpful
        // ENOENT.
        expect(existsSync(path)).toBe(true);
      });
      continue;
    }
    const html = readFileSync(path, 'utf-8');

    describe(page, () => {
      it('renders the drawer trigger with the ARIA controls/expanded pair', () => {
        expect(html).toContain('data-filter-rail-trigger');
        expect(html).toMatch(/aria-controls="filter-rail-panel"/);
        expect(html).toMatch(/aria-expanded="false"/);
      });

      it('renders the rail panel with the matching id and aria-labelledby', () => {
        expect(html).toContain('id="filter-rail-panel"');
        expect(html).toMatch(/aria-labelledby="filter-rail-title"/);
        expect(html).toContain('id="filter-rail-title"');
      });

      it('renders the backdrop hidden by default (no [data-open] yet)', () => {
        // The backdrop element must exist AND carry the `hidden`
        // attribute on first render — JS removes hidden on open.
        expect(html).toMatch(/data-filter-rail-backdrop[^>]*\shidden/);
      });

      it('renders the close button with an aria-label', () => {
        expect(html).toContain('data-filter-rail-close');
        expect(html).toMatch(/aria-label="Close filters"/);
      });

      it('does NOT pre-emit the html[data-drawer-open] body-scroll-lock attribute', () => {
        // Body scroll-lock is JS-managed on the html root. Pre-emitting
        // it would lock the page before hydration on first paint.
        expect(html).not.toMatch(/<html[^>]*data-drawer-open/);
      });

      it('rail panel starts WITHOUT [data-open] (drawer closed by default)', () => {
        // The mobile drawer is `transform: translateY(100%)` until
        // [data-open] is set; without this default-closed state the
        // drawer would briefly appear on first paint.
        expect(html).not.toMatch(/data-filter-rail[^>]*data-open=/);
      });
    });
  }
});
