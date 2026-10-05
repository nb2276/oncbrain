import { describe, it, expect, afterEach } from 'vitest';
import { lutimesSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { distIsStale } from './global-setup.ts';

// A dist older than its inputs made the dist-reading tests fail as if the
// code had regressed; the setup now rebuilds on staleness, not just absence.
describe('distIsStale', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds);
  function repo(): string {
    dir = mkdtempSync(`${tmpdir()}/dist-stale-`);
    for (const d of ['dist', 'src', 'public', 'data/digests']) mkdirSync(`${dir}/${d}`, { recursive: true });
    writeFileSync(`${dir}/src/a.ts`, '');
    writeFileSync(`${dir}/data/digests/2026-10-03.json`, '{}');
    for (const p of ['src/a.ts', 'data/digests/2026-10-03.json', 'src', 'public', 'data/digests']) at(`${dir}/${p}`, 1000);
    writeFileSync(`${dir}/dist/index.html`, '');
    writeFileSync(`${dir}/dist/pwa-sw.js`, '');
    at(`${dir}/dist/index.html`, 2000);
    return dir;
  }

  it('a dist newer than every input is fresh', () => {
    expect(distIsStale(repo())).toBe(false);
  });

  it('a missing service worker is stale', () => {
    const r = repo();
    rmSync(`${r}/dist/pwa-sw.js`);
    expect(distIsStale(r)).toBe(true);
  });

  it('a digest that landed after the build is stale', () => {
    const r = repo();
    at(`${r}/data/digests/2026-10-03.json`, 3000);
    expect(distIsStale(r)).toBe(true);
  });

  it('a symlinked archive under public/ is not followed', () => {
    const r = repo();
    mkdirSync(`${r}/photos`);
    writeFileSync(`${r}/photos/new.jpg`, ''); // mtime now, after the build
    symlinkSync(`${r}/photos`, `${r}/public/slides`);
    lutimesSync(`${r}/public/slides`, 1000, 1000);
    at(`${r}/public`, 1000);
    // A slide photo saved after the build is not a build input.
    expect(distIsStale(r)).toBe(false);
  });
});
