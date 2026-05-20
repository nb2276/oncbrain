import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  saveBookmark,
  savePaper,
  saveSlideUpload,
  listBookmarks,
  listBookmarkDates,
  listAllSourceDates,
  dominantConferenceForDate,
  deleteBookmark,
  updateBookmarkFetched,
  upsertConference,
  listConferences,
  getConference,
  getSetting,
  setSetting,
  todayIso,
} from '../src/lib/db.ts';
import type Database from 'better-sqlite3';

describe('db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  describe('saveBookmark', () => {
    it('saves a new bookmark with bookmark_date and no conference', () => {
      const result = saveBookmark(db, {
        url: 'https://x.com/test/status/1',
        bookmark_date: '2026-05-18',
      });
      expect(result.created).toBe(true);
      expect(result.id).toBeGreaterThan(0);
      const [b] = listBookmarks(db);
      expect(b.conference_slug).toBeNull();
      expect(b.bookmark_date).toBe('2026-05-18');
    });

    it('saves with optional conference tag', () => {
      saveBookmark(db, {
        url: 'https://x.com/test/status/2',
        bookmark_date: '2026-05-30',
        conference_slug: 'asco2026',
      });
      const [b] = listBookmarks(db);
      expect(b.conference_slug).toBe('asco2026');
    });

    it('rejects malformed bookmark_date', () => {
      expect(() =>
        saveBookmark(db, { url: 'https://x.com/x/status/1', bookmark_date: 'May 18, 2026' }),
      ).toThrow(/YYYY-MM-DD/);
      expect(() =>
        saveBookmark(db, { url: 'https://x.com/x/status/2', bookmark_date: '20260518' }),
      ).toThrow(/YYYY-MM-DD/);
    });

    it('is idempotent on duplicate URL', () => {
      const first = saveBookmark(db, {
        url: 'https://x.com/test/status/1',
        bookmark_date: '2026-05-18',
      });
      const second = saveBookmark(db, {
        url: 'https://x.com/test/status/1',
        bookmark_date: '2026-06-01',
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('stores all optional fields and serializes image_urls as JSON', () => {
      saveBookmark(db, {
        url: 'https://x.com/foo/status/2',
        bookmark_date: '2026-05-30',
        conference_slug: 'asco2026',
        author_handle: '@drfoo',
        author_name: 'Dr Foo, MD',
        tweet_text: 'Practice-changing data.',
        image_urls: ['https://pbs.twimg.com/a.jpg'],
        notes: 'Important',
        fetched_via: 'oembed',
      });
      const [b] = listBookmarks(db);
      expect(b.author_handle).toBe('@drfoo');
      expect(b.tweet_text).toBe('Practice-changing data.');
      expect(b.notes).toBe('Important');
      expect(b.fetched_via).toBe('oembed');
      expect(JSON.parse(b.image_urls!)).toEqual(['https://pbs.twimg.com/a.jpg']);
    });

    it('defaults fetched_via to "pending" when not provided', () => {
      saveBookmark(db, { url: 'https://x.com/y/status/3', bookmark_date: '2026-05-18' });
      const [b] = listBookmarks(db);
      expect(b.fetched_via).toBe('pending');
    });
  });

  describe('listBookmarks', () => {
    beforeEach(() => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-18' });
      saveBookmark(db, { url: 'https://x.com/a/status/2', bookmark_date: '2026-05-18', conference_slug: 'asco2026' });
      saveBookmark(db, { url: 'https://x.com/a/status/3', bookmark_date: '2026-05-30', conference_slug: 'asco2026' });
      saveBookmark(db, { url: 'https://x.com/a/status/4', bookmark_date: '2026-09-15', conference_slug: 'esmo2026' });
    });

    it('returns all bookmarks with no filter, newest date first', () => {
      const all = listBookmarks(db);
      expect(all).toHaveLength(4);
      expect(all[0]!.bookmark_date).toBe('2026-09-15');
    });

    it('filters by bookmark_date', () => {
      const result = listBookmarks(db, { bookmark_date: '2026-05-18' });
      expect(result).toHaveLength(2);
    });

    it('filters by conference_slug', () => {
      const result = listBookmarks(db, { conference_slug: 'asco2026' });
      expect(result).toHaveLength(2);
    });

    it('filters by date range', () => {
      const result = listBookmarks(db, { date_from: '2026-05-01', date_to: '2026-05-31' });
      expect(result).toHaveLength(3);
    });

    it('returns empty when no match', () => {
      expect(listBookmarks(db, { bookmark_date: '2025-01-01' })).toEqual([]);
    });
  });

  describe('listBookmarkDates', () => {
    it('returns distinct dates reverse-chronological', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-18' });
      saveBookmark(db, { url: 'https://x.com/a/status/2', bookmark_date: '2026-05-18' });
      saveBookmark(db, { url: 'https://x.com/a/status/3', bookmark_date: '2026-05-30' });
      saveBookmark(db, { url: 'https://x.com/a/status/4', bookmark_date: '2026-04-01' });
      expect(listBookmarkDates(db)).toEqual(['2026-05-30', '2026-05-18', '2026-04-01']);
    });

    it('returns empty array when no bookmarks', () => {
      expect(listBookmarkDates(db)).toEqual([]);
    });
  });

  describe('listAllSourceDates', () => {
    it('unions distinct dates across tweets, papers, and slides (reverse-chron)', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-18' });
      savePaper(db, { doi: '10.1056/clobber', title: 'A paper', bookmark_date: '2026-05-20' });
      saveSlideUpload(db, {
        file_path: 'data/slide-photos/2026-05-19/x.jpg',
        file_hash: 'deadbeef',
        mime_type: 'image/jpeg',
        bookmark_date: '2026-05-19',
      });
      // A paper-only / slide-only day must appear, unlike listBookmarkDates.
      expect(listAllSourceDates(db)).toEqual(['2026-05-20', '2026-05-19', '2026-05-18']);
      expect(listBookmarkDates(db)).toEqual(['2026-05-18']);
    });

    it('returns empty array when there are no sources', () => {
      expect(listAllSourceDates(db)).toEqual([]);
    });
  });

  describe('dominantConferenceForDate', () => {
    it('returns the slug when all bookmarks for that date share one conference', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-30', conference_slug: 'asco2026' });
      saveBookmark(db, { url: 'https://x.com/a/status/2', bookmark_date: '2026-05-30', conference_slug: 'asco2026' });
      expect(dominantConferenceForDate(db, '2026-05-30')).toBe('asco2026');
    });

    it('returns null when bookmarks span multiple conferences on one date', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-30', conference_slug: 'asco2026' });
      saveBookmark(db, { url: 'https://x.com/a/status/2', bookmark_date: '2026-05-30', conference_slug: 'asco-gu' });
      expect(dominantConferenceForDate(db, '2026-05-30')).toBeNull();
    });

    it('returns null when no bookmarks are tagged with a conference for that date', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-18' });
      saveBookmark(db, { url: 'https://x.com/a/status/2', bookmark_date: '2026-05-18' });
      expect(dominantConferenceForDate(db, '2026-05-18')).toBeNull();
    });
  });

  describe('deleteBookmark + updateBookmarkFetched', () => {
    it('deletes an existing bookmark', () => {
      const { id } = saveBookmark(db, {
        url: 'https://x.com/del/status/1',
        bookmark_date: '2026-05-18',
      });
      expect(deleteBookmark(db, id)).toBe(true);
      expect(listBookmarks(db)).toHaveLength(0);
    });

    it('returns false when nothing to delete', () => {
      expect(deleteBookmark(db, 99999)).toBe(false);
    });

    it('updateBookmarkFetched flips a pending bookmark to fetched state', () => {
      const { id } = saveBookmark(db, {
        url: 'https://x.com/foo/status/1',
        bookmark_date: '2026-05-18',
      });
      updateBookmarkFetched(db, id, {
        author_handle: '@drfoo',
        author_name: 'Dr Foo',
        tweet_text: 'fetched text',
      });
      const [b] = listBookmarks(db);
      expect(b.fetched_via).toBe('oembed');
      expect(b.author_handle).toBe('@drfoo');
      expect(b.tweet_text).toBe('fetched text');
    });
  });

  describe('conferences', () => {
    it('upserts and lists conferences sorted by start_date desc', () => {
      upsertConference(db, { slug: 'asco2026', name: 'ASCO 2026', start_date: '2026-05-30', end_date: '2026-06-03', hashtag: '#ASCO26' });
      upsertConference(db, { slug: 'esmo2026', name: 'ESMO 2026', start_date: '2026-09-12', end_date: '2026-09-16', hashtag: '#ESMO26' });
      const list = listConferences(db);
      expect(list).toHaveLength(2);
      expect(list[0]!.slug).toBe('esmo2026');
    });

    it('updates a conference on upsert with same slug', () => {
      upsertConference(db, { slug: 'asco2026', name: 'ASCO 2026', start_date: null, end_date: null, hashtag: null });
      upsertConference(db, { slug: 'asco2026', name: 'ASCO Annual Meeting 2026', start_date: '2026-05-30', end_date: null, hashtag: '#ASCO26' });
      const c = getConference(db, 'asco2026');
      expect(c?.name).toBe('ASCO Annual Meeting 2026');
    });

    it('getConference returns undefined for missing slug', () => {
      expect(getConference(db, 'nonexistent')).toBeUndefined();
    });
  });

  describe('settings', () => {
    it('stores and retrieves a value', () => {
      setSetting(db, 'telegram_offset', '42');
      expect(getSetting(db, 'telegram_offset')).toBe('42');
    });

    it('returns undefined for missing key', () => {
      expect(getSetting(db, 'never_set')).toBeUndefined();
    });

    it('upserts on repeated set', () => {
      setSetting(db, 'k', 'v1');
      setSetting(db, 'k', 'v2');
      expect(getSetting(db, 'k')).toBe('v2');
    });
  });

  describe('todayIso', () => {
    it('returns YYYY-MM-DD format', () => {
      expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
