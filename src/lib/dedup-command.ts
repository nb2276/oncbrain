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
  lookupDigest?: (
    date: string,
  ) => {
    digest: {
      sites: Array<{
        studies: Array<{
          slug?: string;
          name: string;
          nct?: string | null;
          source_ids?: { type: string; id: number }[];
        }>;
      }>;
    };
  } | null;
  overridesDir?: string;
};

// Apply a drop command: verify the study exists in the published digest, refuse
// to empty the date, record the target's identity, add a suppress override, and
// queue a rebuild. Never throws — returns a curator-facing message (a courtesy
// reply must not break the poller). Idempotent: dropping an already-suppressed
// slug just re-queues the rebuild.
//
// THIS IS THE OTHER DOOR. Trial lineage grew an elaborate evidence gate for
// automatic suppression, and every guard sits upstream of THIS function — which
// wrote the override directly, so a `drop` reply reached the same destructive
// end with none of them applied. Two of those guards are structural invariants
// rather than judgment calls, and they belong here too:
//
//   · NEVER EMPTY A DATE. Removing a day's last card leaves an orphaned
//     headline describing studies the page no longer renders. That is not a
//     curator preference to override by replying to a DM; an empty day wants
//     the artifact removed, which is a different act.
//   · RECORD IDENTITY. Suppressing removes the card from the artifact, so the
//     next rebuild cannot hold its slug and renames the survivors — and a
//     vacated slug can be inherited by a sibling card, at which point a
//     slug-only override hides the wrong study. Lineage records provenance for
//     exactly this reason; a manual drop needs it just as much.
//
// The EVIDENCE gate is deliberately NOT applied here. A curator can see things
// the classifier cannot, and requiring machine authorization for a human's
// explicit decision would be backwards. What the machine owes them instead is an
// honest offer: notify-curator only proposes a drop when the evidence gate
// passed or an identity gap was the sole blocker.
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
    const allStudies = artifact.digest.sites.flatMap((s) => s.studies);
    const study = allStudies.find((st) => st.slug === cmd.slug);
    if (!study) {
      return {
        ok: false,
        message: `No study "${cmd.slug}" on ${cmd.date}. Reply with the exact date/slug from the heads-up.`,
      };
    }

    const ov = loadOverrides(cmd.date, overridesDir) ?? {};
    const alreadyHidden = new Set(Array.isArray(ov.suppress) ? ov.suppress : []);
    // Count what would still publish: everything not already hidden, minus this.
    const surviving = allStudies.filter(
      (st) => st.slug !== cmd.slug && !(st.slug && alreadyHidden.has(st.slug)),
    ).length;
    if (surviving === 0) {
      return {
        ok: false,
        message:
          `Not dropping "${study.name}" — it is the last card still published on ${cmd.date}, ` +
          `and removing it would leave that date with a headline and no studies. ` +
          `Unpublish the whole date instead if that is what you want.`,
      };
    }
    // A hand-edited override file could have a non-array `suppress` (a bare
    // string would explode into per-character entries via new Set(...)); guard
    // it so a malformed file can't be silently corrupted here.
    const suppress = new Set(alreadyHidden);
    const already = suppress.has(cmd.slug);
    suppress.add(cmd.slug);
    ov.suppress = [...suppress];
    // Record what the card WAS so the override survives the rename that
    // suppressing it causes. Provenance is the strongest of the three; name and
    // NCT are recorded too for the passes that run before it.
    const identity = { ...(ov.identity ?? {}) };
    identity[cmd.slug] = {
      nct: (study as { nct?: string | null }).nct ?? null,
      name: study.name,
      source_ids: (study as { source_ids?: { type: string; id: number }[] }).source_ids ?? [],
    };
    ov.identity = identity;
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
