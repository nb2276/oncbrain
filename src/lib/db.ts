import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

export type Bookmark = {
  id: number;
  url: string;
  conference_slug: string;
  day: number;
  author_handle: string | null;
  author_name: string | null;
  tweet_text: string | null;
  image_urls: string | null;
  notes: string | null;
  fetched_via: 'oembed' | 'manual' | 'pending';
  created_at: number;
};

export type NewBookmark = {
  url: string;
  conference_slug: string;
  day: number;
  author_handle?: string | null;
  author_name?: string | null;
  tweet_text?: string | null;
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  conference_slug TEXT NOT NULL,
  day INTEGER NOT NULL,
  author_handle TEXT,
  author_name TEXT,
  tweet_text TEXT,
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

CREATE INDEX IF NOT EXISTS idx_bookmarks_conf_day ON bookmarks(conference_slug, day);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at);
`;

export function openDb(path: string = process.env.DB_PATH || './oncbrain.db'): Database.Database {
  const isNew = !existsSync(path);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (isNew) db.exec(SCHEMA);
  else db.exec(SCHEMA); // idempotent IF NOT EXISTS
  return db;
}

export function saveBookmark(db: Database.Database, b: NewBookmark): { id: number; created: boolean } {
  const existing = db.prepare('SELECT id FROM bookmarks WHERE url = ?').get(b.url) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };

  const stmt = db.prepare(`
    INSERT INTO bookmarks (url, conference_slug, day, author_handle, author_name, tweet_text, image_urls, notes, fetched_via, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    b.url,
    b.conference_slug,
    b.day,
    b.author_handle ?? null,
    b.author_name ?? null,
    b.tweet_text ?? null,
    b.image_urls ? JSON.stringify(b.image_urls) : null,
    b.notes ?? null,
    b.fetched_via ?? 'pending',
    Date.now(),
  );
  return { id: result.lastInsertRowid as number, created: true };
}

export function listBookmarks(
  db: Database.Database,
  filter: { conference_slug?: string; day?: number } = {},
): Bookmark[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.conference_slug) {
    where.push('conference_slug = ?');
    params.push(filter.conference_slug);
  }
  if (filter.day !== undefined) {
    where.push('day = ?');
    params.push(filter.day);
  }
  const sql = `SELECT * FROM bookmarks${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return db.prepare(sql).all(...params) as Bookmark[];
}

export function deleteBookmark(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  return result.changes > 0;
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
