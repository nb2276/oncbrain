// CLI: poll Telegram for new bot messages, write each detected ingestable
// (tweet URL, paper URL/citation, image attachment) to inbox_items.
//
// v0.5 split:
//   - pull:telegram does ONLY inbox writes + offset advance. No enrichment.
//   - enrich:inbox processes pending inbox_items into bookmarks/papers/slides.
//
// Why split: codex P0 #1 — if enrichment (NCBI fetch, OCR) is inline and
// fails transiently, the Telegram offset advances and the message is lost.
// Inbox-first decouples; failed enrichment retries on the next enrich run.
//
// Usage:
//   npm run pull:telegram                  # poll once, save new inbox items
//   npm run pull:telegram -- --since-zero  # reset offset (re-process history)
//   npm run pull:telegram -- --dry-run     # show what would be saved, no write

import 'dotenv/config';
import {
  openDb,
  saveInboxItem,
  getSetting,
  setSetting,
} from '../src/lib/db.ts';
import {
  fetchUpdates,
  extractTweetUrls,
  extractPaperPmids,
  extractSlidePhoto,
  messageOf,
  unixToLocalDate,
} from '../src/lib/telegram-ingest.ts';
import { extractPaperUrls } from '../src/lib/paper-url.ts';

const OFFSET_KEY = 'telegram_offset';

type Args = {
  sinceZero: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]!] = m[2] ?? true;
  }
  return {
    sinceZero: !!args['since-zero'],
    dryRun: !!args['dry-run'],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Missing TELEGRAM_BOT_TOKEN. Add it to .env (from @BotFather).');
    process.exit(1);
  }

  const db = openDb();
  const storedOffset = getSetting(db, OFFSET_KEY);
  const offset = args.sinceZero ? 0 : storedOffset ? parseInt(storedOffset, 10) : undefined;

  console.log(`Polling Telegram (offset=${offset ?? 'none'})${args.dryRun ? ' [dry-run]' : ''}...`);

  const updates = await fetchUpdates(token, { offset });
  if (updates.length === 0) {
    console.log('No new updates.');
    return;
  }

  let savedTweets = 0;
  let savedPapers = 0;
  let savedSlides = 0;
  let skippedDuplicate = 0;
  let skippedNoTarget = 0;
  let maxUpdateId = offset ?? 0;

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id + 1);
    const msg = messageOf(update);
    if (!msg) continue;

    const text = msg.text ?? msg.caption ?? '';
    const entities = msg.entities ?? msg.caption_entities ?? [];
    const date = unixToLocalDate(msg.date);

    // v0.5: tweet URLs + PubMed PMIDs + slide photos.
    // v0.8: also DOI/journal/PMC URLs (resolved at enrichment, not here).
    const tweetUrls = extractTweetUrls(text, entities);
    const paperPmids = extractPaperPmids(text, entities);
    const paperUrls = extractPaperUrls(text, entities);
    const slidePhoto = extractSlidePhoto(msg);

    if (
      tweetUrls.length === 0 &&
      paperPmids.length === 0 &&
      paperUrls.length === 0 &&
      !slidePhoto
    ) {
      skippedNoTarget++;
      continue;
    }

    for (const url of tweetUrls) {
      if (args.dryRun) {
        console.log(`  [dry-run] would inbox: msg=${msg.message_id} type=tweet target=${url}`);
        savedTweets++;
        continue;
      }
      try {
        const r = saveInboxItem(db, {
          type: 'tweet',
          raw_target: url,
          raw_message_text: text || null,
          telegram_msg_id: msg.message_id,
          telegram_chat_id: msg.chat?.id ?? null,
          bookmark_date: date,
        });
        if (r.created) {
          console.log(`  inbox #${r.id}: tweet ${date} ${url}`);
          savedTweets++;
        } else {
          skippedDuplicate++;
        }
      } catch (err) {
        console.warn(`  failed to inbox ${url}: ${(err as Error).message}`);
      }
    }

    for (const pmid of paperPmids) {
      if (args.dryRun) {
        console.log(`  [dry-run] would inbox: msg=${msg.message_id} type=paper pmid=${pmid}`);
        savedPapers++;
        continue;
      }
      try {
        const r = saveInboxItem(db, {
          type: 'paper',
          raw_target: pmid,
          raw_message_text: text || null,
          telegram_msg_id: msg.message_id,
          telegram_chat_id: msg.chat?.id ?? null,
          bookmark_date: date,
        });
        if (r.created) {
          console.log(`  inbox #${r.id}: paper ${date} PMID:${pmid}`);
          savedPapers++;
        } else {
          skippedDuplicate++;
        }
      } catch (err) {
        console.warn(`  failed to inbox PMID:${pmid}: ${(err as Error).message}`);
      }
    }

    // v0.8: DOI/journal/PMC URLs. Stored raw as type=paper; classified +
    // resolved (fetch + meta + PubMed/Crossref) at enrich:inbox time.
    for (const url of paperUrls) {
      if (args.dryRun) {
        console.log(`  [dry-run] would inbox: msg=${msg.message_id} type=paper url=${url}`);
        savedPapers++;
        continue;
      }
      try {
        const r = saveInboxItem(db, {
          type: 'paper',
          raw_target: url,
          raw_message_text: text || null,
          telegram_msg_id: msg.message_id,
          telegram_chat_id: msg.chat?.id ?? null,
          bookmark_date: date,
        });
        if (r.created) {
          console.log(`  inbox #${r.id}: paper ${date} ${url}`);
          savedPapers++;
        } else {
          skippedDuplicate++;
        }
      } catch (err) {
        console.warn(`  failed to inbox ${url}: ${(err as Error).message}`);
      }
    }

    if (slidePhoto) {
      if (args.dryRun) {
        console.log(
          `  [dry-run] would inbox: msg=${msg.message_id} type=slide file_id=${slidePhoto.file_id} ${slidePhoto.width}x${slidePhoto.height}`,
        );
        savedSlides++;
      } else {
        try {
          const r = saveInboxItem(db, {
            type: 'slide',
            raw_target: slidePhoto.file_id,
            raw_message_text: text || null,
            attachments_json: JSON.stringify({
              file_unique_id: slidePhoto.file_unique_id,
              width: slidePhoto.width,
              height: slidePhoto.height,
              file_size: slidePhoto.file_size,
            }),
            telegram_msg_id: msg.message_id,
            telegram_chat_id: msg.chat?.id ?? null,
            // Multi-photo album messages share media_group_id — used in
            // Phase E to render multiple slides under one source card.
            source_batch_key: msg.media_group_id ?? null,
            bookmark_date: date,
          });
          if (r.created) {
            console.log(`  inbox #${r.id}: slide ${date} ${slidePhoto.width}x${slidePhoto.height}`);
            savedSlides++;
          } else {
            skippedDuplicate++;
          }
        } catch (err) {
          console.warn(`  failed to inbox slide ${slidePhoto.file_id}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (!args.dryRun && maxUpdateId > (offset ?? 0)) {
    setSetting(db, OFFSET_KEY, String(maxUpdateId));
  }

  console.log(
    `Done. inboxed-tweets=${savedTweets} inboxed-papers=${savedPapers} inboxed-slides=${savedSlides} duplicates=${skippedDuplicate} no-target=${skippedNoTarget} next-offset=${maxUpdateId}`,
  );
  console.log(`Next: \`npm run enrich:inbox\` to enrich pending items, then \`npm run build:day\`.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
