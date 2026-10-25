// v0.62.2: stamp each study's own meeting (study-meeting.ts) onto the committed
// digest artifacts built before per-study meetings existed. Reads sources from
// the local DB; no LLM calls. Only the `meeting` field is added.
//
//   npx tsx build/backfill-meetings.ts [--dry-run]
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/lib/db.ts';
import { stampStudyMeetings } from '../src/lib/study-meeting.ts';
import { writeFileAtomic } from '../src/lib/atomic-write.ts';

const dryRun = process.argv.includes('--dry-run');
const dir = join(process.cwd(), 'data/digests');
const db = openDb();
let files = 0;
let differ = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(dir, f);
  const before = readFileSync(path, 'utf8');
  const artifact = JSON.parse(before);
  const day = artifact.conference?.slug ?? null;
  stampStudyMeetings(db, artifact.digest);
  for (const site of artifact.digest.sites) {
    for (const s of site.studies) {
      if ((s.meeting?.slug ?? null) !== day) {
        differ++;
        console.log(`  ${f.slice(0, 10)}  ${String(s.name).slice(0, 50).padEnd(50)} day=${day ?? '-'}  study=${s.meeting?.slug ?? '-'}`);
      }
    }
  }
  const after = JSON.stringify(artifact, null, 2) + '\n';
  if (after !== before) {
    files++;
    if (!dryRun) writeFileAtomic(path, after);
  }
}
console.log(`backfill-meetings — ${files} artifact(s) ${dryRun ? 'would change' : 'stamped'}; ${differ} stud(ies) whose meeting differs from the day's`);
