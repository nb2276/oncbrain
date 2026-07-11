// npm run find:dups — scan published digests for the same trial covered on more
// than one date (cross-day duplicate study cards), and print candidates with
// ready-to-run override commands. READ-ONLY: it suggests, it never edits.
//
// Grouping (study-dedup.ts): shared NCT (strong) + discriminating acronym key
// (medium, cooperative-group/society-guarded). A candidate is a set of ≥2 cards
// on ≥2 dates. The curator decides which to keep — an OS-update re-read or a
// flagged review is legitimate longitudinal coverage, not a duplicate.
//
//   npm run find:dups            human report + suggested suppress commands
//   npm run find:dups -- --json  machine-readable candidates (for cron / tooling)
import { listDigests } from '../src/lib/digest-data.ts';
import { findCrossDateDuplicates, type DuplicateCandidate } from '../src/lib/study-dedup.ts';

function suggestions(c: DuplicateCandidate): string[] {
  // Heuristic: keep the NEWEST card (usually the fuller full-paper version),
  // suggest suppressing the older ones — but never auto-suggest suppressing a
  // review (flagged re-coverage is intentional).
  const newest = c.occurrences[c.occurrences.length - 1]!;
  const lines: string[] = [];
  for (const o of c.occurrences) {
    if (o === newest) continue;
    if (o.isReview) {
      lines.push(`    (skip ${o.date}/${o.slug}: review — likely intentional)`);
      continue;
    }
    lines.push(
      `    npm run override -- --date=${o.date} --suppress=${o.slug}   # keep ${newest.date}/${newest.slug}`,
    );
  }
  if (newest.isReview) {
    lines.push(`    note: newest (${newest.date}/${newest.slug}) is a review — the earlier card may be the keeper`);
  }
  return lines;
}

function main(): void {
  const json = process.argv.includes('--json');
  const candidates = findCrossDateDuplicates(listDigests());

  if (json) {
    process.stdout.write(JSON.stringify(candidates, null, 2) + '\n');
    return;
  }

  if (candidates.length === 0) {
    console.log('No cross-date duplicate study cards found.');
    return;
  }

  console.log(
    `Found ${candidates.length} cross-date duplicate candidate${candidates.length > 1 ? 's' : ''} ` +
      `(same trial on ≥2 dates). Review — an OS update or a flagged review is intentional:\n`,
  );
  for (const c of candidates) {
    const label = c.reason === 'shared-nct' ? `NCT ${c.matchKey}` : `acronym ${c.matchKey}`;
    console.log(`● ${label}  (${c.occurrences.length} cards)`);
    for (const o of c.occurrences) {
      const tags = [o.nct ?? 'no-nct', o.isReview ? 'review' : null].filter(Boolean).join(', ');
      console.log(`    ${o.date}  ${o.slug.padEnd(28)} ${o.name}  [${tags}]`);
    }
    for (const s of suggestions(c)) console.log(s);
    console.log('');
  }
}

main();
