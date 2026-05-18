import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  saveBookmark,
  listBookmarks,
  deleteBookmark,
  upsertConference,
  listConferences,
  getConference,
} from '../src/lib/db.ts';
import type Database from 'better-sqlite3';

describe('db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  describe('saveBookmark', () => {
    it('saves a new bookmark and returns its id', () => {
      const result = saveBookmark(db, {
        url: 'https://x.com/test/status/1',
        conference_slug: 'asco2026',
        day: 1,
      });
      expect(result.created).toBe(true);
      expect(result.id).toBeGreaterThan(0);
    });

    it('is idempotent on duplicate URL', () => {
      const first = saveBookmark(db, {
        url: 'https://x.com/test/status/1',
        conference_slug: 'asco2026',
        day: 1,
      });
      const second = saveBookmark(db, {
        url: 'https://x.com/test/status/1',
        conference_slug: 'esmo2026',
        day: 99,
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('stores all optional fields and serializes image_urls as JSON', () => {
      saveBookmark(db, {
        url: 'https://x.com/foo/status/2',
        conference_slug: 'asco2026',
        day: 2,
        author_handle: '@drfoo',
        author_name: 'Dr Foo, MD',
        tweet_text: 'Practice-changing data.',
        image_urls: ['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg'],
        notes: 'Important',
        fetched_via: 'oembed',
      });
      const [b] = listBookmarks(db);
      expect(b.author_handle).toBe('@drfoo');
      expect(b.author_name).toBe('Dr Foo, MD');
      expect(b.tweet_text).toBe('Practice-changing data.');
      expect(b.notes).toBe('Important');
      expect(b.fetched_via).toBe('oembed');
      expect(JSON.parse(b.image_urls!)).toEqual([
        'https://pbs.twimg.com/a.jpg',
        'https://pbs.twimg.com/b.jpg',
      ]);
    });

    it('defaults fetched_via to "pending" when not provided', () => {
      saveBookmark(db, { url: 'https://x.com/y/status/3', conference_slug: 'asco2026', day: 1 });
      const [b] = listBookmarks(db);
      expect(b.fetched_via).toBe('pending');
    });
  });

  describe('listBookmarks', () => {
    beforeEach(() => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', conference_slug: 'asco2026', day: 1 });
      saveBookmark(db, { url: 'https://x.com/a/status/2', conference_slug: 'asco2026', day: 2 });
      saveBookmark(db, { url: 'https://x.com/a/status/3', conference_slug: 'esmo2026', day: 1 });
    });

    it('returns all bookmarks with no filter', () => {
      expect(listBookmarks(db)).toHaveLength(3);
    });

    it('filters by conference_slug', () => {
      const result = listBookmarks(db, { conference_slug: 'asco2026' });
      expect(result).toHaveLength(2);
      expect(result.every((b) => b.conference_slug === 'asco2026')).toBe(true);
    });

    it('filters by conference_slug + day', () => {
      const result = listBookmarks(db, { conference_slug: 'asco2026', day: 1 });
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://x.com/a/status/1');
    });

    it('returns empty array when nothing matches', () => {
      expect(listBookmarks(db, { conference_slug: 'nope' })).toEqual([]);
    });
  });

  describe('deleteBookmark', () => {
    it('deletes an existing bookmark and returns true', () => {
      const { id } = saveBookmark(db, {
        url: 'https://x.com/del/status/1',
        conference_slug: 'asco2026',
        day: 1,
      });
      expect(deleteBookmark(db, id)).toBe(true);
      expect(listBookmarks(db)).toHaveLength(0);
    });

    it('returns false when nothing to delete', () => {
      expect(deleteBookmark(db, 99999)).toBe(false);
    });
  });

  describe('conferences', () => {
    it('upserts and lists conferences sorted by start_date desc', () => {
      upsertConference(db, { slug: 'asco2026', name: 'ASCO 2026', start_date: '2026-05-30', end_date: '2026-06-03', hashtag: '#ASCO26' });
      upsertConference(db, { slug: 'esmo2026', name: 'ESMO 2026', start_date: '2026-09-12', end_date: '2026-09-16', hashtag: '#ESMO26' });
      const list = listConferences(db);
      expect(list).toHaveLength(2);
      expect(list[0]!.slug).toBe('esmo2026'); // later start_date first
    });

    it('updates a conference on upsert with same slug', () => {
      upsertConference(db, { slug: 'asco2026', name: 'ASCO 2026', start_date: null, end_date: null, hashtag: null });
      upsertConference(db, { slug: 'asco2026', name: 'ASCO Annual Meeting 2026', start_date: '2026-05-30', end_date: null, hashtag: '#ASCO26' });
      const c = getConference(db, 'asco2026');
      expect(c?.name).toBe('ASCO Annual Meeting 2026');
      expect(c?.start_date).toBe('2026-05-30');
      expect(c?.hashtag).toBe('#ASCO26');
    });

    it('getConference returns undefined for missing slug', () => {
      expect(getConference(db, 'nonexistent')).toBeUndefined();
    });
  });
});
