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
let swept = 0;
const readNote = (f: string) => {
  try {
    return readFileSync(join(noteDir, f), 'utf8');
  } catch {
    return null;
  }
};
for (const f of readdirSync(digestDir).filter((x) => x.endsWith('.json')).sort()) {
  const path = join(digestDir, f);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const before: string | null = artifact.conference?.slug ?? null;
  const after = dominantConferenceForDate(db, artifact.date);
  if (before !== after) {
    changed++;
    console.log(`  ${artifact.date}: ${before ?? '-'} -> ${after ?? '-'}`);
    if (!dryRun) {
      const conf = after ? getConference(db, after) : undefined;
      artifact.conference = conf ? { slug: conf.slug, name: conf.name } : null;
      writeFileAtomic(path, JSON.stringify(artifact, null, 2) + '\n');
      writeFileAtomic(join(noteDir, obsidianNoteName(artifact.date, artifact.conference?.slug)), renderObsidian(artifact, { publicSiteUrl: process.env.PUBLIC_SITE_URL }));
    }
  }
  // Every date, relabelled or not: earlier label changes left twins behind.
  const keep = obsidianNoteName(artifact.date, (dryRun ? (after ? { slug: after } : null) : artifact.conference)?.slug);
  for (const stale of staleObsidianNotes(readdirSync(noteDir), artifact.date, keep, readNote)) {
    swept++;
    console.log(`  remove stale note ${stale} (keeping ${keep})`);
    if (!dryRun) unlinkSync(join(noteDir, stale));
  }
}
console.log(`backfill-day-conference — ${changed} date(s) relabelled, ${swept} stale note(s) removed${dryRun ? ' [dry-run]' : ''}`);
