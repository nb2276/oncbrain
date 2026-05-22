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
import { isArchivePage, isHome, isSearchIndex } from './lib/pwa-routes';

// __WB_MANIFEST is injected by vite-plugin-pwa at build time.
declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// autoUpdate: take over immediately so a new deploy reaches readers on next load.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Archive pages grow without bound; cache on visit, bounded, time-boxed.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && isArchivePage(url.pathname),
  new NetworkFirst({
    cacheName: 'oncbrain-archive',
    networkTimeoutSeconds: 3,
    plugins: [
      new ExpirationPlugin({ maxEntries: 30 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Home + search index change daily: serve instantly from cache, refresh behind.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && isHome(url.pathname),
  new StaleWhileRevalidate({ cacheName: 'oncbrain-home' }),
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
