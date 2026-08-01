// Shared scaffolding for the two notification CLIs (build/notify-curator.ts,
// build/notify-channel.ts). TODOS P3.
//
// WHY. The two CLIs duplicated argument parsing, the PUBLIC_SITE_URL default,
// the digest-existence check, the artifact load, and the fail-soft top-level
// catch. Nothing was broken, but the predicted failure was that a change lands
// in one file and is missed in the other — and that is exactly what happened:
// v0.39 added an isInvokedAsScript() guard to notify-curator and left
// notify-channel calling main() on import. The channel CLI posts to a PUBLIC
// Telegram channel, so importing it from a test could publish.
//
// WHAT STAYS OUT. The deploy-readiness POLICY is deliberately not shared. The
// curator DM sends even on timeout (with the preview suppressed, so it cannot
// poison the URL's Telegram cache for the channel post that follows it); the
// channel skips entirely and exits non-zero, because there the preview IS the
// product. Those are opposite calls on purpose, and folding them into one
// helper would invite someone to "unify" them later. See deploy-ready.ts.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayIso } from './db.ts';

export type NotifyArgs = { date: string; dryRun: boolean };

/** `--date=YYYY-MM-DD` and `--dry-run`; date defaults to today. */
export function parseNotifyArgs(argv: string[], today: string = todayIso()): NotifyArgs {
  let date = today;
  let dryRun = false;
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'date' && m[2]) date = m[2];
    if (m[1] === 'dry-run') dryRun = true;
  }
  return { date, dryRun };
}

export const DEFAULT_SITE_URL = 'https://oncbrain.oncologytoolkit.com';

/** The public site origin. Both CLIs build deep links and deploy checks from it. */
export function siteUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.PUBLIC_SITE_URL || DEFAULT_SITE_URL;
}

/**
 * Load a committed digest artifact, or null when the date has none.
 *
 * Returns null rather than throwing: a missing digest is an ordinary skip in
 * both CLIs (the cron calls them for dates that may not have built), and these
 * run unattended where an exception would be noise, not signal.
 */
export function loadDigestArtifact<T>(
  date: string,
  label: string,
  opts: { root?: string; log?: (msg: string) => void } = {},
): T | null {
  const log = opts.log ?? console.log;
  const digestPath = resolve(opts.root ?? 'data/digests', `${date}.json`);
  if (!existsSync(digestPath)) {
    log(`${label}: no digest at ${digestPath}, skipping`);
    return null;
  }
  return JSON.parse(readFileSync(digestPath, 'utf8')) as T;
}

/**
 * True only when this module is the file node was asked to run.
 *
 * Both CLIs export formatters that tests import. Without this, importing the
 * module runs its main(): notify-curator would poll deploy-readiness and DM the
 * curator, and notify-channel would POST TO THE PUBLIC CHANNEL. Mirrors the
 * guard in digest-builder.ts.
 */
export function isInvokedAsScript(moduleUrl: string, argv: string[] = process.argv): boolean {
  const arg = argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Run a CLI's main() only when invoked as a script, fail-soft.
 *
 * Fail-soft (the catch logs and returns rather than rethrowing) because
 * daily-build.sh runs these in sequence and a notification failure must never
 * abort the pipeline — the digest is already built, committed and deployed by
 * the time these run. A CLI that wants a LOUD skip sets process.exitCode itself
 * (notify-channel does); that survives this wrapper.
 */
export function runNotifyCli(
  label: string,
  moduleUrl: string,
  main: () => Promise<void>,
): void {
  if (!isInvokedAsScript(moduleUrl)) return;
  main().catch((err: unknown) => {
    console.log(
      `${label}: unexpected error (${err instanceof Error ? err.message : String(err)}), continuing`,
    );
  });
}
