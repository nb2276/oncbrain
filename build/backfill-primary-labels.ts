// v0.62.3: remove unsourced "1° EP" / "primary endpoint" labels from the
// committed digests (src/lib/primary-claim.ts, the same rule the build now
// applies). Source text is read from the local DB exactly as the pipeline
// grounds it; no LLM calls. Only the labels change, never a number.
//
//   npx tsx build/backfill-primary-labels.ts [--dry-run]
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/lib/db.ts';
import { stripUngroundedPrimaryClaims } from '../src/lib/primary-claim.ts';
import { writeFileAtomic } from '../src/lib/atomic-write.ts';

const dryRun = process.argv.includes('--dry-run');
const db = openDb();
const SQL: Record<string, string> = {
  tweet:
    "SELECT coalesce(tweet_text,'') || char(10) || coalesce((SELECT group_concat(json_extract(value,'$.text'), char(10)) FROM json_each(coalesce(image_ocr_texts,'[]'))),'') AS t FROM bookmarks WHERE id = ?",
  paper:
    "SELECT coalesce(title,'')||char(10)||coalesce(abstract,'')||char(10)||coalesce(fulltext_excerpt_md,'')||char(10)||coalesce(figure_structured_md,'')||char(10)||coalesce(figure_ocr_md,'') AS t FROM papers WHERE id = ?",
  slide: "SELECT coalesce(ocr_text,'') AS t FROM slide_uploads WHERE id = ?",
};
const dir = join(process.cwd(), 'data/digests');
let cards = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const path = join(dir, f);
  const before = readFileSync(path, 'utf8');
  const artifact = JSON.parse(before);
  for (const site of artifact.digest.sites) {
    for (const study of site.studies) {
      const src = (study.source_ids ?? [])
        .map((r: { type: string; id: number }) => (SQL[r.type] ? ((db.prepare(SQL[r.type]!).get(r.id) as { t?: string })?.t ?? '') : ''))
        .join('\n');
      if (!src.trim()) continue; // no sources on file: cannot judge, leave as is
      const changed = stripUngroundedPrimaryClaims(study, src);
      if (changed.length) {
        cards++;
        console.log(`  ${f.slice(0, 10)}  ${String(study.name).slice(0, 45).padEnd(45)} ${changed.join(', ')}`);
      }
    }
  }
  const after = JSON.stringify(artifact, null, 2) + '\n';
  if (after !== before && !dryRun) writeFileAtomic(path, after);
}
console.log(`backfill-primary-labels — ${cards} card(s) ${dryRun ? 'would be relabelled [dry-run]' : 'relabelled'}`);
