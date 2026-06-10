import { defineConfig } from 'astro/config';
import AstroPWA from '@vite-pwa/astro';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { latestDigestDateFromFiles } from './src/lib/pwa-routes.ts';
import slugUniqueness from './src/integrations/slug-uniqueness.ts';

// Build-time precache of the SINGLE latest digest page. NetworkFirst alone would
// only cache a digest after the reader visited that exact dated page online; this
// makes "open the latest digest offline" hold even for a reader who installed
// from the home screen and never opened today's page. Bounded to one page,
// re-pointed (and re-revisioned on content change) each build.
//
// The precache revision MUST hash the rendered HTML, not the digest JSON.
// The HTML carries content-hashed <link rel="stylesheet"> references to
// Base.<hash>.css and StudyCard.<hash>.css; when a UI commit changes those
// bundle hashes but the digest JSON is unchanged, a JSON-based revision would
// match the existing precache, Workbox would keep the stale HTML, and that
// HTML would point at a CSS bundle Workbox has evicted (and which `astro build`
// has deleted from dist/). The reader gets unstyled HTML with no --bg and a
// flash of white background until they hard-reload.
const digestsDir = fileURLToPath(new URL('./data/digests', import.meta.url));
const distDir = fileURLToPath(new URL('./dist', import.meta.url));

type ManifestTransformEntry = { url: string; revision: string | null; size: number };

// `manifestTransforms` runs second-to-last in workbox-build, AFTER glob scan
// and BEFORE additionalManifestEntries. Two reasons we do everything in one
// transform instead of using additionalManifestEntries + a separate revision
// transform:
//   1. additionalManifestEntries appends LAST, so a separate revision transform
//      would never see the digest URL and silently no-op.
//   2. @vite-pwa/astro only auto-pushes its own `.html` → clean-URL transform
//      when the user hasn't supplied any manifestTransforms (its config code
//      guards on `if (!manifestTransforms)`), so providing our own array
//      disables the directory-format rewrite (`sites/index.html` → `sites`).
// One transform does both: rewrite all `.html` URLs to clean URLs (matching
// what astro-pwa would have auto-injected), then append the latest-digest URL
// with its HTML-derived revision.
function buildManifestTransform(useDirectoryFormat: boolean, trailingSlash: 'always' | 'never') {
  return async (entries: ManifestTransformEntry[]) => {
    const rewritten = entries.map((e) => {
      if (!e || !e.url.endsWith('.html')) return e;
      const raw = e.url.startsWith('/') ? e.url.slice(1) : e.url;
      let url: string;
      if (raw === 'index.html') {
        url = '/';
      } else {
        const parts = raw.split('/');
        parts[parts.length - 1] = parts[parts.length - 1].replace(/\.html$/, '');
        url = useDirectoryFormat
          ? parts.length > 1
            ? parts.slice(0, parts.length - 1).join('/')
            : parts[0]
          : parts.join('/');
        if (trailingSlash === 'always') url += '/';
      }
      return { ...e, url };
    });

    // Append the latest digest with its HTML-derived revision (or skip if none
    // exists yet — fresh checkout, shell-only precache is the right behavior).
    try {
      const latest = latestDigestDateFromFiles(readdirSync(digestsDir));
      if (!latest) return { manifest: rewritten };
      const htmlPath = `${distDir}/${latest}/index.html`;
      if (!existsSync(htmlPath)) return { manifest: rewritten };
      const html = readFileSync(htmlPath, 'utf8');
      const revision = createHash('md5').update(html).digest('hex').slice(0, 12);
      return {
        manifest: [...rewritten, { url: `/${latest}/`, revision, size: html.length }],
      };
    } catch {
      return { manifest: rewritten };
    }
  };
}

// https://astro.build/config
export default defineConfig({
  // Canonical production URL. Makes context.site available to the RSS feed +
  // JSON API endpoints (v0.8 PR3) so they can emit absolute links.
  site: 'https://oncbrain.oncologytoolkit.com',
  integrations: [
    // v0.11 PR-1a: fail the build pre-SSG if any tag slug collides
    // across modality/intent/methodology/verdict/meeting namespaces.
    // build:day already validates after `build:day`, but `astro build`
    // ran independently before this — a hand-edited override JSON could
    // ship a colliding slug and silently mis-route the /tags/<slug>/
    // landing. This integration closes that gap.
    slugUniqueness(),
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
          'studies/index.html', // v0.14 T3 full index -> NetworkFirst (grows with corpus)
          '2[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/index.html', // dated digests -> NetworkFirst
          'sites/*/index.html', // per-site detail -> NetworkFirst (keeps sites/index.html)
          'conferences/*/index.html', // per-conference -> NetworkFirst (keeps conferences index)
          // v0.10: per-tag landing pages + 2-way + 3-way intersection pages all
          // route through NetworkFirst. The 1000-page intersection cap would
          // otherwise blow the precache budget (and would re-create the
          // v0.9.13->v0.9.14 stale-precache bug class because new tags shift
          // CSS bundle hashes faster than the precache revisioning catches).
          // Single pattern is sufficient: intersections live in the same
          // one-segment-deep namespace via `+` joiners (e.g.
          // tags/radiation+palliative/index.html), NOT nested. `**/index.html`
          // would re-create the dir-matches-itself bug documented above
          // (would evict the bare tags/index.html shell page).
          'tags/*/index.html', // single-tag + intersection landings (one-segment-deep)
          '**/*-latin-ext-*.woff2', // unused font subsets; unicode-range gates runtime fetch
          '**/*-vietnamese-*.woff2',
        ],
        // useDirectoryFormat=true + trailingSlash='never' matches astro-pwa's
        // default auto-injected transform — see buildManifestTransform comment.
        manifestTransforms: [buildManifestTransform(true, 'never')],
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
