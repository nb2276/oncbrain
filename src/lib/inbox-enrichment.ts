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
  savePaper,
  saveSlideUpload,
  markInboxEnriched,
  markInboxFailed,
  type InboxItem,
} from './db.ts';
import { fetchTweet, TweetFetchError } from './twitter-fetch.ts';
import { extractCuratorNote } from './telegram-ingest.ts';
import { fetchPubMedPaper, PubMedClientError } from './pubmed-client.ts';
import {
  downloadTelegramFile,
  saveSlidePhotoBytes,
  TelegramFileError,
} from './slide-photo-storage.ts';
import { ocrFile, isOcrAvailable } from './vision-ocr.ts';
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
      return enrichPaperItem(db, item);
    case 'slide':
      return enrichSlideItem(db, item);
    default:
      return { status: 'failed', reason: `unknown inbox item type: ${item.type}` };
  }
}

async function enrichSlideItem(
  db: Database.Database,
  item: InboxItem,
): Promise<EnrichmentResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return {
      status: 'failed',
      reason: 'TELEGRAM_BOT_TOKEN missing — cannot download slide bytes',
    };
  }
  if (!isOcrAvailable()) {
    // Without OCR, the slide is just bytes — not useful for the pipeline.
    // Defer so the next run on a macOS+vision machine picks it up.
    return {
      status: 'deferred',
      reason: 'vision-ocr binary unavailable — defer slide enrichment until OCR is set up',
    };
  }
  const fileId = item.raw_target;
  const note = item.raw_message_text ? extractCuratorNote(item.raw_message_text) : null;

  let downloaded;
  try {
    downloaded = await downloadTelegramFile(fileId, token);
  } catch (err) {
    if (err instanceof TelegramFileError) {
      return { status: 'failed', reason: `${err.kind}: ${err.message}` };
    }
    return { status: 'failed', reason: `unexpected download error: ${(err as Error).message}` };
  }

  let saved;
  try {
    saved = saveSlidePhotoBytes({
      buffer: downloaded.buffer,
      ext: downloaded.ext,
      bookmarkDate: item.bookmark_date,
    });
  } catch (err) {
    return { status: 'failed', reason: `disk save failed: ${(err as Error).message}` };
  }

  // OCR the saved file. Failure here is non-fatal — slide ships without
  // OCR text and the operator can manually re-OCR later via tooling.
  let ocrResult;
  try {
    ocrResult = await ocrFile(saved.absPath);
  } catch (err) {
    console.warn(`  [enrich] slide OCR failed: ${(err as Error).message}`);
    ocrResult = null;
  }

  // Parse dimensions from the inbox attachment metadata (the bot saw them
  // pre-download; we trust those over re-decoding the bytes).
  let width: number | null = null;
  let height: number | null = null;
  if (item.attachments_json) {
    try {
      const meta = JSON.parse(item.attachments_json) as { width?: number; height?: number };
      width = typeof meta.width === 'number' ? meta.width : null;
      height = typeof meta.height === 'number' ? meta.height : null;
    } catch {
      // Tolerate malformed metadata — width/height stay null
    }
  }

  try {
    const r = saveSlideUpload(db, {
      file_path: saved.relPath,
      file_hash: saved.hash,
      mime_type: downloaded.mime_type,
      width,
      height,
      ocr_text: ocrResult?.entry.text ?? null,
      ocr_version: ocrResult?.entry.version ?? null,
      bookmark_date: item.bookmark_date,
      curator_note: note,
      source_batch_key: null, // batched in pull-telegram; this column is set there
      inbox_item_id: item.id,
    });
    return { status: 'enriched', enrichedRowId: r.id, bookmarkCreated: r.created };
  } catch (err) {
    return { status: 'failed', reason: `slide row insert failed: ${(err as Error).message}` };
  }
}

async function enrichPaperItem(
  db: Database.Database,
  item: InboxItem,
): Promise<EnrichmentResult> {
  const pmid = item.raw_target;
  const note = item.raw_message_text ? extractCuratorNote(item.raw_message_text) : null;

  let fetched;
  try {
    fetched = await fetchPubMedPaper(pmid);
  } catch (err) {
    if (err instanceof PubMedClientError) {
      // Retryable kinds (rate_limit, network) leave the inbox item to retry
      // on next enrich:inbox call. Permanent kinds (not_found, parse) still
      // mark failed — there's no recoverable path.
      return { status: 'failed', reason: `${err.kind}: ${err.message}` };
    }
    return { status: 'failed', reason: `unexpected pubmed error: ${(err as Error).message}` };
  }

  try {
    const r = savePaper(db, {
      pmid: fetched.metadata.pmid,
      doi: fetched.metadata.doi,
      pmc_id: fetched.metadata.pmc_id,
      title: fetched.metadata.title,
      authors_json: JSON.stringify(fetched.metadata.authors),
      journal: fetched.metadata.journal,
      pub_date: fetched.metadata.pub_date,
      abstract: fetched.abstract,
      fulltext_excerpt_md: fetched.fulltext_excerpt_md,
      mesh_terms_json: JSON.stringify(fetched.metadata.mesh_terms),
      bookmark_date: item.bookmark_date,
      curator_note: note,
      inbox_item_id: item.id,
      fetched_via: 'pubmed_efetch',
    });
    return { status: 'enriched', enrichedRowId: r.id, bookmarkCreated: r.created };
  } catch (err) {
    return { status: 'failed', reason: `paper insert failed: ${(err as Error).message}` };
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
