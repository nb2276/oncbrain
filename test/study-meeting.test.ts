// v0.62.2: a study's meeting comes from its own sources, not the day's.
import { describe, it, expect } from 'vitest';
import { openDb, upsertConference } from '../src/lib/db.ts';
import { meetingFromSources, stampStudyMeetings, studyMeeting } from '../src/lib/study-meeting.ts';
import { studyDataTags } from '../src/lib/study-data-tags.ts';
import { deriveStudyTags, studyTagChips } from '../src/lib/tag-index.ts';
import type { DigestStudy } from '../src/lib/digest-data.ts';

const ESMO = { slug: 'esmo-2026', name: 'ESMO Congress 2026' };

function fixture() {
  const db = openDb(':memory:');
  upsertConference(db, { slug: 'esmo-2026', name: 'ESMO Congress 2026', start_date: null, end_date: null, hashtag: null } as never);
  upsertConference(db, { slug: 'astro-2026', name: 'ASTRO 2026', start_date: null, end_date: null, hashtag: null } as never);
  const tweet = (slug: string | null) =>
    Number(
      db
        .prepare("INSERT INTO bookmarks (url, bookmark_date, conference_slug, created_at) VALUES (?, '2026-10-24', ?, 0)")
        .run(`https://x.com/a/status/${Math.random()}`, slug).lastInsertRowid,
    );
  const paper = (slug: string | null) =>
    Number(
      db
        .prepare("INSERT INTO papers (content_hash, title, bookmark_date, conference_slug, fetched_via, created_at) VALUES (?, 't', '2026-10-24', ?, 'pdf', 0)")
        .run(String(Math.random()), slug).lastInsertRowid,
    );
  return { db, tweet, paper };
}

describe('meetingFromSources', () => {
  it('one meeting across the sources → that meeting; untagged sources do not dilute it', () => {
    const { db, tweet, paper } = fixture();
    expect(meetingFromSources(db, [{ type: 'tweet', id: tweet('esmo-2026') }, { type: 'paper', id: paper(null) }])).toEqual(ESMO);
  });
  it('a drip paper or an untagged tweet alone has no meeting, whatever the day carries', () => {
    const { db, tweet, paper } = fixture();
    tweet('esmo-2026'); // the day is ESMO
    expect(meetingFromSources(db, [{ type: 'paper', id: paper(null) }])).toBeNull();
    expect(meetingFromSources(db, [{ type: 'tweet', id: tweet(null) }])).toBeNull();
  });
  it('two different meetings → no meeting', () => {
    const { db, tweet } = fixture();
    expect(meetingFromSources(db, [{ type: 'tweet', id: tweet('esmo-2026') }, { type: 'tweet', id: tweet('astro-2026') }])).toBeNull();
  });
  it('stamps every study, null included', () => {
    const { db, tweet, paper } = fixture();
    const digest = {
      sites: [{ studies: [{ source_ids: [{ type: 'tweet', id: tweet('esmo-2026') }] }, { source_ids: [{ type: 'paper', id: paper(null) }] }] }],
    };
    stampStudyMeetings(db, digest as never);
    expect(digest.sites[0]!.studies.map((s) => (s as { meeting?: unknown }).meeting)).toEqual([ESMO, null]);
  });
});

describe('the tag surfaces use the study meeting', () => {
  const base = { name: 'x', tldr: 'x', details: [], nct: null, tweet_ids: [] } as unknown as DigestStudy;
  it('a stamped null beats the day conference (drip paper on an ESMO day)', () => {
    const s = { ...base, meeting: null } as DigestStudy;
    expect(studyMeeting(s, ESMO)).toBeNull();
    expect(studyTagChips(s, ESMO).some((c) => c.slug === 'esmo-2026')).toBe(false);
    expect(studyDataTags(s, 'thoracic', 'esmo-2026')).not.toContain('meeting:');
    expect(deriveStudyTags(s, 'thoracic', 'esmo-2026').meeting).toBeNull();
  });
  it('a stamped meeting shows even when the day has none', () => {
    const s = { ...base, meeting: ESMO } as DigestStudy;
    expect(studyTagChips(s, null)).toContainEqual({ slug: 'esmo-2026', label: 'ESMO Congress 2026' });
    expect(studyDataTags(s, 'thoracic', null)).toContain('meeting:esmo-2026');
  });
  it('an unstamped (pre-v0.62.2) study keeps the day conference', () => {
    expect(deriveStudyTags(base, 'thoracic', 'esmo-2026').meeting).toBe('esmo-2026');
  });
});

describe('meetingsOf + the meeting surfaces (v0.63.1)', () => {
  const ASTRO24 = { slug: 'astro-2024', name: 'ASTRO Annual Meeting 2024' };
  const digest = (conference: typeof ESMO | null, meetings: Array<typeof ESMO | null>) => ({
    conference,
    digest: { sites: [{ studies: meetings.map((meeting) => ({ name: 'x', meeting })) }] },
  });
  it('lists the day label and every card meeting', async () => {
    const { meetingsOf } = await import('../src/lib/study-meeting.ts');
    expect([...meetingsOf(digest(null, [ASTRO24, null])).entries()]).toEqual([['astro-2024', 'ASTRO Annual Meeting 2024']]);
    expect([...meetingsOf(digest(ESMO, [ESMO, ASTRO24])).keys()]).toEqual(['esmo-2026', 'astro-2024']);
  });
  it('a card meeting on an unlabelled day still resolves as a meeting tag', async () => {
    const { resolveTagDisplay, collectMeetingSlugs } = await import('../src/lib/tag-index.ts');
    const study = { name: 'SBRT', tldr: 'x', details: [], nct: null, tweet_ids: [], meeting: ASTRO24 } as unknown as DigestStudy;
    const occ = { date: '2026-07-09', conference: null, diseaseSite: 'prostate', resolvedSlug: 'sbrt', study, bookmarks: [] };
    expect(resolveTagDisplay('astro-2024', [occ as never])).toEqual({ namespace: 'meeting', label: 'ASTRO Annual Meeting 2024', emoji: null });
    expect(collectMeetingSlugs([{ date: '2026-07-09', ...digest(null, [ASTRO24]) } as never])).toEqual(['astro-2024']);
  });
});
