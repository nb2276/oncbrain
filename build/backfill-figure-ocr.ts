// Backfill figure OCR (Path A) for papers ingested before v0.15.
//
// Figure OCR runs automatically for newly-ingested PDFs (inbox-enrichment), but
// papers filed earlier have figure_ocr_md = NULL. This re-OCRs the figure pages
// of every filed PDF that's missing it and updates the row, so the build-time
// study agent can ground figure-locked magnitudes (KM medians, forest-plot
// estimates, image-rendered tables) on the back catalog too.
//
// Usage:
//   npx tsx build/backfill-figure-ocr.ts                 # every paper missing figure OCR
//   npx tsx build/backfill-figure-ocr.ts --date=2026-06-10
//   npx tsx build/backfill-figure-ocr.ts --id=23
//   npx tsx build/backfill-figure-ocr.ts --force         # re-OCR even if already set
//
// Best-effort: a paper whose PDF is gone or yields no figure text is skipped,
// not failed. Idempotent — re-running only touches rows still missing OCR
// (unless --force).

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/lib/db.ts';
import { extractPdfFigureOcr, MAX_FIGURE_OCR_CHARS } from '../src/lib/pdf-text.ts';
import { isOcrAvailable } from '../src/lib/vision-ocr.ts';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const force = process.argv.includes('--force');
const dateFilter = arg('date');
const idFilter = arg('id');

async function main(): Promise<void> {
  if (!isOcrAvailable()) {
    console.error('Apple Vision OCR binary missing — run `npm run setup:vision` (macOS only).');
    process.exit(1);
  }

  const db = openDb(); // opening runs the figure_ocr_md migration
  const where = ['pdf_path IS NOT NULL'];
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
    .prepare(`SELECT id, title, pdf_path FROM papers WHERE ${where.join(' AND ')} ORDER BY id`)
    .all(...params) as { id: number; title: string; pdf_path: string }[];

  if (rows.length === 0) {
    console.log('No papers to backfill (all filed PDFs already have figure OCR).');
    return;
  }
  console.log(`Backfilling figure OCR for ${rows.length} paper(s)…`);

  const update = db.prepare('UPDATE papers SET figure_ocr_md = ? WHERE id = ?');
  let filled = 0;
  let empty = 0;
  let missing = 0;
  for (const r of rows) {
    const abs = resolve(process.cwd(), r.pdf_path);
    if (!existsSync(abs)) {
      console.log(`  [${r.id}] SKIP (PDF not on disk: ${r.pdf_path})`);
      missing++;
      continue;
    }
    const ocr = (await extractPdfFigureOcr(abs)).slice(0, MAX_FIGURE_OCR_CHARS);
    if (ocr.trim()) {
      update.run(ocr, r.id);
      filled++;
      console.log(`  [${r.id}] ${ocr.length} chars — ${r.title.slice(0, 60)}`);
    } else {
      empty++;
      console.log(`  [${r.id}] no figure text (vector figures or no figures) — ${r.title.slice(0, 50)}`);
    }
  }
  console.log(`Done. ${filled} filled, ${empty} no-figure-text, ${missing} PDF-missing.`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
