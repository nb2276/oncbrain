// Backfill the trial-lineage facet on sources ingested before the classifier
// existed.
//
// Newly-enriched sources are classified automatically (inbox-enrichment ->
// classifySourceFacet), but every paper and bookmark filed earlier has
// report_facet = NULL. A null facet makes the lineage classifier ABSTAIN, so an
// unclassified back catalogue silently disables the feature against exactly the
// cards a new submission is most likely to supersede.
//
// THIS WRITES METADATA ONLY. It records what each source reports; it never
// suppresses a card, never edits a digest, and never queues a rebuild. The
// update/new-card/duplicate verdicts are applied by build:day, against the date
// being built. Backfilling a facet makes a FUTURE build able to judge an older
// card — it does not retroactively rewrite published history.
//
// Usage:
//   npx tsx build/backfill-facets.ts                  # every unclassified source
//   npx tsx build/backfill-facets.ts --date=2026-07-08
//   npx tsx build/backfill-facets.ts --id=43 --id=44  # specific papers
//   npx tsx build/backfill-facets.ts --slug=nrg-gu005 # every source behind a card
//   npx tsx build/backfill-facets.ts --dry-run
//   npx tsx build/backfill-facets.ts --force          # re-classify even if set
//
// Best-effort and idempotent: a source the model cannot classify is left null
// and skipped on the next run only if --force is absent.

import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, saveSourceFacet } from '../src/lib/db.ts';
import { extractSourceFacet } from '../src/lib/source-facet.ts';

function args(name: string): string[] {
  return process.argv
    .filter((a) => a.startsWith(`--${name}=`))
    .map((a) => a.slice(name.length + 3));
}
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

type Row = { id: number; kind: 'paper' | 'tweet'; label: string; text: string };

// Every source id behind a published study card, so `--slug` can target one
// card's inputs without the caller having to look them up.
function idsForSlug(slugs: string[], outDir = 'data/digests'): Set<string> {
  const want = new Set(slugs);
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return out;
  }
  for (const f of names) {
    let art: { digest?: { sites?: { studies?: { slug?: string; source_ids?: { type: string; id: number }[] }[] }[] } };
    try {
      art = JSON.parse(readFileSync(resolve(outDir, f), 'utf-8'));
    } catch {
      continue;
    }
    for (const site of art.digest?.sites ?? []) {
      for (const st of site.studies ?? []) {
        if (!st.slug || !want.has(st.slug)) continue;
        for (const ref of st.source_ids ?? []) out.add(`${ref.type}:${ref.id}`);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const db = openDb(); // opening runs the facet-column migration
  const dates = args('date');
  const ids = args('id').map(Number).filter(Number.isFinite);
  const slugs = args('slug');
  const slugRefs = slugs.length > 0 ? idsForSlug(slugs) : null;

  const rows: Row[] = [];
  for (const kind of ['paper', 'tweet'] as const) {
    const table = kind === 'paper' ? 'papers' : 'bookmarks';
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!force) where.push('report_facet IS NULL');
    if (dates.length > 0) {
      where.push(`bookmark_date IN (${dates.map(() => '?').join(',')})`);
      params.push(...dates);
    }
    // --id targets papers; a tweet id and a paper id share a number space only
    // by accident, so applying it to both tables would classify a random tweet.
    if (ids.length > 0) {
      if (kind !== 'paper') continue;
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    const sql =
      kind === 'paper'
        ? `SELECT id, COALESCE(title,'') AS label,
                  COALESCE(title,'') || ' ' || COALESCE(abstract,'') AS text
             FROM papers`
        : `SELECT id, COALESCE(tweet_text,'') AS label, COALESCE(tweet_text,'') AS text
             FROM bookmarks`;
    const q = where.length > 0 ? `${sql} WHERE ${where.join(' AND ')}` : sql;
    for (const r of db.prepare(q).all(...params) as { id: number; label: string; text: string }[]) {
      if (slugRefs && !slugRefs.has(`${kind}:${r.id}`)) continue;
      if (!r.text.trim()) continue;
      rows.push({ id: r.id, kind, label: r.label.slice(0, 60), text: r.text });
    }
  }

  if (rows.length === 0) {
    console.log('Nothing to classify.');
    return;
  }
  console.log(`Classifying ${rows.length} source(s)${dryRun ? ' [dry-run]' : ''}...`);

  let done = 0;
  let abstained = 0;
  for (const r of rows) {
    try {
      const f = await extractSourceFacet(r.text);
      const summary = `${f.facet ?? 'null'} · ${f.maturity ?? 'null'}${
        f.followup_months !== null ? ` · ${f.followup_months}mo` : ''
      }${f.trial_acronyms.length ? ` · ${f.trial_acronyms.join(',')}` : ''}`;
      console.log(`  ${r.kind} #${r.id}: ${summary}  — ${r.label}`);
      if (!f.facet && !f.maturity && f.followup_months === null && f.trial_acronyms.length === 0) {
        abstained++;
        continue;
      }
      if (!dryRun) saveSourceFacet(db, r.kind, r.id, f);
      done++;
    } catch (err) {
      console.warn(`  ${r.kind} #${r.id}: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`Done. classified=${done} abstained=${abstained}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
