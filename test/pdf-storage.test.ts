import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { isPdfBuffer, filePdfToVault, filePdfUnfiled, PAPERS_ROOT } from '../src/lib/pdf-storage.ts';

describe('isPdfBuffer', () => {
  it('accepts %PDF- magic bytes', () => {
    expect(isPdfBuffer(Buffer.from('%PDF-1.7\n%âãÏÓ'))).toBe(true);
  });
  it('rejects non-PDF bytes', () => {
    expect(isPdfBuffer(Buffer.from('PK\x03\x04zip'))).toBe(false);
    expect(isPdfBuffer(Buffer.from(''))).toBe(false);
    expect(isPdfBuffer(Buffer.from('not a pdf'))).toBe(false);
  });
});

describe('filePdfToVault', () => {
  const created: string[] = [];
  afterAll(() => {
    for (const p of created) {
      try {
        rmSync(p, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('files under papers/<site>/<slug>.pdf and returns a repo-relative path', () => {
    const buf = Buffer.from('%PDF-1.4 sample bytes');
    const r = filePdfToVault({ buffer: buf, site: 'prostate', slug: 'prestige-psma' });
    created.push(r.absPath);
    expect(r.relPath).toBe('data/obsidian/papers/prostate/prestige-psma.pdf');
    expect(r.absPath.startsWith(PAPERS_ROOT + '/')).toBe(true);
    expect(readFileSync(r.absPath)).toEqual(buf);
  });

  it('falls back to _unsorted when the site sanitizes to empty', () => {
    const r1 = filePdfToVault({ buffer: Buffer.from('%PDF-'), site: null, slug: 'a' });
    const r2 = filePdfToVault({ buffer: Buffer.from('%PDF-'), site: '...', slug: 'b' });
    created.push(r1.absPath, r2.absPath);
    expect(r1.relPath).toBe('data/obsidian/papers/_unsorted/a.pdf');
    expect(r2.relPath).toBe('data/obsidian/papers/_unsorted/b.pdf');
  });

  it('rejects a slug that sanitizes to nothing (path-safety)', () => {
    expect(() => filePdfToVault({ buffer: Buffer.from('%PDF-'), site: 'prostate', slug: '!!!' })).toThrow(
      /unsafe pdf slug/,
    );
  });

  it('sanitizes traversal characters out of the slug rather than escaping root', () => {
    const r = filePdfToVault({ buffer: Buffer.from('%PDF-'), site: 'kidney', slug: '../escape' });
    created.push(r.absPath);
    // ".." and "/" are stripped → "escape", staying under PAPERS_ROOT.
    expect(r.relPath).toBe('data/obsidian/papers/kidney/escape.pdf');
    expect(r.absPath.startsWith(PAPERS_ROOT + '/')).toBe(true);
  });

  it('filePdfUnfiled writes under _unsorted keyed by content hash', () => {
    const r = filePdfUnfiled({ buffer: Buffer.from('%PDF-'), contentHash: 'abcdef0123456789' });
    created.push(r.absPath);
    expect(r.relPath).toContain('data/obsidian/papers/_unsorted/');
    expect(r.relPath).toContain('abcdef0123456789');
  });
});
