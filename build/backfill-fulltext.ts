// Re-extract `fulltext_excerpt_md` for already-filed PDFs using the
// section-aware composer (fulltext-sections.ts).
//
// The excerpt is written once, at enrichment time. Papers filed before this
// change carry a leading 8000-char slice — for a text-layer PDF that is the
// title page, affiliations, the disclosure block, and a truncated abstract, so
// the study agent never reached Results or the back-matter tables. This re-runs
// poppler over the filed PDF and rewrites the column with a section-selected
// excerpt (tables and figure captions first, references/disclosures dropped).
//
// Usage:
//   npx tsx build/backfill-fulltext.ts --id=74
//   npx tsx build/backfill-fulltext.ts --date=2026-08-08
//   npx tsx build/backfill-fulltext.ts --all
//   npx tsx build/backfill-fulltext.ts --all --dry-run     # report, write nothing
//
// Rewriting an excerpt does NOT rebuild any digest: published artifacts are
// already on disk and keep whatever the old excerpt produced until that date is
// rebuilt with `npm run build:day -- --date=<date>`. Deliberate — a backfill
// should not silently change what a published day says.
//
// No LLM, no network: poppler plus pure string work. Safe to re-run.

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/lib/db.ts';
import { extractPdfText } from '../src/lib/pdf-text.ts';
import { composeExcerpt, DEFAULT_EXCERPT_CHARS } from '../src/lib/fulltext-sections.ts';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const dryRun = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');
const dateFilter = arg('date');
const idFilter = arg('id');
// Honour FULLTEXT_EXCERPT_CHARS like inbox-enrichment does, or the documented
// release valve ("drop to 8000 for a mass rebuild") has no effect on the actual
// mass-rebuild tool, and the two paths write different-length excerpts for the
// same PDF. --max-chars still wins for a one-off.
const maxChars = (() => {
  // Match inbox-enrichment's >0 test exactly. A negative budget is not merely
  // useless: composeExcerpt's fallback does source.slice(0, maxChars), and a
  // negative end index is SUFFIX semantics, so it would store almost the whole
  // paper — the wrong direction to fail given the local-only IP constraint.
  for (const raw of [arg('max-chars'), process.env.FULLTEXT_EXCERPT_CHARS]) {
    const n = Number.parseInt(raw ?? '', 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_EXCERPT_CHARS;
})();

async function main(): Promise<void> {
  if (!all && !dateFilter && !idFilter) {
    console.error('Refusing to touch every paper implicitly. Pass --id=, --date=, or --all.');
    process.exit(1);
  }

  const db = openDb();
  const where = ['pdf_path IS NOT NULL'];
  const params: (string | number)[] = [];
  if (dateFilter) {
    where.push('bookmark_date = ?');
    params.push(dateFilter);
  }
  if (idFilter) {
    where.push('id = ?');
    params.push(Number(idFilter));
  }
  const rows = db
    .prepare(
      `SELECT id, title, pdf_path, abstract, length(fulltext_excerpt_md) AS was
       FROM papers WHERE ${where.join(' AND ')} ORDER BY id`,
    )
    .all(...params) as {
    id: number;
    title: string;
    pdf_path: string;
    abstract: string | null;
    was: number | null;
  }[];

  if (rows.length === 0) {
    console.log('No filed PDFs matched.');
    return;
  }
  console.log(
    `Re-extracting ${rows.length} paper(s) at ${maxChars} chars${dryRun ? ' (dry run)' : ''}…`,
  );

  const update = db.prepare('UPDATE papers SET fulltext_excerpt_md = ? WHERE id = ?');
  let done = 0;
  let missing = 0;
  let failed = 0;
  let skippedOcr = 0;
  for (const r of rows) {
    const abs = resolve(process.cwd(), r.pdf_path);
    if (!existsSync(abs)) {
      console.log(`  [${r.id}] SKIP (PDF not on disk: ${r.pdf_path})`);
      missing++;
      continue;
    }
    try {
      const extracted = await extractPdfText(abs);
      // db.ts savePaper refuses to overwrite a clean excerpt with Vision OCR of
      // a scanned PDF ("a longer noisy body must not overwrite a clean
      // pdftotext/PMC excerpt"). This CLI writes the column directly, so it has
      // to honour the same rule itself or `--all` would launder noise past the
      // guard — including onto papers whose text came from PMC nxml and merely
      // gained a pdf_path later.
      if (extracted.via === 'ocr') {
        console.log(`  [${r.id}] SKIP (scanned PDF, OCR-only — would downgrade a clean excerpt)`);
        skippedOcr++;
        continue;
      }
      const composed = composeExcerpt(extracted.text, {
        maxChars,
        layoutText: extracted.layoutText,
        includeAbstract: !r.abstract,
      });
      if (!dryRun) update.run(composed.text, r.id);
      done++;
      const tables = composed.kept.filter((k) => k.kind === 'table').length;
      const figures = composed.kept.filter((k) => k.kind === 'figure').length;
      const shape = composed.fellBack
        ? 'FELL BACK to head slice (no usable headings)'
        : `${tables} table(s), ${figures} figure caption(s), dropped: ${composed.droppedKinds.join(', ') || 'nothing'}`;
      console.log(
        `  [${r.id}] ${r.was ?? 0} → ${composed.text.length} chars of ${composed.sourceChars}; ${shape} — ${r.title.slice(0, 50)}`,
      );
    } catch (err) {
      failed++;
      console.log(`  [${r.id}] FAILED: ${(err as Error).message}`);
    }
  }
  console.log(
    `Done. ${done} re-extracted, ${skippedOcr} OCR-skipped, ${missing} PDF-missing, ${failed} failed.${
      dryRun ? ' (dry run — nothing written)' : ''
    }`,
  );
  if (!dryRun && done > 0) {
    console.log('Rebuild an affected date to see it in the digest: npm run build:day -- --date=…');
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
