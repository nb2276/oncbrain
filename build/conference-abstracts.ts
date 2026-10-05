// v0.60: conference abstracts from a meeting portal (src/lib/conference-abstract.ts).
//
//   npm run conf:abstracts -- --index [--meeting=astro]
//       Crawl the portal's server-rendered abstract + poster listings into a
//       local title index (data/.cache/conference-index-<meeting>.json).
//   npm run conf:abstracts -- --match [--notify] [--dry-run] [--meeting=astro]
//       Match every still-watched DOI from this meeting's journal against the
//       index and print candidates. With --notify, DM the curator each NEW
//       candidate (each DOI/candidate pair at most once, ever). CONFIRM-ONLY:
//       nothing is ingested. The curator confirms by replying to the bot with
//       exactly "<abstract link> <doi>", which ingests the abstract with its
//       DOI and retires the watch.
//   npm run conf:abstracts -- --ingest --url=<abstract link> [--doi=<doi>] [--date=YYYY-MM-DD] [--quiet] [--dry-run]
//       Queue one confirmed abstract into the inbox (then `npm run enrich:inbox`).
//       --quiet skips only the per-item "Got it" reply (a bulk backfill), never
//       the prior-coverage nudge. Re-running with a corrected --doi or --date
//       queues a new item; an identical re-run is a no-op.
//
// The nightly cron runs `--match --notify`, so a watched DOI that never gets a
// Crossref abstract still surfaces as a one-tap confirmation.

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb, listDoiWatch, saveInboxItem, getCuratorChatId } from '../src/lib/db.ts';
import { ssrfSafeFetchText } from '../src/lib/ssrf-fetch.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';
import { normalizeDoi } from '../src/lib/doi.ts';
import {
  ADAPTERS,
  adapterForUrl,
  planNotifications,
  rankListingMatches,
  watchedForMeeting,
  type ConferenceAdapter,
  type ListingEntry,
} from '../src/lib/conference-abstract.ts';

// Longer than the cron's 24h period on purpose: a 24h TTL expired a few
// seconds before every nightly run and re-crawled the portal each night.
const INDEX_TTL_MS = 36 * 60 * 60 * 1000;
const CRAWL_DELAY_MS = 250;
const LISTING_FETCH_ATTEMPTS = 2;
const LISTING_RETRY_DELAY_MS = 2000;
// Bounds on a crawl that runs inside the 1am cron, before enrichment and the
// build: a portal change (or a hostile page=999999 link) must not stall them.
const MAX_LISTING_PAGES = 200;
const CRAWL_BUDGET_MS = 5 * 60 * 1000;

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
const sentPath = (meeting: string) => resolve(process.cwd(), `data/.cache/conference-notified-${meeting}.json`);

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

async function buildIndex(adapter: ConferenceAdapter): Promise<{ entries: ListingEntry[]; complete: boolean }> {
  const pinned = { allowedHostSuffixes: [adapter.host] };
  const seen = new Map<string, ListingEntry>();
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  let complete = true;
  const fetchPage = async (url: string): Promise<string | null> => {
    for (let attempt = 1; attempt <= LISTING_FETCH_ATTEMPTS; attempt++) {
      try {
        return await ssrfSafeFetchText(url, pinned);
      } catch (err) {
        if (attempt === LISTING_FETCH_ATTEMPTS) console.warn(`  ${url}: ${(err as Error).message} (skipped)`);
        else await sleep(LISTING_RETRY_DELAY_MS);
      }
    }
    complete = false;
    return null;
  };
  for (const path of adapter.listingPaths) {
    const first = await fetchPage(`https://${adapter.host}/${path}`);
    if (!first) continue;
    let last = adapter.lastListingPage(first);
    if (last > MAX_LISTING_PAGES) {
      console.warn(`  ${path}: listing claims ${last} pages; capped at ${MAX_LISTING_PAGES}`);
      last = MAX_LISTING_PAGES;
      complete = false;
    }
    for (const e of adapter.parseListing(first)) seen.set(e.url, e);
    for (let p = 2; p <= last; p++) {
      if (Date.now() > deadline) {
        console.warn(`  crawl budget spent at ${path} page ${p}; index is partial`);
        return { entries: [...seen.values()], complete: false };
      }
      await sleep(CRAWL_DELAY_MS);
      const html = await fetchPage(`https://${adapter.host}/${path}?page=${p}`);
      if (html) for (const e of adapter.parseListing(html)) seen.set(e.url, e);
    }
    console.log(`  ${path}: ${last} page(s), ${seen.size} abstract(s) indexed so far`);
  }
  return { entries: [...seen.values()], complete };
}

async function loadIndex(adapter: ConferenceAdapter, meeting: string, refresh: boolean): Promise<ListingEntry[]> {
  const cached = readJson<{ fetched_at: number; entries: ListingEntry[] } | null>(indexPath(meeting), null);
  if (!refresh && cached && Date.now() - cached.fetched_at < INDEX_TTL_MS) return cached.entries;
  console.log(`Indexing ${adapter.host}…`);
  const { entries, complete } = await buildIndex(adapter);
  // A partial index is still useful tonight but must not be trusted for 36h.
  writeJson(indexPath(meeting), { fetched_at: complete ? Date.now() : 0, entries });
  return entries;
}

// Each distinct submission gets its own synthetic (negative) Telegram id, so a
// re-run with a corrected DOI or date is a NEW item rather than "already
// queued", while an identical re-run stays a no-op.
function syntheticMsgId(url: string, doi: string | null, date: string): number {
  const h = createHash('sha256').update(`${url}|${doi ?? ''}|${date}`).digest();
  return -(1 + (h.readUInt32BE(0) % 2_000_000_000));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const adapter = ADAPTERS.find((a) => a.id === args.meeting);
  if (!adapter) throw new Error(`unknown meeting "${args.meeting}" (known: ${ADAPTERS.map((a) => a.id).join(', ')})`);

  if (args.ingest) {
    if (!args.url || !adapterForUrl(args.url)) throw new Error('--ingest needs --url=<a portal abstract link>');
    const doi = args.doi ? normalizeDoi(args.doi) : null;
    if (args.doi && !doi) throw new Error(`--doi is not a DOI: ${args.doi}`);
    const date = args.date ?? new Date().toLocaleDateString('en-CA');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
    if (args.dryRun) {
      console.log(`[dry-run] would queue ${args.url}${doi ? ` with ${doi}` : ''} for ${date}; nothing written`);
      return;
    }
    const db = openDb();
    const r = saveInboxItem(db, {
      type: 'paper',
      raw_target: args.url,
      // The exact confirm form, so enrichment pairs the DOI with this abstract.
      raw_message_text: [args.url, doi].filter(Boolean).join(' '),
      attachments_json: args.quiet ? JSON.stringify({ quiet: true }) : null,
      telegram_msg_id: syntheticMsgId(args.url, doi, date),
      telegram_chat_id: getCuratorChatId(db),
      bookmark_date: date,
    });
    console.log(`${r.created ? 'queued' : 'already queued'} inbox #${r.id} for ${date}. Next: npm run enrich:inbox`);
    return;
  }

  const db = openDb();
  if (args.index) {
    const entries = await loadIndex(adapter, args.meeting, true);
    console.log(`Indexed ${entries.length} abstract(s) → ${indexPath(args.meeting)}`);
    if (!args.match) return;
  }

  if (args.match) {
    const watched = watchedForMeeting(adapter, listDoiWatch(db));
    if (watched.length === 0) {
      console.log(`conf:abstracts --match — no watched ${adapter.id.toUpperCase()} DOIs; nothing to crawl`);
      return;
    }
    // A confirm reply pulled tonight but not yet enriched: don't re-suggest it.
    const pending = new Set(
      (db
        .prepare("SELECT raw_message_text FROM inbox_items WHERE enrichment_status = 'pending' AND raw_message_text IS NOT NULL")
        .all() as Array<{ raw_message_text: string }>)
        .flatMap((r) => watched.filter((w) => r.raw_message_text.toLowerCase().includes(w.doi.toLowerCase())))
        .map((w) => w.doi.toLowerCase()),
    );
    const entries = await loadIndex(adapter, args.meeting, false);
    const sent = readJson<Record<string, string[]>>(sentPath(args.meeting), {});
    for (const w of watched) {
      const hits = rankListingMatches(w.title ?? '', entries);
      console.log(`  ${w.doi}  ${(w.title ?? '').slice(0, 60)}${hits.length === 0 ? '  → no portal match' : ''}`);
      for (const h of hits) console.log(`      [${h.score}] #${h.number} ${h.title.slice(0, 90)}\n          ${h.url}`);
    }
    const plan = planNotifications(adapter, watched, entries, sent, pending);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getCuratorChatId(db);
    let dmd = 0;
    if (args.notify && !args.dryRun && token && chatId != null) {
      for (const n of plan) {
        const text =
          `Possible ${adapter.id.toUpperCase()} portal match for watched DOI ${n.doi} (${n.label}):\n` +
          `#${n.candidate.number} ${n.candidate.title}\n\n` +
          `If it's right, reply with exactly this line to ingest it:\n${n.candidate.url} ${n.doi}`;
        try {
          await sendMessage(token, chatId, text, { disableWebPagePreview: true });
          sent[n.doi] = [...(sent[n.doi] ?? []), n.candidate.url];
          dmd++;
        } catch (err) {
          console.warn(`  failed to DM ${n.doi}: ${(err as Error).message}`);
        }
      }
      if (dmd > 0) writeJson(sentPath(args.meeting), sent);
    }
    console.log(
      `conf:abstracts --match — ${watched.length} watched, ${plan.length} new candidate(s), ${dmd} DM'd` +
        (args.dryRun ? ' [dry-run]' : ''),
    );
    return;
  }

  console.log(
    'usage: npm run conf:abstracts -- (--index | --match [--notify] [--dry-run] | --ingest --url=<link> [--doi=<doi>] [--date=YYYY-MM-DD] [--quiet] [--dry-run])',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
