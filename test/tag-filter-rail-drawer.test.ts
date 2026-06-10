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

// v0.14 T3: the home page (dist/index.html) is now a what's-new SLICE and no
// longer hosts the filter rail; the full filterable index moved to /studies,
// which is where the rail lives now. Site / date / tag pages keep the rail.
const PAGES_WITH_RAIL = [
  'dist/studies/index.html',
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
      it('renders the drawer trigger with the ARIA controls/expanded/haspopup triple', () => {
        expect(html).toContain('data-filter-rail-trigger');
        expect(html).toMatch(/aria-controls="filter-rail-panel"/);
        expect(html).toMatch(/aria-expanded="false"/);
        // aria-haspopup="dialog" advertises the trigger's WAI-ARIA
        // dialog target — paired with the panel's role=dialog +
        // aria-modal=true (asserted below).
        expect(html).toMatch(/aria-haspopup="dialog"/);
      });

      it('rail panel emits role=dialog + aria-modal + aria-labelledby (full WAI-ARIA dialog pattern)', () => {
        expect(html).toContain('id="filter-rail-panel"');
        expect(html).toMatch(/role="dialog"/);
        expect(html).toMatch(/aria-modal="true"/);
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

describe('PR-3 SSR data-active for URL-filtered initial loads', () => {
  // The tag landing page renders with the URL's path tags pre-checked
  // (initialFilters non-empty) — the trigger should emit data-active
  // at SSR so there's no first-paint flash where the trigger looks
  // un-filtered until the inline script runs. Codex P2 finding.
  const root = resolve(process.cwd());
  const tagLanding = resolve(root, 'dist/tags/radiation/index.html');

  it('tags/radiation/ emits data-active="true" on the trigger', () => {
    if (!existsSync(tagLanding)) {
      // Build artifact missing; test the file when it exists.
      expect(existsSync(tagLanding)).toBe(true);
      return;
    }
    const html = readFileSync(tagLanding, 'utf-8');
    // Match the trigger element's attributes for data-active.
    expect(html).toMatch(
      /data-filter-rail-trigger[^>]*data-active="true"/,
    );
  });

  it('non-tag pages (e.g. /studies) emit the trigger WITHOUT data-active by default', () => {
    // v0.14 T3: /studies is the full-index page that hosts the rail (home is
    // now a slice with no rail).
    const studies = resolve(root, 'dist/studies/index.html');
    if (!existsSync(studies)) {
      expect(existsSync(studies)).toBe(true);
      return;
    }
    const html = readFileSync(studies, 'utf-8');
    // Trigger exists but has no data-active attribute (filter state
    // is empty by default on a non-tag page).
    const triggerMatch = html.match(/<button[^>]*data-filter-rail-trigger[^>]*>/);
    expect(triggerMatch).not.toBeNull();
    expect(triggerMatch![0]).not.toMatch(/data-active/);
  });
});
