// CLI entry point: build one day's digest.
//
// Usage:
//   npm run build:day -- --conf=asco2026 --day=2
//   tsx build/digest-builder.ts --conf=asco2026 --day=2 [--dry-run] [--skip-fetch]
//
// Flow:
//   1. Read bookmarks from SQLite for the given conference + day.
//   2. For any bookmark with fetched_via='pending', try oEmbed. Save result back.
//      On oEmbed failure, leave the bookmark as-is — the curator should refill
//      via manual-paste mode in the admin form before rebuilding.
//   3. Run the LLM digest pipeline over the resulting tweet set.
//   4. Write the digest to data/digests/<slug>/day-<N>.json (committed artifact).
//
// The Astro build then reads these JSON files to produce static digest pages.
// This separation means re-running `astro build` is free (no LLM calls);
// you only pay for compute when you intentionally rebuild a day.

import 'dotenv/config';
import { openDb, listBookmarks, getConference } from '../src/lib/db.ts';
import { fetchTweet, TweetFetchError } from '../src/lib/twitter-fetch.ts';
import { buildDigest, type DigestInputTweet, type DigestOutput } from '../src/lib/llm-pipeline.ts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

type Args = {
  conferenceSlug: string;
  day: number;
  dryRun: boolean;
  skipFetch: boolean;
  outDir: string;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]!] = m[2] ?? true;
  }
  const conferenceSlug = String(args.conf || args.conference || '').trim();
  const day = parseInt(String(args.day || '0'), 10);
  if (!conferenceSlug) throw new Error('--conf=<slug> is required');
  if (!day || day < 1) throw new Error('--day=<N> is required and must be >= 1');
  return {
    conferenceSlug,
    day,
    dryRun: !!args['dry-run'],
    skipFetch: !!args['skip-fetch'],
    outDir: typeof args.out === 'string' ? args.out : 'data/digests',
  };
}

async function ensureTweetData(db: ReturnType<typeof openDb>, skipFetch: boolean): Promise<void> {
  if (skipFetch) return;
  const pending = db
    .prepare("SELECT id, url FROM bookmarks WHERE fetched_via = 'pending'")
    .all() as { id: number; url: string }[];

  if (pending.length === 0) return;
  console.log(`Fetching ${pending.length} pending tweet(s) via oEmbed...`);

  const update = db.prepare(
    `UPDATE bookmarks SET author_handle = ?, author_name = ?, tweet_text = ?, fetched_via = ? WHERE id = ?`,
  );

  for (const row of pending) {
    try {
      const tweet = await fetchTweet(row.url);
      update.run(tweet.author_handle, tweet.author_name, tweet.text, 'oembed', row.id);
      console.log(`  [oembed] #${row.id} ${row.url}`);
    } catch (err) {
      if (err instanceof TweetFetchError) {
        console.warn(`  [skip] #${row.id} ${err.kind}: ${row.url}`);
      } else {
        console.warn(`  [skip] #${row.id} unexpected error: ${(err as Error).message}`);
      }
    }
  }
}

function selectUsableBookmarks(db: ReturnType<typeof openDb>, slug: string, day: number) {
  const all = listBookmarks(db, { conference_slug: slug, day });
  // Keep bookmarks that have any usable text (either fetched or manually pasted).
  return all.filter((b) => (b.tweet_text || '').trim().length > 0);
}

function toDigestInput(bookmarks: ReturnType<typeof selectUsableBookmarks>): DigestInputTweet[] {
  return bookmarks.map((b) => ({
    id: b.id,
    author: b.author_handle ?? b.author_name ?? null,
    text: b.tweet_text!,
    note: b.notes,
  }));
}

type DigestArtifact = {
  conference: { slug: string; name: string; day: number };
  generated_at: number;
  digest: DigestOutput;
  bookmarks: Array<{
    id: number;
    url: string;
    author_handle: string | null;
    author_name: string | null;
    text: string;
    note: string | null;
    fetched_via: string;
  }>;
};

function buildArtifact(
  args: Args,
  conferenceName: string,
  bookmarks: ReturnType<typeof selectUsableBookmarks>,
  digest: DigestOutput,
): DigestArtifact {
  return {
    conference: { slug: args.conferenceSlug, name: conferenceName, day: args.day },
    generated_at: Date.now(),
    digest,
    bookmarks: bookmarks.map((b) => ({
      id: b.id,
      url: b.url,
      author_handle: b.author_handle,
      author_name: b.author_name,
      text: b.tweet_text!,
      note: b.notes,
      fetched_via: b.fetched_via,
    })),
  };
}

function writeArtifact(args: Args, artifact: DigestArtifact): string {
  const outPath = resolve(args.outDir, args.conferenceSlug, `day-${args.day}.json`);
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  const conference = getConference(db, args.conferenceSlug);
  if (!conference) {
    console.error(`Conference not found: ${args.conferenceSlug}. Add it via the admin /conferences page first.`);
    process.exit(1);
  }

  console.log(`Building digest: ${conference.name} — Day ${args.day}`);

  await ensureTweetData(db, args.skipFetch);

  const bookmarks = selectUsableBookmarks(db, args.conferenceSlug, args.day);
  if (bookmarks.length === 0) {
    console.error(`No usable bookmarks for ${args.conferenceSlug} day ${args.day}. Add some in the admin first.`);
    process.exit(1);
  }
  console.log(`  using ${bookmarks.length} bookmark(s) with text`);

  const inputs = toDigestInput(bookmarks);
  let digest: DigestOutput;
  if (args.dryRun) {
    console.log('  --dry-run: skipping LLM call');
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
      conferenceName: conference.name,
      conferenceDay: args.day,
    });
  }

  const artifact = buildArtifact(args, conference.name, bookmarks, digest);
  const outPath = writeArtifact(args, artifact);
  console.log(`Wrote ${outPath}`);
  console.log(`  TL;DR: ${digest.tldr}`);
  console.log(`  Clusters: ${digest.clusters.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
