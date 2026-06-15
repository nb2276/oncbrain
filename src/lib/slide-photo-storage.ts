// Slide photo storage. Downloads Telegram photos via getFile API, saves
// to data/slide-photos/<date>/<uuid>.<ext>, computes hash, runs OCR.
//
// Telegram getFile flow:
//   1. POST /bot<TOKEN>/getFile?file_id=AgADBQADr...
//      → { ok: true, result: { file_path: "photos/file_42.jpg", file_size: ..., file_unique_id: ... } }
//   2. GET https://api.telegram.org/file/bot<TOKEN>/<file_path>
//      → raw bytes
//
// File-size cap: Telegram supports up to 20MB via getFile (regular photos
// are well under 1MB after Telegram's compression). We hard-cap at 25MB
// to surface anomalies (very large documents masquerading as photos).
//
// Path safety: filenames are UUID v4. Path joins resolve under data/
// slide-photos/. Defense-in-depth check rejects anything that escapes.

import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type TelegramPhotoMeta = {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  file_size?: number;
};

export class TelegramFileError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'not_found' | 'too_large' | 'network' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TelegramFileError';
  }
}

const MAX_BYTES = 25 * 1024 * 1024;
const SLIDES_ROOT = resolve(process.cwd(), 'data/slide-photos');

export type DownloadResult = {
  buffer: Buffer;
  mime_type: string;
  ext: string;
};

// Two-call Telegram getFile pattern. Returns image bytes + detected
// extension. Throws TelegramFileError on auth/network/oversize failure.
export async function downloadTelegramFile(
  fileId: string,
  token: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  if (!token) throw new TelegramFileError('Missing TELEGRAM_BOT_TOKEN', 'auth');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // Step 1: resolve file_id → file_path via getFile. Bound it with the same
  // timeout as the byte download — a hung getFile (Telegram incident, network
  // black hole) would otherwise block the whole enrich:inbox run (and the cron
  // chained behind it) indefinitely, since this call had no AbortController.
  const metaUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaController = new AbortController();
  const metaTimer = setTimeout(() => metaController.abort(), timeoutMs);
  let metaRes: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    metaRes = await fetchImpl(metaUrl, { signal: metaController.signal });
  } finally {
    clearTimeout(metaTimer);
  }
  if (metaRes.status === 401 || metaRes.status === 403) {
    throw new TelegramFileError(`Telegram getFile auth failed (${metaRes.status})`, 'auth', metaRes.status);
  }
  if (!metaRes.ok) {
    throw new TelegramFileError(`Telegram getFile HTTP ${metaRes.status}`, 'network', metaRes.status);
  }
  let metaJson: { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  try {
    metaJson = await metaRes.json();
  } catch (err) {
    throw new TelegramFileError(`getFile JSON parse: ${(err as Error).message}`, 'parse');
  }
  if (!metaJson.ok || !metaJson.result?.file_path) {
    throw new TelegramFileError('getFile response missing file_path', 'not_found');
  }
  if (metaJson.result.file_size && metaJson.result.file_size > MAX_BYTES) {
    throw new TelegramFileError(
      `File too large: ${metaJson.result.file_size} > ${MAX_BYTES}`,
      'too_large',
    );
  }

  // Step 2: download bytes.
  const bytesUrl = `https://api.telegram.org/file/bot${token}/${metaJson.result.file_path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const bytesRes = await fetchImpl(bytesUrl, { signal: controller.signal });
    if (!bytesRes.ok) {
      throw new TelegramFileError(`Bytes download HTTP ${bytesRes.status}`, 'network', bytesRes.status);
    }
    const arrayBuf = await bytesRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_BYTES) {
      throw new TelegramFileError(`Downloaded ${arrayBuf.byteLength} > MAX_BYTES`, 'too_large');
    }
    const buffer = Buffer.from(arrayBuf);
    const { ext, mime_type } = sniffImageType(buffer, metaJson.result.file_path);
    return { buffer, mime_type, ext };
  } finally {
    clearTimeout(timer);
  }
}

// Magic-bytes sniff. Telegram doesn't always send a content-type header that
// matches the actual bytes (especially for documents); we read the file's
// own magic to be safe. Falls back to extension from the file_path.
function sniffImageType(buffer: Buffer, file_path: string): { ext: string; mime_type: string } {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime_type: 'image/jpeg' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { ext: 'png', mime_type: 'image/png' };
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return { ext: 'gif', mime_type: 'image/gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime_type: 'image/webp' };
  }
  // Fallback to file_path extension if magic didn't match.
  const ext = (file_path.split('.').pop() ?? 'bin').toLowerCase();
  return { ext, mime_type: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
}

// Save a slide photo to data/slide-photos/<date>/<uuid>.<ext>.
// Returns the absolute path + sha256 hash for cache + dedup.
// Refuses to write outside SLIDES_ROOT (defense-in-depth against path traversal).
export function saveSlidePhotoBytes(opts: {
  buffer: Buffer;
  ext: string;
  bookmarkDate: string;
}): { absPath: string; relPath: string; hash: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.bookmarkDate)) {
    throw new Error(`bookmarkDate must be YYYY-MM-DD, got: ${opts.bookmarkDate}`);
  }
  if (!/^[a-z0-9]{1,5}$/i.test(opts.ext)) {
    throw new Error(`unsafe extension: ${opts.ext}`);
  }
  const uuid = randomUUID();
  const dir = join(SLIDES_ROOT, opts.bookmarkDate);
  const absPath = resolve(dir, `${uuid}.${opts.ext.toLowerCase()}`);
  if (!absPath.startsWith(SLIDES_ROOT + '/')) {
    throw new Error('refused: resolved path escapes SLIDES_ROOT');
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, opts.buffer);
  const hash = createHash('sha256').update(opts.buffer).digest('hex');
  // Relative path is what gets persisted in DB so the repo is portable.
  const relPath = `data/slide-photos/${opts.bookmarkDate}/${uuid}.${opts.ext.toLowerCase()}`;
  return { absPath, relPath, hash };
}

// Sanity: make sure the path resolves under SLIDES_ROOT before any read/write.
// Used by Astro static route in Phase E too.
export function isSafeSlidePath(p: string): boolean {
  try {
    const abs = resolve(p);
    return abs.startsWith(SLIDES_ROOT + '/') && existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

// Used by Phase E rendering layer (not yet shipped) to expose the SLIDES_ROOT
// constant without forcing the import path back into Astro pages.
export const SLIDE_PHOTOS_ROOT = SLIDES_ROOT;
