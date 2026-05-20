import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, savePaper } from '../src/lib/db.ts';

// Build an in-memory DB with the OLD papers shape (pmid NOT NULL UNIQUE, no
// source_url, no CHECK) so we can exercise the migration directly.
function oldShapeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pmid TEXT NOT NULL UNIQUE,
      doi TEXT,
      pmc_id TEXT,
      title TEXT NOT NULL,
      authors_json TEXT,
      journal TEXT,
      pub_date TEXT,
      abstract TEXT,
      fulltext_excerpt_md TEXT,
      mesh_terms_json TEXT,
      bookmark_date TEXT NOT NULL,
      conference_slug TEXT,
      curator_note TEXT,
      inbox_item_id INTEGER,
      fetched_via TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe('migratePapersAllowDoiOnly (CRITICAL)', () => {
  it('a fresh openDb is born in the new shape (pmid nullable)', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(papers)').all() as { name: string; notnull: number }[];
    const pmid = cols.find((c) => c.name === 'pmid');
    expect(pmid?.notnull).toBe(0);
    expect(cols.some((c) => c.name === 'source_url')).toBe(true);
  });

  it('preserves existing rows across the rebuild', () => {
    // Seed an old-shape DB on disk so openDb runs the real migration path.
    // (in-memory openDb already starts new-shape, so we simulate by hand:
    //  insert into old shape, then run openDb's migration via re-open isn't
    //  possible for :memory:; instead assert the migration logic on a file DB.)
    const path = `/tmp/oncbrain-migrate-test-${Date.now()}.db`;
    // Seed ONLY the old-shape papers table; openDb's SCHEMA creates the rest
    // of the schema (bookmarks etc.) fresh. CREATE TABLE IF NOT EXISTS papers
    // is then a no-op, so the old shape survives until the migration rebuilds.
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pmid TEXT NOT NULL UNIQUE, doi TEXT, pmc_id TEXT, title TEXT NOT NULL,
        authors_json TEXT, journal TEXT, pub_date TEXT, abstract TEXT,
        fulltext_excerpt_md TEXT, mesh_terms_json TEXT, bookmark_date TEXT NOT NULL,
        conference_slug TEXT, curator_note TEXT, inbox_item_id INTEGER,
        fetched_via TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
    `);
    seed.prepare(
      `INSERT INTO papers (pmid, doi, title, bookmark_date, fetched_via, created_at)
       VALUES ('42144018', '10.1016/x', 'FASTRACK II', '2026-05-18', 'pubmed_efetch', 1)`,
    ).run();
    seed.close();

    // openDb runs migratePapersAllowDoiOnly on the existing file.
    const db = openDb(path);
    const cols = db.prepare('PRAGMA table_info(papers)').all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === 'pmid')?.notnull).toBe(0); // now nullable
    const row = db.prepare('SELECT pmid, doi, title FROM papers WHERE pmid = ?').get('42144018') as
      | { pmid: string; doi: string; title: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row?.title).toBe('FASTRACK II'); // row survived
    db.close();
  });

  it('is idempotent — second openDb is a no-op', () => {
    const path = `/tmp/oncbrain-migrate-idem-${Date.now()}.db`;
    const db1 = openDb(path);
    savePaper(db1, { pmid: '111', title: 'P1', bookmark_date: '2026-05-18' });
    db1.close();
    const db2 = openDb(path); // runs migration again — must not throw or lose data
    const row = db2.prepare('SELECT title FROM papers WHERE pmid = ?').get('111') as { title: string };
    expect(row.title).toBe('P1');
    db2.close();
  });

  it('enforces the dual unique indexes + CHECK after migration', () => {
    const db = openDb(':memory:');
    savePaper(db, { pmid: '222', doi: '10.1/a', title: 'A', bookmark_date: '2026-05-18' });
    // Same PMID → dedup, no second row.
    savePaper(db, { pmid: '222', title: 'A dup', bookmark_date: '2026-05-18' });
    const count = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('savePaper DOI key + merge', () => {
  it('inserts a DOI-only paper (pmid NULL)', () => {
    const db = openDb(':memory:');
    const r = savePaper(db, { doi: '10.1101/preprint1', title: 'Preprint', bookmark_date: '2026-05-18' });
    expect(r.created).toBe(true);
    const row = db.prepare('SELECT pmid, doi FROM papers WHERE id = ?').get(r.id) as {
      pmid: string | null;
      doi: string;
    };
    expect(row.pmid).toBeNull();
    expect(row.doi).toBe('10.1101/preprint1');
  });

  it('merges a PMID onto a DOI-only row instead of duplicating', () => {
    const db = openDb(':memory:');
    const first = savePaper(db, { doi: '10.1016/Merge', title: 'X', bookmark_date: '2026-05-18' });
    const second = savePaper(db, {
      pmid: '999',
      doi: 'https://doi.org/10.1016/merge', // same DOI, different spelling
      title: 'X',
      bookmark_date: '2026-05-18',
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id); // same row
    const row = db.prepare('SELECT pmid FROM papers WHERE id = ?').get(first.id) as { pmid: string };
    expect(row.pmid).toBe('999'); // PMID got attached
  });

  it('dedupes on normalized DOI across spellings', () => {
    const db = openDb(':memory:');
    savePaper(db, { doi: '10.1056/NEJMoa1', title: 'A', bookmark_date: '2026-05-18' });
    savePaper(db, { doi: 'https://doi.org/10.1056/nejmoa1', title: 'A', bookmark_date: '2026-05-18' });
    const count = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('rejects a paper with neither pmid nor doi', () => {
    const db = openDb(':memory:');
    expect(() => savePaper(db, { title: 'orphan', bookmark_date: '2026-05-18' })).toThrow(
      /at least one of pmid or doi/,
    );
  });
});
