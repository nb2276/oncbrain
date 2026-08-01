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
import { openDb, getCuratorChatId } from '../src/lib/db.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';
import { getDiseaseSite } from '../src/lib/disease-sites.ts';
import { waitForDeployedDate } from '../src/lib/deploy-ready.ts';
import {
  parseNotifyArgs,
  siteUrlFromEnv,
  loadDigestArtifact,
  runNotifyCli,
} from '../src/lib/notify-cli.ts';

const LABEL = 'notify:curator';

type DigestArtifact = {
  date: string;
  // Build stamp, compared against the deployed page's <meta name="oncbrain:build">
  // so a re-rendered date isn't mistaken for its previous deploy. Optional: an
  // artifact written before the stamp existed falls back to existence-only.
  generated_at?: number;
  digest: {
    sites: Array<{
      disease_site: string;
      studies: Array<{
        name: string;
        // v0.37 (E5): set by the build when this trial's magnitude moved since
        // the digest last covered it.
        primary_endpoint?: { stat_value?: string | null } | null;
        prior_estimate?: { date: string; stat_value: string } | null;
      }>;
    }>;
  };
};

export function formatMessage(artifact: DigestArtifact, siteUrl: string): string {
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

  // v0.37 (E5), the detector half. A trial the digest already covered has come
  // back reporting a DIFFERENT number. That is the one thing in a routine build
  // worth reading the DM for, so it goes above the fold, before the site
  // breakdown. Silent on the overwhelmingly common day where nothing moved.
  const moved = sites
    .flatMap((s) => s.studies)
    .filter((st) => st.prior_estimate)
    .map((st) => `↻ ${st.name}: ${st.prior_estimate!.stat_value} → ${st.primary_endpoint?.stat_value ?? '?'} (was ${st.prior_estimate!.date})`);
  const movedBlock = moved.length ? `\n${moved.join('\n')}` : '';

  return `${header}${movedBlock}\n${breakdown}\n${url}`;
}

async function main(): Promise<void> {
  const args = parseNotifyArgs(process.argv);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const siteUrl = siteUrlFromEnv();

  if (!token) {
    console.log('notify:curator: TELEGRAM_BOT_TOKEN not set, skipping');
    return;
  }

  const artifact = loadDigestArtifact<DigestArtifact>(args.date, LABEL);
  if (!artifact) return;
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

// Script-only + fail-soft. See runNotifyCli: importing formatMessage() from a
// test must not run main() and DM the curator.
runNotifyCli(LABEL, import.meta.url, main);
