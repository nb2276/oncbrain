import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export default function setup() {
  if (!existsSync(`${root}/dist/pwa-sw.js`) || !existsSync(`${root}/dist/index.html`)) {
    console.log('[global-setup] dist/ build artifacts missing; running `npm run build` once before the suite (~30s)');
    // stderr passes through so a broken build is diagnosable from the test log.
    execSync('npm run build', { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
