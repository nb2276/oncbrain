// CLI: refuse to publish a digest that would REMOVE a study main already has.
//
// Runs inside the publish worktree, after the build has copied its artifacts in
// and before the commit. For each staged digest it compares the incoming file
// against main's committed version and, when the publish would remove content,
// RESTORES main's copy for that date and reports it.
//
// Restore-and-continue rather than abort-everything: the common case is one past
// date going wrong while today's digest is fine, and today's digest is the point
// of the nightly run. Main keeps what it had; the local branch keeps its version
// for inspection.
//
// Usage:
//   npx tsx build/verify-publish.ts --worktree=/path/to/publish-worktree
//
// Exit code is 0 even when dates are withheld — the pipeline should go on to
// publish the good ones. Withheld dates are printed and counted.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  studiesLostInPublish,
  publishRemovesContent,
  describePublishDiff,
} from '../src/lib/publish-diff.ts';

function git(wt: string, args: string[]): string {
  // stderr piped, not inherited: showHead probes for files HEAD may not have,
  // and a bare `fatal: path ... does not exist` in the cron log reads like a
  // failure when it is the expected answer.
  return execFileSync('git', ['-C', wt, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A file's content at HEAD, or null when HEAD does not have it. */
function showHead(wt: string, path: string): string | null {
  try {
    return git(wt, ['show', `HEAD:${path}`]);
  } catch {
    return null;
  }
}

function parse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Staged digest paths, as `data/digests/<date>.json`. */
export function stagedDigestPaths(wt: string): string[] {
  const out = git(wt, ['diff', '--cached', '--name-only', '--', 'data/digests']);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^data\/digests\/\d{4}-\d{2}-\d{2}\.json$/.test(s));
}

/**
 * Every OTHER staged file that belongs to this date, so a withheld date is
 * reverted as a unit.
 *
 * Today that is the Obsidian twin, which is committed alongside the artifact and
 * named `<date>.md` or `<date>-<conference>.md`. Derived from the staged set
 * rather than a hardcoded list so a future per-date committed file is caught by
 * the same sweep instead of quietly shipping half-reverted.
 */
export function stagedCompanionPaths(wt: string, date: string): string[] {
  const out = git(wt, ['diff', '--cached', '--name-only', '--', 'data']);
  const dateAnywhere = new RegExp(`(^|/)${date}(-[^/]*)?\\.[^/.]+$`);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !s.startsWith('data/digests/'))
    .filter((s) => dateAnywhere.test(s));
}

const stagedPathsForDate = stagedCompanionPaths;

function main(): void {
  const wtArg = process.argv.slice(2).find((a) => a.startsWith('--worktree='));
  const wt = wtArg?.split('=')[1];
  if (!wt || !existsSync(wt)) {
    console.error('verify-publish: --worktree=<path> is required and must exist');
    process.exit(2);
  }

  let withheld = 0;
  for (const path of stagedDigestPaths(wt)) {
    const date = path.slice('data/digests/'.length, -'.json'.length);
    const baseline = parse(showHead(wt, path));
    // No baseline means main has never published this date — nothing to lose.
    if (!baseline) continue;

    const incomingFile = join(wt, path);
    const incoming = parse(existsSync(incomingFile) ? readFileSync(incomingFile, 'utf8') : null);
    if (!incoming) continue;

    // Overrides as they will be published (staged if present, else HEAD's).
    const ovPath = `data/overrides/${date}.json`;
    const ovFile = join(wt, ovPath);
    const ov = parse(
      existsSync(ovFile) ? readFileSync(ovFile, 'utf8') : showHead(wt, ovPath),
    ) as { suppress?: string[] } | null;

    const diff = studiesLostInPublish({
      baseline,
      incoming,
      suppressed: Array.isArray(ov?.suppress) ? ov!.suppress : [],
    });
    if (!publishRemovesContent(diff)) continue;

    console.warn(`  ⚠ WITHHELD ${date} — this publish would remove live content:`);
    console.warn(describePublishDiff(date, diff));
    // Put main's version back so the commit carries no regression for this date.
    //
    // THE WHOLE DATE, NOT JUST THE JSON. A date publishes as a set: the digest
    // artifact plus its Obsidian markdown twin (`<date>.md`, or
    // `<date>-<conference>.md`), and both are committed in the same push.
    // Restoring only the artifact would ship main's studies next to the rejected
    // build's prose — a twin describing cards the artifact does not contain,
    // which is a worse state than either version alone.
    const companions = stagedPathsForDate(wt, date);
    let restored = 0;
    for (const p of [path, ...companions]) {
      try {
        git(wt, ['checkout', 'HEAD', '--', p]);
        restored += 1;
      } catch (err) {
        // A companion that HEAD does not have cannot be restored — unstage it so
        // it cannot ride along with the reverted artifact.
        try {
          git(wt, ['rm', '--cached', '-q', '--', p]);
          restored += 1;
        } catch {
          console.error(
            `  ✗ could not restore or unstage ${p}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (restored > 0) withheld += 1;
  }

  if (withheld > 0) {
    console.warn(
      `  ⚠ ${withheld} date(s) withheld from this publish. Main keeps its version. ` +
        `Rebuild them locally and inspect before publishing:\n` +
        `      npm run build:day -- --date=<date>`,
    );
  }
}

// Script-only: importing stagedDigestPaths from a test must not run main().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
