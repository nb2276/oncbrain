// CLI: process pending items in the inbox_items queue.
//
// Reads pending/failed items, dispatches to type-specific enrichment
// (tweet → bookmarks; paper → papers; slide → slide_uploads), updates
// inbox state. Idempotent: re-running is safe because (a) bookmarks have
// UNIQUE(url), (b) markInbox* updates by id, (c) max-attempts cap prevents
// runaway retry loops.
//
// Usage:
//   npm run enrich:inbox                    # process all pending/failed
//   npm run enrich:inbox -- --type=tweet    # only tweet items
//   npm run enrich:inbox -- --max-attempts=N  # override retry cap (default 5)
//   npm run enrich:inbox -- --dry-run       # print queue depth, do nothing

import 'dotenv/config';
import {
  openDb,
  listInboxItemsForEnrichment,
  countInboxByStatus,
  type InboxItem,
} from '../src/lib/db.ts';
import { runEnrichmentLoop } from '../src/lib/inbox-enrichment.ts';

type Args = {
  type?: InboxItem['type'];
  maxAttempts?: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]!] = m[2] ?? true;
  }
  const typeArg = typeof args.type === 'string' ? args.type : undefined;
  if (typeArg && !['tweet', 'paper', 'slide'].includes(typeArg)) {
    throw new Error(`--type must be tweet | paper | slide, got: ${typeArg}`);
  }
  const maxAttemptsArg =
    typeof args['max-attempts'] === 'string' ? parseInt(args['max-attempts'], 10) : undefined;
  return {
    type: typeArg as InboxItem['type'] | undefined,
    maxAttempts: maxAttemptsArg,
    dryRun: !!args['dry-run'],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  const before = countInboxByStatus(db);
  console.log(
    `Inbox status: pending=${before.pending} enriched=${before.enriched} failed=${before.failed} deferred=${before.deferred}`,
  );

  const items = listInboxItemsForEnrichment(db, {
    type: args.type,
    maxAttempts: args.maxAttempts,
  });
  if (items.length === 0) {
    console.log('Nothing to enrich.');
    return;
  }

  if (args.dryRun) {
    console.log(`[dry-run] would process ${items.length} item(s):`);
    for (const i of items) {
      console.log(`  #${i.id} ${i.type} ${i.raw_target} (attempts so far: ${i.enrichment_attempts})`);
    }
    return;
  }

  console.log(`Enriching ${items.length} item(s)...`);
  const result = await runEnrichmentLoop(db, items);
  console.log(
    `Done. enriched=${result.enriched} failed=${result.failed} deferred=${result.deferred} bookmarks-created=${result.bookmarksCreated}`,
  );
  console.log(`Next: \`npm run build:day\` to publish.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
