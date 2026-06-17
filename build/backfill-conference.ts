// Backfill conference_slug on stored sources ingested before conference
// auto-detect (v0.14.9), or that arrived without a meeting signal at ingest.
//
// Conference detection runs automatically on new ingests (inbox-enrichment), but
// older bookmarks / papers / slides have conference_slug = NULL. This re-runs the
// SAME detector (detectAndEnsureConference) over each row's stored text and stamps
// the year-specific slug (asco-2026, astro-2025, …) when a real meeting signal is
// present — so the /tags/<meeting> filter, /conferences/<slug> pages, and per-day
// badges light up for the back catalog. Journal papers with no meeting signal stay
// untagged, by design.
//
// Usage:
//   npx tsx build/backfill-conference.ts            # tag every untagged source
//   npx tsx build/backfill-conference.ts --dry-run  # show what would tag, no writes
//   npx tsx build/backfill-conference.ts --date=2026-06-01
//   npx tsx build/backfill-conference.ts --force     # re-detect even if already set
//
// Mirrors the per-type detection fields used at enrichment time (papers: title /
// journal / source_url / note — deliberately NOT the body, whose intro can cite an
// unrelated meeting; slides: note + OCR; tweets: text + url + image OCR). After it
// runs, REBUILD the affected dates (build:day) so the digest artifacts carry the
// conference and the meeting tags surface. Idempotent; never throws on a bad row.

import 'dotenv/config';
import type Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.ts';
import { detectAndEnsureConference } from '../src/lib/inbox-enrichment.ts';
import { detectConferenceFromTexts } from '../src/lib/conference-detect.ts';

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
const dateArg = process.argv.find((a) => a.startsWith('--date='));
const dateFilter = dateArg ? dateArg.slice('--date='.length) : undefined;

// image_ocr_texts is a JSON array (strings, or {text} entries) — flatten to text.
function ocrTexts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).filter(Boolean);
  } catch {
    return [];
  }
}

type Target = {
  table: 'bookmarks' | 'papers' | 'slide_uploads';
  id: number;
  date: string;
  label: string;
  texts: Array<string | null | undefined>;
};

function collectTargets(db: Database.Database): Target[] {
  const out: Target[] = [];
  // force → re-scan all rows; otherwise only untagged. Optional date filter,
  // bound as a parameter (no string interpolation into SQL).
  const cond = force ? '1=1' : 'conference_slug IS NULL';
  const whereClause = `(${cond})${dateFilter ? ' AND bookmark_date = ?' : ''}`;
  const params = dateFilter ? [dateFilter] : [];

  for (const r of db
    .prepare(`SELECT id, bookmark_date d, tweet_text, url, notes, tweet_html, image_ocr_texts FROM bookmarks WHERE ${whereClause}`)
    .all(...params) as any[]) {
    out.push({
      table: 'bookmarks',
      id: r.id,
      date: r.d,
      label: (r.tweet_text || r.url || '').slice(0, 50),
      texts: [r.tweet_text, r.url, r.notes, r.tweet_html, ...ocrTexts(r.image_ocr_texts)],
    });
  }
  for (const r of db
    .prepare(`SELECT id, bookmark_date d, title, journal, source_url, curator_note FROM papers WHERE ${whereClause}`)
    .all(...params) as any[]) {
    out.push({
      table: 'papers',
      id: r.id,
      date: r.d,
      label: (r.title || '').slice(0, 50),
      texts: [r.title, r.journal, r.source_url, r.curator_note],
    });
  }
  for (const r of db
    .prepare(`SELECT id, bookmark_date d, source_label, ocr_text, curator_note FROM slide_uploads WHERE ${whereClause}`)
    .all(...params) as any[]) {
    out.push({
      table: 'slide_uploads',
      id: r.id,
      date: r.d,
      label: (r.source_label || 'slide').slice(0, 50),
      texts: [r.curator_note, r.ocr_text, r.source_label],
    });
  }
  return out;
}

function main(): void {
  const db = openDb();
  const targets = collectTargets(db);
  if (targets.length === 0) {
    console.log('No untagged sources to backfill.');
    return;
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}Scanning ${targets.length} source(s) for a meeting signal…`);

  const byTable: Record<string, { tagged: number; scanned: number }> = {};
  const tagCounts: Record<string, number> = {};
  const updaters: Record<string, Database.Statement> = {
    bookmarks: db.prepare('UPDATE bookmarks SET conference_slug = ? WHERE id = ?'),
    papers: db.prepare('UPDATE papers SET conference_slug = ? WHERE id = ?'),
    slide_uploads: db.prepare('UPDATE slide_uploads SET conference_slug = ? WHERE id = ?'),
  };

  for (const t of targets) {
    byTable[t.table] ??= { tagged: 0, scanned: 0 };
    byTable[t.table]!.scanned++;
    // dry-run uses the PURE detector (no conferences-table write); the real run
    // uses detectAndEnsureConference, which also upserts the conference row.
    let slug: string | null;
    if (dryRun) {
      const yr = Number(t.date.slice(0, 4)) || undefined;
      slug = detectConferenceFromTexts(t.texts, { defaultYear: yr })?.slug ?? null;
    } else {
      slug = detectAndEnsureConference(db, t.texts, t.date);
    }
    if (!slug) continue;
    byTable[t.table]!.tagged++;
    tagCounts[slug] = (tagCounts[slug] ?? 0) + 1;
    if (!dryRun) updaters[t.table]!.run(slug, t.id);
    console.log(`  ${dryRun ? 'would tag' : 'tagged'} ${t.table}[${t.id}] → ${slug}  (${t.date}) — ${t.label}`);
  }

  console.log('\n--- summary ---');
  for (const [tbl, s] of Object.entries(byTable)) {
    console.log(`  ${tbl}: ${s.tagged}/${s.scanned} tagged`);
  }
  const meetings = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  if (meetings.length) {
    console.log(`  meetings: ${meetings.map(([s, n]) => `${s}(${n})`).join(', ')}`);
    console.log(
      dryRun
        ? '\nDry run — no writes. Re-run without --dry-run, then `build:day --backfill` to surface the tags.'
        : '\nDone. Now rebuild the affected dates (`npm run build:day -- --backfill`) so the digest artifacts carry the conference and the meeting tags appear.',
    );
  } else {
    console.log('  no meeting signal found in any source (expected for journal-only / non-conference content).');
  }
}

main();
