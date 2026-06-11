// CLI: post a day's digest to the public Telegram channel (v0.14.7 T5 — the
// distribution "cheap proof"). Reader-facing announcement (formatChannelPost),
// distinct from notify:curator (the curator's private "build done" DM).
//
// Config: TELEGRAM_CHANNEL_ID — a channel "@username" or numeric id. The bot
// (@oncbrain_bot) must be an ADMIN of that channel to post. Unset → skip, so
// the step ships DORMANT and lights up once the channel is set up.
//
// Usage:
//   npm run notify:channel                    # today
//   npm run notify:channel -- --date=YYYY-MM-DD
//   npm run notify:channel -- --dry-run       # print the message, don't send
//
// Fail-soft (exit 0) so the cron pipeline never aborts on a notify failure.
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { todayIso } from '../src/lib/db.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';
import { formatChannelPost, type ChannelArtifact } from '../src/lib/channel-post.ts';

type Args = { date: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let date = todayIso();
  let dryRun = false;
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'date' && m[2]) date = m[2];
    if (m[1] === 'dry-run') dryRun = true;
  }
  return { date, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://oncbrain.oncologytoolkit.com';

  const digestPath = resolve(`data/digests/${args.date}.json`);
  if (!existsSync(digestPath)) {
    console.log(`notify:channel: no digest at ${digestPath}, skipping`);
    return;
  }
  const artifact = JSON.parse(readFileSync(digestPath, 'utf8')) as ChannelArtifact;
  const text = formatChannelPost(artifact, siteUrl);

  if (args.dryRun) {
    console.log('--- dry run ---');
    console.log(text);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token) {
    console.log('notify:channel: TELEGRAM_BOT_TOKEN not set, skipping');
    return;
  }
  if (!channelId) {
    console.log('notify:channel: TELEGRAM_CHANNEL_ID not set, skipping (channel not configured yet)');
    return;
  }

  try {
    // Leave the web-page preview ON: Telegram renders the /<date>/ OG card (T4)
    // as a rich link preview under the message.
    await sendMessage(token, channelId, text);
    console.log(`notify:channel: posted ${args.date} to ${channelId}`);
  } catch (err) {
    console.log(`notify:channel: send failed (${(err as Error).message}), continuing`);
  }
}

main().catch((err) => {
  console.log(`notify:channel: unexpected error (${(err as Error).message}), continuing`);
});
