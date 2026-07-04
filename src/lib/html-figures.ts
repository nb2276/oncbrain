// v0.25 (#2): OCR figure images embedded in a TRADE-PRESS article page (UroToday
// / ASCO Post / OncLive conference coverage), so a non-PDF, non-PMC ingest can
// still surface figure-locked numbers.
//
// OPT-IN + IP-SENSITIVE, so this is deliberately narrow and defensive (both
// review rounds drove these constraints):
//   - DEFAULT OFF: only runs when the curator sets HTML_FIGURE_OCR=on.
//   - TRADE-PRESS ONLY: the caller restricts this to the trade-press host
//     allowlist (all 2-label .com/.org), so the domain-pin below can't be
//     defeated by a multi-part public suffix (co.uk / com.au) — which the
//     caller-side restriction plus the PUBLIC_SUFFIX guard here both prevent.
//   - GROUNDED-ONLY: a trade-press page is copyrighted, so we NEVER store raw
//     figure OCR (which the publishing LLM could paraphrase). We emit ONLY the
//     v0.20 grounded, per-panel structured extract, and only when the Qwen+Opus
//     reconciliation actually succeeds (status 'ok') — i.e. numbers verified
//     against the image's own OCR. No Qwen stack → no HTML figures (by design).
//   - IMAGES STAY ON THE MACHINE: fetched only from the article's own domain
//     (SSRF-safe, host-pinned), OCR'd locally; only grounded numbers reach the
//     digest via figure_structured_md (local-only, guarded out of the artifact).
//
// macOS-only (Apple Vision). Never throws; returns nulls when it can't.
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ssrfSafeFetchBuffer } from './ssrf-fetch.ts';
import { ocrFile, isOcrAvailable } from './vision-ocr.ts';
import { extractFigure, MAX_FIGURE_STRUCTURED_CHARS, type FigureExtraction } from './figure-extract.ts';
import { isQwenAvailable } from './qwen-client.ts';

const MAX_HTML_FIGURES = 5; // OCR at most N page images (bounds cost + junk)
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_IMAGE_BYTES = 12 * 1024; // skip tiny icons / spacers
const OCRABLE_EXT = /\.(jpe?g|png|webp|tiff?)(\?|#|$)/i;
const FIGURE_HINT = /(fig(ure)?|chart|graph|curve|kaplan|forest|plot|table|slide)/i;
const NON_FIGURE_HINT =
  /(logo|icon|avatar|headshot|banner|ad[-_/]|advert|sprite|thumb|social|share|pixel|spacer|footer|header|nav)/i;
// Common multi-part public suffixes: a last-2-labels "registrable domain" that
// lands on ONE of these is actually a public suffix, so pinning to it would
// allow any host under that TLD. Refuse the feature for such a page (#P1).
const MULTIPART_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'co.jp', 'com.br', 'com.cn', 'co.in', 'co.za', 'com.mx', 'com.tr', 'co.kr',
]);

export function isHtmlFigureOcrEnabled(): boolean {
  return process.env.HTML_FIGURE_OCR === 'on';
}

// Registrable domain heuristic: the last two labels of the host (urotoday.com).
// Returns null when that lands on a known multi-part public suffix (co.uk, …),
// where the heuristic is unsafe — callers must then refuse (no host to pin to).
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const last2 = labels.slice(-2).join('.');
  if (MULTIPART_PUBLIC_SUFFIXES.has(last2)) return null;
  return last2;
}

// Pull the best src from an <img> tag: prefer the real (lazy-load) source over a
// placeholder `src`, and the LARGEST srcset candidate. Handles single/double
// quotes. Returns '' when none.
function imgSrc(tag: string): string {
  const attr = (name: string): string | undefined =>
    tag.match(new RegExp(`\\b${name}=("([^"]+)"|'([^']+)')`, 'i'))?.slice(2).find(Boolean);
  const srcset = attr('srcset') || attr('data-srcset');
  if (srcset) {
    // "url1 320w, url2 640w" → the url with the largest width descriptor.
    let best = '';
    let bestW = -1;
    for (const part of srcset.split(',')) {
      const [u, w] = part.trim().split(/\s+/);
      const width = Number((w ?? '').replace(/\D/g, '')) || 0;
      if (u && width >= bestW) {
        best = u;
        bestW = width;
      }
    }
    if (best) return best;
  }
  return (
    attr('data-src') || attr('data-original') || attr('data-lazy-src') || attr('src') || ''
  );
}

// Extract figure-candidate image URLs from a page's HTML: same registrable domain
// as the page, raster extension, POSITIVE figure signal (a figure keyword or a
// large declared dimension — not just any same-domain image), deduped + capped.
// Pure + exported for testing. Returns [] when the page's registrable domain is
// unsafe (multi-part suffix) or malformed.
export function extractFigureImageUrls(html: string, pageUrl: string): string[] {
  let pageHost: string;
  try {
    pageHost = new URL(pageUrl).hostname;
  } catch {
    return [];
  }
  const pageDomain = registrableDomain(pageHost);
  if (!pageDomain) return []; // unsafe / unresolvable domain → refuse

  type Cand = { url: string; score: number };
  const seen = new Set<string>();
  const cands: Cand[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const raw = imgSrc(tag);
    if (!raw || raw.startsWith('data:')) continue;
    let abs: URL;
    try {
      abs = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== 'https:') continue;
    if (registrableDomain(abs.hostname) !== pageDomain) continue; // article's own domain only
    if (!OCRABLE_EXT.test(abs.pathname)) continue;
    const href = abs.toString();
    if (seen.has(href)) continue;

    const meta = tag.toLowerCase();
    if (NON_FIGURE_HINT.test(meta)) continue;
    const w = Number(tag.match(/\bwidth="?(\d+)/i)?.[1] ?? 0);
    const h = Number(tag.match(/\bheight="?(\d+)/i)?.[1] ?? 0);
    const hint = FIGURE_HINT.test(meta);
    const large = w >= 300 || h >= 300;
    if (!hint && !large) continue; // require a POSITIVE figure signal (#P2)
    seen.add(href);
    cands.push({ url: href, score: (hint ? 2 : 0) + (large ? 1 : 0) });
  }
  return cands
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HTML_FIGURES)
    .map((c) => c.url);
}

export type HtmlFiguresDeps = {
  fetchBuffer?: (url: string, allowedHostSuffixes: string[]) => Promise<Buffer>;
  extract?: (imagePath: string) => Promise<Pick<FigureExtraction, 'figure_structured_md' | 'status'>>;
  ocrAvailable?: () => boolean;
  qwenAvailable?: () => Promise<boolean>;
};

// Fetch + grounded-OCR the trade-press page's figure-candidate images. Emits ONLY
// the grounded structured extract (numbers verified against the image OCR), never
// raw OCR — the source is copyrighted (#P1). Best-effort; nulls when disabled / no
// Vision / no Qwen / nothing usable. Never throws.
export async function enrichHtmlFigures(
  html: string,
  pageUrl: string,
  deps: HtmlFiguresDeps = {},
): Promise<{ figure_ocr_md: null; figure_structured_md: string | null }> {
  const none = { figure_ocr_md: null, figure_structured_md: null };
  try {
    if (!isHtmlFigureOcrEnabled()) return none;
    const ocrAvailable = deps.ocrAvailable ?? isOcrAvailable;
    if (!ocrAvailable()) return none;
    // Preflight the Qwen stack: grounded reconciliation needs it, and we will
    // NOT feed raw copyrighted OCR to the publishing LLM. (The hard guarantee is
    // the status==='ok' check below — only a grounded reconciliation is kept, so
    // even a per-image Vision-only reconcile stays numbers-grounded, never raw.)
    const qwenUp = deps.qwenAvailable ? await deps.qwenAvailable() : await isQwenAvailable();
    if (!qwenUp) return none;

    const urls = extractFigureImageUrls(html, pageUrl);
    if (urls.length === 0) return none;

    const pageDomain = registrableDomain(new URL(pageUrl).hostname);
    if (!pageDomain) return none;
    // Pin every image fetch to the article's REGISTRABLE domain: its own host or
    // a sibling CDN subdomain of it (media.urotoday.com), never off-domain. The
    // trade-press-only caller restriction keeps this a 2-label host, and the
    // private-IP guard in ssrfSafeFetchBuffer still applies on every hop.
    const allowed = [`.${pageDomain}`];

    const fetchBuffer =
      deps.fetchBuffer ??
      ((url: string, allowedHostSuffixes: string[]) =>
        ssrfSafeFetchBuffer(url, { allowedHostSuffixes, maxBodyBytes: MAX_IMAGE_BYTES, timeoutMs: 20_000 }));
    const extract = deps.extract ?? ((p: string) => extractFigure(p));

    const parts: string[] = [];
    let used = 0;
    let idx = 0;
    for (const url of urls) {
      idx += 1;
      const tmpPath = join(tmpdir(), `oncbrain-htmlfig-${randomBytes(8).toString('hex')}.bin`);
      try {
        const buf = await fetchBuffer(url, allowed);
        if (buf.byteLength < MIN_IMAGE_BYTES) continue;
        writeFileSync(tmpPath, buf);
        const res = await extract(tmpPath);
        // ONLY a successful grounded reconciliation — a 'degraded' result may be
        // raw OCR and must not reach the digest for a copyrighted source.
        if (res.status !== 'ok') continue;
        const md = res.figure_structured_md.trim();
        if (!md) continue;
        const block = `[Image ${idx}]\n${md}`;
        if (parts.length === 0) {
          parts.push(block.length > MAX_FIGURE_STRUCTURED_CHARS ? block.slice(0, MAX_FIGURE_STRUCTURED_CHARS) : block);
          used = Math.min(block.length, MAX_FIGURE_STRUCTURED_CHARS) + 2;
        } else if (used + block.length + 2 <= MAX_FIGURE_STRUCTURED_CHARS) {
          parts.push(block);
          used += block.length + 2;
        }
      } catch {
        // one bad image shouldn't lose the rest
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          // may not exist if fetch failed
        }
      }
    }
    return { figure_ocr_md: null, figure_structured_md: parts.length ? parts.join('\n\n') : null };
  } catch {
    return none;
  }
}
