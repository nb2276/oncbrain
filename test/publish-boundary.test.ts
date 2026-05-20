import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The load-bearing IP constraint (v0.8 PR2): filed full-text PDFs are
// LOCAL-ONLY. Three locks guarantee they never reach git or DigitalOcean:
//   1. data/obsidian/papers/ is gitignored.
//   2. There is NO public/ symlink into the papers vault (so they never enter
//      the Astro build — unlike public/slides, which exists for slide preview).
//   3. The renderer only links the PDF inside the local Obsidian note, never
//      on the public site (covered by obsidian-export tests).
// This file asserts locks 1 and 2 structurally so a future change can't
// silently start publishing copyrighted PDFs.
describe('PDF publish boundary', () => {
  const root = resolve(process.cwd());

  it('gitignores data/obsidian/papers/', () => {
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf-8');
    expect(gitignore).toMatch(/^data\/obsidian\/papers\/?$/m);
  });

  it('keeps the daily .md notes committable (only the papers/ subtree is ignored)', () => {
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf-8');
    // A blanket data/obsidian/ ignore would also hide the public-safe daily
    // notes. Guard against that regression.
    expect(gitignore).not.toMatch(/^data\/obsidian\/?$/m);
  });

  it('has no public/ path that exposes the papers vault to the Astro build', () => {
    for (const candidate of ['public/papers', 'public/obsidian']) {
      expect(existsSync(resolve(root, candidate))).toBe(false);
    }
  });
});
