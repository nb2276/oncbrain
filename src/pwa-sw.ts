/// <reference lib="webworker" />
//
// oncbrain service worker (injectManifest mode, compiled by @vite-pwa/astro).
//
// Workbox owns cache correctness: precacheAndRoute() consumes the build-time
// __WB_MANIFEST (content-hashed shell + the latest digest), so a new deploy
// busts exactly the changed entries. We add only the routing policy on top.
//
//   precache   shell (about, sites index, CSS/JS, latin Newsreader, icons,
//              /offline/) + the single latest digest page (injected at build)
//   archive    /YYYY-MM-DD/, /sites/<s>/, /conferences/<s>/  -> NetworkFirst
//              (3s timeout for hostile wifi, bounded to 30 entries)
//   home + search-index                                       -> StaleWhileRevalidate
//   navigation failure (offline + uncached)                   -> /offline/
//
import type { PrecacheEntry } from 'workbox-precaching';
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import {
  isArchivePage,
  isHome,
  isSearchIndex,
  hasOnlyFilterParams,
  stripFilterParams,
} from './lib/pwa-routes';

// __WB_MANIFEST is injected by vite-plugin-pwa at build time.
declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// autoUpdate: take over immediately so a new deploy reaches readers on next load.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// v0.11 PR-1b: Workbox cache-key normalization plugin. Used on both the
// archive and home routes so a reader hitting `/sites/breast/`,
// `/sites/breast/?tag=radiation`, and `/sites/breast/?tag=radiation&tag=phase-3-rct`
// shares ONE cache entry instead of creating three. Without this plugin
// (matcher change alone) the 30-entry archive cap would thrash on the
// PR-2 filter rail's `?tag=` URL sync.
//
// Returning a STRING is intentional: Workbox accepts either a string
// (used directly as the cache key URL) or a Request (used as a Cache.put
// key). Earlier draft returned a Request constructed from the normalized
// URL — that path needed a `mode: 'navigate' → 'cors'` substitution
// because `new Request(..., {mode: 'navigate'})` throws from script,
// and `'cors'` is semantically wrong (it triggers CORS preflight
// expectations on a synthesized Request that has no Origin). The string
// return sidesteps the whole Request-construction edge-case class.
//
// stripFilterParams is idempotent and pure, so calling it
// unconditionally is cheaper than the previous case-sensitive
// short-circuit (which silently skipped mixed-case keys like `?Tag=...`
// — caught by adversarial + Codex review).
const stripFilterCacheKey = {
  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
    const normalized = stripFilterParams(new URL(request.url));
    return normalized.toString();
  },
};

// Home-specific normalization: every request to `/` (regardless of query
// string) shares ONE cache entry. The home page changes daily; cache
// pollution from social referrers (utm_source=twitter, gclid, fbclid)
// would otherwise accumulate forever in the no-cap home cache. Strip
// EVERY query and hash so the cache key is the bare origin + '/'.
const homeFixedCacheKey = {
  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    return `${url.origin}/`;
  },
};

// Archive pages grow without bound; cache on visit, bounded, time-boxed.
//
// v0.11 PR-1b: the matcher now ACCEPTS URLs whose only query params are
// filter-rail params (`?tag=...`) and routes them through the same cache
// entry as the bare URL (via stripFilterCacheKey). Non-filter queries
// (utm_*, gclid, fbclid, ...) are still rejected — they fall through to
// the network rather than evicting useful cache entries one variant at
// a time. The url.hash check stays because hashes never round-trip
// server-side; routing them through the cache adds no value and risks
// collision with anchor-bearing variants.
registerRoute(
  ({ url, sameOrigin }) =>
    sameOrigin &&
    hasOnlyFilterParams(url) &&
    url.hash === '' &&
    isArchivePage(url.pathname),
  new NetworkFirst({
    cacheName: 'oncbrain-archive',
    networkTimeoutSeconds: 3,
    plugins: [
      stripFilterCacheKey,
      new ExpirationPlugin({ maxEntries: 30 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Home + search index change daily: serve instantly from cache, refresh
// behind. Home accepts ANY query — utm_source from Twitter / Reddit /
// Slack referrals are the primary traffic vector; gating them on
// hasOnlyFilterParams (the archive route's rule) would force every
// social click to pay a network round-trip and would show the offline
// page instead of the cached home when the reader is offline.
// Adversarial + Codex review caught that regression on the first draft.
//
// homeFixedCacheKey collapses EVERY variant (tag, utm, gclid, fbclid,
// any future tracking key) to the single origin+'/' cache entry, so the
// no-cap oncbrain-home cache stays at one entry forever.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && isHome(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'oncbrain-home',
    plugins: [homeFixedCacheKey],
  }),
);
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && isSearchIndex(url.pathname),
  new StaleWhileRevalidate({ cacheName: 'oncbrain-search-index' }),
);

// Any navigation that still fails (offline + not cached) gets the branded
// /offline/ page instead of the browser's default error screen.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const offline = await matchPrecache('/offline/index.html');
    if (offline) return offline;
  }
  return Response.error();
});
