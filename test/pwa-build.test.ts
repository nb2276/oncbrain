import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latestDigestDateFromFiles } from '../src/lib/pwa-routes.ts';

// Integration test: build the site once, then assert the PWA wiring is correct.
// This guards the things that are easy to silently break: precache scope (shell
// only + the latest digest), the runtime cache routes, the offline fallback,
// and the page-level injection that @vite-pwa/astro does NOT do under Astro 6.
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}/dist`;

let sw = '';
let home = '';
let manifest: Record<string, unknown> = {};

beforeAll(() => {
  execSync('npm run build', { cwd: root, stdio: 'ignore' });
  sw = readFileSync(`${dist}/pwa-sw.js`, 'utf8');
  home = readFileSync(`${dist}/index.html`, 'utf8');
  manifest = JSON.parse(readFileSync(`${dist}/manifest.webmanifest`, 'utf8'));
}, 180_000);

describe('PWA build output', () => {
  it('emits the service worker, manifest, and all icons', () => {
    expect(existsSync(`${dist}/pwa-sw.js`)).toBe(true);
    expect(existsSync(`${dist}/manifest.webmanifest`)).toBe(true);
    for (const icon of [
      'icon-192.png',
      'icon-512.png',
      'icon-192-maskable.png',
      'icon-512-maskable.png',
      'apple-touch-icon.png',
    ]) {
      expect(existsSync(`${dist}/${icon}`), icon).toBe(true);
    }
  });

  it('manifest has the installability fields + a 512 maskable icon', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#f7f5f0');
    expect(manifest.background_color).toBe('#f7f5f0');
    const icons = manifest.icons as Array<{ sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
  });

  it('precaches the latest digest page so it works offline after install', () => {
    const latest = latestDigestDateFromFiles(readdirSync(`${root}/data/digests`));
    expect(latest).toBeTruthy();
    expect(sw).toContain(`"url":"/${latest}/"`);
  });

  it('precaches the shell (sites index, about, offline) but NOT the unbounded archive', () => {
    expect(sw).toContain('"url":"sites"'); // sites index = shell
    expect(sw).toContain('"url":"about"');
    expect(sw).toContain('"url":"offline"'); // offline fallback must be precached
    // per-site detail + per-conference pages are NetworkFirst, not precache
    expect(sw).not.toMatch(/"url":"sites\/[^"]+"/);
    expect(sw).not.toMatch(/"url":"conferences\/[^"]+"/);
  });

  it('does NOT precache the home page, the search index, or non-latin fonts', () => {
    expect(sw).not.toMatch(/"url":"\/?index\.html"/); // home -> StaleWhileRevalidate
    expect(sw).not.toContain('"url":"search-index.json"'); // -> StaleWhileRevalidate
    expect(sw).not.toContain('latin-ext-opsz'); // unused subset (unicode-range gates runtime)
    expect(sw).not.toContain('vietnamese-opsz');
    // self-hosted latin Newsreader IS precached for offline fidelity
    expect(sw).toMatch(/newsreader-latin-opsz-(normal|italic)/);
  });

  it('wires the archive NetworkFirst (3s timeout, bounded), SWR routes, and offline catch', () => {
    expect(sw).toContain('oncbrain-archive');
    expect(sw).toContain('networkTimeoutSeconds: 3');
    expect(sw).toContain('maxEntries: 30');
    expect(sw).toContain('oncbrain-home');
    expect(sw).toContain('oncbrain-search-index');
    expect(sw).toContain('offline/index.html'); // catch handler fallback target
  });

  it('injects the manifest link + SW registration into pages (manual, since the integration does not on Astro 6)', () => {
    expect(home).toContain('rel="manifest"');
    expect(home).toContain('serviceWorker');
    expect(home).toContain('/pwa-sw.js');
  });

  it('drops the Google Fonts CDN dependency in favour of self-hosting', () => {
    expect(home).not.toContain('fonts.googleapis.com');
    expect(home).not.toContain('fonts.gstatic.com');
  });

  it('offline page renders the recovery link to the precached latest digest', () => {
    // Regression: the build-time digests-dir lookup must resolve from cwd, or the
    // latest-digest recovery link silently disappears (only "Home" shows).
    const latest = latestDigestDateFromFiles(readdirSync(`${root}/data/digests`));
    const offline = readFileSync(`${dist}/offline/index.html`, 'utf8');
    expect(offline).toContain(`href="/${latest}/"`);
    expect(offline).toContain('Latest digest');
  });
});
