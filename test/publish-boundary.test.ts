import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The load-bearing IP constraint (v0.8 PR2): filed full-text PDFs are
// LOCAL-ONLY. Three locks guarantee they never reach git or DigitalOcean:
//   1. data/obsidian/papers/ is gitignored.
//   2. There is NO public/ symlink into the papers vault (so they never enter
//      the Astro build — unlike public/slides, which exists for slide preview).
//   3. The renderer only links the PDF inside the local Obsidian note, never
//      on the public site (covered by obsidian-export tests).
// This file asserts locks 1 and 2 structurally so a future change can't
// silently start publishing copyrighted PDFs.
describe('PDF publish boundary', () => {
  const root = resolve(process.cwd());

  it('gitignores data/obsidian/papers/', () => {
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf-8');
    expect(gitignore).toMatch(/^data\/obsidian\/papers\/?$/m);
  });

  it('keeps the daily .md notes committable (only the papers/ subtree is ignored)', () => {
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf-8');
    // A blanket data/obsidian/ ignore would also hide the public-safe daily
    // notes. Guard against that regression.
    expect(gitignore).not.toMatch(/^data\/obsidian\/?$/m);
  });

  it('has no public/ path that exposes the papers vault to the Astro build', () => {
    for (const candidate of ['public/papers', 'public/obsidian']) {
      expect(existsSync(resolve(root, candidate))).toBe(false);
    }
  });
});

// v0.15 — the committed digest artifacts (data/digests/<date>.json) are
// published verbatim (consumed by Astro getStaticPaths + the JSON API). They
// must NEVER carry copyrighted full text: fulltext_excerpt_md (PDF body) or
// figure_ocr_md (OCR of figure pages). buildArtifact keeps both out via an
// explicit field allowlist, but that's hand-maintained — a future `...p` spread
// would silently start publishing. This guards the real deploy surface so the
// boundary can't regress without a red test.
// PDF-derived abstracts: the LLM-from-PDF abstract is dropped at the SOURCE
// (inbox-enrichment nulls meta.abstract before savePaper) so it never reaches
// papers.abstract, which is published. Only an authoritative Crossref abstract
// repopulates it on a PDF-with-DOI row. The gate is at ingestion (not build)
// because fetched_via can't distinguish a publishable Crossref abstract from a
// leaked LLM one on the same fetched_via='pdf' row — codex /ship review caught
// that a build-time fetched_via gate would wrongly drop legit Crossref abstracts.

describe('digest artifact publish boundary (v0.15)', () => {
  const root = resolve(process.cwd());
  const FORBIDDEN_KEYS = ['fulltext_excerpt_md', 'figure_ocr_md'];

  function digestFiles(): string[] {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const dir = resolve(root, 'data/digests');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => resolve(dir, n));
  }

  it('no committed digest paper object carries copyrighted full-text fields', () => {
    for (const f of digestFiles()) {
      const artifact = JSON.parse(readFileSync(f, 'utf-8'));
      for (const paper of artifact.papers ?? []) {
        for (const key of FORBIDDEN_KEYS) {
          expect(paper, `${f}: paper ${paper.id} leaks ${key}`).not.toHaveProperty(key);
        }
      }
    }
  });

  it('covers at least the days that have papers (guard is actually exercised)', () => {
    // Sanity: at least one committed digest has a papers array, so the loop above
    // isn't vacuously passing on an empty corpus.
    const withPapers = digestFiles().filter((f) => {
      const a = JSON.parse(readFileSync(f, 'utf-8'));
      return Array.isArray(a.papers) && a.papers.length > 0;
    });
    expect(withPapers.length).toBeGreaterThan(0);
  });
});

// v0.10 surface — extends the boundary to the new tag pages. A future
// rendering bug or schema drift could conceivably inject a vault PDF link
// (data/obsidian/papers/<site>/<slug>.pdf) into /tags/<slug>/ output;
// these assertions catch that pre-deploy.
describe('PDF publish boundary — /tags/ surfaces (v0.10)', () => {
  const root = resolve(process.cwd());
  const distRoot = resolve(root, 'dist');

  function* walkHtmlFiles(dir: string): IterableIterator<string> {
    if (!existsSync(dir)) return;
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) {
        yield* walkHtmlFiles(full);
      } else if (name.endsWith('.html')) {
        yield full;
      }
    }
  }

  function* walkFeedFiles(dir: string): IterableIterator<string> {
    if (!existsSync(dir)) return;
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) {
        yield* walkFeedFiles(full);
      } else if (name === 'feed.xml') {
        yield full;
      }
    }
  }

  it('no /tags/ HTML page contains a data/obsidian/papers/ reference', () => {
    const tagsDir = resolve(distRoot, 'tags');
    if (!existsSync(tagsDir)) return; // build not yet run in this test session
    for (const f of walkHtmlFiles(tagsDir)) {
      const content = readFileSync(f, 'utf-8');
      expect(content, `${f}: contains vault PDF reference`).not.toMatch(/data\/obsidian\/papers/);
      // Also catch raw .pdf hrefs that aren't via the vault path.
      expect(content, `${f}: contains a .pdf href`).not.toMatch(/href="[^"]*\.pdf"/);
    }
  });

  it('no /tags/ RSS feed contains a vault PDF reference', () => {
    const tagsDir = resolve(distRoot, 'tags');
    if (!existsSync(tagsDir)) return;
    for (const f of walkFeedFiles(tagsDir)) {
      const content = readFileSync(f, 'utf-8');
      expect(content, `${f}: contains vault PDF reference`).not.toMatch(/data\/obsidian\/papers/);
      expect(content, `${f}: contains a .pdf URL`).not.toMatch(/\.pdf</);
    }
  });

  it('no /api/v1/tag/ JSON response contains a vault PDF reference', () => {
    const tagApiDir = resolve(distRoot, 'api/v1/tag');
    if (!existsSync(tagApiDir)) return;
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const name of readdirSync(tagApiDir)) {
      if (!name.endsWith('.json')) continue;
      const full = resolve(tagApiDir, name);
      const content = readFileSync(full, 'utf-8');
      expect(content, `${full}: contains vault PDF reference`).not.toMatch(/data\/obsidian\/papers/);
      expect(content, `${full}: contains pdf_path field`).not.toMatch(/"pdf_path"/);
    }
  });
});

// v0.14 T4 — the OG share-image generator. The card is synthesized TEXT only
// (wordmark, date, top-line, verdict label, handle). It must NEVER reach for a
// study's figure or slide pixels, or a copyrighted/curator-private image could
// be baked into a publicly-served PNG. Structural lock on the generator source.
describe('OG share image publish boundary (v0.14 T4)', () => {
  const root = resolve(process.cwd());

  it('share-image.ts never references a figure / slide / image source', () => {
    const src = readFileSync(resolve(root, 'src/lib/share-image.ts'), 'utf-8');
    // No CODE reference to a figure/slide source (bare words in a comment are
    // fine; these are the real code-shaped accessors + image hosts).
    expect(src).not.toMatch(/studyFigures|\.figures\b|\/slides\/|slide-photos|slide_uploads|pbs\.twimg/i);
    // The only file it reads is the vendored Newsreader font; it reads no image.
    expect(src).toMatch(/og-fonts/);
    expect(src).not.toMatch(/\.(png|jpg|jpeg|webp|svg)['"]/i);
  });

  it('EVERY /og/ endpoint passes only text fields to the renderer', () => {
    // Glob, not a hardcoded list: a future OG endpoint (e.g. a per-study card)
    // that fed a figure URL into the card must be auto-covered by this guard.
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const ogDir = resolve(root, 'src/pages/og');
    function* walk(dir: string): IterableIterator<string> {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (name.endsWith('.png.ts')) yield full;
      }
    }
    const endpoints = [...walk(ogDir)];
    expect(endpoints.length).toBeGreaterThanOrEqual(3); // default + date + site
    for (const ep of endpoints) {
      const src = readFileSync(ep, 'utf-8');
      expect(src, `${ep}: references a figure/slide source`).not.toMatch(/studyFigures|\.figures\b|\/slides\/|slide-photos|pbs\.twimg/i);
    }
  });
});
