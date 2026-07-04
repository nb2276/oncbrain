// Backfill HTML figure OCR (v0.25 #2) for TRADE-PRESS papers ingested before the
// feature (or before HTML_FIGURE_OCR was enabled), which have
// figure_structured_md = NULL. Re-fetches each trade-press article page, runs its
// figure images through the grounded OCR pipeline (html-figures.ts), and merges
// the result onto the row (fill-if-missing). Opt-in / IP-sensitive like the live
// path: only trade-press hosts, grounded-only output, local-only field.
//
// Usage:
//   npx tsx build/backfill-html-figures.ts                 # every trade-press paper missing figures
//   npx tsx build/backfill-html-figures.ts --id=35
//   npx tsx build/backfill-html-figures.ts --date=2026-06-29
//   npx tsx build/backfill-html-figures.ts --force         # re-run even if set
//
// Requires HTML_FIGURE_OCR=on + macOS Vision + the Qwen/Ollama stack (grounded
// reconciliation). Reports the dates touched; rebuild them with build:day.

import 'dotenv/config';
import { openDb } from '../src/lib/db.ts';
import { isOcrAvailable } from '../src/lib/vision-ocr.ts';
import { ssrfSafeFetchText } from '../src/lib/ssrf-fetch.ts';
import { enrichHtmlFigures, isHtmlFigureOcrEnabled } from '../src/lib/html-figures.ts';
import { isTradePressUrl } from '../src/lib/paper-url.ts';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const idFilter = arg('id');
const dateFilter = arg('date');
const force = process.argv.includes('--force');

async function main(): Promise<void> {
  if (!isHtmlFigureOcrEnabled()) {
    console.error('HTML_FIGURE_OCR is not enabled — set HTML_FIGURE_OCR=on in .env first.');
    process.exit(1);
  }
  if (!isOcrAvailable()) {
    console.error('Apple Vision OCR binary missing — run `npm run setup:vision` (macOS only).');
    process.exit(1);
  }

  const db = openDb();
  const where = ['source_url IS NOT NULL'];
  const params: (string | number)[] = [];
  if (!force) where.push('figure_structured_md IS NULL');
  if (idFilter) {
    where.push('id = ?');
    params.push(Number(idFilter));
  }
  if (dateFilter) {
    where.push('bookmark_date = ?');
    params.push(dateFilter);
  }
  const rows = db
    .prepare(`SELECT id, title, source_url, bookmark_date FROM papers WHERE ${where.join(' AND ')} ORDER BY id`)
    .all(...params) as { id: number; title: string; source_url: string; bookmark_date: string }[];
  const tradeRows = rows.filter((r) => isTradePressUrl(r.source_url));
  if (tradeRows.length === 0) {
    console.log('No trade-press papers to backfill.');
    return;
  }
  console.log(`Attempting HTML figure backfill for ${tradeRows.length} trade-press paper(s)…`);

  const update = db.prepare('UPDATE papers SET figure_structured_md = COALESCE(figure_structured_md, ?) WHERE id = ?');
  const touched = new Set<string>();
  let filled = 0;
  let empty = 0;
  for (const r of tradeRows) {
    let html: string;
    try {
      html = await ssrfSafeFetchText(r.source_url, { maxBodyBytes: 8 * 1024 * 1024 });
    } catch (err) {
      console.log(`  [${r.id}] page fetch failed: ${(err as Error).message}`);
      continue;
    }
    const figs = await enrichHtmlFigures(html, r.source_url);
    if (figs.figure_structured_md) {
      update.run(figs.figure_structured_md, r.id);
      touched.add(r.bookmark_date);
      filled += 1;
      console.log(`  [${r.id}] ${figs.figure_structured_md.length} chars — ${r.title.slice(0, 50)}`);
    } else {
      empty += 1;
      console.log(`  [${r.id}] no grounded figures cleared the gate — ${r.title.slice(0, 45)}`);
    }
  }
  console.log(
    `Done. ${filled} filled, ${empty} none. ` +
      (touched.size
        ? `Rebuild: ${[...touched].map((d) => `npm run build:day -- --date=${d}`).join(' ; ')}`
        : '(nothing to rebuild)'),
  );
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
