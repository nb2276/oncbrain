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

/** Every published byte, for guards that are not paper-scoped. */
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

/**
 * Published text per STUDY PAGE, keyed by its `<date>-<slug>` param.
 *
 * Scoped rather than one big blob, because a paper's text can only be quoted
 * onto the page of a study that HAS that paper as a source — Phase 2 runs
 * per-study and is handed only that study's sources. A probe from paper 67
 * turning up under `arto`, `rtog9804` and `radiosa` (three studies that do not
 * cite it) is therefore proof of standard terminology, not of a quote, and that
 * is exactly what the ECOG false positive was.
 *
 * The study page carries the whole card, so any card field that leaked is here.
 */
function readStudyPages(): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(DIST, 'study');
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e, 'index.html');
    if (existsSync(f)) out.set(e, norm(readFileSync(f, 'utf-8')));
  }
  return out;
}

/** paper id -> the study-page params whose studies cite that paper. */
function papersToStudyParams(): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const dir = resolve(process.cwd(), 'data', 'digests');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const art = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    const date = art.date as string;
    for (const site of art.digest?.sites ?? []) {
      for (const study of site.studies ?? []) {
        const param = `${date}-${study.slug}`;
        for (const r of study.source_ids ?? []) {
          if (r?.type !== 'paper' || typeof r.id !== 'number') continue;
          if (!out.has(r.id)) out.set(r.id, new Set());
          out.get(r.id)!.add(param);
        }
      }
    }
  }
  return out;
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

// Generous timeouts, deliberately. This is an O(probes x published-bytes) audit
// over the whole built site (~60MB, ~700 files) and it is SUPPOSED to be
// thorough rather than quick. It first shipped on the 5s default, passed alone
// at 3.75s, and then timed out under full-suite parallelism — a flaky IP guard
// is worse than none. If this ever feels slow, raise the budget; do NOT cut the
// probe count, which is the coverage.
const AUDIT_TIMEOUT_MS = 120_000;

describe.skipIf(!hasInputs)('publish boundary — content, not just field names', () => {
  it('no local-only sentence reaches dist/ unless it is ordinary public metadata', () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const studyPages = readStudyPages();
      const citedBy = papersToStudyParams();

      const publicParts: string[] = [];
      for (const r of db.prepare('SELECT title, abstract, authors_json FROM papers').all() as Record<string, string | null>[]) {
        publicParts.push(norm(r.title), norm(r.abstract), norm(r.authors_json));
      }
      // The curator's own slide photographs.
      for (const r of db.prepare('SELECT image_ocr_texts FROM bookmarks').all() as Record<string, string | null>[]) {
        publicParts.push(norm(r.image_ocr_texts));
      }
      const publicText = publicParts.join(' ');

      // A line that appears in MORE THAN ONE paper's local-only text is not that
      // paper's expression — it is boilerplate. Measured over the corpus, 189 of
      // 5839 probe lines are shared: CC-license blocks, standard scale names
      // ("Eastern Cooperative Oncology Group (ECOG) performance status score",
      // in papers 7 and 67), and our OWN injected
      // "[row association uncertain: ...]" markers, which are not source text at
      // all. Those must not count, and excluding them is the copyright-correct
      // rule rather than a convenience: copyright protects a work's particular
      // expression, not terminology the whole literature shares. A sentence
      // unique to ONE paper still trips this, which is the case that matters.
      //
      // The ECOG line was a real false positive: it reached dist/ on the pages of
      // arto, rtog9804 and radiosa — three studies that are NOT paper 67 — which
      // is by itself proof the model wrote a standard term rather than quoting.
      const paperCount = new Map<string, Set<number>>();
      for (const field of LOCAL_ONLY) {
        const rows = db
          .prepare(`SELECT id, ${field} AS v FROM papers WHERE ${field} IS NOT NULL`)
          .all() as { id: number; v: string }[];
        for (const { id, v } of rows) {
          for (const probe of distinctiveLines(v)) {
            if (!paperCount.has(probe)) paperCount.set(probe, new Set());
            paperCount.get(probe)!.add(id);
          }
        }
      }
      const shared = (probe: string) => (paperCount.get(probe)?.size ?? 0) > 1;

      const leaks: string[] = [];
      let probes = 0;
      for (const field of LOCAL_ONLY) {
        const rows = db
          .prepare(`SELECT id, ${field} AS v FROM papers WHERE ${field} IS NOT NULL`)
          .all() as { id: number; v: string }[];
        for (const { id, v } of rows) {
          // Only the pages of studies that actually cite this paper.
          const targets = [...(citedBy.get(id) ?? [])]
            .map((param) => studyPages.get(param))
            .filter((t): t is string => Boolean(t));
          if (targets.length === 0) continue;
          for (const probe of distinctiveLines(v).filter((l) => !shared(l)).slice(0, 6)) {
            probes++;
            if (targets.some((t) => t.includes(probe)) && !publicText.includes(probe)) {
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
  }, AUDIT_TIMEOUT_MS);

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
  }, AUDIT_TIMEOUT_MS);
});
