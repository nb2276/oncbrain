// Queue-vs-build ordering, kept in a SIDE-EFFECT-FREE module.
//
// This logic used to live in build/rebuild-queued.ts, which calls main() at
// module scope — so importing it (a unit test did) opened the real database,
// took the drain lock, and could spawn paid build:day child processes. The repo
// has been burned by exactly that once already: v0.39 left build/notify-channel
// running main() on import, which POSTS TO THE PUBLIC TELEGRAM CHANNEL, and
// v0.39.1 fixed it by moving shared logic into a lib module. Same shape, same
// fix. A pure function that a test wants to call does not belong in a CLI.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Was this date re-queued AFTER its published artifact was generated?
 *
 * If so, the caller's "I already rebuilt this date this run" claim is stale: the
 * request postdates the build that supposedly satisfied it. The cron builds
 * yesterday, then today — and today's lineage pass can suppress a card on
 * yesterday, writing the override and queueing yesterday AFTER yesterday was
 * built. Skipping there deletes the request and the superseded card stays live.
 *
 * Fails OPEN (returns true → rebuild) when the artifact is missing or its
 * timestamp unreadable. A wasted rebuild costs one LLM run; a wrongly skipped
 * one leaves a superseded card published indefinitely.
 */
export function queuedAfterBuild(
  date: string,
  queuedAt: number,
  outDir = 'data/digests',
): boolean {
  try {
    const raw = readFileSync(join(outDir, `${date}.json`), 'utf-8');
    const generatedAt = (JSON.parse(raw) as { generated_at?: unknown }).generated_at;
    if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) return true;
    return queuedAt > generatedAt;
  } catch {
    return true;
  }
}
