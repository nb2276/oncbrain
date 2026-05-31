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
// The plugin only triggers when filter params are present; otherwise it
// returns the unchanged request so non-filter URLs (the most common case)
// pay no overhead.
const stripFilterCacheKey = {
  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    if (
      !url.searchParams.has('tag') &&
      !url.searchParams.has('tags') &&
      !url.searchParams.has('TAG') &&
      !url.searchParams.has('TAGS')
    ) {
      return request;
    }
    const normalized = stripFilterParams(url);
    return new Request(normalized.toString(), {
      method: request.method,
      headers: request.headers,
      credentials: request.credentials,
      mode: request.mode === 'navigate' ? 'cors' : request.mode,
      redirect: request.redirect,
    });
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

// Home + search index change daily: serve instantly from cache, refresh behind.
// Home gets the same filter-param normalization treatment so PR-2's
// `/?tag=radiation` URL share doesn't multiply cache entries on the home page.
registerRoute(
  ({ url, sameOrigin }) =>
    sameOrigin && hasOnlyFilterParams(url) && isHome(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'oncbrain-home',
    plugins: [stripFilterCacheKey],
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
