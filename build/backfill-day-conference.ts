// v0.63.1: re-label published dates under the majority day-conference rule
// (db.dominantConferenceForDate). Rewrites only the artifact's `conference`
// field and regenerates the Obsidian note under its new name, removing the
// old one. No LLM calls; card text and per-study meetings are untouched.
//
//   npx tsx build/backfill-day-conference.ts [--dry-run]
import 'dotenv/config';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, dominantConferenceForDate, getConference } from '../src/lib/db.ts';
import { renderObsidian, obsidianNoteName, staleObsidianNotes } from '../src/lib/obsidian-export.ts';
import { writeFileAtomic } from '../src/lib/atomic-write.ts';

const dryRun = process.argv.includes('--dry-run');
const digestDir = join(process.cwd(), 'data/digests');
const noteDir = join(process.cwd(), 'data/obsidian');
const db = openDb();
let changed = 0;
for (const f of readdirSync(digestDir).filter((x) => x.endsWith('.json')).sort()) {
  const path = join(digestDir, f);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const before: string | null = artifact.conference?.slug ?? null;
  const after = dominantConferenceForDate(db, artifact.date);
  if (before === after) continue;
  changed++;
  console.log(`  ${artifact.date}: ${before ?? '-'} -> ${after ?? '-'}`);
  if (dryRun) continue;
  const conf = after ? getConference(db, after) : undefined;
  artifact.conference = conf ? { slug: conf.slug, name: conf.name } : null;
  writeFileAtomic(path, JSON.stringify(artifact, null, 2) + '\n');
  const name = obsidianNoteName(artifact.date, artifact.conference?.slug);
  writeFileAtomic(join(noteDir, name), renderObsidian(artifact, { publicSiteUrl: process.env.PUBLIC_SITE_URL }));
  for (const stale of staleObsidianNotes(readdirSync(noteDir), artifact.date, name)) unlinkSync(join(noteDir, stale));
}
console.log(`backfill-day-conference — ${changed} date(s) ${dryRun ? 'would be' : ''} relabelled`);
