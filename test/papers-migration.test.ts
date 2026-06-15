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

  it('rejects a paper with neither pmid, doi, nor content_hash', () => {
    const db = openDb(':memory:');
    expect(() => savePaper(db, { title: 'orphan', bookmark_date: '2026-05-18' })).toThrow(
      /at least one of pmid, doi, or content_hash/,
    );
  });
});

describe('migratePapersAddPdfColumns (content_hash + pdf_path)', () => {
  it('a fresh openDb has content_hash + pdf_path columns', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(papers)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'content_hash')).toBe(true);
    expect(cols.some((c) => c.name === 'pdf_path')).toBe(true);
  });

  it('upgrades an ORIGINAL-shape DB through both migrations, preserving rows', () => {
    const path = `/tmp/oncbrain-pdfmig-${Date.now()}.db`;
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
    seed
      .prepare(
        `INSERT INTO papers (pmid, doi, title, bookmark_date, fetched_via, created_at)
         VALUES ('42144018', '10.1016/x', 'FASTRACK II', '2026-05-18', 'pubmed_efetch', 1)`,
      )
      .run();
    seed.close();

    const db = openDb(path); // runs allowDoiOnly THEN addPdfColumns
    const cols = db.prepare('PRAGMA table_info(papers)').all() as { name: string; notnull: number }[];
    expect(cols.some((c) => c.name === 'content_hash')).toBe(true);
    expect(cols.some((c) => c.name === 'pdf_path')).toBe(true);
    expect(cols.find((c) => c.name === 'pmid')?.notnull).toBe(0); // nullable
    const row = db.prepare('SELECT title FROM papers WHERE pmid = ?').get('42144018') as
      | { title: string }
      | undefined;
    expect(row?.title).toBe('FASTRACK II'); // row survived both rebuilds

    // Relaxed CHECK now accepts an identifier-less (content_hash-only) paper.
    const r = savePaper(db, {
      content_hash: 'deadbeef',
      title: 'Scanned manuscript',
      bookmark_date: '2026-05-18',
      fetched_via: 'pdf_ocr',
    });
    expect(r.created).toBe(true);
    db.close();
  });

  it('is idempotent — a second openDb is a no-op and preserves data', () => {
    const path = `/tmp/oncbrain-pdfmig-idem-${Date.now()}.db`;
    const db1 = openDb(path);
    savePaper(db1, { content_hash: 'h1', title: 'PDFOnly', bookmark_date: '2026-05-18' });
    db1.close();
    const db2 = openDb(path);
    const row = db2.prepare('SELECT title FROM papers WHERE content_hash = ?').get('h1') as {
      title: string;
    };
    expect(row.title).toBe('PDFOnly');
    db2.close();
  });

  it('carries figure_ocr_md forward through the rebuild (does not drop populated OCR)', () => {
    // Out-of-order / restored DB: old shape (no content_hash → triggers the
    // destructive rebuild) but WITH a populated figure_ocr_md. The rebuild used
    // to create papers_new without the column and silently lose the OCR.
    const path = `/tmp/oncbrain-figocr-${Date.now()}.db`;
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pmid TEXT NOT NULL UNIQUE, doi TEXT, pmc_id TEXT, title TEXT NOT NULL,
        authors_json TEXT, journal TEXT, pub_date TEXT, abstract TEXT,
        fulltext_excerpt_md TEXT, figure_ocr_md TEXT, mesh_terms_json TEXT,
        bookmark_date TEXT NOT NULL, conference_slug TEXT, curator_note TEXT,
        inbox_item_id INTEGER, fetched_via TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
    `);
    seed
      .prepare(
        `INSERT INTO papers (pmid, title, bookmark_date, figure_ocr_md, fetched_via, created_at)
         VALUES ('99999999', 'OCR paper', '2026-05-18', 'median OS 41.6 mo', 'pdf_ocr', 1)`,
      )
      .run();
    seed.close();

    const db = openDb(path); // runs allowDoiOnly THEN addPdfColumns
    const row = db.prepare('SELECT figure_ocr_md FROM papers WHERE pmid = ?').get('99999999') as
      | { figure_ocr_md: string | null }
      | undefined;
    expect(row?.figure_ocr_md).toBe('median OS 41.6 mo'); // preserved, not nulled
    db.close();
  });
});

describe('savePaper content_hash key + PDF merge', () => {
  it('inserts and dedupes a content-hash-only paper', () => {
    const db = openDb(':memory:');
    const r1 = savePaper(db, { content_hash: 'abc', title: 'A', bookmark_date: '2026-05-18' });
    expect(r1.created).toBe(true);
    const r2 = savePaper(db, { content_hash: 'abc', title: 'A again', bookmark_date: '2026-05-18' });
    expect(r2.created).toBe(false);
    expect(r2.id).toBe(r1.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('attaches content_hash + pdf_path + full text onto an existing DOI row', () => {
    const db = openDb(':memory:');
    const first = savePaper(db, {
      doi: '10.1056/merge',
      title: 'X',
      bookmark_date: '2026-05-18',
      fetched_via: 'crossref',
    });
    const second = savePaper(db, {
      doi: 'https://doi.org/10.1056/MERGE', // same paper, now as a PDF
      content_hash: 'pdfhash',
      pdf_path: 'data/obsidian/papers/prostate/x.pdf',
      fulltext_excerpt_md: 'Methods and Results full text',
      title: 'X',
      bookmark_date: '2026-05-18',
      fetched_via: 'pdf',
    });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    const row = db
      .prepare('SELECT content_hash, pdf_path, fulltext_excerpt_md FROM papers WHERE id = ?')
      .get(first.id) as { content_hash: string; pdf_path: string; fulltext_excerpt_md: string };
    expect(row.content_hash).toBe('pdfhash');
    expect(row.pdf_path).toContain('x.pdf');
    expect(row.fulltext_excerpt_md).toContain('Methods');
  });

  it('does not clobber an existing full-text excerpt on merge', () => {
    const db = openDb(':memory:');
    const first = savePaper(db, {
      doi: '10.1056/clobber',
      title: 'X',
      fulltext_excerpt_md: 'ORIGINAL',
      bookmark_date: '2026-05-18',
    });
    savePaper(db, {
      doi: '10.1056/clobber',
      fulltext_excerpt_md: 'NEWER',
      title: 'X',
      bookmark_date: '2026-05-18',
    });
    const row = db.prepare('SELECT fulltext_excerpt_md FROM papers WHERE id = ?').get(first.id) as {
      fulltext_excerpt_md: string;
    };
    expect(row.fulltext_excerpt_md).toBe('ORIGINAL');
  });
});
