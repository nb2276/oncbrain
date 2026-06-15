// One-time backfill: scrub LLM-from-PDF abstracts from the back catalog.
//
// The v0.19.4 IP-boundary fix nulls the LLM-from-PDF abstract at INGESTION, so
// papers.abstract is only ever provider-sourced going forward. But a paper
// ingested BEFORE that fix can still carry an LLM-from-PDF abstract on a
// fetched_via='pdf'/'pdf_ocr' row (the old code did prefer(cr.abstract,
// meta.abstract) — so when Crossref had no abstract it fell back to the LLM one).
// Since papers.abstract is PUBLISHED (site + JSON API), those existing rows are
// a residual leak.
//
// This re-derives each pdf/pdf_ocr abstract from the authoritative source
// (Crossref by DOI, else null), updates the DB, and patches the committed digest
// artifacts so the published site carries only provider abstracts — no LLM
// rebuild needed (re-serializes with the same JSON.stringify(…, null, 2) + '\n'
// writeArtifact uses, so the diff is just the changed abstracts).
//
//   npx tsx build/backfill-pdf-abstracts.ts --dry-run   # preview, no writes
//   npx tsx build/backfill-pdf-abstracts.ts             # apply (DB + digests)

import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/lib/db.ts';
import { fetchCrossrefPaper } from '../src/lib/crossref-client.ts';

const DRY = process.argv.includes('--dry-run');

async function main() {
  const db = openDb();

  // 1. pdf/pdf_ocr rows that carry a stored abstract — the potential leak set.
  const rows = db
    .prepare(
      `SELECT id, doi, abstract, fetched_via FROM papers
       WHERE fetched_via IN ('pdf','pdf_ocr') AND abstract IS NOT NULL AND length(abstract) > 0`,
    )
    .all() as { id: number; doi: string | null; abstract: string; fetched_via: string }[];

  console.log(`${rows.length} pdf/pdf_ocr paper(s) with a stored abstract${DRY ? '  [dry-run]' : ''}`);

  // id -> authoritative provider abstract (Crossref) or null.
  const newAbstractById = new Map<number, string | null>();
  for (const r of rows) {
    let provider: string | null = null;
    if (r.doi) {
      try {
        const cr = await fetchCrossrefPaper(r.doi);
        provider = cr.doi === r.doi && cr.abstract && cr.abstract.trim() ? cr.abstract : null;
      } catch (e) {
        console.warn(
          `  #${r.id} ${r.doi}: Crossref fetch failed (${(e as Error).message}) — nulling abstract (fail-safe)`,
        );
        provider = null;
      }
    }
    newAbstractById.set(r.id, provider);
    const desc = provider === null ? 'null' : `${provider.length}ch (crossref)`;
    const changed = provider !== r.abstract;
    console.log(
      `  #${r.id} via=${r.fetched_via} doi=${r.doi ?? 'none'}: ${r.abstract.length}ch -> ${desc}${changed ? '' : ' (unchanged)'}`,
    );
    if (!DRY && changed) {
      db.prepare('UPDATE papers SET abstract = ? WHERE id = ?').run(provider, r.id);
    }
  }

  // 2. Patch committed digest artifacts so the published value matches the
  //    cleaned DB (only pdf-sourced papers that were in the leak set; a fresh
  //    build would now produce exactly this).
  const DIGESTS = resolve(process.cwd(), 'data/digests');
  let filesPatched = 0;
  for (const f of readdirSync(DIGESTS).filter((x) => x.endsWith('.json'))) {
    const path = resolve(DIGESTS, f);
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as {
      papers?: Array<{ id: number; abstract?: string | null }>;
    };
    let changed = false;
    for (const p of artifact.papers ?? []) {
      if (!newAbstractById.has(p.id)) continue; // not a pdf leak-set paper
      const desired = newAbstractById.get(p.id) ?? null;
      if ((p.abstract ?? null) !== desired) {
        p.abstract = desired;
        changed = true;
      }
    }
    if (changed) {
      console.log(`  ${DRY ? 'would patch' : 'patch'} data/digests/${f}`);
      filesPatched++;
      if (!DRY) writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n');
    }
  }
  console.log(`${DRY ? '[dry-run] would patch' : 'patched'} ${filesPatched} digest file(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
