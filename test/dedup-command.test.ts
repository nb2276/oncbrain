import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, listRebuildQueue } from '../src/lib/db.ts';
import { parseDedupCommand, executeDedupDrop } from '../src/lib/dedup-command.ts';

describe('parseDedupCommand', () => {
  it('parses "drop <date>/<slug>"', () => {
    expect(parseDedupCommand('drop 2026-05-17/radiosa')).toEqual({ date: '2026-05-17', slug: 'radiosa' });
  });

  it('accepts a space separator and is case-insensitive on the verb', () => {
    expect(parseDedupCommand('DROP 2026-05-17 radiosa')).toEqual({ date: '2026-05-17', slug: 'radiosa' });
    expect(parseDedupCommand('  drop   2026-05-17/peace-2  ')).toEqual({ date: '2026-05-17', slug: 'peace-2' });
  });

  it('returns null for ordinary chat and near-misses', () => {
    expect(parseDedupCommand('drop me a line')).toBeNull();
    expect(parseDedupCommand('please drop 2026-05-17/radiosa')).toBeNull(); // must lead with the verb
    expect(parseDedupCommand('drop 2026-5-17/radiosa')).toBeNull(); // malformed date
    expect(parseDedupCommand('https://x.com/a/status/1')).toBeNull();
    expect(parseDedupCommand('')).toBeNull();
    expect(parseDedupCommand(null)).toBeNull();
  });
});

describe('executeDedupDrop', () => {
  let db: Database.Database;
  let dir: string;
  const digest = {
    digest: { sites: [{ studies: [{ slug: 'radiosa', name: 'RADIOSA' }, { slug: 'other', name: 'OTHER' }] }] },
  };
  const lookupDigest = (date: string) => (date === '2026-05-17' ? digest : null);

  beforeEach(() => {
    db = openDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'oncbrain-ov-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a suppress override and queues a rebuild for a real study', () => {
    const r = executeDedupDrop(db, { date: '2026-05-17', slug: 'radiosa' }, { lookupDigest, overridesDir: dir });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('RADIOSA');

    const ov = JSON.parse(readFileSync(join(dir, '2026-05-17.json'), 'utf8'));
    expect(ov.suppress).toContain('radiosa');
    expect(listRebuildQueue(db).map((q) => q.bookmark_date)).toContain('2026-05-17');
  });

  it('rejects an unknown slug without writing anything', () => {
    const r = executeDedupDrop(db, { date: '2026-05-17', slug: 'nope' }, { lookupDigest, overridesDir: dir });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('nope');
    expect(existsSync(join(dir, '2026-05-17.json'))).toBe(false);
    expect(listRebuildQueue(db)).toHaveLength(0);
  });

  it('rejects a date with no published digest', () => {
    const r = executeDedupDrop(db, { date: '2020-01-01', slug: 'radiosa' }, { lookupDigest, overridesDir: dir });
    expect(r.ok).toBe(false);
    expect(listRebuildQueue(db)).toHaveLength(0);
  });

  it('rejects a malformed date/slug even if a caller bypasses the parser (defense in depth)', () => {
    const r = executeDedupDrop(
      db,
      { date: '../../etc', slug: 'radiosa' },
      { lookupDigest, overridesDir: dir },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Invalid');
    expect(listRebuildQueue(db)).toHaveLength(0);
  });

  it('tolerates a malformed pre-existing override file (non-array suppress)', () => {
    writeFileSync(join(dir, '2026-05-17.json'), JSON.stringify({ suppress: 'radiosa' }));
    const r = executeDedupDrop(db, { date: '2026-05-17', slug: 'radiosa' }, { lookupDigest, overridesDir: dir });
    expect(r.ok).toBe(true);
    const ov = JSON.parse(readFileSync(join(dir, '2026-05-17.json'), 'utf8'));
    // The bare string was discarded, not exploded into per-character entries.
    expect(ov.suppress).toEqual(['radiosa']);
  });

  it('is idempotent: a second drop re-queues but keeps one suppress entry', () => {
    const cmd = { date: '2026-05-17', slug: 'radiosa' } as const;
    executeDedupDrop(db, cmd, { lookupDigest, overridesDir: dir });
    const r2 = executeDedupDrop(db, cmd, { lookupDigest, overridesDir: dir });
    expect(r2.ok).toBe(true);
    expect(r2.message).toMatch(/[Aa]lready/);
    const ov = JSON.parse(readFileSync(join(dir, '2026-05-17.json'), 'utf8'));
    expect(ov.suppress.filter((s: string) => s === 'radiosa')).toHaveLength(1);
  });
});
