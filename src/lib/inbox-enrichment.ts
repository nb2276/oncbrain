// Inbox enrichment dispatcher.
//
// pull:telegram writes raw items to inbox_items. enrich:inbox runs this
// dispatcher to convert pending items into bookmarks/papers/slide_uploads.
// Decoupling guarantees Telegram offset advances on inbox write, never on
// enrichment success — transient enrichment failures retry on the next
// enrich run without losing source messages (codex amended-plan P0 #1).
//
// Phase A scope: only `type='tweet'` items are processed. Papers and slides
// are out-of-scope until Phases B and C of v0.5 land. Items of those types
// in the queue are skipped with a clear log line and left at 'pending'.

import {
  saveBookmark,
  markInboxEnriched,
  markInboxFailed,
  type InboxItem,
} from './db.ts';
import { fetchTweet, TweetFetchError } from './twitter-fetch.ts';
import { extractCuratorNote } from './telegram-ingest.ts';
import type Database from 'better-sqlite3';

export type EnrichmentResult =
  | { status: 'enriched'; enrichedRowId: number; bookmarkCreated: boolean }
  | { status: 'failed'; reason: string }
  | { status: 'deferred'; reason: string };

export async function enrichInboxItem(
  db: Database.Database,
  item: InboxItem,
): Promise<EnrichmentResult> {
  switch (item.type) {
    case 'tweet':
      return enrichTweetItem(db, item);
    case 'paper':
      return {
        status: 'deferred',
        reason: 'paper enrichment lands in v0.5 Phase B (not yet implemented)',
      };
    case 'slide':
      return {
        status: 'deferred',
        reason: 'slide enrichment lands in v0.5 Phase C (not yet implemented)',
      };
    default:
      return { status: 'failed', reason: `unknown inbox item type: ${item.type}` };
  }
}

async function enrichTweetItem(
  db: Database.Database,
  item: InboxItem,
): Promise<EnrichmentResult> {
  const url = item.raw_target;
  const note = item.raw_message_text ? extractCuratorNote(item.raw_message_text) : null;

  // Two-step: (1) reserve a bookmark row in 'pending' state so a re-run is
  // a no-op if it already exists, (2) attempt oEmbed enrichment. If (2)
  // fails, the bookmark stays in 'pending' and the next build:day's
  // ensureTweetData() will retry from there. We don't have to drive that
  // here — same as the v0.4 flow.
  let bookmarkId: number;
  let bookmarkCreated: boolean;
  try {
    const r = saveBookmark(db, {
      url,
      bookmark_date: item.bookmark_date,
      notes: note,
      fetched_via: 'pending',
    });
    bookmarkId = r.id;
    bookmarkCreated = r.created;
  } catch (err) {
    return { status: 'failed', reason: `bookmark insert failed: ${(err as Error).message}` };
  }

  // Attempt oEmbed enrichment inline. Failures are non-fatal — bookmark
  // remains 'pending' and the next build:day retries. We still mark the
  // inbox item enriched so it doesn't loop forever; the bookmark itself
  // owns the retry state.
  try {
    const tweet = await fetchTweet(url);
    const { updateBookmarkFetched } = await import('./db.ts');
    updateBookmarkFetched(db, bookmarkId, {
      author_handle: tweet.author_handle,
      author_name: tweet.author_name,
      tweet_text: tweet.text,
      tweet_html: tweet.html,
      image_urls: tweet.image_urls,
    });
  } catch (err) {
    if (err instanceof TweetFetchError) {
      // Soft failure: bookmark stays 'pending'. Caller marks inbox enriched
      // anyway because we DID successfully insert into bookmarks; oEmbed
      // retry is the bookmark's responsibility now.
      console.warn(`  [enrich] tweet ${url} oEmbed deferred: ${err.kind}`);
    } else {
      // Hard failure (unexpected). Surface to caller.
      return {
        status: 'failed',
        reason: `unexpected tweet enrichment error: ${(err as Error).message}`,
      };
    }
  }

  return { status: 'enriched', enrichedRowId: bookmarkId, bookmarkCreated };
}

// Convenience wrapper for the enrich-inbox CLI. Walks items, calls handler,
// updates inbox_items rows according to the result. Returns counts.
export async function runEnrichmentLoop(
  db: Database.Database,
  items: InboxItem[],
): Promise<{
  enriched: number;
  failed: number;
  deferred: number;
  bookmarksCreated: number;
}> {
  let enriched = 0;
  let failed = 0;
  let deferred = 0;
  let bookmarksCreated = 0;

  for (const item of items) {
    const result = await enrichInboxItem(db, item);
    switch (result.status) {
      case 'enriched':
        markInboxEnriched(db, item.id, result.enrichedRowId);
        enriched++;
        if (result.bookmarkCreated) bookmarksCreated++;
        break;
      case 'failed':
        markInboxFailed(db, item.id, result.reason);
        failed++;
        console.warn(`  [enrich] item #${item.id} (${item.type}) failed: ${result.reason}`);
        break;
      case 'deferred':
        // Don't bump attempts; leave at 'pending' so the next phase can
        // pick it up when it lands. Log for visibility.
        deferred++;
        console.log(`  [enrich] item #${item.id} (${item.type}) deferred: ${result.reason}`);
        break;
    }
  }

  return { enriched, failed, deferred, bookmarksCreated };
}
