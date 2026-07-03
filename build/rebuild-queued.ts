// npm run rebuild:queued — drain the rebuild_queue (src/lib/db.ts).
//
// Enrichment queues a date when a source gained richer data AFTER that date's
// digest was already published: a full-paper PDF that merged figures / full
// text onto a study first ingested as an abstract, or a late conference slide
// that arrived for a past date. Those upgrades sit in the DB but never reach the
// published card until the date is rebuilt. This drains the queue, rebuilds each
// queued date's digest JSON so the richer input reaches the study agent, and
// dequeues on success.
//
// Reuses the build:day CLI once per date (one child process each) so all of its
// arg / env (DIGEST_PERSPECTIVE, model overrides) / durable-override wiring
// applies exactly as a normal build. This writes only the digest JSON + Obsidian
// twin; run `npm run build` (Astro) afterward to regenerate the static site (the
// daily cron does that in its next stage).
//
// Flags:
//   --skip=YYYY-MM-DD,YYYY-MM-DD   dates the caller already rebuilt this run
//     (the cron passes today+yesterday). A skipped date is DEQUEUED, not left
//     pending: its fresh build already incorporated the merged data, so a
//     second drain rebuild would be a wasted, nondeterministic re-run (#A6).
//
// Robustness:
//   - Compare-and-delete on queued_at so a re-queue that lands mid-drain (a
//     newer richer merge) survives to the next run (#C1,A3).
//   - Attempts cap: a date whose build:day keeps failing (including for reasons
//     unrelated to the date, e.g. a whole-corpus assertion) is dead-lettered
//     after MAX_ATTEMPTS instead of burning an LLM build every night forever
//     (#A5).
//   - Best-effort lockfile so a manual drain doesn't run concurrently with the
//     cron drain (#A4). Stale locks (crashed drain) are reclaimed.
//
// Run by the daily cron (after enrich + the today/yesterday builds) and
// available manually: `npm run rebuild:queued`.
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, unlinkSync, statSync, writeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  listRebuildQueue,
  dequeueRebuild,
  bumpRebuildAttempt,
} from '../src/lib/db.ts';

// Give up on a date after this many failed rebuilds (dead-letter). Bounds the
// worst case where a date can never build (a persistent global build failure).
const MAX_ATTEMPTS = 3;
const LOCK_PATH = join(tmpdir(), 'oncbrain-rebuild-queued.lock');
// Reclaim only after 6h. A real drain (one build:day per queued date, minutes
// each) finishes well under this even for a large queue, so an ACTIVE drain is
// never reclaimed; only a genuinely crashed one is (codex re-review #P2).
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

// Our unique lock token, written into the lockfile so release/reclaim can verify
// ownership (never unlink a lock a different process holds).
const LOCK_TOKEN = `${process.pid}:${Date.now()}`;
let lockHeld = false;

// Acquire a best-effort ownership-verified exclusive lock. Returns true on
// success. A stale lock (older than LOCK_STALE_MS → a crashed drain) is
// reclaimed; the exclusive 'wx' create means only one racer wins the reclaim.
function acquireLock(): boolean {
  try {
    const fd = openSync(LOCK_PATH, 'wx'); // exclusive create; throws EEXIST if held
    writeSync(fd, LOCK_TOKEN);
    closeSync(fd);
    lockHeld = true;
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
      if (age > LOCK_STALE_MS) {
        unlinkSync(LOCK_PATH); // drop the crashed drain's stale lock, then re-race the create
        return acquireLock();
      }
    } catch {
      // lock vanished between the failed create and the stat — retry.
      return acquireLock();
    }
    return false;
  }
}

// Release only OUR lock: verify the file still carries our token before
// unlinking, so we never delete a lock a replacement drain now holds.
function releaseLock(): void {
  if (!lockHeld) return;
  try {
    if (readFileSync(LOCK_PATH, 'utf8') === LOCK_TOKEN) unlinkSync(LOCK_PATH);
  } catch {
    // already gone
  }
  lockHeld = false;
}

function parseSkip(): Set<string> {
  const arg = process.argv.find((a) => a.startsWith('--skip='));
  if (!arg) return new Set();
  return new Set(
    arg
      .slice('--skip='.length)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
  );
}

function main(): void {
  const db = openDb();
  const queued = listRebuildQueue(db);
  if (queued.length === 0) {
    console.log('rebuild:queued — queue empty, nothing to do.');
    return;
  }

  if (!acquireLock()) {
    console.warn(
      'rebuild:queued — another drain holds the lock (' + LOCK_PATH + '); skipping this run.',
    );
    return;
  }

  const skip = parseSkip();
  console.log(
    `rebuild:queued — draining ${queued.length} date(s): ${queued.map((q) => q.bookmark_date).join(', ')}` +
      (skip.size ? ` (skip: ${[...skip].join(', ')})` : ''),
  );

  let rebuilt = 0;
  let failed = 0;
  let skipped = 0;
  let deadLettered = 0;
  try {
    for (const q of queued) {
      // A date the caller already rebuilt this run (cron: today+yesterday). Its
      // fresh build incorporated the merged data, so drop it rather than re-run
      // a wasted, nondeterministic build. Compare-and-delete on queued_at.
      if (skip.has(q.bookmark_date)) {
        console.log(`\n⤼ skip ${q.bookmark_date} (already rebuilt this run)`);
        dequeueRebuild(db, q.bookmark_date, q.queued_at);
        skipped += 1;
        continue;
      }

      console.log(`\n▶ rebuild ${q.bookmark_date} (${q.reason ?? 'no reason recorded'})`);
      // Reuse the build:day CLI so overrides + perspective + model env all apply.
      const res = spawnSync('npm', ['run', 'build:day', '--', `--date=${q.bookmark_date}`], {
        stdio: 'inherit',
      });
      if (res.status === 0) {
        // Compare-and-delete: if enrichment re-queued this date mid-build, the
        // row now carries a newer queued_at and this DELETE no-ops, so the
        // fresher upgrade is rebuilt next run (#C1,A3).
        dequeueRebuild(db, q.bookmark_date, q.queued_at);
        rebuilt += 1;
      } else {
        const attempts = bumpRebuildAttempt(db, q.bookmark_date, q.queued_at);
        if (attempts >= MAX_ATTEMPTS) {
          // Dead-letter: compare-and-delete on the SAME generation we claimed
          // (codex re-review #P1). If a richer merge re-queued this date mid-
          // build, its new queued_at won't match and this no-ops, so the fresh
          // entry (attempts reset to 0) survives to be retried. Loud, not silent.
          dequeueRebuild(db, q.bookmark_date, q.queued_at);
          console.warn(
            `  ✗✗ rebuild FAILED ${attempts}x for ${q.bookmark_date} (exit ${res.status ?? 'signal'}); DEAD-LETTERED (dropped from queue). Rebuild it manually: npm run build:day -- --date=${q.bookmark_date}`,
          );
          deadLettered += 1;
        } else {
          console.warn(
            `  ✗ rebuild failed for ${q.bookmark_date} (exit ${res.status ?? 'signal'}, attempt ${attempts}/${MAX_ATTEMPTS}); left queued for retry`,
          );
          failed += 1;
        }
      }
    }
  } finally {
    releaseLock();
  }

  const remaining = listRebuildQueue(db).length;
  console.log(
    `\nrebuild:queued done — rebuilt ${rebuilt}, skipped ${skipped}, failed ${failed}, dead-lettered ${deadLettered}, remaining ${remaining}.`,
  );
  // Non-zero exit so the cron's exit-status guard surfaces a failure (retryable
  // or the final dead-letter run). Wired as a non-publish-gating stage, so this
  // never blocks committing today's fresh build.
  if (failed > 0 || deadLettered > 0) process.exitCode = 1;
}

main();
