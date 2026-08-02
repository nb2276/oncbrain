// CONTENT-level publish boundary. Complements test/publish-boundary.test.ts,
// which guards STRUCTURE: forbidden field names in artifacts, vault paths in
// HTML/RSS/JSON, renderers that must not touch local-only fields.
//
// Structure is not sufficient. The Phase 2 agent is handed
// `fulltext_excerpt_md` / `figure_ocr_md` / `figure_structured_md` as grounding
// context, and writes prose. If it ever quotes a sentence of paywalled full text
// into a bullet, no forbidden KEY appears anywhere — the artifact is shaped
// correctly and the words are published anyway. Only a content check sees that.
//
// The IP rule (CLAUDE.md): filed PDFs and their extracted text are local-only.
// The public site carries the summary, plus ordinary bibliographic data.
//
// WHAT IS LEGITIMATELY PUBLIC, and why each is allowed:
//   title / abstract  — the abstract is deliberately rendered in a <details>
//                       block on the study page; abstracts are freely available.
//   authors_json      — the author list, including CORPORATE authors ("… for the
//                       European Organization for Research and Treatment of
//                       Cancer …"), which reads like prose but is metadata.
//   bookmark OCR      — the curator's OWN photographs of conference slides. A
//                       slide and its paper share affiliations, so slide text
//                       overlaps the PDF without coming from it.
// A local-only sentence found in dist/ that matches NONE of those is the real
// thing this test exists to catch.
//
// Requires the local DB, so it SKIPS on a machine without one (fresh checkout,
// CI). That is the right scope: digests are built on the curator's machine,
// which is the only place the leak could be introduced.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = resolve(process.cwd(), 'oncbrain.db');
const DIST = resolve(process.cwd(), 'dist');
const LOCAL_ONLY = ['fulltext_excerpt_md', 'figure_ocr_md', 'figure_structured_md'] as const;

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function readPublished(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(html|json|xml)$/.test(e)) parts.push(norm(readFileSync(p, 'utf-8')));
    }
  };
  walk(DIST);
  return parts.join(' ');
}

/** Content-bearing lines only: skip headings, table rows, image markup. */
function distinctiveLines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 60 && !'#|!'.includes(l[0]!))
    .map((l) => norm(l).slice(0, 110))
    .filter(Boolean);
}

const hasInputs = existsSync(DB_PATH) && existsSync(DIST);

describe.skipIf(!hasInputs)('publish boundary — content, not just field names', () => {
  it('no local-only sentence reaches dist/ unless it is ordinary public metadata', () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const published = readPublished();

      const publicParts: string[] = [];
      for (const r of db.prepare('SELECT title, abstract, authors_json FROM papers').all() as Record<string, string | null>[]) {
        publicParts.push(norm(r.title), norm(r.abstract), norm(r.authors_json));
      }
      // The curator's own slide photographs.
      for (const r of db.prepare('SELECT image_ocr_texts FROM bookmarks').all() as Record<string, string | null>[]) {
        publicParts.push(norm(r.image_ocr_texts));
      }
      const publicText = publicParts.join(' ');

      const leaks: string[] = [];
      let probes = 0;
      for (const field of LOCAL_ONLY) {
        const rows = db
          .prepare(`SELECT id, ${field} AS v FROM papers WHERE ${field} IS NOT NULL`)
          .all() as { id: number; v: string }[];
        for (const { id, v } of rows) {
          for (const probe of distinctiveLines(v).slice(0, 6)) {
            probes++;
            if (published.includes(probe) && !publicText.includes(probe)) {
              leaks.push(`${field} paper=${id}: ${probe.slice(0, 90)}`);
            }
          }
        }
      }

      // Guard the guard: if nothing was probed the assertion below is vacuous.
      expect(probes, 'no local-only text to probe — is the corpus loaded?').toBeGreaterThan(50);
      expect(leaks, `copyrighted full text reached the published site:\n${leaks.join('\n')}`).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('the vault PDFs themselves never appear in dist', () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT pdf_path FROM papers WHERE pdf_path IS NOT NULL')
        .all() as { pdf_path: string }[];
      expect(rows.length, 'no filed PDFs — guard not exercised').toBeGreaterThan(0);
      const published = readPublished();
      for (const { pdf_path } of rows) {
        const base = pdf_path.split('/').pop()!;
        expect(published.includes(base), `${base} appears in dist/`).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
