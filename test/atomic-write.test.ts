// A torn write is not a hypothetical here. The digest artifact and the override
// sidecars are read back by other processes mid-run, and both fail in a
// direction that quietly removes safety: an unparseable sidecar reads as "no
// overrides", so suppressions stop applying; an unparseable artifact reads as
// "no prior coverage", which is the input state that makes lineage treat a
// returning trial as brand new.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/lib/atomic-write.ts';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oncbrain-atomic-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the file', () => {
    const p = join(dir, 'a.json');
    writeFileAtomic(p, '{"x":1}\n');
    expect(readFileSync(p, 'utf8')).toBe('{"x":1}\n');
  });

  it('replaces an existing file', () => {
    const p = join(dir, 'a.json');
    writeFileSync(p, 'old');
    writeFileAtomic(p, 'new');
    expect(readFileSync(p, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind', () => {
    // data/digests is enumerated by getStaticPaths and data/overrides by the
    // build; a stray sibling would be picked up as a date.
    writeFileAtomic(join(dir, '2026-07-08.json'), '{}');
    expect(readdirSync(dir)).toEqual(['2026-07-08.json']);
  });

  it('cleans up the temp file when the write fails', () => {
    // A directory where the target path expects a file: the rename fails.
    const p = join(dir, 'target');
    mkdirSync(p);
    expect(() => writeFileAtomic(p, 'x')).toThrow();
    expect(readdirSync(dir)).toEqual(['target']);
  });

  it('never exposes a partial file under the real name', () => {
    // The invariant that matters: at every point the target path either does not
    // exist or holds a complete, parseable document — never a prefix of one.
    const p = join(dir, 'artifact.json');
    const big = JSON.stringify({ digest: { sites: Array.from({ length: 500 }, (_, i) => ({ i })) } });
    writeFileAtomic(p, big);
    expect(() => JSON.parse(readFileSync(p, 'utf8'))).not.toThrow();
    expect(existsSync(p)).toBe(true);
  });
});

// EVERY writer of these two file classes, not just the one that got the fix.
//
// v0.56.1 made saveOverrides and the builder's artifact write atomic and left
// three other writers of the SAME two file classes on a plain writeFileSync:
// `npm run override` (the curator's primary way to suppress a card) and both
// digest backfills. That is the sixth instance of securing a mechanism and
// leaving another caller open, so it gets an invariant rather than three fixes.
describe('no module writes an override sidecar or digest artifact non-atomically', () => {
  const FILES = [
    'src/lib/digest-overrides.ts',
    'build/digest-builder.ts',
    'build/manage-overrides.ts',
    'build/backfill-pdf-abstracts.ts',
    'build/backfill-source-url.ts',
  ];

  it('uses writeFileAtomic in every module that persists one', () => {
    for (const f of FILES) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, `${f} should import writeFileAtomic`).toContain('atomic-write.ts');
      // A bare writeFileSync in one of these modules is the regression.
      const bare = src.split('\n').filter((l) => /\bwriteFileSync\s*\(/.test(l));
      expect(bare, `${f} still writes with plain writeFileSync: ${bare.join(' | ')}`).toEqual([]);
    }
  });

  it('leaves no module importing writeFileSync without using it', () => {
    // The dead import that hid a missing writeFileAtomic import behind a
    // still-compiling file.
    for (const f of FILES) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      if (/import \{[^}]*\bwriteFileSync\b/.test(src)) {
        expect(/\bwriteFileSync\s*\(/.test(src), `${f} imports writeFileSync but never calls it`).toBe(true);
      }
    }
  });
});
