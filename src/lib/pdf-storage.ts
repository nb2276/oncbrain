// PDF vault filing (v0.8 PR2).
//
// Filed PDFs are LOCAL-ONLY: stored under data/obsidian/papers/ (gitignored,
// no public/ symlink, never in the Astro build) so they sync into the
// curator's Obsidian vault but never reach git or DigitalOcean. The public
// site carries only the SUMMARY (title/authors/abstract/verdict). This is the
// load-bearing IP constraint — see docs/plans/v0.8-non-pmid-sources.md.
//
// Organized by disease site: data/obsidian/papers/<site>/<slug>.pdf. The site
// is provisional (the paper's site at ingest, before digest clustering); a PDF
// is never moved once filed (the Obsidian wikilink records its location).
// Re-ingesting the same study overwrites in place (same slug → same path).

import { writeFileSync, mkdirSync } from 'node:fs';
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
  const s = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!s || !/^[a-z0-9]/.test(s)) {
    throw new Error(`unsafe pdf slug: ${slug}`);
  }
  return s;
}

// File a PDF at papers/<site>/<slug>.pdf. relPath (repo-relative) is what's
// stored in papers.pdf_path so the location is portable.
export function filePdfToVault(opts: {
  buffer: Buffer;
  site: string | null;
  slug: string;
}): FiledPdf {
  return writePdf(safeSiteFolder(opts.site), `${safeSlug(opts.slug)}.pdf`, opts.buffer);
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
