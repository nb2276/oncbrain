// v0.62.2: a study's meeting (ESMO Congress 2026, ASTRO 2026, ...) is a fact
// about ITS sources, not about the day it was filed on.
//
// The meeting used to be the day's (dominantConferenceForDate: the one
// conference any source that day carried), applied to every card on the date.
// On 2026-10-24 five #ESMO26 tweets made all nine cards "ESMO", including four
// decades-old reference papers from the ingest:local drip and an untagged
// PEACE-1 tweet. They showed an ESMO chip and were filed under the ESMO tag.
//
// Rule: the distinct non-null conference_slug values of the study's sources;
// exactly one → that meeting; none or several → no meeting. A drip paper that
// clusters with an ESMO tweet about the same trial still gets ESMO (the tweet
// says it was presented there).
import type Database from 'better-sqlite3';

export type StudyMeeting = { slug: string; name: string };
type Ref = { type: string; id: number };
type StudyLike = { source_ids?: Ref[]; tweet_ids?: number[]; meeting?: StudyMeeting | null };

const TABLE: Record<string, string> = { tweet: 'bookmarks', paper: 'papers', slide: 'slide_uploads' };

export function meetingFromSources(db: Database.Database, refs: Ref[]): StudyMeeting | null {
  const slugs = new Set<string>();
  for (const r of refs) {
    const table = TABLE[r.type];
    if (!table) continue;
    const row = db.prepare(`SELECT conference_slug AS s FROM ${table} WHERE id = ?`).get(r.id) as { s: string | null } | undefined;
    if (row?.s) slugs.add(row.s);
  }
  if (slugs.size !== 1) return null;
  const slug = [...slugs][0]!;
  const conf = db.prepare('SELECT name FROM conferences WHERE slug = ?').get(slug) as { name: string } | undefined;
  return conf ? { slug, name: conf.name } : null;
}

/** Stamp `meeting` on every study (null when its sources carry none). Mutates. */
export function stampStudyMeetings(db: Database.Database, digest: { sites: Array<{ studies: StudyLike[] }> }): void {
  for (const site of digest.sites) {
    for (const study of site.studies) {
      const refs: Ref[] = study.source_ids ?? (study.tweet_ids ?? []).map((id) => ({ type: 'tweet', id }));
      study.meeting = meetingFromSources(db, refs);
    }
  }
}

/**
 * The meeting to show for a study. A stamped study (field present, even null)
 * is authoritative; an artifact built before v0.62.2 falls back to the day's.
 */
export function studyMeeting(
  study: { meeting?: StudyMeeting | null },
  day: StudyMeeting | null | undefined,
): StudyMeeting | null {
  return study.meeting !== undefined ? study.meeting : (day ?? null);
}

/**
 * v0.63.1: every meeting a digest touches, slug → display name: its day label
 * plus each card's own meeting. A day can lose its label (fewer than half its
 * sources from the meeting) while one of its cards keeps the meeting chip, so
 * any surface that lists meetings (conference pages, tag labels, the meeting
 * namespace) must read both, or the chip links to a page that was never built.
 */
export function meetingsOf(digest: {
  conference?: StudyMeeting | null;
  digest: { sites: Array<{ studies: Array<{ meeting?: StudyMeeting | null }> }> };
}): Map<string, string> {
  const out = new Map<string, string>();
  if (digest.conference?.slug) out.set(digest.conference.slug, digest.conference.name);
  for (const site of digest.digest.sites) {
    for (const st of site.studies) if (st.meeting?.slug && !out.has(st.meeting.slug)) out.set(st.meeting.slug, st.meeting.name);
  }
  return out;
}
