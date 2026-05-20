import Database from 'better-sqlite3';
import { existsSync, copyFileSync } from 'node:fs';
import { normalizeDoi } from './doi.ts';

export type Bookmark = {
  id: number;
  url: string;
  bookmark_date: string; // YYYY-MM-DD
  conference_slug: string | null;
  author_handle: string | null;
  author_name: string | null;
  tweet_text: string | null;
  tweet_html: string | null; // raw oEmbed blockquote — fed to Twitter widgets.js for image-rich rendering
  image_urls: string | null; // JSON-stringified array
  image_ocr_texts: string | null; // JSON-stringified array of OCR strings, aligned to image_urls index. v0.4+.
  notes: string | null;
  fetched_via: 'oembed' | 'manual' | 'pending';
  created_at: number;
};

export type NewBookmark = {
  url: string;
  bookmark_date: string; // YYYY-MM-DD
  conference_slug?: string | null;
  author_handle?: string | null;
  author_name?: string | null;
  tweet_text?: string | null;
  tweet_html?: string | null;
  image_urls?: string[] | null;
  image_ocr_texts?: string[] | null;
  notes?: string | null;
  fetched_via?: 'oembed' | 'manual' | 'pending';
};

export type Conference = {
  slug: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  hashtag: string | null;
};

export type BookmarkListFilter = {
  bookmark_date?: string; // exact YYYY-MM-DD
  conference_slug?: string;
  date_from?: string; // YYYY-MM-DD inclusive
  date_to?: string; // YYYY-MM-DD inclusive
};

// v0.5: inbox-first ingestion. Telegram puller writes here immediately on
// receipt; enrichment runs separately and writes to bookmarks/papers/slides.
// One row per identifiable target (tweet URL, paper PMID/URL, image attachment),
// NOT one row per Telegram message — a single message with 2 URLs + 1 photo
// produces 3 rows, each enrichable independently. The UNIQUE constraint
// (telegram_msg_id, type, raw_target) keeps re-runs idempotent.
export type InboxItem = {
  id: number;
  type: 'tweet' | 'paper' | 'slide';
  raw_target: string; // tweet/paper URL, or slide file_id from Telegram getFile
  raw_message_text: string | null; // full message text for curator-note extraction
  attachments_json: string | null; // JSON: any additional metadata (paper PMID, slide mime, etc.)
  telegram_msg_id: number;
  telegram_chat_id: number | null;
  source_batch_key: string | null; // groups items from one Telegram message (e.g., multi-photo)
  received_at: number; // unix ms
  bookmark_date: string; // YYYY-MM-DD local at message receipt
  enrichment_status: 'pending' | 'enriched' | 'failed' | 'failed_permanent' | 'deferred';
  enrichment_attempts: number;
  enrichment_attempted_at: number | null;
  enrichment_error: string | null;
  enriched_row_id: number | null;
  created_at: number;
};

export type NewInboxItem = {
  type: 'tweet' | 'paper' | 'slide';
  raw_target: string;
  raw_message_text?: string | null;
  attachments_json?: string | null;
  telegram_msg_id: number;
  telegram_chat_id?: number | null;
  source_batch_key?: string | null;
  bookmark_date: string;
};

// v0.5 Phase B: PubMed paper metadata. Stored alongside bookmarks. The
// build pipeline picks these up in Phase D when DigestInputItem becomes
// a union. Until then, papers accumulate but aren't rendered.
// v0.8 PR2: papers may also enter via PDF. content_hash (sha256 of the PDF
// bytes) is a third dedup key so an identifier-less PDF (author manuscript,
// old scanned paper predating DOIs) can still be stored; pdf_path records
// where the PDF was filed in the curator's gitignored Obsidian vault.
export type FetchedVia =
  | 'pubmed_efetch'
  | 'crossref'
  | 'html_meta'
  | 'pdf' // PDF with a text layer
  | 'pdf_ocr' // scanned PDF, text recovered via Apple Vision OCR
  | 'pending'
  | 'failed';

export type Paper = {
  id: number;
  pmid: string | null; // v0.8: nullable — DOI-only papers have no PMID
  doi: string | null;
  pmc_id: string | null; // e.g., "PMC1234567"; nullable when no OA fulltext
  source_url: string | null; // v0.8: the URL the curator submitted (audit trail)
  content_hash: string | null; // v0.8 PR2: sha256 of PDF bytes; dedup key for identifier-less PDFs
  pdf_path: string | null; // v0.8 PR2: data/obsidian/papers/<site>/<slug>.pdf (gitignored, never published)
  title: string;
  authors_json: string | null; // JSON array of {name, affiliation?}
  journal: string | null;
  pub_date: string | null; // YYYY-MM-DD when known
  abstract: string | null;
  fulltext_excerpt_md: string | null; // section-filtered Methods + Results, ≤2000 tokens
  mesh_terms_json: string | null;
  bookmark_date: string;
  conference_slug: string | null;
  curator_note: string | null;
  inbox_item_id: number | null;
  fetched_via: FetchedVia;
  created_at: number;
};

export type NewPaper = {
  pmid?: string | null; // v0.8: nullable — at least one of pmid/doi/content_hash required
  doi?: string | null;
  pmc_id?: string | null;
  source_url?: string | null;
  content_hash?: string | null;
  pdf_path?: string | null;
  title: string;
  authors_json?: string | null;
  journal?: string | null;
  pub_date?: string | null;
  abstract?: string | null;
  fulltext_excerpt_md?: string | null;
  mesh_terms_json?: string | null;
  bookmark_date: string;
  conference_slug?: string | null;
  curator_note?: string | null;
  inbox_item_id?: number | null;
  fetched_via?: FetchedVia;
};

// v0.5 Phase C: slide photos uploaded via Telegram bot. Stored as files
// under data/slide-photos/<date>/<uuid>.<ext>; this table tracks metadata
// and OCR. Rendering moves to Phase E.
export type SlideUpload = {
  id: number;
  file_path: string; // data/slide-photos/YYYY-MM-DD/<uuid>.<ext>
  file_hash: string; // sha256 of bytes (used for cache invalidation)
  mime_type: string; // image/jpeg, image/png, etc.
  width: number | null;
  height: number | null;
  source_label: string | null; // curator-supplied: "ASCO Day 2 plenary"
  ocr_text: string | null;
  ocr_version: string | null;
  bookmark_date: string;
  conference_slug: string | null;
  curator_note: string | null;
  source_batch_key: string | null; // groups multi-photo from one Telegram message
  inbox_item_id: number | null;
  created_at: number;
};

export type NewSlideUpload = {
  file_path: string;
  file_hash: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  source_label?: string | null;
  ocr_text?: string | null;
  ocr_version?: string | null;
  bookmark_date: string;
  conference_slug?: string | null;
  curator_note?: string | null;
  source_batch_key?: string | null;
  inbox_item_id?: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  bookmark_date TEXT NOT NULL,
  conference_slug TEXT,
  author_handle TEXT,
  author_name TEXT,
  tweet_text TEXT,
  tweet_html TEXT,
  image_urls TEXT,
  image_ocr_texts TEXT,
  notes TEXT,
  fetched_via TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conferences (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  hashtag TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_date ON bookmarks(bookmark_date);
CREATE INDEX IF NOT EXISTS idx_bookmarks_conf ON bookmarks(conference_slug);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at);

-- v0.8: pmid is nullable (DOI-only papers exist). Uniqueness moved from an
-- inline pmid UNIQUE to partial unique indexes (pmid, lower(doi), content_hash),
-- and a CHECK guarantees at least one identifier. v0.8 PR2 adds content_hash
-- (a third key so identifier-less PDFs can be stored) + pdf_path (vault file
-- location). New DBs are born in this shape; existing DBs are rebuilt by
-- migratePapersAllowDoiOnly() then migratePapersAddPdfColumns().
CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pmid TEXT,
  doi TEXT,
  pmc_id TEXT,
  source_url TEXT,
  content_hash TEXT,
  pdf_path TEXT,
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
  created_at INTEGER NOT NULL,
  CHECK (pmid IS NOT NULL OR doi IS NOT NULL OR content_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_papers_date ON papers(bookmark_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_pmid ON papers(pmid) WHERE pmid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi ON papers(lower(doi)) WHERE doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_inbox ON papers(inbox_item_id);
-- NOTE: the content_hash unique index is created after migrations run (see
-- openDb), not here — an old-shape papers table predates the content_hash
-- column, so SCHEMA's CREATE INDEX would fail on "no such column" before
-- migratePapersAddPdfColumns gets a chance to add it.

CREATE TABLE IF NOT EXISTS slide_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL UNIQUE,
  file_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  source_label TEXT,
  ocr_text TEXT,
  ocr_version TEXT,
  bookmark_date TEXT NOT NULL,
  conference_slug TEXT,
  curator_note TEXT,
  source_batch_key TEXT,
  inbox_item_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slides_date ON slide_uploads(bookmark_date);
CREATE INDEX IF NOT EXISTS idx_slides_inbox ON slide_uploads(inbox_item_id);
CREATE INDEX IF NOT EXISTS idx_slides_hash ON slide_uploads(file_hash);
CREATE INDEX IF NOT EXISTS idx_slides_batch ON slide_uploads(source_batch_key);

CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  raw_target TEXT NOT NULL,
  raw_message_text TEXT,
  attachments_json TEXT,
  telegram_msg_id INTEGER NOT NULL,
  telegram_chat_id INTEGER,
  source_batch_key TEXT,
  received_at INTEGER NOT NULL,
  bookmark_date TEXT NOT NULL,
  enrichment_status TEXT NOT NULL DEFAULT 'pending',
  enrichment_attempts INTEGER NOT NULL DEFAULT 0,
  enrichment_attempted_at INTEGER,
  enrichment_error TEXT,
  enriched_row_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(telegram_msg_id, type, raw_target)
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_inbox_date ON inbox_items(bookmark_date);
CREATE INDEX IF NOT EXISTS idx_inbox_msg ON inbox_items(telegram_msg_id);
`;

export function openDb(path: string = process.env.DB_PATH || './oncbrain.db'): Database.Database {
  const isNew = !existsSync(path) && path !== ':memory:';
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if (!isNew) detectAndGuardOldSchema(db);
  migrateAddTweetHtml(db);
  migrateAddImageOcrTexts(db);
  migratePapersAllowDoiOnly(db, path);
  migratePapersAddPdfColumns(db, path);
  // content_hash column is guaranteed to exist now (fresh SCHEMA or migration);
  // create its partial unique index here rather than in SCHEMA so an old-shape
  // DB doesn't error on the missing column before the migration runs.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_content_hash ON papers(content_hash) WHERE content_hash IS NOT NULL;',
  );
  return db;
}

// v0.8 PR2: PDF ingestion needs two new papers columns and a relaxed CHECK:
//   - content_hash: sha256 of the PDF bytes — a third dedup key so an
//     identifier-less PDF (author manuscript, scanned pre-DOI paper) can be
//     stored. CHECK becomes (pmid OR doi OR content_hash).
//   - pdf_path: where the PDF was filed in the curator's Obsidian vault.
//
// Relaxing the CHECK and adding a partial unique index require a table
// rebuild (SQLite can't ALTER a CHECK in place). Detection: the table lacks
// a content_hash column. Idempotent: once rebuilt, the column exists so it
// no-ops. Runs AFTER migratePapersAllowDoiOnly so a legacy DB upgrades
// original → nullable-pmid → +pdf-columns; a backup is written once per day
// without clobbering the earlier migration's same-day backup.
function migratePapersAddPdfColumns(db: Database.Database, dbPath: string): void {
  const cols = db.prepare('PRAGMA table_info(papers)').all() as { name: string }[];
  if (cols.length === 0) return; // table absent (shouldn't happen after SCHEMA)
  if (cols.some((c) => c.name === 'content_hash')) return; // already migrated

  // Back up before a destructive rebuild, but don't overwrite a backup the
  // earlier migration already wrote today (that one captures the older shape).
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    const stamp = new Date().toISOString().slice(0, 10);
    const backup = `${dbPath}.bak-${stamp}`;
    if (!existsSync(backup)) {
      try {
        copyFileSync(dbPath, backup);
      } catch {
        // Backup is best-effort; the rebuild itself is transactional.
      }
    }
  }

  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE papers_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pmid TEXT,
        doi TEXT,
        pmc_id TEXT,
        source_url TEXT,
        content_hash TEXT,
        pdf_path TEXT,
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
        created_at INTEGER NOT NULL,
        CHECK (pmid IS NOT NULL OR doi IS NOT NULL OR content_hash IS NOT NULL)
      );
      INSERT INTO papers_new
        (id, pmid, doi, pmc_id, source_url, content_hash, pdf_path, title,
         authors_json, journal, pub_date, abstract, fulltext_excerpt_md,
         mesh_terms_json, bookmark_date, conference_slug, curator_note,
         inbox_item_id, fetched_via, created_at)
      SELECT
        id, pmid, doi, pmc_id, source_url, NULL, NULL, title,
        authors_json, journal, pub_date, abstract, fulltext_excerpt_md,
        mesh_terms_json, bookmark_date, conference_slug, curator_note,
        inbox_item_id, fetched_via, created_at
      FROM papers;
      DROP TABLE papers;
      ALTER TABLE papers_new RENAME TO papers;
      CREATE INDEX idx_papers_date ON papers(bookmark_date);
      CREATE INDEX idx_papers_inbox ON papers(inbox_item_id);
      CREATE UNIQUE INDEX idx_papers_pmid ON papers(pmid) WHERE pmid IS NOT NULL;
      CREATE UNIQUE INDEX idx_papers_doi ON papers(lower(doi)) WHERE doi IS NOT NULL;
      CREATE UNIQUE INDEX idx_papers_content_hash ON papers(content_hash) WHERE content_hash IS NOT NULL;
    `);
  });
  tx();
}

// v0.8: the papers table moves from `pmid TEXT NOT NULL UNIQUE` to a
// nullable pmid + partial unique indexes on pmid and lower(doi) + a CHECK,
// so DOI-only papers (preprints, non-MEDLINE journals) can be stored.
//
// SQLite can't ALTER away NOT NULL/UNIQUE in place, so this is a table
// rebuild (the documented SQLite procedure). Detection: the old table has
// pmid with notnull=1. Idempotent: once rebuilt, pmid notnull=0 so it
// no-ops. A backup is written first because DROP TABLE is destructive and
// the DB holds the only copy of un-built source data.
//
// No SQL foreign keys reference papers (inbox_item_id is a plain column), so
// there's no cascade dance — but we still wrap the rebuild in a transaction.
function migratePapersAllowDoiOnly(db: Database.Database, dbPath: string): void {
  const cols = db.prepare('PRAGMA table_info(papers)').all() as {
    name: string;
    notnull: number;
  }[];
  const pmidCol = cols.find((c) => c.name === 'pmid');
  // Already migrated (pmid nullable) or table somehow absent → nothing to do.
  if (!pmidCol || pmidCol.notnull === 0) return;

  // Back up the DB before a destructive rebuild (skip for in-memory tests).
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      copyFileSync(dbPath, `${dbPath}.bak-${stamp}`);
    } catch {
      // Backup is best-effort; the rebuild itself is transactional.
    }
  }

  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE papers_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pmid TEXT,
        doi TEXT,
        pmc_id TEXT,
        source_url TEXT,
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
        created_at INTEGER NOT NULL,
        CHECK (pmid IS NOT NULL OR doi IS NOT NULL)
      );
      INSERT INTO papers_new
        (id, pmid, doi, pmc_id, source_url, title, authors_json, journal,
         pub_date, abstract, fulltext_excerpt_md, mesh_terms_json,
         bookmark_date, conference_slug, curator_note, inbox_item_id,
         fetched_via, created_at)
      SELECT
        id, pmid, doi, pmc_id, NULL, title, authors_json, journal,
        pub_date, abstract, fulltext_excerpt_md, mesh_terms_json,
        bookmark_date, conference_slug, curator_note, inbox_item_id,
        fetched_via, created_at
      FROM papers;
      DROP TABLE papers;
      ALTER TABLE papers_new RENAME TO papers;
      CREATE INDEX idx_papers_date ON papers(bookmark_date);
      CREATE INDEX idx_papers_inbox ON papers(inbox_item_id);
      CREATE UNIQUE INDEX idx_papers_pmid ON papers(pmid) WHERE pmid IS NOT NULL;
      CREATE UNIQUE INDEX idx_papers_doi ON papers(lower(doi)) WHERE doi IS NOT NULL;
    `);
  });
  tx();
}

// Non-destructive ALTER for v0.2.0: existing oncbrain.db files predate the
// tweet_html column. SQLite ALTER TABLE ADD COLUMN is idempotent only via the
// PRAGMA check — calling it twice errors. Skip silently if the column is
// already there.
function migrateAddTweetHtml(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(bookmarks)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'tweet_html')) {
    db.exec('ALTER TABLE bookmarks ADD COLUMN tweet_html TEXT');
  }
}

// Non-destructive ALTER for v0.4.0: image_ocr_texts holds Apple Vision OCR
// output per image, aligned to image_urls. Same idempotency pattern.
function migrateAddImageOcrTexts(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(bookmarks)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'image_ocr_texts')) {
    db.exec('ALTER TABLE bookmarks ADD COLUMN image_ocr_texts TEXT');
  }
}

// The v1 schema had `day INTEGER NOT NULL` and `conference_slug NOT NULL`.
// v2 (this file) replaces them with `bookmark_date NOT NULL` and optional conference.
// If we open a DB that still has the v1 shape, fail loud rather than silently
// produce mixed-state rows. Since v1 was never deployed with real data, the
// expected fix is `rm oncbrain.db && restart`.
function detectAndGuardOldSchema(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(bookmarks)").all() as { name: string; notnull: number }[];
  const hasBookmarkDate = cols.some((c) => c.name === 'bookmark_date');
  const hasOldDay = cols.some((c) => c.name === 'day');
  if (!hasBookmarkDate || hasOldDay) {
    throw new Error(
      'oncbrain.db has the v1 schema (day INT, conference_slug NOT NULL). ' +
        'No production migration path exists — delete oncbrain.db and re-add bookmarks. ' +
        '(rm oncbrain.db oncbrain.db-wal oncbrain.db-shm)',
    );
  }
}

// Today's date in YYYY-MM-DD form, in the local timezone (en-CA conveniently
// formats as YYYY-MM-DD). Used by callers that want to default new bookmarks
// to "today" — and must match the local-date assignment used by Telegram
// ingest (unixToLocalDate), otherwise the admin form's default date and
// pull:telegram's date assignment drift across midnight UTC.
export function todayIso(): string {
  return new Date().toLocaleDateString('en-CA');
}

export function saveBookmark(db: Database.Database, b: NewBookmark): { id: number; created: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.bookmark_date)) {
    throw new Error(`bookmark_date must be YYYY-MM-DD, got: ${b.bookmark_date}`);
  }

  const existing = db.prepare('SELECT id FROM bookmarks WHERE url = ?').get(b.url) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };

  const stmt = db.prepare(`
    INSERT INTO bookmarks (url, bookmark_date, conference_slug, author_handle, author_name, tweet_text, tweet_html, image_urls, image_ocr_texts, notes, fetched_via, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    b.url,
    b.bookmark_date,
    b.conference_slug ?? null,
    b.author_handle ?? null,
    b.author_name ?? null,
    b.tweet_text ?? null,
    b.tweet_html ?? null,
    b.image_urls ? JSON.stringify(b.image_urls) : null,
    b.image_ocr_texts ? JSON.stringify(b.image_ocr_texts) : null,
    b.notes ?? null,
    b.fetched_via ?? 'pending',
    Date.now(),
  );
  return { id: result.lastInsertRowid as number, created: true };
}

export function listBookmarks(db: Database.Database, filter: BookmarkListFilter = {}): Bookmark[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.bookmark_date) {
    where.push('bookmark_date = ?');
    params.push(filter.bookmark_date);
  }
  if (filter.conference_slug) {
    where.push('conference_slug = ?');
    params.push(filter.conference_slug);
  }
  if (filter.date_from) {
    where.push('bookmark_date >= ?');
    params.push(filter.date_from);
  }
  if (filter.date_to) {
    where.push('bookmark_date <= ?');
    params.push(filter.date_to);
  }
  const sql = `SELECT * FROM bookmarks${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY bookmark_date DESC, created_at DESC`;
  return db.prepare(sql).all(...params) as Bookmark[];
}

// Distinct dates that have at least one bookmark. Used by the homepage to
// enumerate which days need digest pages. Reverse-chronological.
export function listBookmarkDates(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT DISTINCT bookmark_date FROM bookmarks ORDER BY bookmark_date DESC')
    .all() as { bookmark_date: string }[];
  return rows.map((r) => r.bookmark_date);
}

// For a given date, which conference (if any) had ALL its bookmarks tagged?
// Used by the digest builder to attach a conference badge when the day is
// unambiguously about one meeting. Returns null when bookmarks span multiple
// conferences (or none).
export function dominantConferenceForDate(db: Database.Database, date: string): string | null {
  const rows = db
    .prepare('SELECT DISTINCT conference_slug FROM bookmarks WHERE bookmark_date = ? AND conference_slug IS NOT NULL')
    .all(date) as { conference_slug: string }[];
  if (rows.length !== 1) return null;
  return rows[0]!.conference_slug;
}

export function deleteBookmark(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateBookmarkFetched(
  db: Database.Database,
  id: number,
  data: {
    author_handle: string | null;
    author_name: string | null;
    tweet_text: string;
    tweet_html?: string | null;
    image_urls?: string[] | null;
  },
): void {
  // COALESCE patterns mean: if the new fetch didn't return a value, leave
  // any pre-existing column value in place rather than nulling it out.
  db.prepare(
    `UPDATE bookmarks
        SET author_handle = ?,
            author_name = ?,
            tweet_text = ?,
            tweet_html = COALESCE(?, tweet_html),
            image_urls = COALESCE(?, image_urls),
            fetched_via = ?
      WHERE id = ?`,
  ).run(
    data.author_handle,
    data.author_name,
    data.tweet_text,
    data.tweet_html ?? null,
    data.image_urls ? JSON.stringify(data.image_urls) : null,
    'oembed',
    id,
  );
}

// Separate update for OCR results because OCR happens AFTER the oEmbed
// fetch (sequentially in the builder), and we want re-OCR to be possible
// without re-fetching the tweet text.
// Stored shape: JSON-encoded `Array<{text, hash, version}>` aligned with
// image_urls. The caller is expected to pass OcrEntry-shaped objects; we
// don't enforce the shape here, just stringify.
export function updateBookmarkOcrTexts(
  db: Database.Database,
  id: number,
  entries: Array<{ text: string; hash: string; version: string }>,
): void {
  db.prepare(`UPDATE bookmarks SET image_ocr_texts = ? WHERE id = ?`).run(
    JSON.stringify(entries),
    id,
  );
}

export function upsertConference(db: Database.Database, c: Conference): void {
  db.prepare(`
    INSERT INTO conferences (slug, name, start_date, end_date, hashtag)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      hashtag = excluded.hashtag
  `).run(c.slug, c.name, c.start_date, c.end_date, c.hashtag);
}

export function listConferences(db: Database.Database): Conference[] {
  return db.prepare('SELECT * FROM conferences ORDER BY start_date DESC, slug ASC').all() as Conference[];
}

export function getConference(db: Database.Database, slug: string): Conference | undefined {
  return db.prepare('SELECT * FROM conferences WHERE slug = ?').get(slug) as Conference | undefined;
}

// Settings (key-value store) — used by ingestion sources to persist state like
// the Telegram getUpdates offset.

export function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

// Most-recent chat that DM'd the bot. Used by notify-curator to address the
// build-done message; the bot is single-curator in practice, so the latest
// inbox row's chat_id is the curator.
export function getCuratorChatId(db: Database.Database): number | null {
  const row = db
    .prepare(
      `SELECT telegram_chat_id FROM inbox_items
       WHERE telegram_chat_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { telegram_chat_id: number } | undefined;
  return row?.telegram_chat_id ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Inbox items (v0.5)
// ────────────────────────────────────────────────────────────────────────────

// Insert an inbox item. The UNIQUE(telegram_msg_id, type, raw_target) index
// makes re-runs idempotent — a duplicate insert returns the existing row's id.
// Returns {id, created} so the caller can log accurately.
export function saveInboxItem(
  db: Database.Database,
  item: NewInboxItem,
): { id: number; created: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.bookmark_date)) {
    throw new Error(`bookmark_date must be YYYY-MM-DD, got: ${item.bookmark_date}`);
  }
  // INSERT OR IGNORE returns 0 changes when the UNIQUE constraint blocks the
  // insert. We then SELECT the existing row to return its id.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO inbox_items
       (type, raw_target, raw_message_text, attachments_json, telegram_msg_id,
        telegram_chat_id, source_batch_key, received_at, bookmark_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.type,
      item.raw_target,
      item.raw_message_text ?? null,
      item.attachments_json ?? null,
      item.telegram_msg_id,
      item.telegram_chat_id ?? null,
      item.source_batch_key ?? null,
      Date.now(),
      item.bookmark_date,
      Date.now(),
    );
  if (result.changes > 0) {
    return { id: result.lastInsertRowid as number, created: true };
  }
  const existing = db
    .prepare(
      `SELECT id FROM inbox_items
       WHERE telegram_msg_id = ? AND type = ? AND raw_target = ?`,
    )
    .get(item.telegram_msg_id, item.type, item.raw_target) as { id: number } | undefined;
  if (!existing) {
    // Shouldn't happen, but fail loud if it does.
    throw new Error(
      `INSERT OR IGNORE returned 0 changes but no existing row found for msg=${item.telegram_msg_id} type=${item.type}`,
    );
  }
  return { id: existing.id, created: false };
}

// List inbox items needing enrichment (pending or previously failed but not
// exhausted). max attempts default 5 — after that they need manual review.
// Optional type filter for per-type enrichment workers.
export function listInboxItemsForEnrichment(
  db: Database.Database,
  opts: { type?: InboxItem['type']; maxAttempts?: number } = {},
): InboxItem[] {
  const maxAttempts = opts.maxAttempts ?? 5;
  const conds = [
    "enrichment_status IN ('pending', 'failed')",
    'enrichment_attempts < ?',
  ];
  const params: (string | number)[] = [maxAttempts];
  if (opts.type) {
    conds.push('type = ?');
    params.push(opts.type);
  }
  return db
    .prepare(
      `SELECT * FROM inbox_items
       WHERE ${conds.join(' AND ')}
       ORDER BY received_at ASC, id ASC`,
    )
    .all(...params) as InboxItem[];
}

// Mark an inbox item as successfully enriched. Records the enriched row id
// (FK into bookmarks/papers/slides) so reverse lookups work later.
export function markInboxEnriched(
  db: Database.Database,
  id: number,
  enrichedRowId: number,
): void {
  db.prepare(
    `UPDATE inbox_items
        SET enrichment_status = 'enriched',
            enrichment_attempts = enrichment_attempts + 1,
            enrichment_attempted_at = ?,
            enrichment_error = NULL,
            enriched_row_id = ?
      WHERE id = ?`,
  ).run(Date.now(), enrichedRowId, id);
}

// Mark an inbox item as failed. Bumps attempt counter; the next list call
// excludes items past maxAttempts so the retry loop is bounded.
export function markInboxFailed(db: Database.Database, id: number, error: string): void {
  db.prepare(
    `UPDATE inbox_items
        SET enrichment_status = 'failed',
            enrichment_attempts = enrichment_attempts + 1,
            enrichment_attempted_at = ?,
            enrichment_error = ?
      WHERE id = ?`,
  ).run(Date.now(), error.slice(0, 500), id);
}

// Mark an inbox item PERMANENTLY failed — a non-retryable error (403 bot-block,
// unrecognized target, unreadable PDF). 'failed_permanent' is excluded from
// listInboxItemsForEnrichment, so the item isn't retried (and the curator isn't
// re-pinged the same failure) on every subsequent enrich run.
export function markInboxFailedPermanent(db: Database.Database, id: number, error: string): void {
  db.prepare(
    `UPDATE inbox_items
        SET enrichment_status = 'failed_permanent',
            enrichment_attempts = enrichment_attempts + 1,
            enrichment_attempted_at = ?,
            enrichment_error = ?
      WHERE id = ?`,
  ).run(Date.now(), error.slice(0, 500), id);
}

// ────────────────────────────────────────────────────────────────────────────
// Papers (v0.5 Phase B)
// ────────────────────────────────────────────────────────────────────────────

// v0.8: papers are keyed on PMID, normalized DOI, OR (PR2) content_hash.
// Dedup + merge against the first existing row matched (in that key order):
//   - attach a PMID / content_hash / pdf_path / full-text the existing row
//     lacks — e.g., a DOI-ingested paper later forwarded as a PDF gains its
//     content_hash + pdf_path + full text instead of duplicating
//   - else INSERT
// DOI normalization MUST go through normalizeDoi so the lookup matches the
// lower(doi) unique index (eng-review decision 3). PMID/content_hash attaches
// are guarded against colliding with a different row's unique index.
type PaperMatch = {
  id: number;
  pmid: string | null;
  content_hash: string | null;
  pdf_path: string | null;
  fulltext_excerpt_md: string | null;
};

export function savePaper(
  db: Database.Database,
  p: NewPaper,
): { id: number; created: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.bookmark_date)) {
    throw new Error(`bookmark_date must be YYYY-MM-DD, got: ${p.bookmark_date}`);
  }
  const pmid = p.pmid ?? null;
  const doi = normalizeDoi(p.doi);
  const contentHash = p.content_hash ?? null;
  if (!pmid && !doi && !contentHash) {
    throw new Error('savePaper requires at least one of pmid, doi, or content_hash');
  }

  const matchBy = (clause: string, value: string): PaperMatch | undefined =>
    db
      .prepare(
        `SELECT id, pmid, content_hash, pdf_path, fulltext_excerpt_md FROM papers WHERE ${clause}`,
      )
      .get(value) as PaperMatch | undefined;

  const existing =
    (pmid ? matchBy('pmid = ?', pmid) : undefined) ??
    (doi ? matchBy('lower(doi) = ?', doi) : undefined) ??
    (contentHash ? matchBy('content_hash = ?', contentHash) : undefined);

  if (existing) {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    // Guard unique-index columns: only attach if no different row holds the
    // value (a clash means two rows describe the same paper — leave both
    // rather than crash on the unique index; a rare manual-merge case).
    if (pmid && !existing.pmid && !matchBy('pmid = ?', pmid)) {
      sets.push('pmid = ?');
      vals.push(pmid);
    }
    if (contentHash && !existing.content_hash && !matchBy('content_hash = ?', contentHash)) {
      sets.push('content_hash = ?');
      vals.push(contentHash);
    }
    if (p.pdf_path && !existing.pdf_path) {
      sets.push('pdf_path = ?');
      vals.push(p.pdf_path);
    }
    if (p.fulltext_excerpt_md && !existing.fulltext_excerpt_md) {
      sets.push('fulltext_excerpt_md = ?');
      vals.push(p.fulltext_excerpt_md);
    }
    if (sets.length > 0) {
      vals.push(existing.id);
      db.prepare(`UPDATE papers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return { id: existing.id, created: false };
  }

  const result = db
    .prepare(
      `INSERT INTO papers
       (pmid, doi, pmc_id, source_url, content_hash, pdf_path, title, authors_json,
        journal, pub_date, abstract, fulltext_excerpt_md, mesh_terms_json,
        bookmark_date, conference_slug, curator_note, inbox_item_id, fetched_via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      pmid,
      doi,
      p.pmc_id ?? null,
      p.source_url ?? null,
      contentHash,
      p.pdf_path ?? null,
      p.title,
      p.authors_json ?? null,
      p.journal ?? null,
      p.pub_date ?? null,
      p.abstract ?? null,
      p.fulltext_excerpt_md ?? null,
      p.mesh_terms_json ?? null,
      p.bookmark_date,
      p.conference_slug ?? null,
      p.curator_note ?? null,
      p.inbox_item_id ?? null,
      p.fetched_via ?? 'pending',
      Date.now(),
    );
  return { id: result.lastInsertRowid as number, created: true };
}

export function listPapers(
  db: Database.Database,
  filter: { bookmark_date?: string } = {},
): Paper[] {
  if (filter.bookmark_date) {
    return db
      .prepare('SELECT * FROM papers WHERE bookmark_date = ? ORDER BY created_at DESC')
      .all(filter.bookmark_date) as Paper[];
  }
  return db.prepare('SELECT * FROM papers ORDER BY bookmark_date DESC, created_at DESC').all() as Paper[];
}

export function getPaperByPmid(db: Database.Database, pmid: string): Paper | undefined {
  return db.prepare('SELECT * FROM papers WHERE pmid = ?').get(pmid) as Paper | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Slide uploads (v0.5 Phase C)
// ────────────────────────────────────────────────────────────────────────────

export function saveSlideUpload(
  db: Database.Database,
  s: NewSlideUpload,
): { id: number; created: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.bookmark_date)) {
    throw new Error(`bookmark_date must be YYYY-MM-DD, got: ${s.bookmark_date}`);
  }
  const existing = db
    .prepare('SELECT id FROM slide_uploads WHERE file_path = ?')
    .get(s.file_path) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const result = db
    .prepare(
      `INSERT INTO slide_uploads
       (file_path, file_hash, mime_type, width, height, source_label, ocr_text,
        ocr_version, bookmark_date, conference_slug, curator_note,
        source_batch_key, inbox_item_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.file_path,
      s.file_hash,
      s.mime_type,
      s.width ?? null,
      s.height ?? null,
      s.source_label ?? null,
      s.ocr_text ?? null,
      s.ocr_version ?? null,
      s.bookmark_date,
      s.conference_slug ?? null,
      s.curator_note ?? null,
      s.source_batch_key ?? null,
      s.inbox_item_id ?? null,
      Date.now(),
    );
  return { id: result.lastInsertRowid as number, created: true };
}

export function listSlideUploads(
  db: Database.Database,
  filter: { bookmark_date?: string } = {},
): SlideUpload[] {
  if (filter.bookmark_date) {
    return db
      .prepare('SELECT * FROM slide_uploads WHERE bookmark_date = ? ORDER BY created_at ASC')
      .all(filter.bookmark_date) as SlideUpload[];
  }
  return db
    .prepare('SELECT * FROM slide_uploads ORDER BY bookmark_date DESC, created_at DESC')
    .all() as SlideUpload[];
}

export function countInboxByStatus(
  db: Database.Database,
): Record<InboxItem['enrichment_status'], number> {
  const rows = db
    .prepare('SELECT enrichment_status AS status, COUNT(*) AS n FROM inbox_items GROUP BY enrichment_status')
    .all() as { status: InboxItem['enrichment_status']; n: number }[];
  const out: Record<InboxItem['enrichment_status'], number> = {
    pending: 0,
    enriched: 0,
    failed: 0,
    failed_permanent: 0,
    deferred: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
