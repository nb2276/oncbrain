// v0.24 (Tier B): fetch an open-access article's figure IMAGES from PMC and run
// them through the EXISTING figure-OCR + grounded-structuring pipeline, so a
// paper ingested via a PMID / DOI / PMC link (no forwarded PDF) still gets the
// numbers printed INSIDE its figures (KM medians, forest-plot HRs, image-rendered
// tables) that the text layer can't see.
//
// Scope: only the PMC OPEN-ACCESS subset (a minority of oncology trial papers;
// JCO / Lancet Onc / NEJM are usually paywalled → skipped, forwarded-PDF path
// stays primary). macOS-only (Apple Vision), same as the PDF path. Output goes to
// the LOCAL-ONLY figure_ocr_md / figure_structured_md fields (never published;
// guarded by publish-boundary.test.ts). Best-effort + gated: any failure just
// means no figures, exactly like the PDF figure step. Kill switch PMC_OA_FIGURES=off.
//
// The ONLY new work here is ACQUIRING the images (query PMC's OA service,
// download + untar the package, pick the figures from the nxml). The OCR +
// grounding is reused wholesale from vision-ocr.ts / figure-extract.ts.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { ssrfSafeFetchText, ssrfSafeFetchBuffer } from './ssrf-fetch.ts';
import { ocrFile, isOcrAvailable } from './vision-ocr.ts';
import { extractFigure, MAX_FIGURE_STRUCTURED_CHARS } from './figure-extract.ts';
import { isQwenAvailable } from './qwen-client.ts';
import { MAX_FIGURE_OCR_CHARS } from './pdf-text.ts';

const OA_SERVICE = 'https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi';
const IDCONV_SERVICE = 'https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/';
// Pin the OA package download to NCBI (the tgz href comes from the oa.fcgi
// RESPONSE body, so it must not be trusted to steer the fetch anywhere; #P1).
const NCBI_HOST_SUFFIXES = ['.ncbi.nlm.nih.gov'];
// OA figure packages run a few MB; cap the COMPRESSED download generously.
const MAX_PACKAGE_BYTES = 60 * 1024 * 1024;
// Extraction bounds (decompression-bomb + tar-slip defense, atop the host-pin).
const MAX_TAR_ENTRIES = 3000;
const MAX_TAR_UNCOMPRESSED = 500 * 1024 * 1024;
const MAX_FIGURES = 6; // OCR at most N figures/paper (bounds Vision + Opus cost)
const MIN_FIGURE_BYTES = 8 * 1024; // skip tiny icons / rendered equations
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff']);
// Deterministic tiebreak when two files share a basename (fig1.jpg vs fig1.tif):
// prefer the web-raster the article renders, not a scan/thumbnail (#P2).
const EXT_PREFERENCE = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.gif'];

export function isPmcOaFiguresEnabled(): boolean {
  return process.env.PMC_OA_FIGURES !== 'off';
}

// v0.25 (#1): resolve a DOI → its PMCID via NCBI's ID converter, so a DOI-only
// ingest of an open-access paper (which today never resolves a pmc_id, so Tier B
// never fires) flows into the PMC-OA figure path automatically. Best-effort:
// null on any failure or when the DOI isn't in PMC. Host-pinned to NCBI.
export async function resolvePmcIdForDoi(
  doi: string,
  fetchText: (url: string) => Promise<string> = (u) =>
    ssrfSafeFetchText(u, { allowedHostSuffixes: NCBI_HOST_SUFFIXES }),
): Promise<string | null> {
  const clean = doi.trim();
  if (!clean) return null;
  let body: string;
  try {
    body = await fetchText(
      `${IDCONV_SERVICE}?ids=${encodeURIComponent(clean)}&format=json&tool=oncbrain`,
    );
  } catch {
    return null;
  }
  try {
    const json = JSON.parse(body) as { records?: Array<{ pmcid?: string; doi?: string }> };
    const rec = json.records?.[0];
    const pmcid = rec?.pmcid;
    if (!pmcid || !/^PMC\d+$/i.test(pmcid)) return null;
    // Verify the record is actually for the DOI we asked about (idconv echoes
    // it): don't ship a mis-mapped PMCID as a published PMC link (#P2).
    if (rec.doi && rec.doi.trim().toLowerCase() !== clean.toLowerCase()) return null;
    return pmcid.toUpperCase();
  } catch {
    return null;
  }
}

export type PmcFigure = { imagePath: string; label: string; caption: string };

export type PmcOaFiguresDeps = {
  // Seams for tests (no network / tar / Vision / Ollama needed).
  fetchText?: (url: string) => Promise<string>;
  fetchBuffer?: (url: string) => Promise<Buffer>;
  untar?: (tarPath: string, destDir: string) => void;
  ocr?: (imagePath: string) => Promise<string>;
  structured?: (imagePath: string) => Promise<string>;
  ocrAvailable?: () => boolean;
  qwenAvailable?: () => Promise<boolean>;
};

// Query the OA service and return the https tgz package URL, or null when the
// article is not in the OA subset (or the query fails). NCBI still returns an
// ftp:// href; rewrite it to the https mirror since our fetch is https-only.
export async function resolvePmcOaPackageUrl(
  pmcId: string,
  fetchText: (url: string) => Promise<string> = (u) => ssrfSafeFetchText(u),
): Promise<string | null> {
  const id = pmcId.startsWith('PMC') ? pmcId : `PMC${pmcId}`;
  let xml: string;
  try {
    xml = await fetchText(`${OA_SERVICE}?id=${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
  // Explicit non-OA marker → skip (also covers the generic error shape).
  if (/<error\b/i.test(xml)) return null;
  for (const link of xml.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/format="tgz"/i.test(link)) continue;
    const href = link.match(/href="([^"]+)"/i)?.[1];
    if (!href) continue;
    const https = href.replace(
      /^ftp:\/\/ftp\.ncbi\.nlm\.nih\.gov\//i,
      'https://ftp.ncbi.nlm.nih.gov/',
    );
    // Belt-and-suspenders host-pin (the download also pins via
    // allowedHostSuffixes): reject any tgz href that isn't an NCBI https URL,
    // so a poisoned oa.fcgi response can't hand us an attacker URL (#P1).
    if (!https.startsWith('https://')) continue;
    let host: string;
    try {
      host = new URL(https).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === 'ncbi.nlm.nih.gov' || host.endsWith('.ncbi.nlm.nih.gov')) return https;
  }
  return null;
}

// Validate a `tar -tvzf` listing BEFORE extracting (defense-in-depth atop the
// NCBI host-pin — a compromised mirror still can't traverse or bomb us; #P1):
//   - only regular files ('-') and directories ('d'); reject symlinks /
//     hardlinks / devices (first column of the verbose listing);
//   - no absolute paths and no '..' segment (tar-slip);
//   - bounded entry count and total UNCOMPRESSED size (gzip bomb — the download
//     cap only bounds compressed bytes).
// Exported for unit testing. Throws on any violation.
export function assertSafeTarListing(tvzfStdout: string): void {
  const lines = tvzfStdout.split('\n').filter((l) => l.trim());
  if (lines.length > MAX_TAR_ENTRIES) throw new Error(`tar: too many entries (${lines.length})`);
  let total = 0;
  for (const line of lines) {
    const type = line[0];
    if (type && type !== '-' && type !== 'd') {
      throw new Error(`tar: unsafe entry type '${type}' (symlink/hardlink/device)`);
    }
    // Name is the tail after the DATE token — anchored on a full date/time so a
    // 4-digit run inside the size column can't be mistaken for the year (that
    // let an absolute path slip past). Covers bsdtar ("Mon D YYYY" / "Mon D
    // HH:MM") and GNU tar ISO ("YYYY-MM-DD HH:MM").
    const name =
      line.match(
        /(?:\d{4}-\d\d-\d\d \d\d:\d\d|\w{3}\s+\d+\s+(?:\d{4}|\d\d:\d\d))\s+(.+?)\s*$/,
      )?.[1] ?? '';
    if (name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name)) {
      throw new Error(`tar: unsafe path '${name}'`);
    }
    total += Number(line.match(/\s(\d+)\s+(?:\d{4}-\d\d-\d\d|\w{3}\s+\d+)/)?.[1] ?? 0);
  }
  if (total > MAX_TAR_UNCOMPRESSED) {
    throw new Error(`tar: uncompressed size ${total} exceeds cap`);
  }
}

// Untar a .tar.gz via the system `tar` (bsdtar on macOS; no npm dep, matching
// the poppler ethos), preflight-validated. Throws on a missing binary (ENOENT),
// a bad/unsafe archive, or a non-zero exit.
function untarDefault(tarPath: string, destDir: string): void {
  const list = spawnSync('tar', ['-tvzf', tarPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (list.error) throw list.error;
  if (list.status !== 0) throw new Error(`tar list exited ${list.status ?? 'signal'}`);
  assertSafeTarListing(list.stdout);
  const ex = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'ignore' });
  if (ex.error) throw ex.error;
  if (ex.status !== 0) throw new Error(`tar extract exited ${ex.status ?? 'signal'}`);
}

function listFilesRecursive(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(full, out);
    else out.push(full);
  }
  return out;
}

// Parse the package nxml for <fig>/<table-wrap> → <graphic xlink:href> + caption,
// and resolve each href to an extracted image file (basename match, any
// extension — JATS hrefs often omit the extension). Only blocks that map to a
// real image are returned (so we never OCR a logo the nxml didn't call a figure).
export function parsePmcFigures(nxml: string, extractedFiles: string[]): PmcFigure[] {
  const extRank = (f: string): number => {
    const i = EXT_PREFERENCE.indexOf(extname(f).toLowerCase());
    return i < 0 ? 99 : i;
  };
  // basename(no ext) → path, keeping the preferred extension on a collision
  // (fig1.jpg wins over fig1.tif) so we OCR the rendered raster, not a thumbnail.
  const byBase = new Map<string, string>();
  for (const f of extractedFiles) {
    if (!IMAGE_EXTS.has(extname(f).toLowerCase())) continue;
    const key = basename(f, extname(f)).toLowerCase();
    const cur = byBase.get(key);
    if (!cur || extRank(f) < extRank(cur)) byBase.set(key, f);
  }
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const figs: PmcFigure[] = [];
  for (const m of nxml.matchAll(/<(fig|table-wrap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const inner = m[2] ?? '';
    const href = inner.match(/<graphic\b[^>]*xlink:href="([^"]+)"/i)?.[1];
    if (!href) continue;
    const imagePath = byBase.get(basename(href, extname(href)).toLowerCase());
    if (!imagePath) continue;
    figs.push({
      imagePath,
      label: strip(inner.match(/<label>([\s\S]*?)<\/label>/i)?.[1] ?? ''),
      caption: strip(inner.match(/<caption>([\s\S]*?)<\/caption>/i)?.[1] ?? ''),
    });
  }
  return figs;
}

// Orchestrate: OA gate → download + unpack → select figures → OCR each through
// the existing pipeline. Returns local-only figure markdown, or nulls when the
// article isn't OA / Vision is unavailable / anything fails.
export async function enrichPmcOaFigures(
  pmcId: string,
  deps: PmcOaFiguresDeps = {},
): Promise<{ figure_ocr_md: string | null; figure_structured_md: string | null }> {
  const none = { figure_ocr_md: null, figure_structured_md: null };
  if (!isPmcOaFiguresEnabled()) return none;
  const ocrAvailable = deps.ocrAvailable ?? isOcrAvailable;
  if (!ocrAvailable()) return none; // Apple Vision (macOS) only

  const pkgUrl = await resolvePmcOaPackageUrl(pmcId, deps.fetchText);
  if (!pkgUrl) return none; // not in the OA subset

  let workDir: string | undefined;
  try {
    const buf = deps.fetchBuffer
      ? await deps.fetchBuffer(pkgUrl)
      : await ssrfSafeFetchBuffer(pkgUrl, {
          maxBodyBytes: MAX_PACKAGE_BYTES,
          timeoutMs: 30_000,
          allowedHostSuffixes: NCBI_HOST_SUFFIXES, // pin every hop to NCBI (#P1)
        });
    workDir = mkdtempSync(join(tmpdir(), 'oncbrain-pmc-oa-'));
    const tarPath = join(workDir, 'pkg.tar.gz');
    writeFileSync(tarPath, buf);
    (deps.untar ?? untarDefault)(tarPath, workDir);

    const all = listFilesRecursive(workDir);
    const nxmlPath = all.find((f) => f.toLowerCase().endsWith('.nxml'));
    if (!nxmlPath) return none;
    const figs = parsePmcFigures(readFileSync(nxmlPath, 'utf8'), all)
      .filter((f) => {
        try {
          // Skip symlinks (lstat, not stat) as defense-in-depth against an escape
          // the tar-listing check somehow missed, and cull tiny icons.
          const st = lstatSync(f.imagePath);
          return st.isFile() && st.size >= MIN_FIGURE_BYTES;
        } catch {
          return false;
        }
      })
      .slice(0, MAX_FIGURES);
    if (figs.length === 0) return none;

    const ocr = deps.ocr ?? (async (p: string) => (await ocrFile(p)).entry.text.trim());
    const structured =
      deps.structured ?? (async (p: string) => (await extractFigure(p)).figure_structured_md.trim());
    const qwenUp = deps.qwenAvailable ? await deps.qwenAvailable() : await isQwenAvailable();

    const ocrParts: string[] = [];
    const structParts: string[] = [];
    let ocrUsed = 0;
    let structUsed = 0;
    // Append a block, honoring the char cap. A first block that alone exceeds the
    // cap is SLICED (not stored whole), so a single dense table can't overflow it
    // (#P2). Returns the new accumulated length.
    const pushCapped = (parts: string[], used: number, block: string, cap: number): number => {
      if (parts.length === 0) {
        parts.push(block.length > cap ? block.slice(0, cap) : block);
        return Math.min(block.length, cap) + 2;
      }
      if (used + block.length + 2 <= cap) {
        parts.push(block);
        return used + block.length + 2;
      }
      return used;
    };
    for (const fig of figs) {
      const tag = fig.label || 'Figure';
      try {
        const raw = (await ocr(fig.imagePath)).trim();
        if (raw) ocrUsed = pushCapped(ocrParts, ocrUsed, `[${tag}]\n${raw}`, MAX_FIGURE_OCR_CHARS);
      } catch {
        // one bad figure shouldn't lose the rest
      }
      // Structured (grounded) layer only when a local Qwen is up (it makes Opus
      // reconcile calls); extractFigure applies the v0.20 grounding gate itself.
      if (qwenUp) {
        try {
          const md = (await structured(fig.imagePath)).trim();
          if (md) {
            structUsed = pushCapped(structParts, structUsed, `[${tag}]\n${md}`, MAX_FIGURE_STRUCTURED_CHARS);
          }
        } catch {
          // skip
        }
      }
    }
    return {
      figure_ocr_md: ocrParts.length ? ocrParts.join('\n\n') : null,
      figure_structured_md: structParts.length ? structParts.join('\n\n') : null,
    };
  } catch {
    // Non-fatal: any failure (fetch, tar missing, corrupt archive) → no figures,
    // exactly like the PDF figure step. The paper still ships with its text.
    return none;
  } finally {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
