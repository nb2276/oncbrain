// v0.59: a local archive of the images attached to bookmarked posts.
//
// A speaker's slides shared on X live only on Twitter's CDN: the post can be
// deleted, the account locked, the media rotated. The digest keeps rendering
// them through the embed (no re-hosting, same IP posture as before), but the
// curator's Obsidian vault gets its own copy so a talk worth keeping stays
// readable after the post is gone.
//
// LOCAL-ONLY, same boundary as the filed PDFs: data/obsidian/media/ is
// gitignored, has no public/ symlink, and never enters the Astro build
// (test/publish-boundary.test.ts guards it). The ignore rule is also checked at
// RUNTIME, fail-closed: the cron stages `data` with `git add`, so a checkout
// whose .gitignore lacks the rule (an older branch, main before this merged)
// would commit and push a speaker's slides to the public repo. Without
// confirmation from git that the directory is ignored, nothing is written.
//
// The path is DERIVED, not stored: <vault>/media/tweets/<date>/<basename>,
// where basename is the pbs.twimg.com media key the URL already carries. So the
// Obsidian export can embed an image from the artifact's image_urls alone, and
// no new column or artifact field is needed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isSafeImageUrl } from './vision-ocr.ts';
import { ssrfSafeFetchBuffer, type SsrfFetchOptions } from './ssrf-fetch.ts';

export const MEDIA_VAULT_DIR = 'media/tweets';
const VAULT_ROOT = 'data/obsidian';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const BASENAME_RE = /^[A-Za-z0-9_-]{4,64}\.(jpe?g|png|webp)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONCURRENCY = 4;
// A permanent miss (the post or its media is gone) leaves <file>.miss so every
// later build of that date doesn't re-pay the download. The archive exists
// because posts disappear, so the count of dead URLs only grows. A transient
// failure (timeout, 5xx, network) writes nothing and is retried next build.
const MISS_SUFFIX = '.miss';
// Only "gone" is permanent. A 401/403 from the CDN can be transient (rate
// limiting, a protected account later made public) and a non-image 200 is
// usually an error page; both are retried.
const PERMANENT_HTTP = /\bHTTP (404|410)\b/;

/**
 * Vault-relative archive path for one post image, or null when the URL or date
 * can't produce a safe one. Pure: the Obsidian export calls it to embed, the
 * archiver to write, and both must agree.
 */
export function archivedMediaPath(date: string, url: string): string | null {
  if (!DATE_RE.test(date) || !isSafeImageUrl(url)) return null;
  let base: string;
  try {
    const u = new URL(url);
    base = u.pathname.split('/').pop() ?? '';
    // Twitter also serves the query form: /media/<key>?format=jpg&name=large.
    const fmt = u.searchParams.get('format');
    if (!base.includes('.') && fmt) base = `${base}.${fmt}`;
  } catch {
    return null;
  }
  if (!BASENAME_RE.test(base)) return null;
  return `${MEDIA_VAULT_DIR}/${date}/${base}`;
}

// Twitter serves the original upload with name=orig; the bare URL is a
// downscaled variant. Slides are text-dense, so the archive keeps the original.
function originalUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set('name', 'orig');
  return u.toString();
}

// Kill switch TWEET_MEDIA_ARCHIVE=off. Also off under vitest so the enrichment
// and build suites never touch the network; the archiver's own tests call
// archiveTweetImages directly with an injected fetch.
export function isMediaArchiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST) return false;
  return (env.TWEET_MEDIA_ARCHIVE ?? '').toLowerCase() !== 'off';
}

// Magic bytes, not the content-type header: only a real JPEG / PNG / WebP is
// kept, so an HTML error page served as 200 never lands in the vault.
export function isImageBytes(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/**
 * Is `dir` git-ignored in the checkout rooted at `root`? Fail-closed: any
 * error (not a repo, git missing) answers false, so nothing is written.
 */
export function isGitIgnored(root: string, relPath: string): boolean {
  try {
    const r = spawnSync('git', ['check-ignore', '-q', '--', relPath], { cwd: root, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

export type ArchiveResult = { saved: number; existing: number; skippedMiss: number; failed: string[] };

export type ArchiveOptions = Pick<SsrfFetchOptions, 'fetchImpl' | 'lookupImpl' | 'timeoutMs'> & {
  root?: string;
  // Tests run in a temp dir that is not a git checkout; production never sets it.
  skipIgnoreCheck?: boolean;
};

/**
 * Download each post image into the vault, skipping any already archived or
 * recorded as permanently gone. Best-effort: a failure is reported, never
 * thrown, because an archive miss must not fail an enrichment or a build.
 */
export async function archiveTweetImages(
  date: string,
  urls: string[],
  opts: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const out: ArchiveResult = { saved: 0, existing: 0, skippedMiss: 0, failed: [] };
  const root = resolve(opts.root ?? process.cwd());
  const vault = join(root, VAULT_ROOT);
  const mediaRoot = join(vault, MEDIA_VAULT_DIR);

  if (!opts.skipIgnoreCheck && !isGitIgnored(root, `${VAULT_ROOT}/${MEDIA_VAULT_DIR}/${date}/probe.jpg`)) {
    out.failed.push(`${VAULT_ROOT}/${MEDIA_VAULT_DIR} is not git-ignored in this checkout; refusing to archive (publish boundary)`);
    return out;
  }

  const one = async (url: string): Promise<void> => {
    const rel = archivedMediaPath(date, url);
    if (!rel) {
      out.failed.push(`${url}: not an archivable post image`);
      return;
    }
    const abs = join(vault, rel);
    // Defense in depth: the basename regex already excludes separators.
    if (!abs.startsWith(mediaRoot + '/')) {
      out.failed.push(`${url}: path escapes the media vault`);
      return;
    }
    if (existsSync(abs)) {
      out.existing++;
      return;
    }
    if (existsSync(abs + MISS_SUFFIX)) {
      out.skippedMiss++;
      return;
    }
    const markMiss = (reason: string) => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs + MISS_SUFFIX, `${new Date().toISOString()} ${reason}\n`);
    };
    try {
      // Host-pinned, redirect-revalidated, body capped while streaming.
      const buf = await ssrfSafeFetchBuffer(originalUrl(url), {
        fetchImpl: opts.fetchImpl,
        lookupImpl: opts.lookupImpl,
        timeoutMs: opts.timeoutMs ?? 15_000,
        maxBodyBytes: MAX_IMAGE_BYTES,
        allowedHostSuffixes: ['pbs.twimg.com'],
      });
      if (!isImageBytes(buf)) {
        out.failed.push(`${url}: not an image`);
        return;
      }
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.part`;
      writeFileSync(tmp, buf);
      renameSync(tmp, abs);
      out.saved++;
    } catch (err) {
      const msg = (err as Error).message;
      if (PERMANENT_HTTP.test(msg)) {
        try {
          markMiss(msg);
        } catch {
          // a marker we can't write just means a retry next build
        }
      }
      out.failed.push(`${url}: ${msg}`);
    }
  };

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    await Promise.all(urls.slice(i, i + CONCURRENCY).map(one));
  }
  return out;
}
