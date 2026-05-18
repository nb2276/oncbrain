// CLI: poll Telegram for new bot messages, extract tweet URLs, save as bookmarks.
//
// Usage:
//   npm run pull:telegram                  # poll once, save new bookmarks
//   npm run pull:telegram -- --since-zero  # reset offset (re-process all history)
//   npm run pull:telegram -- --dry-run     # print what would happen, do not write

import 'dotenv/config';
import {
  openDb,
  saveBookmark,
  getSetting,
  setSetting,
  todayIso,
} from '../src/lib/db.ts';
import {
  fetchUpdates,
  extractTweetUrls,
  messageOf,
  unixToLocalDate,
} from '../src/lib/telegram-ingest.ts';

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

  let saved = 0;
  let skippedNoUrl = 0;
  let skippedDuplicate = 0;
  let maxUpdateId = offset ?? 0;

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id + 1);
    const msg = messageOf(update);
    if (!msg) continue;

    const text = msg.text ?? msg.caption ?? '';
    const entities = msg.entities ?? msg.caption_entities ?? [];
    const urls = extractTweetUrls(text, entities);

    if (urls.length === 0) {
      skippedNoUrl++;
      continue;
    }

    const date = unixToLocalDate(msg.date);
    const noteMatch = text.match(/^\/note\s+(.+)/i);
    const note = noteMatch ? noteMatch[1]!.trim() : null;

    for (const url of urls) {
      if (args.dryRun) {
        console.log(`  [dry-run] would save: ${date} ${url}${note ? ` (note: ${note})` : ''}`);
        saved++;
        continue;
      }
      try {
        const r = saveBookmark(db, {
          url,
          bookmark_date: date,
          notes: note,
          fetched_via: 'pending',
        });
        if (r.created) {
          console.log(`  saved #${r.id}: ${date} ${url}`);
          saved++;
        } else {
          skippedDuplicate++;
        }
      } catch (err) {
        console.warn(`  failed to save ${url}: ${(err as Error).message}`);
      }
    }
  }

  if (!args.dryRun && maxUpdateId > (offset ?? 0)) {
    setSetting(db, OFFSET_KEY, String(maxUpdateId));
  }

  console.log(
    `Done. saved=${saved} duplicate=${skippedDuplicate} no-url=${skippedNoUrl} next-offset=${maxUpdateId}`,
  );
  console.log(`Next: run \`npm run build:day\` to publish today's digest (${todayIso()}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
