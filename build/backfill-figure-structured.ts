// Backfill grounded figure extraction (v0.20) for papers ingested before it.
//
// The Vision + Qwen → Opus pipeline runs automatically on newly-ingested PDFs
// (inbox-enrichment, when a local Qwen/Ollama is reachable), but papers filed
// earlier have figure_structured_md = NULL. This re-runs the pipeline over the
// figure pages of every filed PDF that's missing it and updates the row, so the
// build-time study agent gets the grounded per-panel extraction on the back
// catalog too. Mirror of backfill-figure-ocr.ts.
//
// Usage:
//   npx tsx build/backfill-figure-structured.ts                 # every paper missing it
//   npx tsx build/backfill-figure-structured.ts --date=2026-06-10
//   npx tsx build/backfill-figure-structured.ts --id=23
//   npx tsx build/backfill-figure-structured.ts --force         # re-run even if set
//   npx tsx build/backfill-figure-structured.ts --dry-run       # list targets, no LLM/DB writes
//
// Requires a reachable local Qwen/Ollama (the pipeline makes Opus reconcile calls
// per figure page) + the Apple Vision binary + poppler. Best-effort per paper: a
// PDF that's gone, has only vector figures (no figure pages), or whose merge is
// withheld by the grounding gate is skipped, not failed. Idempotent.

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/lib/db.ts';
import { extractPdfFigureStructured, MAX_FIGURE_STRUCTURED_CHARS } from '../src/lib/figure-extract.ts';
import { isQwenAvailable } from '../src/lib/qwen-client.ts';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
const dateFilter = arg('date');
const idFilter = arg('id');

async function main(): Promise<void> {
  if (!(await isQwenAvailable())) {
    console.error(
      'Local Qwen/Ollama not reachable (or FIGURE_STRUCTURED=off) — start it with ' +
        '`ollama serve` + `ollama pull qwen2.5vl:7b`. Nothing backfilled.',
    );
    process.exit(1);
  }

  const db = openDb(); // opening runs the figure_structured_md migration
  const where = ['pdf_path IS NOT NULL'];
  const params: (string | number)[] = [];
  if (!force) where.push('figure_structured_md IS NULL');
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
    console.log('No papers to backfill (all filed PDFs already have grounded figure extraction).');
    return;
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}Backfilling figure_structured_md for ${rows.length} paper(s)…`);

  const update = db.prepare('UPDATE papers SET figure_structured_md = ? WHERE id = ?');
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
    if (dryRun) {
      console.log(`  [${r.id}] would process — ${r.title.slice(0, 60)}`);
      continue;
    }
    const md = (await extractPdfFigureStructured(abs)).slice(0, MAX_FIGURE_STRUCTURED_CHARS);
    if (md.trim()) {
      update.run(md, r.id);
      filled++;
      console.log(`  [${r.id}] ${md.length} chars — ${r.title.slice(0, 60)}`);
    } else {
      empty++;
      console.log(`  [${r.id}] no figure pages (vector figures / none) — ${r.title.slice(0, 50)}`);
    }
  }
  console.log(`Done. ${filled} filled, ${empty} no-figure-pages, ${missing} PDF-missing.`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
