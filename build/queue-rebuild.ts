// npm run queue:rebuild -- --date=YYYY-MM-DD [--reason="..."]
//
// Put one date on the rebuild_queue so the next `rebuild:queued` drain builds it.
//
// The nightly cron calls this for a date whose own build:day stage FAILED. Before
// it did, a failed build stranded its sources: the cron only ever targets today
// and yesterday, and nothing else queues a date whose build simply broke. The
// TORPEdO paper (2026-09-09) sat unpublished for five days after one build hit
// the claude-cli session limit — the run logged the failure, the next night's
// window had already moved on, and the queue was empty.
//
// The drain owns retry policy (attempts cap, dead-letter, compare-and-delete), so
// this only enqueues.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, queueRebuild } from '../src/lib/db.ts';

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function main(): void {
  const date = argValue('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('queue:rebuild — --date=YYYY-MM-DD is required');
    process.exitCode = 2;
    return;
  }
  const reason = argValue('reason') || 'queued manually';
  const db = openDb();
  queueRebuild(db, date, reason);
  db.close();
  console.log(`queue:rebuild — queued ${date} (${reason})`);
}

// Same import guard as rebuild-queued.ts: importing a CLI must never touch the DB.
function isInvokedAsScript(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isInvokedAsScript()) main();
