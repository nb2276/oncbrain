// Deploy-readiness gate for the Telegram notifications.
//
// THE BUG THIS FIXES (found 2026-07-30, verified against the live site):
// scripts/daily-build.sh runs notify:curator / notify:channel immediately after
// `git push`, but DigitalOcean takes ~40s to build and deploy. Telegram fetches
// the announced URL the moment it renders the link preview — before the page
// exists. And `.do/app.yaml` sets `catchall_document: index.html`, so a path
// that isn't deployed yet returns **HTTP 200 with the HOME PAGE** (title
// "onc brain", og:image /og/default.png) instead of a 404. Telegram previews
// that, then CACHES it per URL, so the wrong card sticks even after the deploy
// lands. The public channel post is affected, not just the curator DM.
//
// Three consequences drive the design:
//
//   1. A status-code check is USELESS here. The catchall makes every URL 200 —
//      including a missing OG image, verified live:
//          /og/2026-07-29.png -> 200 image/png   49820 bytes
//          /og/2099-01-01.png -> 200 text/html   85747 bytes  (the home page!)
//      So readiness is decided on CONTENT, and the image probe must check
//      content-type, not just status.
//
//   2. Telegram fetches TWO things: the HTML, then the og:image it names. Both
//      must be live before the message goes out, or the preview renders without
//      a card and THAT gets cached.
//
//   3. Probe the CLEAN URL — the exact one Telegram will fetch. An earlier
//      version appended a `?_deploycheck=N` cache-buster; that is a DIFFERENT
//      CDN cache key, so a fresh response for the busted URL proved nothing
//      about the real one. `cache-control: no-cache` is the correct tool for
//      defeating a stale response on the URL you actually care about.
//
// Fail-soft by construction: this never throws. The CALLER decides what a
// timeout means — the curator DM sends anyway (an operational ping is worth
// more than its preview), the channel post skips (there the preview IS the
// product, and publishing on timeout is the very act that poisons the cache).
import { setTimeout as sleep } from 'node:timers/promises';

export type DeployReadyReason = 'ready' | 'timeout' | 'disabled' | 'invalid-date';

export type DeployReadyResult = {
  ready: boolean;
  reason: DeployReadyReason;
  attempts: number;
  elapsedMs: number;
};

/** What a single probe of the date page learned. */
export type PageProbe = {
  html: string;
  /** true only when the og:image responded 200 AND with an image/* content-type. */
  ogImageOk: boolean;
};

export type WaitOptions = {
  siteUrl?: string;
  /**
   * The digest artifact's `generated_at` (epoch ms, a number in the artifact).
   * When given, the page must carry this exact build stamp, which is what
   * distinguishes "a page for this date exists" from "THIS build is live" on a
   * re-rendered date. Omit to fall back to existence-only checking (older
   * artifacts, or a page with no stamp).
   */
  expectBuildStamp?: string | number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Delay between probes. */
  intervalMs?: number;
  /** Grace pause after the page appears, so CDN edges converge before Telegram fetches. */
  settleMs?: number;
  /** Injectable for tests. Receives the page URL and the og:image URL. */
  probe?: (pageUrl: string, ogUrl: string) => Promise<PageProbe>;
  log?: (msg: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
};

const DEFAULT_SITE_URL = 'https://oncbrain.oncologytoolkit.com';
// DO deploys this site in ~40s. 2 min is triple that, and bounds a bad night:
// daily-build.sh can invoke up to 4 notify processes, each with its own budget.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_SETTLE_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The public URL a notification announces for a date. */
export function digestPageUrl(siteUrl: string, date: string): string {
  return `${siteUrl.replace(/\/$/, '')}/${date}/`;
}

/**
 * The og:image URL we EXPECT for a date. Used as the fallback when the page
 * hasn't been fetched yet (first probe) or carries no og:image tag.
 */
export function digestOgImageUrl(siteUrl: string, date: string): string {
  return `${siteUrl.replace(/\/$/, '')}/og/${date}.png`;
}

/**
 * The og:image URL the SERVED page actually names. Probing this rather than a
 * synthesized path means the gate checks the exact asset Telegram will fetch —
 * a future host/path/query change in Base.astro can't leave the probe passing
 * while Telegram pulls something else.
 */
export function servedOgImageUrl(html: string): string | null {
  const tag = html.match(/<meta\b[^>]*\bproperty=["']og:image["'][^>]*>/i);
  if (!tag) return null;
  const content = tag[0].match(/\bcontent=["']([^"']*)["']/i);
  const url = content?.[1]?.trim();
  return url ? url : null;
}

/**
 * True when the fetched HTML is the REAL date page rather than the catchall
 * home page. Keyed on the per-date og:image reference, which is exactly what
 * Telegram reads to build the preview.
 *
 * With `expectBuildStamp`, also requires the page to carry that exact stamp
 * (Base.astro emits `<meta name="oncbrain:build">`), so a stale same-date
 * deploy does not pass. Without it, existence-only — the graceful path for a
 * page built before the stamp existed.
 */
export function isDatePageDeployed(
  html: string,
  date: string,
  expectBuildStamp?: string | number,
): boolean {
  if (!html || !ISO_DATE.test(date)) return false;
  if (!html.includes(`/og/${date}.png`)) return false;

  const stamp = expectBuildStamp == null ? '' : String(expectBuildStamp).trim();
  if (!stamp) return true;

  // Read the stamp OUT of its own meta tag and compare exactly. A bare
  // `html.includes(stamp)` is far too loose: the page is ~85KB, so a short or
  // digit-prefix stamp matches somewhere by accident (`includes("1")` is true
  // on virtually any document). Same failure family as the repo's
  // grounding-gate-spoofable-boundary learning — never let a substring stand in
  // for a scoped, exact comparison.
  const served = extractBuildStamp(html);
  return served !== null && served === stamp;
}

/**
 * The value of `<meta name="oncbrain:build" content="...">`, or null when the
 * page carries no stamp (pre-stamp build, or a non-date page).
 *
 * Attribute order doesn't matter: the leading `[^>]*` absorbs any attributes
 * before `name=`, so `content`-then-`name` matches too. The content value is
 * then pulled from the matched tag rather than from the page, which is what
 * keeps the comparison scoped.
 */
export function extractBuildStamp(html: string): string | null {
  const tag = html.match(/<meta\b[^>]*\bname=["']oncbrain:build["'][^>]*>/i);
  if (!tag) return null;
  const content = tag[0].match(/\bcontent=["']([^"']*)["']/i);
  return content ? content[1]!.trim() : null;
}

/** Live probe: fetch the page HTML, and confirm the og:image is really an image. */
async function defaultProbe(pageUrl: string, ogUrl: string): Promise<PageProbe> {
  const headers = { 'cache-control': 'no-cache' };
  let html = '';
  try {
    const res = await fetch(pageUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers,
    });
    if (res.ok) html = await res.text();
  } catch {
    // Network hiccup, DNS, timeout — indistinguishable from "not deployed yet"
    // for our purposes, and both are retryable.
  }

  // Prefer the og:image the page itself names over the synthesized fallback, so
  // the probe hits the exact asset Telegram will request.
  const target = servedOgImageUrl(html) ?? ogUrl;

  let ogImageOk = false;
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers,
    });
    // The content-type check is load-bearing, NOT belt-and-braces: under the
    // catchall a missing PNG returns 200 with text/html, so status alone passes
    // on precisely the broken case.
    ogImageOk = res.ok && (res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/');
  } catch {
    // same as above
  }

  return { html, ogImageOk };
}

/**
 * Block until the date page AND its og:image are live, or until the timeout.
 * Returns a result; NEVER throws. The caller decides what a non-ready result
 * means for its surface.
 *
 * Kill switch: DEPLOY_WAIT=off skips the wait entirely (returns ready=true so
 * callers behave exactly as they did before this gate existed).
 * Override the cap with DEPLOY_WAIT_TIMEOUT_MS.
 */
export async function waitForDeployedDate(
  date: string,
  opts: WaitOptions = {},
): Promise<DeployReadyResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => Date.now());
  const started = now();

  if (process.env.DEPLOY_WAIT === 'off') {
    return { ready: true, reason: 'disabled', attempts: 0, elapsedMs: 0 };
  }
  // A malformed date can't be probed, and guessing would build a bogus URL.
  if (!ISO_DATE.test(date)) {
    return { ready: false, reason: 'invalid-date', attempts: 0, elapsedMs: 0 };
  }

  const siteUrl = opts.siteUrl ?? process.env.PUBLIC_SITE_URL ?? DEFAULT_SITE_URL;
  const envTimeout = Number(process.env.DEPLOY_WAIT_TIMEOUT_MS);
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const probe = opts.probe ?? defaultProbe;
  const pageUrl = digestPageUrl(siteUrl, date);
  const ogUrl = digestOgImageUrl(siteUrl, date);

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const { html, ogImageOk } = await probe(pageUrl, ogUrl);
    if (ogImageOk && isDatePageDeployed(html, date, opts.expectBuildStamp)) {
      if (settleMs > 0) await sleep(settleMs);
      const elapsedMs = now() - started;
      log(
        `  deploy-ready: ${date} live after ${Math.round(elapsedMs / 1000)}s ` +
          `(${attempts} probe${attempts === 1 ? '' : 's'})`,
      );
      return { ready: true, reason: 'ready', attempts, elapsedMs };
    }

    // Sleep only as long as the budget actually has left, so the deadline gets
    // a final probe instead of the loop quitting one interval early.
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) {
      const elapsedMs = now() - started;
      log(
        `  ⚠ deploy-ready: ${date} still not live after ${Math.round(elapsedMs / 1000)}s ` +
          `(${attempts} probes)`,
      );
      return { ready: false, reason: 'timeout', attempts, elapsedMs };
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}
