// Dev helper: seed a fake conference + bookmarks for end-to-end smoke testing.
// Run via: tsx build/seed-dev.ts

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
  {
    url: 'https://x.com/seed/status/1',
    author_handle: '@drfoo',
    author_name: 'Dr Foo, MD',
    tweet_text:
      'NCT04567890 met its primary endpoint: HR 0.62 for OS in mCRPC. Practice-changing data — full results expected in NEJM. doi:10.1056/NEJMoa2024999',
    notes: 'practice-changing',
  },
  {
    url: 'https://x.com/seed/status/2',
    author_handle: '@drbar',
    author_name: 'Dr Bar, MD',
    tweet_text:
      'ARANOTE-RWE shows 21-mo improvement in rPFS with enzalutamide + ADT in newly diagnosed mHSPC. NCT12345678.',
    notes: null,
  },
  {
    url: 'https://x.com/seed/status/3',
    author_handle: '@drbaz',
    author_name: 'Dr Baz, MD',
    tweet_text:
      'TROP2-targeting datopotamab in TNBC: ORR 41% in the second-line setting. PMID: 36912345 for the phase II writeup.',
    notes: 'TROP2 ADC update',
  },
];

for (const f of fixtures) {
  const r = saveBookmark(db, {
    url: f.url,
    conference_slug: 'asco2026-fake',
    day: 1,
    author_handle: f.author_handle,
    author_name: f.author_name,
    tweet_text: f.tweet_text,
    notes: f.notes,
    fetched_via: 'manual',
  });
  console.log(`bookmark #${r.id} (${r.created ? 'created' : 'existed'}): ${f.url}`);
}

console.log('Seeded conference: asco2026-fake, day 1 (3 bookmarks)');
