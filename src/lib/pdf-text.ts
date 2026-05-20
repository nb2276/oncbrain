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
// Cap rasterized pages — bounds OCR cost on a 200-page thesis PDF. The first
// pages carry title/abstract/methods, which is what the digest needs.
const MAX_OCR_PAGES = 15;
const DEFAULT_TIMEOUT_MS = 60_000;
const OCR_TMP_PREFIX = 'oncbrain-ocr-pdf-';

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
  if (wordCount(layer) >= minWords) {
    return { text: layer, via: 'text' };
  }

  // Empty/garbled text layer → treat as scanned, OCR the pages.
  const ocrText = (await runOcr(absPath)).trim();
  if (wordCount(ocrText) === 0) {
    throw new PdfToolError(
      'no text layer and OCR recovered nothing (corrupt or image-only PDF?)',
      'empty',
    );
  }
  return { text: ocrText, via: 'ocr' };
}

function wordCount(s: string): number {
  const t = s.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
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

// Run a poppler binary, resolve stdout. ENOENT (binary missing) → typed
// poppler-missing; non-zero exit → extract-failed.
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
    let settled = false;
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
      if (!settled) {
        settled = true;
        reject(new PdfToolError(`${binary} timed out after ${timeoutMs}ms`, 'extract-failed'));
      }
    }, timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const kind: PdfToolErrorKind = err.code === 'ENOENT' ? 'poppler-missing' : 'extract-failed';
      const hint = kind === 'poppler-missing' ? ' — install with `brew install poppler`' : '';
      reject(new PdfToolError(`${binary} failed: ${err.message}${hint}`, kind));
    });
    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
export const __test = { rasterizeAndOcr, runPoppler };
