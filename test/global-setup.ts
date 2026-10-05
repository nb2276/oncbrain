import { execSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Several test files assert against build artifacts in dist/ (pwa-build,
// publish-boundary, tag-filter-rail-drawer, pwa-routes). Before this setup
// existed, each file coped with a missing dist on its own and they disagreed:
// pwa-build built it in beforeAll (~30s, finishing long after the other files
// had already been collected), tag-filter-rail-drawer registered 6 failing
// placeholder tests at collection time, and publish-boundary silently returned
// (a vacuous pass on the IP-boundary guard). Net effect in a fresh checkout or
// worktree: the first `npm test` failed 6 tests and under-counted the suite,
// the second passed — a "cold-run flake" that was really a build-ordering gap.
//
// globalSetup runs once in the main process before any worker collects a test
// file, so building here (only when artifacts are absent) gives every entry
// point — full suite, single file, cold or warm — a complete dist to assert
// against. A warm run skips the build entirely.
const root = fileURLToPath(new URL('..', import.meta.url));

// Existence alone isn't enough: a dist built before a new digest landed, a
// branch switch, or a src/ edit is STALE, and the dist-reading tests then fail
// as if the code had regressed (pwa-build's latest-digest checks, the /tags/
// publish boundary). Rebuild when any build input is newer than the build.
const BUILD_INPUTS = ['src', 'public', 'data/digests', 'data/overrides', 'astro.config.ts', 'package.json'];

/** Newest mtime under `path`. Symlinks are not followed (public/slides → photo archive). */
export function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs; // a deleted file bumps its directory
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(`${path}/${name}`));
  return newest;
}

export function distIsStale(dir: string = root): boolean {
  const marker = `${dir}/dist/index.html`;
  if (!existsSync(`${dir}/dist/pwa-sw.js`) || !existsSync(marker)) return true;
  const builtAt = statSync(marker).mtimeMs;
  return BUILD_INPUTS.some((p) => newestMtime(`${dir}/${p}`) > builtAt);
}

export default function setup() {
  if (distIsStale()) {
    console.log('[global-setup] dist/ is missing or older than its inputs; running `npm run build` once before the suite (~30s)');
    // stderr passes through so a broken build is diagnosable from the test log.
    execSync('npm run build', { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
