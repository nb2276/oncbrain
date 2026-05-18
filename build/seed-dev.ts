// Dev helper: seed fake conferences + bookmarks for end-to-end smoke testing.
// Run via: tsx build/seed-dev.ts
//
// Three dates, mix of conference-tagged and untagged bookmarks, so the resulting
// digest exercises both code paths (with-conference and bare-date).

import { openDb, upsertConference, saveBookmark } from '../src/lib/db.ts';

const db = openDb();

upsertConference(db, {
  slug: 'asco2026-fake',
  name: 'ASCO Annual Meeting 2026 (seed)',
  start_date: '2026-05-30',
  end_date: '2026-06-03',
  hashtag: '#ASCO26',
});

const fixtures = [
  // Conference-tagged date — exercises the conference badge path.
  {
    bookmark_date: '2026-05-30',
    conference_slug: 'asco2026-fake',
    url: 'https://x.com/seed/status/1',
    author_handle: '@drfoo',
    author_name: 'Dr Foo, MD',
    tweet_text:
      'NCT04567890 met its primary endpoint: HR 0.62 for OS in mCRPC. Practice-changing data — full results expected in NEJM. doi:10.1056/NEJMoa2024999',
    notes: 'practice-changing',
  },
  {
    bookmark_date: '2026-05-30',
    conference_slug: 'asco2026-fake',
    url: 'https://x.com/seed/status/2',
    author_handle: '@drbar',
    author_name: 'Dr Bar, MD',
    tweet_text:
      'ARANOTE-RWE shows 21-mo improvement in rPFS with enzalutamide + ADT in newly diagnosed mHSPC. NCT12345678.',
    notes: null,
  },
  // Same conference, next day.
  {
    bookmark_date: '2026-05-31',
    conference_slug: 'asco2026-fake',
    url: 'https://x.com/seed/status/3',
    author_handle: '@drbaz',
    author_name: 'Dr Baz, MD',
    tweet_text:
      'TROP2-targeting datopotamab in TNBC: ORR 41% in the second-line setting. PMID: 36912345 for the phase II writeup.',
    notes: 'TROP2 ADC update',
  },
  // Bare date with no conference — exercises the no-badge path.
  {
    bookmark_date: '2026-05-17',
    conference_slug: null,
    url: 'https://x.com/seed/status/4',
    author_handle: '@drqux',
    author_name: 'Dr Qux, MD',
    tweet_text:
      'New FDA approval for trastuzumab deruxtecan in HER2-low breast cancer. doi:10.1056/NEJMoa2406909',
    notes: 'regulatory update',
  },
];

for (const f of fixtures) {
  const r = saveBookmark(db, {
    url: f.url,
    bookmark_date: f.bookmark_date,
    conference_slug: f.conference_slug,
    author_handle: f.author_handle,
    author_name: f.author_name,
    tweet_text: f.tweet_text,
    notes: f.notes,
    fetched_via: 'manual',
  });
  console.log(`bookmark #${r.id} (${r.created ? 'created' : 'existed'}): ${f.bookmark_date} ${f.url}`);
}

console.log('Seeded: 2026-05-17 (untagged) + 2026-05-30 + 2026-05-31 (ASCO seed)');
