// Curator "drop a duplicate" reply command (v0.26).
//
// The cross-day nudge (inbox-enrichment notifyPriorCoverage) tells the curator a
// submitted source matches an earlier study and names a droppable card. Both
// cards publish by DEFAULT — the curator opts in to dedup by replying, in their
// Telegram DM, "drop <date>/<slug>". This module parses that reply and applies
// it as a durable suppress override + a queued rebuild, so the next drain
// regenerates the date without the card. No auto-suppression ever happens; this
// only runs on an explicit curator reply.

import type Database from 'better-sqlite3';
import { loadOverrides, saveOverrides } from './digest-overrides.ts';
import { queueRebuild } from './db.ts';
import { getDigest } from './digest-data.ts';

export type DedupCommand = { date: string; slug: string };

// Parse a curator reply into a drop command, or null if it isn't one.
// Accepts "drop 2026-05-17/radiosa" and "drop 2026-05-17 radiosa" (case- and
// whitespace-forgiving). Deliberately strict on shape so ordinary chat never
// trips it.
export function parseDedupCommand(text: string | null | undefined): DedupCommand | null {
  if (!text) return null;
  const m = text.trim().match(/^drop\s+(\d{4}-\d{2}-\d{2})[/\s]+([a-z0-9][a-z0-9-]*)$/i);
  if (!m) return null;
  return { date: m[1]!, slug: m[2]!.toLowerCase() };
}

export type DedupDropResult = { ok: boolean; message: string };

export type DedupDropDeps = {
  // Injectable for tests; defaults to the real digest loader + overrides dir.
  lookupDigest?: (date: string) => { digest: { sites: Array<{ studies: Array<{ slug?: string; name: string }> }> } } | null;
  overridesDir?: string;
};

// Apply a drop command: verify the study exists in the published digest, add a
// suppress override, and queue a rebuild. Never throws — returns a curator-facing
// message (a courtesy reply must not break the poller). Idempotent: dropping an
// already-suppressed slug just re-queues the rebuild.
export function executeDedupDrop(
  db: Database.Database,
  cmd: DedupCommand,
  deps: DedupDropDeps = {},
): DedupDropResult {
  const lookupDigest = deps.lookupDigest ?? getDigest;
  const overridesDir = deps.overridesDir ?? 'data/overrides';
  try {
    // Defense in depth: parseDedupCommand already constrains the shape, but this
    // is an exported function reachable by other callers, and cmd.date flows into
    // a filesystem path (overridesPath). Re-assert the safe shape so a future
    // caller can't slip a traversal segment past the parser.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cmd.date) || !/^[a-z0-9][a-z0-9-]*$/.test(cmd.slug)) {
      return { ok: false, message: `Invalid drop target ${cmd.date}/${cmd.slug}.` };
    }
    const artifact = lookupDigest(cmd.date);
    if (!artifact) {
      return { ok: false, message: `No digest found for ${cmd.date} — nothing to drop.` };
    }
    const study = artifact.digest.sites
      .flatMap((s) => s.studies)
      .find((st) => st.slug === cmd.slug);
    if (!study) {
      return {
        ok: false,
        message: `No study "${cmd.slug}" on ${cmd.date}. Reply with the exact date/slug from the heads-up.`,
      };
    }

    const ov = loadOverrides(cmd.date, overridesDir) ?? {};
    // A hand-edited override file could have a non-array `suppress` (a bare
    // string would explode into per-character entries via new Set(...)); guard
    // it so a malformed file can't be silently corrupted here.
    const suppress = new Set(Array.isArray(ov.suppress) ? ov.suppress : []);
    const already = suppress.has(cmd.slug);
    suppress.add(cmd.slug);
    ov.suppress = [...suppress];
    saveOverrides(cmd.date, ov, overridesDir);
    queueRebuild(db, cmd.date, `curator dropped duplicate ${cmd.slug}`);

    return {
      ok: true,
      message: already
        ? `Already dropping "${study.name}" (${cmd.slug}) on ${cmd.date}; re-queued the rebuild.`
        : `Got it — dropping "${study.name}" (${cmd.slug}) from ${cmd.date}. It'll clear on the next rebuild.`,
    };
  } catch (err) {
    return { ok: false, message: `Could not drop ${cmd.slug} on ${cmd.date}: ${(err as Error).message}` };
  }
}
