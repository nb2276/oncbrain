import { defineConfig } from 'astro/config';
import AstroPWA from '@vite-pwa/astro';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { latestDigestDateFromFiles } from './src/lib/pwa-routes.ts';

// Build-time precache of the SINGLE latest digest page. NetworkFirst alone would
// only cache a digest after the reader visited that exact dated page online; this
// makes "open the latest digest offline" hold even for a reader who installed
// from the home screen and never opened today's page. Bounded to one page,
// re-pointed (and re-revisioned on content change) each build.
const digestsDir = fileURLToPath(new URL('./data/digests', import.meta.url));

function latestDigestPrecacheEntries(): { url: string; revision: string }[] {
  try {
    const latest = latestDigestDateFromFiles(readdirSync(digestsDir));
    if (!latest) return [];
    const json = readFileSync(`${digestsDir}/${latest}.json`, 'utf8');
    const revision = createHash('md5').update(json).digest('hex').slice(0, 12);
    return [{ url: `/${latest}/`, revision }];
  } catch {
    // No digests yet (fresh checkout) — shell-only precache is correct.
    return [];
  }
}

// https://astro.build/config
export default defineConfig({
  // Canonical production URL. Makes context.site available to the RSS feed +
  // JSON API endpoints (v0.8 PR3) so they can emit absolute links.
  site: 'https://oncbrain.oncologytoolkit.com',
  integrations: [
    AstroPWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'pwa-sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Icons are already precached via globPatterns (png); don't let the
      // integration re-add them (and the manifest once per icon) to the list.
      includeManifestIcons: false,
      injectManifest: {
        // Shell only: assets + fixed pages + self-hosted latin Newsreader + icons.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico}'],
        // NOTE: `dir/**` would also match `dir` itself (micromatch lets `/**`
        // match zero segments), which wrongly excluded `sites/index.html`. Use
        // explicit `/index.html` so the shell indexes stay precached and only
        // the per-item archive pages are dropped.
        globIgnores: [
          'index.html', // home -> StaleWhileRevalidate (changes daily)
          '2[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/index.html', // dated digests -> NetworkFirst
          'sites/*/index.html', // per-site detail -> NetworkFirst (keeps sites/index.html)
          'conferences/*/index.html', // per-conference -> NetworkFirst (keeps conferences index)
          '**/*-latin-ext-*.woff2', // unused font subsets; unicode-range gates runtime fetch
          '**/*-vietnamese-*.woff2',
        ],
        additionalManifestEntries: latestDigestPrecacheEntries(),
      },
      manifest: {
        name: 'onc brain',
        short_name: 'onc brain',
        description: 'AI-summarized oncology meeting research digest.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f7f5f0',
        theme_color: '#f7f5f0',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Don't run the SW in `astro dev` (it caches aggressively and confuses HMR).
      devOptions: { enabled: false },
    }),
  ],
});
