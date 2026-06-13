// Backfill papers[].source_url into committed digest artifacts (v0.15.3).
//
// source_url is published as of v0.15.3 (buildArtifact maps it through
// toPublicArticleUrl), but digests built before then don't carry it — so a
// trade-press paper (UroToday/ASCO Post, no PMID/DOI) has no link to render. This
// patches existing data/digests/<date>.json papers with the sanitized source_url
// from the DB, WITHOUT an LLM rebuild (no content drift). Future builds carry it
// automatically; this is the one-time migration for the back catalog.
//
// Deterministic + idempotent: re-running is a no-op once every paper is backfilled.
// Matches buildArtifact's serialization (2-space JSON + trailing newline) and key
// order (source_url before note) so a later real rebuild produces a clean diff.
//
// Usage:
//   npx tsx build/backfill-source-url.ts            # patch all committed digests
//   npx tsx build/backfill-source-url.ts --dry-run  # report what would change
//   npx tsx build/backfill-source-url.ts --date=2026-06-12

import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/lib/db.ts';
import { toPublicArticleUrl } from '../src/lib/paper-url.ts';

const DIGESTS_DIR = resolve(process.cwd(), 'data/digests');
const dryRun = process.argv.includes('--dry-run');
const dateArg = (() => {
  const hit = process.argv.find((a) => a.startsWith('--date='));
  return hit ? hit.slice('--date='.length) : null;
})();

type ArtifactPaper = { id: number; source_url?: string | null; note?: unknown; [k: string]: unknown };

// Reinsert source_url in canonical position (right before `note`), matching a
// fresh buildArtifact, so the field doesn't land at the end of the object.
function withSourceUrl(p: ArtifactPaper, url: string): ArtifactPaper {
  const { note, source_url: _drop, ...rest } = p;
  return { ...rest, source_url: url, note };
}

function main(): void {
  if (!existsSync(DIGESTS_DIR)) {
    console.error(`No digests dir at ${DIGESTS_DIR}`);
    process.exit(1);
  }
  const db = openDb();
  const srcById = new Map<number, string | null>();
  for (const row of db.prepare('SELECT id, source_url FROM papers').all() as {
    id: number;
    source_url: string | null;
  }[]) {
    srcById.set(row.id, row.source_url);
  }

  const files = readdirSync(DIGESTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !dateArg || f === `${dateArg}.json`)
    .sort();

  let filesChanged = 0;
  let papersFilled = 0;
  let missingInDb = 0;

  for (const file of files) {
    const path = resolve(DIGESTS_DIR, file);
    const artifact = JSON.parse(readFileSync(path, 'utf-8')) as { papers?: ArtifactPaper[] };
    if (!Array.isArray(artifact.papers) || artifact.papers.length === 0) continue;

    let changed = false;
    artifact.papers = artifact.papers.map((p) => {
      const raw = srcById.has(p.id) ? srcById.get(p.id)! : null;
      if (!srcById.has(p.id)) {
        missingInDb++;
        return p; // paper id not in DB (re-ingested?) — leave as-is
      }
      const url = toPublicArticleUrl(raw);
      if (!url) return p; // no usable source_url (or non-http) — nothing to link
      if (p.source_url === url) return p; // already correct — idempotent no-op
      changed = true;
      papersFilled++;
      console.log(`  [${file}] paper ${p.id} ← ${url}`);
      return withSourceUrl(p, url);
    });

    if (changed) {
      filesChanged++;
      if (!dryRun) writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n');
    }
  }

  const verb = dryRun ? 'would patch' : 'patched';
  console.log(
    `\n${verb} ${papersFilled} paper(s) across ${filesChanged} digest(s).` +
      (missingInDb ? ` ${missingInDb} paper(s) not found in DB (skipped).` : ''),
  );
  if (dryRun) console.log('(dry-run — no files written)');
}

main();
