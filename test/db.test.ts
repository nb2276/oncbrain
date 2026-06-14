import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  saveBookmark,
  savePaper,
  listPapers,
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
  normalizeAcronym,
  upsertResolution,
  getResolution,
  listResolutions,
  decideResolution,
  reopenStaleResolutions,
  parseResolutionCandidates,
  type ResolutionCandidate,
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

  describe('savePaper figure_ocr_md (v0.15)', () => {
    it('round-trips figure OCR through insert and listPapers', () => {
      savePaper(db, {
        doi: '10.1200/fig1',
        title: 'Figure paper',
        bookmark_date: '2026-06-10',
        fulltext_excerpt_md: 'Methods and results body text',
        figure_ocr_md: '[p.38]\nPathologic N Stage\nNO 28.6 (14.9-42.2) 48.1 (33.3-62.9)',
      });
      const paper = listPapers(db, { bookmark_date: '2026-06-10' })[0];
      expect(paper.figure_ocr_md).toContain('48.1 (33.3-62.9)');
    });

    it('defaults figure_ocr_md to null when not provided (URL-ingested paper)', () => {
      savePaper(db, { doi: '10.1200/nofig', title: 'No-figure paper', bookmark_date: '2026-06-10' });
      const paper = listPapers(db, { bookmark_date: '2026-06-10' })[0];
      expect(paper.figure_ocr_md).toBeNull();
    });

    it('back-fills figure OCR onto an existing row that lacked it (PDF arrives after URL)', () => {
      // First ingest via DOI/URL with no figure OCR.
      const first = savePaper(db, { doi: '10.1200/merge', title: 'Mergeable', bookmark_date: '2026-06-10' });
      // Same paper later forwarded as a PDF carrying figure OCR → attaches, same row.
      const second = savePaper(db, {
        doi: '10.1200/merge',
        title: 'Mergeable',
        bookmark_date: '2026-06-10',
        figure_ocr_md: 'Median OS (95% CI) 3.0 (2.2, 4.0)',
      });
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
      const paper = listPapers(db, { bookmark_date: '2026-06-10' })[0];
      expect(paper.figure_ocr_md).toBe('Median OS (95% CI) 3.0 (2.2, 4.0)');
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

    it('returns the slug from a paper-only conference day (no tagged tweets)', () => {
      savePaper(db, { doi: '10.1056/p1', title: 'A paper', bookmark_date: '2026-05-30', conference_slug: 'asco-2026' });
      expect(dominantConferenceForDate(db, '2026-05-30')).toBe('asco-2026');
    });

    it('returns the slug from a slide-only conference day', () => {
      saveSlideUpload(db, {
        file_path: 'data/slide-photos/2026-05-30/x.jpg',
        file_hash: 'beef01',
        mime_type: 'image/jpeg',
        bookmark_date: '2026-05-30',
        conference_slug: 'esmo-2025',
      });
      expect(dominantConferenceForDate(db, '2026-05-30')).toBe('esmo-2025');
    });

    it('still resolves when an untagged tweet shares the day with a tagged paper', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/9', bookmark_date: '2026-05-30' });
      savePaper(db, { doi: '10.1056/p2', title: 'B paper', bookmark_date: '2026-05-30', conference_slug: 'asco-2026' });
      expect(dominantConferenceForDate(db, '2026-05-30')).toBe('asco-2026');
    });

    it('returns null when tagged sources span conferences across source types', () => {
      saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-30', conference_slug: 'asco-2026' });
      savePaper(db, { doi: '10.1056/p3', title: 'C paper', bookmark_date: '2026-05-30', conference_slug: 'esmo-2025' });
      expect(dominantConferenceForDate(db, '2026-05-30')).toBeNull();
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

// v0.17 (T1): the review-discussed-trial resolution manifest.
describe('review_trial_resolutions manifest', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  const cands: ResolutionCandidate[] = [
    { pmid: '32215577', title: 'ORIOLE: SABR for oligometastatic prostate', journal: 'JAMA Oncol', year: '2020', score: 0.9 },
    { pmid: '36001857', title: 'STOMP/ORIOLE pooled', journal: 'JCO', year: '2022', score: 0.4 },
  ];
  const base = {
    review_source_paper_id: 7,
    acronym_norm: 'ORIOLE',
    acronym_display: 'ORIOLE',
    disease_site: 'prostate',
    bookmark_date: '2026-06-12',
    candidates: cands,
    confidence: 0.9,
    resolver_version: 'v1',
  };

  describe('normalizeAcronym', () => {
    it('upper-cases and collapses whitespace so the freeze key is consistent', () => {
      expect(normalizeAcronym('  stomp ')).toBe('STOMP');
      expect(normalizeAcronym('stampede 2')).toBe('STAMPEDE 2');
      expect(normalizeAcronym('ORIOLE')).toBe('ORIOLE');
    });
  });

  it('upserts a pending row with candidates + confidence', () => {
    const { resolution, created } = upsertResolution(db, base);
    expect(created).toBe(true);
    expect(resolution.status).toBe('pending');
    expect(resolution.review_source_paper_id).toBe(7);
    expect(resolution.acronym_norm).toBe('ORIOLE');
    expect(resolution.confidence).toBe(0.9);
    expect(resolution.decided_at).toBeNull();
    expect(parseResolutionCandidates(resolution.candidates_json)).toHaveLength(2);
    expect(parseResolutionCandidates(resolution.candidates_json)[0]!.pmid).toBe('32215577');
  });

  it('FREEZE: a second upsert of the same (paper, acronym) returns the existing row unchanged', () => {
    const first = upsertResolution(db, base);
    // A re-run with DIFFERENT candidates must NOT overwrite the frozen row.
    const second = upsertResolution(db, {
      ...base,
      confidence: 0.1,
      candidates: [{ pmid: '99999999', title: 'wrong', journal: null, year: null, score: 0.1 }],
    });
    expect(second.created).toBe(false);
    expect(second.resolution.id).toBe(first.resolution.id);
    expect(second.resolution.confidence).toBe(0.9); // original, not overwritten
    expect(parseResolutionCandidates(second.resolution.candidates_json)[0]!.pmid).toBe('32215577');
    expect(listResolutions(db)).toHaveLength(1); // no duplicate row
  });

  it('the freeze key is normalized — "  oriole " collides with "ORIOLE"', () => {
    upsertResolution(db, base);
    const dup = upsertResolution(db, { ...base, acronym_norm: normalizeAcronym('  oriole ') });
    expect(dup.created).toBe(false);
    expect(listResolutions(db)).toHaveLength(1);
  });

  it('stores a failed resolution (no candidates) — the acronym stays plain text downstream', () => {
    const { resolution } = upsertResolution(db, {
      review_source_paper_id: 7, acronym_norm: 'PP3', acronym_display: 'PP3',
      disease_site: 'prostate', bookmark_date: '2026-06-12', status: 'failed',
      resolver_version: 'v1',
    });
    expect(resolution.status).toBe('failed');
    expect(resolution.chosen_pmid).toBeNull();
    expect(parseResolutionCandidates(resolution.candidates_json)).toEqual([]);
  });

  it('getResolution looks up by the freeze key', () => {
    upsertResolution(db, base);
    expect(getResolution(db, 7, 'ORIOLE')?.acronym_display).toBe('ORIOLE');
    expect(getResolution(db, 7, 'STOMP')).toBeUndefined();
    expect(getResolution(db, 999, 'ORIOLE')).toBeUndefined();
  });

  it('listResolutions filters by date and status', () => {
    upsertResolution(db, base); // pending, 2026-06-12
    upsertResolution(db, { ...base, acronym_norm: 'STOMP', acronym_display: 'STOMP', status: 'failed' });
    upsertResolution(db, { ...base, review_source_paper_id: 8, acronym_norm: 'ARTO', acronym_display: 'ARTO', bookmark_date: '2026-06-10' });
    expect(listResolutions(db)).toHaveLength(3);
    expect(listResolutions(db, { date: '2026-06-12' })).toHaveLength(2);
    expect(listResolutions(db, { status: 'pending' })).toHaveLength(2);
    expect(listResolutions(db, { date: '2026-06-12', status: 'failed' })).toHaveLength(1);
  });

  it('decideResolution approves with a chosen pmid and stamps decided_at', () => {
    const { resolution } = upsertResolution(db, base);
    const approved = decideResolution(db, resolution.id, { status: 'approved', chosenPmid: '32215577' });
    expect(approved?.status).toBe('approved');
    expect(approved?.chosen_pmid).toBe('32215577');
    expect(approved?.decided_at).toBeGreaterThan(0);
  });

  it('decideResolution REJECTS approving a pmid that is not a candidate (fix #6a)', () => {
    const { resolution } = upsertResolution(db, base); // candidates: 32215577, 36001857
    expect(() => decideResolution(db, resolution.id, { status: 'approved', chosenPmid: '99999999' })).toThrow(
      /not a candidate/,
    );
    // the row is unchanged (still pending, no chosen_pmid)
    expect(getResolution(db, 7, 'ORIOLE')!.status).toBe('pending');
  });

  it('decideResolution rejects and clears any chosen pmid', () => {
    const { resolution } = upsertResolution(db, base);
    const rejected = decideResolution(db, resolution.id, { status: 'rejected' });
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.chosen_pmid).toBeNull();
    expect(rejected?.decided_at).toBeGreaterThan(0);
  });

  it('reopenStaleResolutions re-opens un-decided OLD-version rows but PRESERVES curator decisions', () => {
    // Three v1 rows; approve one, reject one, leave one pending. Then bump to v2.
    const a = upsertResolution(db, { ...base, acronym_norm: 'A', acronym_display: 'A' });
    const b = upsertResolution(db, { ...base, acronym_norm: 'B', acronym_display: 'B' });
    const c = upsertResolution(db, { ...base, acronym_norm: 'C', acronym_display: 'C', status: 'failed' });
    decideResolution(db, a.resolution.id, { status: 'approved', chosenPmid: '32215577' });
    decideResolution(db, b.resolution.id, { status: 'rejected' });
    // c stays failed (un-decided)
    const reopened = reopenStaleResolutions(db, 'v2');
    expect(reopened).toBe(1); // only the failed (un-decided) v1 row
    expect(getResolution(db, 7, 'A')?.status).toBe('approved'); // preserved
    expect(getResolution(db, 7, 'B')?.status).toBe('rejected'); // preserved
    expect(getResolution(db, 7, 'C')).toBeUndefined(); // re-opened (deleted → resolver re-runs)
  });

  it('reopenStaleResolutions does NOT touch rows already at the current version', () => {
    upsertResolution(db, base); // v1 pending
    expect(reopenStaleResolutions(db, 'v1')).toBe(0);
    expect(listResolutions(db)).toHaveLength(1);
  });

  it('reopenStaleResolutions SCOPED to a date leaves OTHER dates queues intact (P1 fix)', () => {
    // Two pending v1 rows on different dates. The CLI resolves one date and only
    // re-creates that date's rows, so an unscoped delete would wipe the other
    // date's queue without re-resolving it.
    upsertResolution(db, { ...base, bookmark_date: '2026-06-12' });
    upsertResolution(db, { ...base, review_source_paper_id: 9, bookmark_date: '2026-06-13' });
    const reopened = reopenStaleResolutions(db, 'v2', '2026-06-12');
    expect(reopened).toBe(1); // only the target date's stale row
    expect(listResolutions(db, { date: '2026-06-12' })).toHaveLength(0); // re-opened
    expect(listResolutions(db, { date: '2026-06-13' })).toHaveLength(1); // untouched
  });

  it('parseResolutionCandidates is defensive against null / malformed json', () => {
    expect(parseResolutionCandidates(null)).toEqual([]);
    expect(parseResolutionCandidates('{not json')).toEqual([]);
    expect(parseResolutionCandidates('{"not":"array"}')).toEqual([]);
  });
});
