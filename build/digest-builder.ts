// CLI entry point: build one date's digest.
//
// Usage:
//   npm run build:day                            # today
//   npm run build:day -- --date=2026-05-18
//   npm run build:day -- --date=2026-05-18 --dry-run
//   npm run build:day -- --conf=asco2026         # all dates for a conference
//   npm run build:day -- --backfill              # all dates with bookmarks
//
// Flow per date:
//   1. Read bookmarks from SQLite for that date.
//   2. For any bookmark with fetched_via='pending', try oEmbed. Save result back.
//   3. Run the LLM digest pipeline over the resulting tweet set.
//   4. Write the digest to data/digests/<date>.json (committed artifact).
//   5. Write an Obsidian-flavored markdown twin to data/obsidian/<date>[-<conf>].md.
//
// The Astro build then reads these JSON files to produce static digest pages.

import 'dotenv/config';
import {
  openDb,
  listBookmarks,
  listBookmarkDates,
  updateBookmarkFetched,
  dominantConferenceForDate,
  getConference,
  todayIso,
  type Bookmark,
} from '../src/lib/db.ts';
import { fetchTweet, TweetFetchError } from '../src/lib/twitter-fetch.ts';
import { buildDigest, type DigestInputTweet, type DigestOutput } from '../src/lib/llm-pipeline.ts';
import { renderObsidian } from '../src/lib/obsidian-export.ts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

type Args = {
  date?: string; // exact date
  conferenceSlug?: string; // build every date for this conference
  backfill: boolean; // build every date with bookmarks
  dryRun: boolean;
  skipFetch: boolean;
  outDir: string;
  obsidianDir: string;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]!] = m[2] ?? true;
  }
  const date = typeof args.date === 'string' ? args.date.trim() : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${date}`);
  }
  return {
    date,
    conferenceSlug: typeof args.conf === 'string' ? args.conf.trim() : undefined,
    backfill: !!args.backfill,
    dryRun: !!args['dry-run'],
    skipFetch: !!args['skip-fetch'],
    outDir: typeof args.out === 'string' ? args.out : 'data/digests',
    obsidianDir: typeof args.obsidian === 'string' ? args.obsidian : 'data/obsidian',
  };
}

async function ensureTweetData(
  db: ReturnType<typeof openDb>,
  bookmarks: Bookmark[],
  skipFetch: boolean,
): Promise<void> {
  if (skipFetch) return;
  const pending = bookmarks.filter((b) => b.fetched_via === 'pending');
  if (pending.length === 0) return;

  console.log(`  fetching ${pending.length} pending tweet(s) via oEmbed...`);
  for (const b of pending) {
    try {
      const tweet = await fetchTweet(b.url);
      updateBookmarkFetched(db, b.id, {
        author_handle: tweet.author_handle,
        author_name: tweet.author_name,
        tweet_text: tweet.text,
      });
      console.log(`    [oembed] #${b.id} ${b.url}`);
    } catch (err) {
      if (err instanceof TweetFetchError) {
        console.warn(`    [skip] #${b.id} ${err.kind}: ${b.url}`);
      } else {
        console.warn(`    [skip] #${b.id} unexpected error: ${(err as Error).message}`);
      }
    }
  }
}

function toDigestInput(bookmarks: Bookmark[]): DigestInputTweet[] {
  return bookmarks
    .filter((b) => (b.tweet_text || '').trim().length > 0)
    .map((b) => ({
      id: b.id,
      author: b.author_handle ?? b.author_name ?? null,
      text: b.tweet_text!,
      note: b.notes,
    }));
}

type DigestArtifact = {
  date: string; // YYYY-MM-DD
  conference: { slug: string; name: string } | null;
  generated_at: number;
  digest: DigestOutput;
  bookmarks: Array<{
    id: number;
    url: string;
    bookmark_date: string;
    author_handle: string | null;
    author_name: string | null;
    text: string;
    note: string | null;
    fetched_via: string;
    conference_slug: string | null;
  }>;
};

function buildArtifact(
  date: string,
  conference: { slug: string; name: string } | null,
  bookmarks: Bookmark[],
  digest: DigestOutput,
): DigestArtifact {
  return {
    date,
    conference,
    generated_at: Date.now(),
    digest,
    bookmarks: bookmarks.map((b) => ({
      id: b.id,
      url: b.url,
      bookmark_date: b.bookmark_date,
      author_handle: b.author_handle,
      author_name: b.author_name,
      text: b.tweet_text!,
      note: b.notes,
      fetched_via: b.fetched_via,
      conference_slug: b.conference_slug,
    })),
  };
}

function writeArtifact(args: Args, artifact: DigestArtifact): { json: string; obsidian: string } {
  const jsonPath = resolve(args.outDir, `${artifact.date}.json`);
  if (!existsSync(dirname(jsonPath))) mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + '\n');

  const obsidianName = artifact.conference
    ? `${artifact.date}-${artifact.conference.slug}.md`
    : `${artifact.date}.md`;
  const obsidianPath = resolve(args.obsidianDir, obsidianName);
  if (!existsSync(dirname(obsidianPath))) mkdirSync(dirname(obsidianPath), { recursive: true });
  writeFileSync(obsidianPath, renderObsidian(artifact, { publicSiteUrl: process.env.PUBLIC_SITE_URL }));

  return { json: jsonPath, obsidian: obsidianPath };
}

async function buildOneDate(args: Args, db: ReturnType<typeof openDb>, date: string): Promise<void> {
  const allForDate = listBookmarks(db, { bookmark_date: date });
  if (allForDate.length === 0) {
    console.log(`${date}: no bookmarks, skipping.`);
    return;
  }

  await ensureTweetData(db, allForDate, args.skipFetch);

  // Re-read after the fetch step may have updated rows.
  const bookmarks = listBookmarks(db, { bookmark_date: date }).filter(
    (b) => (b.tweet_text || '').trim().length > 0,
  );
  if (bookmarks.length === 0) {
    console.warn(`${date}: no bookmarks with usable text after fetch; skipping.`);
    return;
  }

  const confSlug = dominantConferenceForDate(db, date);
  const conference = confSlug ? getConference(db, confSlug) : undefined;
  const confMeta = conference ? { slug: conference.slug, name: conference.name } : null;

  console.log(
    `${date}${confMeta ? ` · ${confMeta.name}` : ''}: ${bookmarks.length} bookmark(s) → digest`,
  );

  const inputs = toDigestInput(bookmarks);
  let digest: DigestOutput;
  if (args.dryRun) {
    digest = {
      tldr: '[dry-run] LLM not called',
      clusters: [
        {
          topic: '[dry-run]',
          summary: `${inputs.length} bookmarks would be processed.`,
          tweet_ids: inputs.map((t) => t.id),
        },
      ],
    };
  } else {
    digest = await buildDigest(inputs, {
      conferenceName: confMeta?.name ?? `Day digest — ${date}`,
      conferenceDay: date,
    });
  }

  const artifact = buildArtifact(date, confMeta, bookmarks, digest);
  const paths = writeArtifact(args, artifact);
  console.log(`  wrote ${paths.json}`);
  console.log(`  wrote ${paths.obsidian}`);
}

function pickDatesToBuild(db: ReturnType<typeof openDb>, args: Args): string[] {
  if (args.backfill) {
    const dates = listBookmarkDates(db);
    if (args.conferenceSlug) {
      return dates.filter((d) => dominantConferenceForDate(db, d) === args.conferenceSlug);
    }
    return dates;
  }
  if (args.conferenceSlug && !args.date) {
    // Build every date for this conference.
    return listBookmarkDates(db).filter(
      (d) => dominantConferenceForDate(db, d) === args.conferenceSlug,
    );
  }
  return [args.date ?? todayIso()];
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();
  const dates = pickDatesToBuild(db, args);
  if (dates.length === 0) {
    console.error('No dates to build. Did you add any bookmarks?');
    process.exit(1);
  }
  console.log(`Building ${dates.length} date(s): ${dates.join(', ')}`);
  for (const date of dates) {
    await buildOneDate(args, db, date);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
