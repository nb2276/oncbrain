// Backfill PMC open-access figure OCR (v0.24 Tier B) for papers ingested via a
// PMID / DOI / PMC link (no forwarded PDF) that therefore have figure_ocr_md =
// NULL. For every such paper WITH a pmc_id, this fetches the PMC OA figure images
// and runs them through the same Vision + grounded-structuring pipeline as new
// ingests, then merges the result onto the row (via savePaper's v0.23
// fill-if-missing). Retro-fills figures for the open-access back catalog.
//
// Usage:
//   npx tsx build/backfill-pmc-oa-figures.ts                 # every pmc_id paper missing figure OCR
//   npx tsx build/backfill-pmc-oa-figures.ts --date=2026-05-18
//   npx tsx build/backfill-pmc-oa-figures.ts --id=5
//   npx tsx build/backfill-pmc-oa-figures.ts --force         # re-fetch even if figure_ocr_md set
//
// Best-effort: a non-OA paper (JCO, Lancet Onc, paywalled) is skipped, not
// failed. Idempotent — only touches rows still missing figure OCR unless --force.
// macOS-only (Apple Vision). A rebuilt date is NOT auto-queued here; rebuild any
// affected date yourself with `npm run build:day -- --date=…`.

import 'dotenv/config';
import { openDb } from '../src/lib/db.ts';
import { isOcrAvailable } from '../src/lib/vision-ocr.ts';
import { enrichPmcOaFigures, isPmcOaFiguresEnabled } from '../src/lib/pmc-oa.ts';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const force = process.argv.includes('--force');
const dateFilter = arg('date');
const idFilter = arg('id');

async function main(): Promise<void> {
  if (!isPmcOaFiguresEnabled()) {
    console.error('PMC_OA_FIGURES=off — unset it to backfill.');
    process.exit(1);
  }
  if (!isOcrAvailable()) {
    console.error('Apple Vision OCR binary missing — run `npm run setup:vision` (macOS only).');
    process.exit(1);
  }

  const db = openDb();
  const where = ['pmc_id IS NOT NULL'];
  const params: (string | number)[] = [];
  if (!force) where.push('figure_ocr_md IS NULL');
  if (dateFilter) {
    where.push('bookmark_date = ?');
    params.push(dateFilter);
  }
  if (idFilter) {
    where.push('id = ?');
    params.push(Number(idFilter));
  }
  const rows = db
    .prepare(`SELECT id, title, pmc_id FROM papers WHERE ${where.join(' AND ')} ORDER BY id`)
    .all(...params) as { id: number; title: string; pmc_id: string }[];

  if (rows.length === 0) {
    console.log('No PMC papers to backfill.');
    return;
  }
  console.log(`Attempting PMC-OA figure backfill for ${rows.length} paper(s) with a PMC id…`);

  const update = db.prepare(
    'UPDATE papers SET figure_ocr_md = COALESCE(figure_ocr_md, ?), figure_structured_md = COALESCE(figure_structured_md, ?) WHERE id = ?',
  );
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  let filled = 0;
  let notOa = 0;
  let first = true;
  for (const r of rows) {
    // Politeness: space out the oa.fcgi calls over the back catalog so a large
    // backfill doesn't earn a 429 / IP block from NCBI (#P2).
    if (!first) await sleep(400);
    first = false;
    const figs = await enrichPmcOaFigures(r.pmc_id);
    if (figs.figure_ocr_md || figs.figure_structured_md) {
      update.run(figs.figure_ocr_md, figs.figure_structured_md, r.id);
      filled++;
      console.log(
        `  [${r.id}] ${r.pmc_id}: ocr=${figs.figure_ocr_md?.length ?? 0} struct=${figs.figure_structured_md?.length ?? 0} — ${r.title.slice(0, 50)}`,
      );
    } else {
      notOa++;
      console.log(`  [${r.id}] ${r.pmc_id}: no OA figures (not in OA subset, or no figures) — ${r.title.slice(0, 45)}`);
    }
  }
  console.log(`Done. ${filled} filled, ${notOa} skipped (non-OA / no figures). Rebuild affected dates with build:day.`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
