// v0.38 (E6): the reader compare tray.
//
// The tray itself is client-side, but everything that makes it SAFE is decided
// at build time: which studies advertise a compare key, and whether a shared key
// really does mean a shared axis. Those are the assertions here — a key that
// grouped two differently-scaled marks would put them on one visual ruler while
// their axes disagreed, which is a wrong comparison, not a layout bug.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');

// These assertions read built HTML, and test/global-setup.ts only builds when
// dist is ABSENT. On a warm tree an edit to the components below would leave
// these tests validating yesterday's output and passing for the wrong reason.
// Compare mtimes and fail with the fix rather than silently green.
const SOURCES = [
  'src/components/CompareTray.astro',
  'src/components/StudyCard.astro',
  'src/components/EffectMark.astro',
];
function assertDistFresh(): void {
  const probe = join(DIST, 'index.html');
  if (!existsSync(probe)) return; // global-setup will have built it
  const built = statSync(probe).mtimeMs;
  for (const src of SOURCES) {
    const p = resolve(process.cwd(), src);
    if (!existsSync(p)) continue;
    if (statSync(p).mtimeMs > built) {
      throw new Error(
        `dist/ is older than ${src} — these tests would validate stale HTML. ` +
          `Run: rm -rf dist && npm run build`,
      );
    }
  }
}

/** Every built page that renders study cards. */
function pagesWithCards(): { path: string; html: string }[] {
  const out: { path: string; html: string }[] = [];
  const roots = ['sites', 'tags', '.'];
  for (const r of roots) {
    const base = r === '.' ? DIST : join(DIST, r);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const idx = join(base, entry, 'index.html');
      if (!existsSync(idx)) continue;
      const html = readFileSync(idx, 'utf-8');
      // Match the emitted ATTRIBUTE, not the bare string: the tray's own inline
      // script contains `[data-compare-key]` as a selector, so `includes` pulled
      // in pages with zero real cards and made the loops below assert nothing.
      if (/data-compare-key="/.test(html)) out.push({ path: idx, html });
    }
  }
  return out;
}

function compareKeys(html: string): string[] {
  return [...html.matchAll(/data-compare-key="([^"]+)"/g)].map((m) => m[1]!);
}

/** The tick labels a card's mark renders, in order — its axis fingerprint. */
function markAxes(html: string): string[] {
  return [...html.matchAll(/<svg[^>]*class="emark"[\s\S]*?<\/svg>/g)].map((m) =>
    [...m[0].matchAll(/class="emark-tick"[^>]*>([^<]*)</g)].map((t) => t[1]).join('|'),
  );
}

describe('compare tray build contract', () => {
  assertDistFresh();
  const pages = pagesWithCards();

  it('built pages that really do carry multiple compare keys', () => {
    expect(pages.length).toBeGreaterThan(0);
    // Guards the helper itself: if it ever matched on the tray script again,
    // these pages would have zero keys and every loop below would assert nothing.
    const total = pages.reduce((n, p) => n + compareKeys(p.html).length, 0);
    expect(total).toBeGreaterThan(pages.length);
  });

  // The key is "<endpointFamily>::<ratioKind>|<domainLo>:<domainHi>". Both parts
  // matter: the bucket keeps an OS hazard ratio away from a toxicity odds ratio,
  // and the domain is what actually guarantees the axes line up.
  it('every key names both an endpoint bucket and an explicit domain', () => {
    for (const { path, html } of pages) {
      for (const k of compareKeys(html)) {
        expect(k, path).toMatch(/^[a-z-]+::[A-Za-z]+\|[\d.]+:[\d.]+$/);
      }
    }
  });

  // The comparability guarantee, checked against real rendered output: if two
  // cards on a page advertise the same key, their marks must draw the same axis.
  it('a shared key always means an identical rendered axis', () => {
    for (const { path, html } of pages) {
      const cards = [...html.matchAll(/data-compare-key="([^"]+)"[\s\S]*?(?=data-compare-key="|$)/g)];
      const axisByKey = new Map<string, string>();
      for (const c of cards) {
        const key = c[1]!;
        const axes = markAxes(c[0]);
        if (axes.length === 0) continue;
        const axis = axes[0]!;
        if (axisByKey.has(key)) expect(axisByKey.get(key), `${path} ${key}`).toBe(axis);
        else axisByKey.set(key, axis);
      }
    }
  });

  // Different endpoints must never collapse into one key even when their axes
  // happen to coincide — on the breast page os::HR, recurrence::HR and
  // toxicity::HR all render a 0.33-3 axis, and comparing them would be wrong.
  it('keeps distinct endpoint buckets on distinct keys', () => {
    const breast = join(DIST, 'sites', 'breast', 'index.html');
    if (!existsSync(breast)) return;
    const keys = new Set(compareKeys(readFileSync(breast, 'utf-8')));
    const buckets = [...keys].map((k) => k.split('|')[0]);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets.length).toBeGreaterThan(1); // the page really does mix endpoints
  });

  it('only cards with a compare key carry a compare toggle', () => {
    for (const { path, html } of pages) {
      const keys = compareKeys(html).length;
      // Count the rendered BUTTONS, not the script's own selector strings.
      const toggles = [...html.matchAll(/class="compare-toggle"/g)].length;
      expect(toggles, path).toBe(keys);
    }
  });

  it('renders the tray, and its comparability caveat, on those pages', () => {
    for (const { path, html } of pages) {
      expect(html, path).toContain('data-compare-tray');
      expect(html, path).toMatch(/not freely comparable/i);
    }
  });
});

describe('compare tray does not become a third renderer', () => {
  // Slice 1 set the rule: markGeometry is the only place geometry is computed.
  // The tray CLONES the SVG the card already rendered. If this file ever grows
  // its own axis math, two renderers become three and they will drift.
  it('computes no geometry of its own', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/CompareTray.astro'), 'utf-8');
    expect(src).toContain('cloneNode');
    expect(src).not.toMatch(/Math\.log\(/);
    // A CALL, not the word — the header comment names markGeometry to explain
    // precisely why this file must never invoke it.
    expect(src).not.toMatch(/markGeometry\s*\(/);
  });

  it('never persists a selection that its clone source would outlive', () => {
    // Cloning needs the source cards present, so a stored selection would come
    // back on a page whose cards do not exist.
    const src = readFileSync(resolve(process.cwd(), 'src/components/CompareTray.astro'), 'utf-8');
    expect(src).not.toContain('localStorage');
    expect(src).not.toContain('sessionStorage');
  });

  // Card opacity is the SpecialtyBar's channel. Blocking an incomparable study
  // must happen on the button, so a dimmed card never means two things.
  it('blocks incomparable studies by disabling the control, not dimming the card', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/CompareTray.astro'), 'utf-8');
    expect(src).toContain("setAttribute('disabled'");
    expect(src).not.toMatch(/style\.opacity|classList\.add\(['"]dim/);
  });
});
