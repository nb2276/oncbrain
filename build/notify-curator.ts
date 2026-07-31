// CLI: send a Telegram DM to the curator after a build with a one-glance
// summary of what shipped: date, study + site count, per-site emoji breakdown,
// and a deep link to the new digest.
//
// Reads the digest JSON from data/digests/<date>.json (so it works whether
// invoked right after build:day or independently).
//
// Usage:
//   npm run notify:curator                   # today's date
//   npm run notify:curator -- --date=YYYY-MM-DD
//   npm run notify:curator -- --dry-run      # print message, don't send
//
// Failure modes (all exit 0 so the cron pipeline doesn't abort):
//   - No TELEGRAM_BOT_TOKEN → skip with log line
//   - No chat_id in inbox_items (curator hasn't DM'd yet) → skip
//   - Digest file missing → skip
//   - Telegram API error → log and skip

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, getCuratorChatId, todayIso } from '../src/lib/db.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';
import { getDiseaseSite } from '../src/lib/disease-sites.ts';
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

type DigestArtifact = {
  date: string;
  // Build stamp, compared against the deployed page's <meta name="oncbrain:build">
  // so a re-rendered date isn't mistaken for its previous deploy. Optional: an
  // artifact written before the stamp existed falls back to existence-only.
  generated_at?: number;
  digest: {
    sites: Array<{
      disease_site: string;
      studies: Array<{ name: string }>;
    }>;
  };
};

function formatMessage(artifact: DigestArtifact, siteUrl: string): string {
  const sites = artifact.digest.sites.filter((s) => s.studies.length > 0);
  const totalStudies = sites.reduce((n, s) => n + s.studies.length, 0);
  const breakdown = sites
    .map((s) => {
      const meta = getDiseaseSite(s.disease_site);
      return `${meta.emoji} ${meta.label} (${s.studies.length})`;
    })
    .join(' · ');
  const url = `${siteUrl.replace(/\/$/, '')}/${artifact.date}/`;
  const header = `✓ ${artifact.date} built — ${totalStudies} ${totalStudies === 1 ? 'study' : 'studies'} across ${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`;
  return `${header}\n${breakdown}\n${url}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://oncbrain.oncologytoolkit.com';

  if (!token) {
    console.log('notify:curator: TELEGRAM_BOT_TOKEN not set, skipping');
    return;
  }

  const digestPath = resolve(`data/digests/${args.date}.json`);
  if (!existsSync(digestPath)) {
    console.log(`notify:curator: no digest at ${digestPath}, skipping`);
    return;
  }

  const artifact = JSON.parse(readFileSync(digestPath, 'utf8')) as DigestArtifact;
  const text = formatMessage(artifact, siteUrl);

  if (args.dryRun) {
    console.log('--- dry run ---');
    console.log(text);
    return;
  }

  const db = openDb();
  const chatId = getCuratorChatId(db);
  if (chatId == null) {
    console.log('notify:curator: no curator chat_id in inbox_items, skipping');
    return;
  }

  // Wait for the date page to actually be live before sending. Telegram builds
  // its link preview at send time, and an undeployed URL returns the catchall
  // home page (200), which Telegram then caches. See src/lib/deploy-ready.ts.
  //
  // The curator DM SENDS EVEN ON TIMEOUT: this is an operational "the build
  // ran" ping, and knowing that is worth more than the preview attached to it.
  // notify:channel makes the opposite call — see the comment there.
  const ready = await waitForDeployedDate(args.date, {
    siteUrl,
    expectBuildStamp: artifact.generated_at,
  });
  // When the page ISN'T confirmed live, send WITHOUT a link preview. Sending it
  // with previews on is what poisons Telegram's per-URL cache: Telegram fetches
  // the not-yet-deployed URL, gets the catchall home page, and caches that card
  // — and daily-build.sh runs notify:curator BEFORE notify:channel, so the DM
  // would poison the preview for the channel post that follows, even though the
  // channel correctly waits. Suppressing the preview here means the DM still
  // arrives (the operational ping is the point) while leaving the URL's cache
  // untouched for the channel.
  if (!ready.ready) {
    console.log(
      `notify:curator: page not confirmed live (${ready.reason}) — sending WITHOUT a link preview so Telegram's cache for this URL stays clean`,
    );
  }

  try {
    await sendMessage(token, chatId, text, { disableWebPagePreview: !ready.ready });
    console.log(`notify:curator: sent to chat ${chatId}`);
  } catch (err) {
    console.log(`notify:curator: send failed (${(err as Error).message}), continuing`);
  }
}

main().catch((err) => {
  console.log(`notify:curator: unexpected error (${(err as Error).message}), continuing`);
});
