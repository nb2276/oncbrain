// URL classification for the PWA service worker cache strategy.
// Imported by astro.config.mjs (Workbox runtimeCaching + precache wiring) and
// unit-tested in pwa-routes.test.ts. Keeping the branchy decision here (rather
// than inline in the config) means a regex typo can't silently mis-cache pages.
//
//   /                     home        -> StaleWhileRevalidate (changes daily)
//   /search-index.json    search idx  -> StaleWhileRevalidate (changes daily)
//   /about/, /sites/      shell       -> precache (cache-first, revisioned)
//   /sites/breast/        ARCHIVE     -> NetworkFirst (grows one per site)
//   /2026-05-17/          ARCHIVE     -> NetworkFirst (grows one per day)
//   /conferences/asco/    ARCHIVE     -> NetworkFirst
//   /tags/radiation/      ARCHIVE     -> NetworkFirst (grows with corpus,
//                                       intersections multiply 2-way + 3-way)
//   /api/..., /feed.xml   excluded from the navigation fallback
//
// "Archive" = the unbounded, ever-growing set. Precaching it would bloat the
// offline footprint without limit, so it is runtime-cached on visit instead.

const DATED = /^\/\d{4}-\d{2}-\d{2}\/?$/;
const SITE_DETAIL = /^\/sites\/[^/]+\/?$/;
const CONFERENCE_DETAIL = /^\/conferences\/[^/]+\/?$/;
// v0.10: tag landing pages (/tags/<slug>/) AND intersection pages
// (/tags/<a>+<b>/, /tags/<a>+<b>+<c>/) all route through NetworkFirst archive
// caching. NOT the bare /tags/ index — that stays on the shell path because
// it's a fixed page like /sites/ and /about/.
//
// Tightened to enforce isSafeTagSlug() shape on each segment of the `+`-join
// AND to cap at 3-way (plan limit). A permissive `[^/]+` would otherwise
// route querystring-laden URLs (/tags/foo?x=y), uppercase variants
// (/tags/Radiation/), %2F-encoded paths, and 4+ way intersections through
// the NetworkFirst cache, polluting the SW cache with attacker-craftable
// garbage entries.
const SLUG_PART = '[a-z0-9]+(?:-[a-z0-9]+)*';
const TAG_DETAIL = new RegExp(`^/tags/${SLUG_PART}(?:\\+${SLUG_PART}){0,2}/?$`);

/** True for the unbounded archive pages (dated digests + per-site + per-conference + per-tag). */
export function isArchivePage(pathname: string): boolean {
  return (
    DATED.test(pathname) ||
    SITE_DETAIL.test(pathname) ||
    CONFERENCE_DETAIL.test(pathname) ||
    TAG_DETAIL.test(pathname)
  );
}

/** True for the home page (served StaleWhileRevalidate, not precache). */
export function isHome(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html';
}

/** True for the daily-changing search index (served StaleWhileRevalidate). */
export function isSearchIndex(pathname: string): boolean {
  return pathname === '/search-index.json';
}

/**
 * Paths that must never be served the offline navigation fallback: the JSON API,
 * the RSS feed, slide assets, and any request that carries a file extension
 * (assets, not navigations).
 */
export const NAV_FALLBACK_DENYLIST: RegExp[] = [
  /^\/api\//,
  /^\/feed\.xml$/,
  /^\/slides\//,
  /\/[^/?]+\.[^/?]+$/,
];

/**
 * Newest published digest date from a list of `data/digests` filenames.
 * Pure (takes filenames, not fs) so it is unit-testable; the config does the
 * directory read. Returns null when there are no dated digests yet.
 */
export function latestDigestDateFromFiles(files: string[]): string | null {
  const dates = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));
  if (dates.length === 0) return null;
  dates.sort();
  return dates[dates.length - 1];
}
