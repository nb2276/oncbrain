// PDF vault filing (v0.8 PR2).
//
// Filed PDFs are LOCAL-ONLY: stored under data/obsidian/papers/ (gitignored,
// no public/ symlink, never in the Astro build) so they sync into the
// curator's Obsidian vault but never reach git or DigitalOcean. The public
// site carries only the SUMMARY (title/authors/abstract/verdict). This is the
// load-bearing IP constraint — see docs/plans/v0.8-non-pmid-sources.md.
//
// Organized by disease site: data/obsidian/papers/<site>/<name>.pdf, where
// name is `<year>-<first author>-<short title>` (v0.62, vaultBaseName). The
// site is provisional (the paper's site at ingest, before digest clustering).
// Re-filing identical bytes reuses the file; a DIFFERENT PDF that lands on a
// taken name gets a -2/-3 suffix instead of silently replacing it. Renaming the
// existing vault is build/rename-vault.ts, which also rewrites the paths the
// Obsidian notes and digest artifacts record.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const PAPERS_ROOT = resolve(process.cwd(), 'data/obsidian/papers');

// Folder for PDFs we filed but couldn't auto-summarize (no recoverable text).
const UNFILED_SITE = '_unsorted';

export type FiledPdf = { absPath: string; relPath: string };

// True if the bytes are a PDF (%PDF- magic). Telegram's mime header is not
// trustworthy for documents, so we sniff the bytes ourselves.
export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Sanitize a disease-site folder name to a safe kebab token; anything invalid
// (or empty) falls back to the _unsorted bucket.
function safeSiteFolder(site: string | null | undefined): string {
  if (!site) return UNFILED_SITE;
  const s = site.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return /^[a-z0-9]/.test(s) || s === UNFILED_SITE ? s || UNFILED_SITE : UNFILED_SITE;
}

function safeSlug(slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_CHARS);
  if (!s || !/^[a-z0-9]/.test(s)) {
    throw new Error(`unsafe pdf slug: ${slug}`);
  }
  return s;
}

const MAX_NAME_CHARS = 96;
const MAX_TITLE_CHARS = 56;
const TITLE_STOPWORDS = new Set(
  'a an and the of in on for with to by from at as or vs versus is are be its into after among than via'.split(' '),
);

const ascii = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae');
const words = (s: string) => ascii(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** First author's surname: "Hong, Theodore" → hong; "T. S. Hong" / "Anders W. Mølby Nielsen" → hong / nielsen. */
export function authorSurname(name: string | null | undefined): string | null {
  if (!name) return null;
  if (/^for the\b|\bgroup\b|\bconsortium\b|\binvestigators\b/i.test(name)) return null;
  const raw = name.includes(',') ? name.split(',')[0]! : name;
  const tokens = raw.split(/\s+/).filter((t) => t && !/^[A-Z]\.?(-[A-Z]\.?)?$/.test(t) && !/^[A-Z]{1,3}$/.test(t));
  if (tokens.length === 0) return null;
  // "Hong TS" (surname first, initials after) is handled by the initials filter;
  // otherwise the surname is the last remaining token.
  const surname = name.includes(',') ? tokens.join(' ') : tokens[tokens.length - 1]!;
  return words(surname).join('') || null;
}

/**
 * A vault file name a person can scan: `<year>-<first author>-<short title>`,
 * e.g. 1998-freedman-close-positive-margin-age-local-recurrence. The title is
 * cut at a word boundary (stopwords dropped so the words that remain carry the
 * meaning); any missing part is simply omitted.
 */
export function vaultBaseName(p: { title: string | null; authors: string[]; pubDate: string | null }): string {
  const year = p.pubDate?.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
  const author = authorSurname(p.authors[0]);
  let title = '';
  for (const w of words(p.title ?? '').filter((w) => !TITLE_STOPWORDS.has(w))) {
    const next = title ? `${title}-${w}` : w;
    if (next.length > MAX_TITLE_CHARS) break;
    title = next;
  }
  return [year, author, title].filter(Boolean).join('-') || 'untitled';
}

// File a PDF at papers/<site>/<name>.pdf. relPath (repo-relative) is what's
// stored in papers.pdf_path so the location is portable.
export function filePdfToVault(opts: {
  buffer: Buffer;
  site: string | null;
  name: string;
}): FiledPdf {
  const site = safeSiteFolder(opts.site);
  const base = safeSlug(opts.name);
  return writePdf(site, freeName(site, base, opts.buffer), opts.buffer);
}

/**
 * The file name to write `buffer` under: `<base>.pdf` unless that path holds a
 * DIFFERENT file, then the first free `<base>-N.pdf`. Identical bytes reuse the
 * existing name, so re-ingesting the same PDF is still idempotent.
 */
export function freeName(siteFolder: string, base: string, buffer: Buffer | null): string {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`;
    const abs = join(PAPERS_ROOT, siteFolder, name);
    if (!existsSync(abs)) return name;
    if (buffer && readFileSync(abs).equals(buffer)) return name;
  }
  throw new Error(`no free vault name for ${base}`);
}

// File a PDF we couldn't summarize under _unsorted/<contentHash>.pdf so the
// curator keeps the file even though there's no digest entry for it.
export function filePdfUnfiled(opts: { buffer: Buffer; contentHash: string }): FiledPdf {
  const name = `${opts.contentHash.replace(/[^a-f0-9]/gi, '').slice(0, 32) || 'unknown'}.pdf`;
  return writePdf(UNFILED_SITE, name, opts.buffer);
}

function writePdf(siteFolder: string, fileName: string, buffer: Buffer): FiledPdf {
  const dir = join(PAPERS_ROOT, siteFolder);
  const absPath = resolve(dir, fileName);
  // Defense-in-depth against path traversal in site/slug.
  if (absPath !== join(PAPERS_ROOT, siteFolder, fileName) || !absPath.startsWith(PAPERS_ROOT + '/')) {
    throw new Error('refused: resolved PDF path escapes PAPERS_ROOT');
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, buffer);
  const relPath = `data/obsidian/papers/${siteFolder}/${fileName}`;
  return { absPath, relPath };
}
