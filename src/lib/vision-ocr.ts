// Apple Vision OCR wrapper.
//
// Drives the on-device Vision framework via scripts/vision-ocr (Swift binary).
// Used by the build pipeline to extract text from tweet images BEFORE the LLM
// call — Claude vision reads the chart shape/structure; this layer captures
// exact numbers, trial IDs, and author lists that the model might misread.
//
// Lifecycle:
//   1. Caller passes a list of image URLs to ocrImages().
//   2. For each URL: download to /tmp, run vision-ocr binary, capture stdout.
//   3. /tmp file is deleted after OCR completes (success or failure).
//   4. Returns string[] aligned to input URLs (empty string on failure).
//
// Failure modes:
//   - Binary missing (not compiled / not macOS):   warn-once, return [] (skip OCR layer).
//   - Network failure downloading image:           log skip, return '' for that index.
//   - OCR binary nonzero exit:                     log skip, return '' for that index.
// The build pipeline continues with what it has — no exception thrown for
// per-image failures.
//
// Cache: this module is stateless. The bookmarks.image_ocr_texts column is
// the persistent cache; the caller (build/digest-builder.ts) skips re-OCR if
// the bookmark already has a populated array of the right length.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = resolve(__dirname, '../../scripts/vision-ocr');

// Bump when the OCR pipeline changes (Swift binary, prompt, post-processing).
// Cache entries with a stale version are re-OCR'd on next build.
// Codex amended-plan finding #4: cache invalidation by length-equality was
// too weak. This version pins the OCR engine identity so an upgrade can't
// silently produce mixed cache state.
export const OCR_VERSION = 'v1-2026-05-18-vision-accurate';

// Host allowlist for OCR fetching AND public-page <img> rendering. Defense
// against (1) SSRF if a syndication parser ever emits a non-Twitter URL,
// (2) image-decoder CVEs reachable via arbitrary attacker bytes,
// (3) reader-IP-tracking via arbitrary CDN.
// pbs.twimg.com URLs are content-addressed (filename embeds image hash),
// so the URL itself acts as a content fingerprint.
const ALLOWED_IMAGE_HOSTS = new Set(['pbs.twimg.com']);

export function isSafeImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

let warnedBinaryMissing = false;

export type OcrEntry = {
  text: string;
  hash: string; // sha256 of the downloaded image bytes
  version: string; // OCR_VERSION at the time of computation; '' means not-fresh (failed/skipped)
};

export type OcrResult = {
  entry: OcrEntry;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
};

// Sentinel for failed/skipped OCR. Empty version ensures isOcrEntryFresh()
// returns false so the next build will re-attempt. Codex amended-plan #1:
// caching a transient failure as fresh would permanently disable OCR for
// that image until a version bump or DB edit.
const FAILED_ENTRY = (): OcrEntry => ({ text: '', hash: '', version: '' });

export function isOcrAvailable(): boolean {
  return existsSync(BINARY);
}

// OCR a single image URL. Downloads bytes, hashes them, runs Vision binary,
// returns an OcrEntry containing text + bytes-hash + OCR_VERSION.
// On any failure (network, binary, decode), entry.text is '' and entry.hash
// is '' (so re-attempts on next build aren't blocked by a fake cache hit).
export async function ocrImageUrl(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OcrResult> {
  if (!isOcrAvailable()) {
    if (!warnedBinaryMissing) {
      warnedBinaryMissing = true;
      console.warn(
        '  [ocr] scripts/vision-ocr not found — skipping OCR layer. ' +
          'Run `npm run setup:vision` to compile (macOS only).',
      );
    }
    return { entry: FAILED_ENTRY(), status: 'skipped', reason: 'binary-missing' };
  }

  // Host allowlist. Security specialist P1-1: untrusted URLs are an SSRF
  // surface (link-local fetch, image-decoder CVE feed). Currently only
  // pbs.twimg.com is ever expected, but we enforce here so a compromised
  // or misparsed syndication response can't trick the OCR layer.
  if (!isSafeImageUrl(url)) {
    return {
      entry: FAILED_ENTRY(),
      status: 'failed',
      reason: `url not on host allowlist: ${url}`,
    };
  }

  if (!process.env.VITEST) {
    console.log(`  [ocr:vision] Apple Vision OCR on image ${url}`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const tmpPath = join(tmpdir(), `oncbrain-ocr-${randomBytes(8).toString('hex')}.bin`);

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let bytes: ArrayBuffer;
    try {
      // redirect: 'error' refuses HTTP redirects so an attacker-controlled
      // pbs.twimg.com URL can't bounce us to an internal host.
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
      if (!res.ok) {
        return { entry: FAILED_ENTRY(), status: 'failed', reason: `download HTTP ${res.status}` };
      }
      bytes = await res.arrayBuffer();
    } finally {
      clearTimeout(t);
    }

    const buffer = Buffer.from(bytes);
    const hash = createHash('sha256').update(buffer).digest('hex');
    writeFileSync(tmpPath, buffer);

    const text = await runBinary(tmpPath, timeoutMs);
    return {
      entry: { text: text.trim(), hash, version: OCR_VERSION },
      status: 'ok',
    };
  } catch (err) {
    return { entry: FAILED_ENTRY(), status: 'failed', reason: (err as Error).message };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignored — tempfile may not have been created if fetch failed early.
    }
  }
}

// OCR a local file directly (no download). Used by v0.5 Phase C for slide
// photos already on disk. Computes content hash + runs Vision binary;
// returns an OcrEntry compatible with the cache shape.
export async function ocrFile(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<OcrResult> {
  if (!isOcrAvailable()) {
    if (!warnedBinaryMissing) {
      warnedBinaryMissing = true;
      console.warn(
        '  [ocr] scripts/vision-ocr not found — skipping OCR layer. ' +
          'Run `npm run setup:vision` to compile (macOS only).',
      );
    }
    return { entry: FAILED_ENTRY(), status: 'skipped', reason: 'binary-missing' };
  }
  if (!process.env.VITEST) {
    console.log(`  [ocr:vision] Apple Vision OCR on file ${filePath}`);
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const { readFileSync } = await import('node:fs');
    const buffer = readFileSync(filePath);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const text = await runBinary(filePath, timeoutMs);
    return {
      entry: { text: text.trim(), hash, version: OCR_VERSION },
      status: 'ok',
    };
  } catch (err) {
    return { entry: FAILED_ENTRY(), status: 'failed', reason: (err as Error).message };
  }
}

// Batch OCR: process URLs sequentially. Vision is on-device and CPU-bound;
// parallel spawns just thrash. Caller already iterates per-bookmark so any
// outer parallelism is at that level. Returns OcrEntry[] aligned with input.
export async function ocrImageUrls(
  urls: string[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OcrEntry[]> {
  const out: OcrEntry[] = [];
  for (const url of urls) {
    const result = await ocrImageUrl(url, opts);
    if (result.status === 'failed' && result.reason) {
      console.warn(`  [ocr] skip ${url}: ${result.reason}`);
    }
    out.push(result.entry);
  }
  return out;
}

// Returns true when a stored OCR entry is reusable for the given URL.
// Currently: requires entry exists AND version matches the live OCR_VERSION.
// Does not re-hash downloaded bytes (would defeat the cache); pbs.twimg.com
// URLs are content-addressed so URL change ≈ content change.
export function isOcrEntryFresh(entry: OcrEntry | undefined): boolean {
  return !!entry && entry.version === OCR_VERSION;
}

function runBinary(imagePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveProm, reject) => {
    const proc = spawn(BINARY, [imagePath]);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // proc may already be gone
      }
      if (!settled) {
        settled = true;
        reject(new Error(`vision-ocr timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`vision-ocr spawn failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolveProm(stdout);
      else reject(new Error(`vision-ocr exit ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}
