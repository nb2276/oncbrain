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
