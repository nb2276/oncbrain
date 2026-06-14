// v0.17 (T4): CLI for the review-discussed-trial resolution manifest.
//
//   npm run resolve:review-trials -- --date=2026-06-12   # populate the manifest
//   npm run resolve:review-trials -- --review            # curator approves pending/failed
//   npm run resolve:review-trials -- --list [--date=...]  # print the manifest
//
// --date resolves every review on that date (PubMed search + rerank LLM) into
// `pending`/`failed` manifest rows. --review walks the queue interactively; only
// an APPROVED row's chosen PMID enters a later build (T5). Nothing here mutates
// a digest or publishes — the curator is the gate.

import 'dotenv/config';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import {
  openDb,
  listResolutions,
  decideResolution,
  parseResolutionCandidates,
  reopenStaleResolutions,
} from '../src/lib/db.ts';
import { searchPubMed, summarizePmids } from '../src/lib/pubmed-client.ts';
import { createLlmClient } from '../src/lib/llm-client.ts';
import {
  resolveReviewsForDate,
  makeRerankFromLlm,
  RESOLVER_VERSION,
  type DigestArtifactLike,
  type ResolverDeps,
} from '../src/lib/review-trial-resolver.ts';

type Args = { date?: string; mode: 'resolve' | 'review' | 'list' | 'help' };

function parseArgs(argv: string[]): Args {
  let date: string | undefined;
  let mode: Args['mode'] = 'help';
  for (const a of argv.slice(2)) {
    if (a.startsWith('--date=')) date = a.slice('--date='.length);
    else if (a === '--review' || a === '--approve') mode = 'review';
    else if (a === '--list') mode = 'list';
    else if (a === '--help' || a === '-h') mode = 'help';
  }
  if (mode === 'help' && date) mode = 'resolve'; // --date alone = resolve
  return { date, mode };
}

const HELP = `resolve-review-trials — review-discussed-trial resolution manifest

  --date=YYYY-MM-DD   resolve every review on that date into the manifest
  --review            curator: approve/reject pending + failed resolutions
  --list [--date=…]   print the manifest (optionally one date)
  --help`;

function readDigest(date: string): DigestArtifactLike {
  const path = resolve('data/digests', `${date}.json`);
  if (!existsSync(path)) throw new Error(`no committed digest at ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8')) as DigestArtifactLike;
}

export async function runResolve(date: string): Promise<void> {
  const db = openDb();
  try {
    const artifact = readDigest(date);
    const apiKey = process.env.NCBI_API_KEY;
    const llm = createLlmClient();
    const deps: ResolverDeps = {
      search: (term) => searchPubMed(term, { apiKey }),
      summarize: (pmids) => summarizePmids(pmids, { apiKey }),
      rerank: makeRerankFromLlm(llm),
      log: (m) => console.log(m),
    };
    // review fix #2: a RESOLVER_VERSION bump re-opens un-decided (pending/failed)
    // rows so they re-resolve under the new resolver; curator decisions are
    // preserved. This is the documented escape from the freeze — wire it here so
    // the bump actually takes effect (it was previously dead code). SCOPED to
    // this date: we only re-resolve `date` below, so an unscoped delete would
    // wipe every other date's queue without re-resolving it.
    const reopened = reopenStaleResolutions(db, RESOLVER_VERSION, date);
    if (reopened > 0) console.log(`  re-opened ${reopened} stale resolution(s) for re-resolve`);

    console.log(`Resolving review-discussed trials for ${date}…`);
    const summaries = await resolveReviewsForDate(db, artifact, deps);
    if (summaries.length === 0) {
      console.log('  No reviews with discussed trials on this date.');
      return;
    }
    let pending = 0,
      failed = 0,
      frozen = 0,
      errored = 0;
    for (const s of summaries) {
      pending += s.pending;
      failed += s.failed;
      frozen += s.frozen;
      errored += s.errored;
    }
    console.log(
      `  ${summaries.length} review(s): ${pending} pending · ${failed} failed · ${frozen} frozen` +
        (errored > 0 ? ` · ${errored} transient (re-run to retry)` : ''),
    );
    if (pending > 0 || failed > 0) {
      console.log('  Next: npm run resolve:review-trials -- --review   to approve.');
    }
  } finally {
    db.close();
  }
}

function candidateLabel(c: { pmid: string; title: string; journal: string | null; year: string | null }): string {
  const meta = [c.journal, c.year].filter(Boolean).join(' ');
  const title = c.title.length > 70 ? `${c.title.slice(0, 70)}…` : c.title;
  return `${c.pmid} — ${title}${meta ? ` (${meta})` : ''}`;
}

export async function runReview(): Promise<void> {
  const db = openDb();
  try {
    // Pending first (resolver-confident), then failed (curator can still rescue).
    const queue = [...listResolutions(db, { status: 'pending' }), ...listResolutions(db, { status: 'failed' })];
    p.intro(`Review-trial resolution — ${queue.length} to review`);
    if (queue.length === 0) {
      p.outro('Nothing pending. Run --date=… first.');
      return;
    }
    let approved = 0,
      rejected = 0,
      skipped = 0;
    for (const row of queue) {
      const cands = parseResolutionCandidates(row.candidates_json);
      const options = cands.map((c) => ({ value: c.pmid, label: candidateLabel(c) }));
      const choice = await p.select({
        message: `${row.acronym_display}  ·  ${row.disease_site ?? '?'}  ·  [${row.status}, conf ${(row.confidence ?? 0).toFixed(2)}]`,
        options: [
          ...options,
          { value: '__reject__', label: cands.length ? 'Reject — none of these is the trial' : 'Reject — no candidates' },
          { value: '__skip__', label: 'Skip for now' },
        ],
      });
      if (p.isCancel(choice) || choice === '__skip__') {
        skipped += 1;
        continue;
      }
      if (choice === '__reject__') {
        decideResolution(db, row.id, { status: 'rejected' });
        rejected += 1;
        continue;
      }
      decideResolution(db, row.id, { status: 'approved', chosenPmid: String(choice) });
      approved += 1;
    }
    p.outro(`${approved} approved · ${rejected} rejected · ${skipped} skipped. Approved trials enter the next build.`);
  } finally {
    db.close();
  }
}

export function runList(date?: string): void {
  const db = openDb();
  try {
    const rows = listResolutions(db, date ? { date } : {});
    if (rows.length === 0) {
      console.log(date ? `No resolutions for ${date}.` : 'Manifest is empty.');
      return;
    }
    for (const r of rows) {
      const pick = r.chosen_pmid ? ` → PMID ${r.chosen_pmid}` : '';
      console.log(
        `[${r.status}] ${r.bookmark_date} ${r.acronym_display} (${r.disease_site ?? '?'}) conf ${(r.confidence ?? 0).toFixed(2)}${pick}`,
      );
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.mode) {
    case 'resolve':
      await runResolve(args.date!);
      break;
    case 'review':
      await runReview();
      break;
    case 'list':
      runList(args.date);
      break;
    default:
      console.log(HELP);
  }
}

// Only run main() when invoked as a CLI, so studio.ts can import the run*
// functions without triggering an argv parse (mirrors eval-resolver.ts).
function isInvokedAsScript(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isInvokedAsScript()) {
  main().catch((err) => {
    console.error(`resolve-review-trials failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
