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

// The OTHER door. Trial lineage grew an evidence gate for automatic
// suppression, and every guard sat upstream of executeDedupDrop — which wrote
// the override directly, so a `drop` reply reached the same destructive end with
// none of them applied. The two STRUCTURAL invariants now apply here too. (The
// evidence gate deliberately does not: a curator can see what the classifier
// cannot, and the machine's job is to make an honest offer, not to overrule.)
describe('executeDedupDrop enforces the structural guards', () => {
  let db: ReturnType<typeof openDb>;
  let dir: string;
  beforeEach(() => {
    db = openDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'oncbrain-drop-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const study = (slug: string, name: string, ids: number[], nct: string | null = null) => ({
    slug,
    name,
    nct,
    source_ids: ids.map((id) => ({ type: 'paper', id })),
  });
  const artifact = (...studies: ReturnType<typeof study>[]) => ({ digest: { sites: [{ studies }] } });

  it('REFUSES to remove a date’s last published card', () => {
    // An empty day leaves a headline describing studies the page no longer
    // renders. That is not a preference to override by replying to a DM.
    const r = executeDedupDrop(db, { date: '2026-07-08', slug: 'only' }, {
      lookupDigest: () => artifact(study('only', 'Only Card', [1])),
      overridesDir: dir,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/last card still published/);
    expect(existsSync(join(dir, '2026-07-08.json'))).toBe(false);
    expect(listRebuildQueue(db)).toHaveLength(0);
  });

  it('counts cards a previous override already hid', () => {
    writeFileSync(join(dir, '2026-07-08.json'), JSON.stringify({ suppress: ['b'] }));
    const r = executeDedupDrop(db, { date: '2026-07-08', slug: 'a' }, {
      lookupDigest: () => artifact(study('a', 'Card A', [1]), study('b', 'Card B', [2])),
      overridesDir: dir,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/last card still published/);
  });

  it('records the target’s identity so the override survives the rename it causes', () => {
    // Suppressing removes the card from the artifact, so the next rebuild cannot
    // hold its slug — and a vacated slug can be inherited by a sibling card, at
    // which point a slug-only override hides the wrong study.
    const r = executeDedupDrop(db, { date: '2026-07-09', slug: 'a' }, {
      lookupDigest: () => artifact(study('a', 'Card A', [44], 'NCT12345678'), study('b', 'Card B', [43])),
      overridesDir: dir,
    });
    expect(r.ok).toBe(true);
    const ov = JSON.parse(readFileSync(join(dir, '2026-07-09.json'), 'utf8'));
    expect(ov.suppress).toEqual(['a']);
    expect(ov.identity.a).toEqual({
      nct: 'NCT12345678',
      name: 'Card A',
      source_ids: [{ type: 'paper', id: 44 }],
    });
  });

  it('still drops normally when the date keeps other cards', () => {
    const r = executeDedupDrop(db, { date: '2026-07-09', slug: 'a' }, {
      lookupDigest: () => artifact(study('a', 'Card A', [1]), study('b', 'Card B', [2])),
      overridesDir: dir,
    });
    expect(r.ok).toBe(true);
    expect(listRebuildQueue(db)).toHaveLength(1);
  });
});
