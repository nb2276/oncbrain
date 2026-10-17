import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { isPdfBuffer, filePdfToVault, filePdfUnfiled, PAPERS_ROOT, vaultBaseName, authorSurname } from '../src/lib/pdf-storage.ts';

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
    const r = filePdfToVault({ buffer: buf, site: 'prostate', name: 'prestige-psma' });
    created.push(r.absPath);
    expect(r.relPath).toBe('data/obsidian/papers/prostate/prestige-psma.pdf');
    expect(r.absPath.startsWith(PAPERS_ROOT + '/')).toBe(true);
    expect(readFileSync(r.absPath)).toEqual(buf);
  });

  it('falls back to _unsorted when the site sanitizes to empty', () => {
    const r1 = filePdfToVault({ buffer: Buffer.from('%PDF-'), site: null, name: 'a' });
    const r2 = filePdfToVault({ buffer: Buffer.from('%PDF-'), site: '...', name: 'b' });
    created.push(r1.absPath, r2.absPath);
    expect(r1.relPath).toBe('data/obsidian/papers/_unsorted/a.pdf');
    expect(r2.relPath).toBe('data/obsidian/papers/_unsorted/b.pdf');
  });

  it('rejects a slug that sanitizes to nothing (path-safety)', () => {
    expect(() => filePdfToVault({ buffer: Buffer.from('%PDF-'), site: 'prostate', name: '!!!' })).toThrow(
      /unsafe pdf slug/,
    );
  });

  it('sanitizes traversal characters out of the slug rather than escaping root', () => {
    const r = filePdfToVault({ buffer: Buffer.from('%PDF-'), site: 'kidney', name: '../escape' });
    created.push(r.absPath);
    // ".." and "/" are stripped → "escape", staying under PAPERS_ROOT.
    expect(r.relPath).toBe('data/obsidian/papers/kidney/escape.pdf');
    expect(r.absPath.startsWith(PAPERS_ROOT + '/')).toBe(true);
  });

  it('never overwrites a different PDF on a taken name; identical bytes reuse it', () => {
    const a = Buffer.from('%PDF-1.4 first paper');
    const b = Buffer.from('%PDF-1.4 a different paper, same title prefix');
    const r1 = filePdfToVault({ buffer: a, site: 'kidney', name: 'zz-test-collision' });
    const r2 = filePdfToVault({ buffer: b, site: 'kidney', name: 'zz-test-collision' });
    const r3 = filePdfToVault({ buffer: a, site: 'kidney', name: 'zz-test-collision' });
    created.push(r1.absPath, r2.absPath);
    expect(r1.relPath).toBe('data/obsidian/papers/kidney/zz-test-collision.pdf');
    expect(r2.relPath).toBe('data/obsidian/papers/kidney/zz-test-collision-2.pdf');
    expect(r3.relPath).toBe(r1.relPath);
    expect(readFileSync(r1.absPath)).toEqual(a);
  });

  it('filePdfUnfiled writes under _unsorted keyed by content hash', () => {
    const r = filePdfUnfiled({ buffer: Buffer.from('%PDF-'), contentHash: 'abcdef0123456789' });
    created.push(r.absPath);
    expect(r.relPath).toContain('data/obsidian/papers/_unsorted/');
    expect(r.relPath).toContain('abcdef0123456789');
  });
});

describe('vaultBaseName', () => {
  it('year, first author surname, short title cut at a word boundary', () => {
    expect(
      vaultBaseName({
        title: 'A close or positive margin after mastectomy is not an indication for chest wall irradiation except in women aged fifty or younger',
        authors: ['Gary Freedman', 'A. Fowble'],
        pubDate: '1998-07',
      }),
    ).toBe('1998-freedman-close-positive-margin-mastectomy-not-indication-chest');
  });
  it('omits missing parts and never cuts mid-word', () => {
    expect(vaultBaseName({ title: 'PORTEC-3: final results', authors: [], pubDate: null })).toBe('portec-3-final-results');
    expect(vaultBaseName({ title: null, authors: [], pubDate: null })).toBe('untitled');
  });
});

describe('authorSurname', () => {
  it('handles the shapes the metadata sources produce', () => {
    expect(authorSurname('Kaidar‐Person, Orit')).toBe('kaidarperson');
    expect(authorSurname('de Boniface, Jana')).toBe('deboniface');
    expect(authorSurname('T. S. Hong')).toBe('hong');
    expect(authorSurname('Anders W. Mølby Nielsen')).toBe('nielsen');
    expect(authorSurname('Hong TS')).toBe('hong');
    expect(authorSurname('for the EORTC Radiation Oncology Group')).toBeNull();
  });
});
