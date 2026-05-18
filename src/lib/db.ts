import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

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
`;

export function openDb(path: string = process.env.DB_PATH || './oncbrain.db'): Database.Database {
  const isNew = !existsSync(path) && path !== ':memory:';
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if (!isNew) detectAndGuardOldSchema(db);
  migrateAddTweetHtml(db);
  return db;
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
    INSERT INTO bookmarks (url, bookmark_date, conference_slug, author_handle, author_name, tweet_text, tweet_html, image_urls, notes, fetched_via, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
