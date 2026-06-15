// PDF text extraction (v0.8 PR2).
//
// Two-tier, both via poppler (already a project dependency for the curator's
// Mac — `brew install poppler` provides pdftotext + pdftoppm):
//   1. pdftotext — pull the embedded text layer. Fast, exact, no LLM.
//   2. If the text layer is empty/garbled (a SCANNED PDF), rasterize each page
//      to a temporary PNG with pdftoppm and run the on-device Apple Vision OCR
//      binary over them (the same engine used for slide photos), then join.
//
// Only the transient OCR page-images live in os.tmpdir() and they're unlinked
// in a finally block (and swept on the next enrich run). The PDF itself is
// filed elsewhere (pdf-storage.ts); this module never persists anything.
//
// Graceful degradation (codex finding 6): if poppler or the Vision binary is
// absent, throw a typed PdfToolError the enrichment layer turns into a clear
// E3 reply rather than promising OCR that can't run.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnFn } from './llm-client.ts';
import { ocrFile, isOcrAvailable, type OcrResult } from './vision-ocr.ts';

// A scanned PDF often yields a few stray ligatures from pdftotext rather than
// truly empty output, so gate on a word count, not just non-empty.
const MIN_TEXT_WORDS = 30;
// Image-only PDFs from some publishers (Wiley/ACS etc.) carry a per-page
// download watermark in their text layer. pdftotext then returns the same stamp
// on every page — hundreds of words that are almost all duplicates — which would
// clear MIN_TEXT_WORDS and wrongly skip OCR. Require the DISTINCT content to be
// at least this fraction of the total so a stamp echoed N times doesn't pass.
const MIN_DISTINCT_RATIO = 0.5;
// Escape hatch: a long article with heavy repeated headers/footers can dip below
// the ratio yet still carry plenty of real text. Accept the layer regardless of
// ratio once distinct content clears this absolute floor, so we never force OCR
// (and risk a hard failure where Vision is unavailable) on genuinely rich text.
const HIGH_DISTINCT_FLOOR = 200;
// Cap rasterized pages — bounds OCR cost on a 200-page thesis PDF. The first
// pages carry title/abstract/methods, which is what the digest needs.
const MAX_OCR_PAGES = 15;

// Cap stored figure OCR so it can't crowd out the body excerpt (distinct DB
// column, distinct Phase 2 prompt section). Single source of truth for both the
// live-ingest path (inbox-enrichment) and the back-catalog backfill CLI.
export const MAX_FIGURE_OCR_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 60_000;
const OCR_TMP_PREFIX = 'oncbrain-ocr-pdf-';

// Figure-OCR (Path A): a raster image must clear this pixel area to count as a
// "figure page" worth OCR'ing. Filters out small logos, journal marks, ORCID
// icons, and author headshots; a real KM curve / forest plot is ~1300x1000.
const FIGURE_MIN_IMAGE_AREA = 400 * 300;
// Cap figure pages OCR'd per paper. A paper rarely has more than a handful of
// result figures; this bounds cost on a supplement-heavy PDF.
const MAX_FIGURE_OCR_PAGES = 12;

export type PdfToolErrorKind =
  | 'poppler-missing' // pdftotext / pdftoppm not on PATH
  | 'ocr-unavailable' // scanned PDF but the Vision binary isn't built
  | 'extract-failed' // poppler ran but exited non-zero
  | 'empty'; // neither text layer nor OCR recovered any usable text

export class PdfToolError extends Error {
  constructor(
    message: string,
    readonly kind: PdfToolErrorKind,
  ) {
    super(message);
    this.name = 'PdfToolError';
  }
}

export type PdfText = {
  text: string;
  via: 'text' | 'ocr';
};

export type ExtractPdfTextOptions = {
  // Injection seams for tests; default to the real poppler + Vision pipeline.
  runText?: (absPath: string) => Promise<string>;
  runOcr?: (absPath: string) => Promise<string>;
  minWords?: number;
  timeoutMs?: number;
};

// Extract a PDF's text, preferring the embedded layer and falling back to OCR.
export async function extractPdfText(
  absPath: string,
  opts: ExtractPdfTextOptions = {},
): Promise<PdfText> {
  const minWords = opts.minWords ?? MIN_TEXT_WORDS;
  const runText = opts.runText ?? ((p: string) => pdftotext(p, opts.timeoutMs));
  const runOcr = opts.runOcr ?? ((p: string) => rasterizeAndOcr(p, opts.timeoutMs));

  const layer = (await runText(absPath)).trim();
  if (isUsableTextLayer(layer, minWords)) {
    return { text: layer, via: 'text' };
  }

  // Empty/garbled/watermark-only text layer → treat as scanned, OCR the pages.
  const ocrText = (await runOcr(absPath)).trim();
  if (wordCount(ocrText) === 0) {
    throw new PdfToolError(
      'no text layer and OCR recovered nothing (corrupt or image-only PDF?)',
      'empty',
    );
  }
  // A rejected layer is usually a download watermark, which carries the DOI in
  // its URL. OCR of the page image can miss small marginal text, so fold the
  // (deduped) rejected lines back in — keeps the DOI/PMID regex backstop alive
  // for the Crossref rescue downstream. Cheap: the rejected layer is tiny.
  const text = layer ? `${ocrText}\n\n${uniqueLines(layer)}` : ocrText;
  return { text, via: 'ocr' };
}

function wordCount(s: string): number {
  const t = s.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

// Is a pdftotext layer real content, or a scanned page's boilerplate? Rejects
// two cases: near-empty (a few stray ligatures) and watermark-dominated (a
// per-page download stamp repeated on every page). Counts words across DISTINCT
// lines — collapsing the repeated stamp to one instance — and requires the
// distinct content to clear the floor AND either dominate the total OR be large
// in absolute terms (a long article with heavy repeated headers stays usable).
export function isUsableTextLayer(text: string, minWords = MIN_TEXT_WORDS): boolean {
  const total = wordCount(text);
  if (total === 0) return false;
  const distinct = distinctLineWordCount(text);
  if (distinct < minWords) return false;
  return distinct / total >= MIN_DISTINCT_RATIO || distinct >= HIGH_DISTINCT_FLOOR;
}

// Normalize a line so per-page variation in an otherwise-constant stamp (page
// numbers, access dates, minor wrapping) collapses to one key: lowercase, drop
// digits, collapse whitespace. Distinct BODY lines differ by words, not just
// digits, so they survive normalization; a varying watermark does not.
function normalizeLine(line: string): string {
  return line.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
}

function distinctLineWordCount(text: string): number {
  const seen = new Set<string>();
  let n = 0;
  for (const raw of text.split(/[\r\n\f]+/)) {
    const line = raw.trim();
    if (line.length < 3) continue;
    const key = normalizeLine(line);
    if (seen.has(key)) continue;
    seen.add(key);
    n += line.split(/\s+/).length;
  }
  return n;
}

// Distinct (normalized) lines from a text blob, preserving original casing and
// order. Used to fold a tiny rejected watermark layer back into OCR output.
function uniqueLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\r\n\f]+/)) {
    const line = raw.trim();
    if (line.length < 3) continue;
    const key = normalizeLine(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

// pdftotext <abs> - → text on stdout.
async function pdftotext(absPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return runPoppler('pdftotext', ['-q', '-enc', 'UTF-8', absPath, '-'], timeoutMs, spawn as SpawnFn);
}

// Rasterize the first MAX_OCR_PAGES pages to PNGs in a temp dir, OCR each with
// the Apple Vision binary, join. Cleans the temp dir in finally.
async function rasterizeAndOcr(
  absPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deps: { spawnFn?: SpawnFn; ocr?: (p: string) => Promise<OcrResult>; ocrAvailable?: () => boolean } = {},
): Promise<string> {
  const spawnFn = deps.spawnFn ?? (spawn as SpawnFn);
  const ocr = deps.ocr ?? ocrFile;
  const available = deps.ocrAvailable ?? isOcrAvailable;
  if (!available()) {
    throw new PdfToolError(
      'scanned PDF needs the Apple Vision OCR binary (run `npm run setup:vision` on macOS)',
      'ocr-unavailable',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), OCR_TMP_PREFIX));
  try {
    await runPoppler(
      'pdftoppm',
      ['-png', '-r', '200', '-l', String(MAX_OCR_PAGES), absPath, join(dir, 'page')],
      timeoutMs,
      spawnFn,
    );
    const pngs = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .sort();
    const parts: string[] = [];
    for (const f of pngs) {
      const result = await ocr(join(dir, f));
      if (result.entry.text.trim()) parts.push(result.entry.text.trim());
    }
    return parts.join('\n\n');
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort; the startup sweep self-heals leftover dirs.
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Figure-OCR (Path A): recover numbers printed INSIDE figures.
//
// pdftotext reads the text layer; figures (KM curves, forest plots) and some
// publisher tables are embedded as raster images, so their numbers (subgroup
// medians, hazard ratios, 5-yr estimates, n-at-risk) are invisible to it. They
// often live on the last pages of an accepted manuscript, past the OCR-fallback
// page cap. This targets only the pages that actually carry a substantial raster
// image — found via `pdfimages -list` — and OCRs just those, so the build-time
// study agent can GROUND a figure-locked magnitude instead of flagging it
// missing. Best-effort throughout: any failure degrades to '' (the summary still
// ships off the text layer), and it never throws.
// ────────────────────────────────────────────────────────────────────────────

// 1-based page numbers carrying a raster image at least FIGURE_MIN_IMAGE_AREA in
// size. Parsed from `pdfimages -list` columns: page, num, type, width, height.
// Skips 'smask' (soft-mask companion) rows and sub-threshold images. Returns []
// when pdfimages is missing/fails or the PDF is fully vector (text layer already
// covers those figures).
export async function figurePages(
  absPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn: SpawnFn = spawn as SpawnFn,
): Promise<number[]> {
  let listing: string;
  try {
    listing = await runPoppler('pdfimages', ['-list', absPath], timeoutMs, spawnFn);
  } catch {
    return [];
  }
  const pages = new Set<number>();
  for (const line of listing.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const page = Number(cols[0]);
    const type = cols[2];
    const w = Number(cols[3]);
    const h = Number(cols[4]);
    if (!Number.isInteger(page) || page < 1) continue; // header / separator rows
    if (type !== 'image') continue; // ignore 'smask' / 'stencil' companions
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w * h < FIGURE_MIN_IMAGE_AREA) continue;
    pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

// Rasterize one page to PNG and OCR it. Mirrors rasterizeAndOcr's temp-dir +
// cleanup pattern but for a single page (pdftoppm -f/-l <page>).
async function ocrSinglePage(
  absPath: string,
  page: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deps: { spawnFn?: SpawnFn; ocr?: (p: string) => Promise<OcrResult> } = {},
): Promise<string> {
  const spawnFn = deps.spawnFn ?? (spawn as SpawnFn);
  const ocr = deps.ocr ?? ocrFile;
  const dir = mkdtempSync(join(tmpdir(), OCR_TMP_PREFIX));
  try {
    await runPoppler(
      'pdftoppm',
      ['-png', '-r', '200', '-f', String(page), '-l', String(page), absPath, join(dir, 'page')],
      timeoutMs,
      spawnFn,
    );
    const pngs = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .sort();
    const parts: string[] = [];
    for (const f of pngs) {
      const result = await ocr(join(dir, f));
      if (result.entry.text.trim()) parts.push(result.entry.text.trim());
    }
    return parts.join('\n\n');
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort; the startup sweep self-heals leftover dirs
    }
  }
}

export type ExtractPdfFigureOcrOptions = {
  // Injection seams for tests; default to the real pdfimages + Vision pipeline.
  pages?: (absPath: string) => Promise<number[]>;
  ocrPage?: (absPath: string, page: number) => Promise<string>;
  ocrAvailable?: () => boolean;
  timeoutMs?: number;
  maxPages?: number;
};

// OCR just the figure pages of a PDF and return their joined text, page-tagged.
// '' when OCR isn't available, no figure pages exist, or every page fails.
// NEVER throws — this is additive context layered on top of extractPdfText.
export async function extractPdfFigureOcr(
  absPath: string,
  opts: ExtractPdfFigureOcrOptions = {},
): Promise<string> {
  const available = opts.ocrAvailable ?? isOcrAvailable;
  if (!available()) return '';
  const listPages = opts.pages ?? ((p: string) => figurePages(p, opts.timeoutMs));
  const ocrPage = opts.ocrPage ?? ((p: string, page: number) => ocrSinglePage(p, page, opts.timeoutMs));
  const maxPages = opts.maxPages ?? MAX_FIGURE_OCR_PAGES;

  let pages: number[];
  try {
    pages = await listPages(absPath);
  } catch {
    return '';
  }
  if (pages.length === 0) return '';

  const parts: string[] = [];
  for (const page of pages.slice(0, maxPages)) {
    try {
      const txt = (await ocrPage(absPath, page)).trim();
      if (txt) parts.push(`[p.${page}]\n${txt}`);
    } catch {
      // skip this page; one bad page shouldn't lose the rest
    }
  }
  return parts.join('\n\n');
}

// Cap accumulated child output so a small malicious PDF that expands into
// enormous pdftotext output can't OOM the enrichment process. A real paper's
// text layer is tens of KB; 64MB is a generous ceiling that still bounds the
// pathological case.
const MAX_POPPLER_OUTPUT_BYTES = 64 * 1024 * 1024;
// Grace period between SIGTERM and SIGKILL on timeout/overflow.
const POPPLER_KILL_GRACE_MS = 2000;

// Run a poppler binary, resolve stdout. ENOENT (binary missing) → typed
// poppler-missing; non-zero exit → extract-failed. Bounds output size and
// escalates SIGTERM→SIGKILL so a child that ignores termination (or floods
// stdout) can't keep running / consuming memory after we've given up.
function runPoppler(
  binary: string,
  args: string[],
  timeoutMs: number,
  spawnFn: SpawnFn,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let proc;
    try {
      proc = spawnFn(binary, args);
    } catch (err) {
      reject(new PdfToolError(`failed to spawn ${binary}: ${(err as Error).message}`, 'poppler-missing'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    // Terminate the child and reject. SIGTERM first, then SIGKILL after a grace
    // period in case it ignores SIGTERM (or is stuck in a syscall).
    const terminate = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, POPPLER_KILL_GRACE_MS);
      killTimer.unref?.();
      reject(new PdfToolError(message, 'extract-failed'));
    };

    timer = setTimeout(() => terminate(`${binary} timed out after ${timeoutMs}ms`), timeoutMs);

    proc.stdout?.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > MAX_POPPLER_OUTPUT_BYTES) {
        terminate(`${binary} output exceeded ${MAX_POPPLER_OUTPUT_BYTES} bytes`);
        return;
      }
      stdout += c.toString('utf-8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      // Bound stderr too so a noisy failure can't balloon memory.
      if (stderr.length < MAX_POPPLER_OUTPUT_BYTES) stderr += c.toString('utf-8');
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimers();
      if (settled) return;
      settled = true;
      const kind: PdfToolErrorKind = err.code === 'ENOENT' ? 'poppler-missing' : 'extract-failed';
      const hint = kind === 'poppler-missing' ? ' — install with `brew install poppler`' : '';
      reject(new PdfToolError(`${binary} failed: ${err.message}${hint}`, kind));
    });
    proc.on('close', (code: number | null) => {
      // The process exited — no further kill needed, so always clear timers.
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise(stdout);
      else reject(new PdfToolError(`${binary} exit ${code}: ${stderr.trim() || '(no stderr)'}`, 'extract-failed'));
    });
  });
}

// Remove temp OCR page-image dirs left behind by a crashed run. Called once at
// the start of enrich:inbox so orphans don't accumulate in os.tmpdir().
export function sweepOrphanedOcrTmpDirs(maxAgeMs = 60 * 60 * 1000): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(OCR_TMP_PREFIX)) continue;
    const full = join(tmpdir(), name);
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // skip — another process may hold it
    }
  }
  return removed;
}

// Exposed for tests that exercise the real OCR-fallback wiring with injected
// spawn + ocr stubs (avoids shelling out to poppler/Vision in CI).
export const __test = { rasterizeAndOcr, runPoppler, ocrSinglePage };
