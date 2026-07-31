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
import { waitForDeployedDate } from '../src/lib/deploy-ready.ts';

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
  // generated_at isn't part of ChannelArtifact (the post doesn't render it); it's
  // read here only as the deploy-readiness build stamp.
  const artifact = JSON.parse(readFileSync(digestPath, 'utf8')) as ChannelArtifact & {
    generated_at?: number;
  };
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

  // The preview IS the product on this surface, so the channel SKIPS on timeout
  // rather than posting anyway. Posting before the page is live is the very act
  // that makes Telegram cache the catchall home page's default card, and that
  // cache is sticky — a wrong post is worse than a missing one here. The curator
  // DM makes the opposite call deliberately. See src/lib/deploy-ready.ts.
  const ready = await waitForDeployedDate(args.date, {
    siteUrl,
    expectBuildStamp: artifact.generated_at,
  });
  if (!ready.ready) {
    console.log(
      `notify:channel: page not confirmed live (${ready.reason}) — NOT posting ${args.date}. ` +
        `Posting now would cache a wrong preview. Re-run once the deploy lands: ` +
        `npm run notify:channel -- --date=${args.date}`,
    );
    // Exit NON-ZERO so the skip is loud. Everything else in this CLI is
    // fail-soft (exit 0) so the cron never aborts, but a skipped post is a
    // missed publication, not a handled error: the digest is live and nobody
    // was told. daily-build.sh wraps this call with `|| echo "⚠ …"`, so a
    // non-zero exit surfaces a warning line without stopping the run.
    process.exitCode = 1;
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
