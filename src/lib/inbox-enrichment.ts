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
import { extractCuratorNote, sendMessage } from './telegram-ingest.ts';
import { fetchPubMedPaper, PubMedClientError } from './pubmed-client.ts';
import { classifyPaperTarget } from './paper-url.ts';
import { ssrfSafeFetchText, SsrfError } from './ssrf-fetch.ts';
import { extractPaperMeta, MetaNotFoundError } from './html-meta.ts';
import { fetchCrossrefPaper, CrossrefError } from './crossref-client.ts';
import type { NewPaper } from './db.ts';
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

// v0.8: raw_target can be a bare PMID (legacy ingest), a DOI, a PMC/journal
// URL, or a bare DOI. Resolution runs HERE (at enrichment) so HTTP failures
// retry instead of dropping the message (eng-review decision 1). Branches:
//   PMID → PubMed efetch (existing)
//   DOI  → Crossref (abstract often null)
//   URL  → SSRF-safe fetch → Highwire meta → PMID? PubMed : DOI? Crossref :
//          save from meta alone
async function enrichPaperItem(
  db: Database.Database,
  item: InboxItem,
): Promise<EnrichmentResult> {
  const note = item.raw_message_text ? extractCuratorNote(item.raw_message_text) : null;
  const target = classifyPaperTarget(item.raw_target);
  if (!target) {
    await replyToCurator(item, `Couldn't recognize a paper in: ${item.raw_target.slice(0, 80)}`);
    return { status: 'failed', reason: `unrecognized paper target: ${item.raw_target}` };
  }

  let saveInput: NewPaper;
  try {
    saveInput =
      target.kind === 'pmid'
        ? await resolveFromPubMed(target.value, item, note)
        : target.kind === 'doi'
          ? await resolveFromDoi(target.value, item, note)
          : await resolveFromUrl(
              target.kind === 'pmc'
                ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${target.value}/`
                : target.value,
              item,
              note,
            );
  } catch (err) {
    const { retryable, message } = classifyResolveError(err);
    // Only reply on a PERMANENT failure — a transient network blip retries
    // silently, and double-replying on every retry would spam the curator.
    if (!retryable) {
      await replyToCurator(item, `Couldn't ingest that paper: ${message}`);
    }
    return { status: 'failed', reason: message };
  }

  try {
    const r = savePaper(db, saveInput);
    await replyToCurator(
      item,
      `Got it: ${saveInput.title}${saveInput.abstract ? '' : ' (no abstract available)'}. Appears in the next digest.`,
    );
    return { status: 'enriched', enrichedRowId: r.id, bookmarkCreated: r.created };
  } catch (err) {
    return { status: 'failed', reason: `paper insert failed: ${(err as Error).message}` };
  }
}

async function resolveFromPubMed(
  pmid: string,
  item: InboxItem,
  note: string | null,
): Promise<NewPaper> {
  const fetched = await fetchPubMedPaper(pmid);
  return {
    pmid: fetched.metadata.pmid,
    doi: fetched.metadata.doi,
    pmc_id: fetched.metadata.pmc_id,
    source_url: item.raw_target.startsWith('http') ? item.raw_target : null,
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
  };
}

async function resolveFromDoi(
  doi: string,
  item: InboxItem,
  note: string | null,
): Promise<NewPaper> {
  const p = await fetchCrossrefPaper(doi);
  if (!p.title) throw new CrossrefError('Crossref returned no title', 'parse');
  return {
    doi: p.doi,
    source_url: item.raw_target.startsWith('http') ? item.raw_target : null,
    title: p.title,
    authors_json: JSON.stringify(p.authors.map((a) => ({ name: a.name }))),
    journal: p.journal,
    pub_date: p.pub_date,
    abstract: p.abstract, // often null — handled downstream
    bookmark_date: item.bookmark_date,
    curator_note: note,
    inbox_item_id: item.id,
    fetched_via: 'crossref',
  };
}

async function resolveFromUrl(
  url: string,
  item: InboxItem,
  note: string | null,
): Promise<NewPaper> {
  const html = await ssrfSafeFetchText(url);
  const meta = extractPaperMeta(html); // throws MetaNotFoundError if no anchor
  // Prefer PubMed (richest) when the page exposed a PMID, then Crossref for a
  // DOI, then fall back to the page's own meta tags.
  if (meta.pmid) {
    try {
      return { ...(await resolveFromPubMed(meta.pmid, item, note)), source_url: url };
    } catch {
      // PubMed failed but we still have page meta — fall through.
    }
  }
  if (meta.doi) {
    try {
      return { ...(await resolveFromDoi(meta.doi, item, note)), source_url: url };
    } catch {
      // Crossref failed but we still have page meta — fall through.
    }
  }
  if (!meta.doi && !meta.pmid) {
    // Need at least one identifier for the papers CHECK + dedup key.
    throw new MetaNotFoundError('page had a title but no DOI or PMID to key on');
  }
  return {
    pmid: meta.pmid,
    doi: meta.doi,
    source_url: url,
    title: meta.title ?? '(untitled)',
    authors_json: JSON.stringify(meta.authors.map((name) => ({ name }))),
    journal: meta.journal,
    pub_date: meta.pub_date,
    abstract: null,
    bookmark_date: item.bookmark_date,
    curator_note: note,
    inbox_item_id: item.id,
    fetched_via: 'html_meta',
  };
}

// Map a resolution error to {retryable, message}. Network/rate-limit kinds
// retry on the next enrich:inbox run; everything else is permanent and earns
// a curator-facing E3 reply.
function classifyResolveError(err: unknown): { retryable: boolean; message: string } {
  if (err instanceof PubMedClientError) {
    return { retryable: err.kind === 'network' || err.kind === 'rate_limit', message: `${err.kind}: ${err.message}` };
  }
  if (err instanceof CrossrefError) {
    return { retryable: err.kind === 'network' || err.kind === 'rate_limit', message: `crossref ${err.kind}: ${err.message}` };
  }
  if (err instanceof SsrfError) {
    // A blocked/refused fetch won't get better on retry — permanent.
    return { retryable: false, message: `fetch refused: ${err.message}` };
  }
  if (err instanceof MetaNotFoundError) {
    return { retryable: false, message: 'no paper metadata on that page (paywall or non-article URL?)' };
  }
  return { retryable: false, message: `unexpected: ${(err as Error).message}` };
}

// Best-effort E2/E3 reply to the curator's Telegram chat. Never throws — a
// failed reply must not fail the enrichment.
async function replyToCurator(item: InboxItem, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || item.telegram_chat_id == null) return;
  try {
    await sendMessage(token, item.telegram_chat_id, text);
  } catch {
    // swallow — the digest still gets the paper; the reply is a courtesy
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
