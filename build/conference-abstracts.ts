// v0.60: conference abstracts from a meeting portal (src/lib/conference-abstract.ts).
//
//   npm run conf:abstracts -- --index [--meeting=astro]
//       Crawl the portal's server-rendered abstract + poster listings into a
//       local title index (data/.cache/conference-index-<meeting>.json).
//   npm run conf:abstracts -- --match [--notify] [--meeting=astro]
//       Match every unresolved watch:doi entry's label against the index and
//       print candidates. With --notify, DM the curator each NEW top candidate.
//       CONFIRM-ONLY: nothing is ingested. The curator confirms by replying to
//       the bot with "<abstract link> <doi>", which ingests the abstract with
//       its DOI and retires the watch.
//   npm run conf:abstracts -- --ingest --url=<abstract link> [--doi=<doi>] [--date=YYYY-MM-DD] [--quiet]
//       Queue one confirmed abstract into the inbox (then `npm run enrich:inbox`).
//       --quiet: no curator chat on the item, so a bulk backfill sends no
//       per-item "Got it" DMs.
//
// The nightly cron runs `--match --notify`, so a watched DOI that never gets
// a Crossref abstract still surfaces as a one-tap confirmation.

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb, listDoiWatch, saveInboxItem, getCuratorChatId } from '../src/lib/db.ts';
import { ssrfSafeFetchText } from '../src/lib/ssrf-fetch.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';
import {
  ADAPTERS,
  adapterForUrl,
  rankListingMatches,
  type ConferenceAdapter,
  type ListingEntry,
} from '../src/lib/conference-abstract.ts';

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const CRAWL_DELAY_MS = 250;
const SYNTHETIC_MSG_ID = -1; // same convention as watch:doi: never a real Telegram id

type Args = {
  index: boolean;
  match: boolean;
  notify: boolean;
  ingest: boolean;
  dryRun: boolean;
  quiet: boolean;
  meeting: string;
  url?: string;
  doi?: string;
  date?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { index: false, match: false, notify: false, ingest: false, dryRun: false, quiet: false, meeting: 'astro' };
  for (const arg of argv) {
    if (arg === '--index') a.index = true;
    else if (arg === '--match') a.match = true;
    else if (arg === '--notify') a.notify = true;
    else if (arg === '--ingest') a.ingest = true;
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--quiet') a.quiet = true;
    else if (arg.startsWith('--meeting=')) a.meeting = arg.slice(10);
    else if (arg.startsWith('--url=')) a.url = arg.slice(6);
    else if (arg.startsWith('--doi=')) a.doi = arg.slice(6);
    else if (arg.startsWith('--date=')) a.date = arg.slice(7);
  }
  return a;
}

const indexPath = (meeting: string) => resolve(process.cwd(), `data/.cache/conference-index-${meeting}.json`);
const notifiedPath = (meeting: string) => resolve(process.cwd(), `data/.cache/conference-notified-${meeting}.json`);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildIndex(adapter: ConferenceAdapter): Promise<ListingEntry[]> {
  const pinned = { allowedHostSuffixes: [adapter.host] };
  const seen = new Map<string, ListingEntry>();
  for (const kind of ['abstracts', 'posters']) {
    const first = await ssrfSafeFetchText(`https://${adapter.host}/${kind}`, pinned);
    const last = adapter.lastListingPage(first);
    for (const e of adapter.parseListing(first)) seen.set(e.url, e);
    for (let p = 2; p <= last; p++) {
      await sleep(CRAWL_DELAY_MS);
      const pageUrl = `https://${adapter.host}/${kind}?page=${p}`;
      let html: string | null = null;
      for (let attempt = 1; attempt <= 2 && html === null; attempt++) {
        try {
          html = await ssrfSafeFetchText(pageUrl, pinned);
        } catch (err) {
          if (attempt === 2) console.warn(`  ${kind} page ${p}: ${(err as Error).message} (skipped)`);
          else await sleep(2000);
        }
      }
      if (html) for (const e of adapter.parseListing(html)) seen.set(e.url, e);
    }
    console.log(`  ${kind}: ${last} page(s), ${seen.size} abstract(s) indexed so far`);
  }
  return [...seen.values()];
}

async function loadIndex(adapter: ConferenceAdapter, meeting: string, refresh: boolean): Promise<ListingEntry[]> {
  const cached = readJson<{ fetched_at: number; entries: ListingEntry[] } | null>(indexPath(meeting), null);
  if (!refresh && cached && Date.now() - cached.fetched_at < INDEX_TTL_MS) return cached.entries;
  console.log(`Indexing ${adapter.host}…`);
  const entries = await buildIndex(adapter);
  writeJson(indexPath(meeting), { fetched_at: Date.now(), entries });
  return entries;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const adapter = ADAPTERS.find((a) => a.id === args.meeting);
  if (!adapter) throw new Error(`unknown meeting "${args.meeting}" (known: ${ADAPTERS.map((a) => a.id).join(', ')})`);
  const db = openDb();

  if (args.ingest) {
    if (!args.url || !adapterForUrl(args.url)) throw new Error('--ingest needs --url=<a portal abstract link>');
    const date = args.date ?? new Date().toLocaleDateString('en-CA');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
    const r = saveInboxItem(db, {
      type: 'paper',
      raw_target: args.url,
      raw_message_text: [args.url, args.doi].filter(Boolean).join(' '),
      telegram_msg_id: SYNTHETIC_MSG_ID,
      telegram_chat_id: args.quiet ? null : getCuratorChatId(db),
      bookmark_date: date,
    });
    console.log(`${r.created ? 'queued' : 'already queued'} inbox #${r.id} for ${date}. Next: npm run enrich:inbox`);
    return;
  }

  if (args.index) {
    const entries = await loadIndex(adapter, args.meeting, true);
    console.log(`Indexed ${entries.length} abstract(s) → ${indexPath(args.meeting)}`);
    if (!args.match) return;
  }

  if (args.match) {
    const watched = listDoiWatch(db);
    if (watched.length === 0) {
      console.log('conf:abstracts --match — nothing watched');
      return;
    }
    const entries = await loadIndex(adapter, args.meeting, false);
    const notified = readJson<Record<string, string>>(notifiedPath(args.meeting), {});
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getCuratorChatId(db);
    let found = 0;
    let dmd = 0;
    for (const w of watched) {
      const label = w.title ?? '';
      const hits = label ? rankListingMatches(label, entries) : [];
      if (hits.length === 0) {
        console.log(`  ${w.doi}  ${label.slice(0, 60)}  → no portal match`);
        continue;
      }
      found++;
      const top = hits[0]!;
      console.log(`  ${w.doi}  ${label.slice(0, 60)}`);
      for (const h of hits) console.log(`      [${h.score}] #${h.number} ${h.title.slice(0, 90)}\n          ${h.url}`);
      // One DM per (doi, candidate): a re-run never re-sends the same suggestion.
      if (args.notify && !args.dryRun && notified[w.doi] !== top.url && token && chatId != null) {
        const text =
          `Possible ${adapter.id.toUpperCase()} portal match for watched DOI ${w.doi} (${label}):\n` +
          `#${top.number} ${top.title}\n\n` +
          `If it's right, reply with this line to ingest it:\n${top.url} ${w.doi}`;
        try {
          await sendMessage(token, chatId, text, { disableWebPagePreview: true });
          notified[w.doi] = top.url;
          dmd++;
        } catch (err) {
          console.warn(`  failed to DM ${w.doi}: ${(err as Error).message}`);
        }
      }
    }
    if (dmd > 0) writeJson(notifiedPath(args.meeting), notified);
    console.log(`conf:abstracts --match — ${watched.length} watched, ${found} with portal candidates, ${dmd} DM'd`);
    return;
  }

  console.log('usage: npm run conf:abstracts -- (--index | --match [--notify] | --ingest --url=<link> [--doi=<doi>] [--date=YYYY-MM-DD])');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

