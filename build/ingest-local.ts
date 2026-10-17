// v0.61: local ingestion, no Telegram. For PDFs already on disk (a downloaded
// reference folder, a meeting's abstract book) where forwarding each one to the
// bot is impractical.
//
//   npm run ingest:local -- <file|dir>... [--kind=paper|talk] [--note="..."] [--now]
//       Stage PDFs (a directory is walked recursively). Staged PDFs drip into
//       the inbox via --release (the nightly cron releases INGEST_LOCAL_NIGHTLY,
//       default 5, per night). --now releases them immediately, dated today.
//       --kind=talk marks slide decks: Phase 1 is told it is a talk, so it
//       publishes as a presentation card, not a study report.
//   npm run ingest:local -- --vault --site=<disease-site> <file|dir>...
//       File PDFs into the private Obsidian vault only (data/obsidian/papers/
//       <site>/), no card. For protocols and other reference documents.
//   npm run ingest:local -- --release [--limit=5] [--date=YYYY-MM-DD] [--dry-run]
//   npm run ingest:local -- --list
//
// Files must live inside the project (enrichment refuses any other path). The
// PDFs never leave the machine: full text stays local-only like every PDF.

import 'dotenv/config';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  openDb,
  enqueueLocalIngest,
  listLocalIngest,
  releaseLocalIngest,
  getCuratorChatId,
  type LocalIngestKind,
} from '../src/lib/db.ts';
import { DISEASE_SITES } from '../src/lib/disease-sites.ts';
import { PAPERS_ROOT } from '../src/lib/pdf-storage.ts';

const DEFAULT_NIGHTLY = 5;
const TALK_NOTE = 'Slide deck from a talk (presentation), not a study report.';

type Args = {
  paths: string[];
  kind: LocalIngestKind;
  note: string | null;
  now: boolean;
  vault: boolean;
  site: string | null;
  release: boolean;
  list: boolean;
  limit: number;
  date: string | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const nightly = Number.parseInt(process.env.INGEST_LOCAL_NIGHTLY ?? '', 10);
  const a: Args = {
    paths: [],
    kind: 'paper',
    note: null,
    now: false,
    vault: false,
    site: null,
    release: false,
    list: false,
    limit: Number.isFinite(nightly) && nightly >= 0 ? nightly : DEFAULT_NIGHTLY,
    date: null,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === '--now') a.now = true;
    else if (arg === '--vault') a.vault = true;
    else if (arg === '--release') a.release = true;
    else if (arg === '--list') a.list = true;
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--kind=')) {
      const k = arg.slice(7);
      if (k !== 'paper' && k !== 'talk') throw new Error(`--kind must be paper or talk, got ${k}`);
      a.kind = k;
    } else if (arg.startsWith('--note=')) a.note = arg.slice(7).trim() || null;
    else if (arg.startsWith('--site=')) a.site = arg.slice(7);
    else if (arg.startsWith('--limit=')) a.limit = Number.parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--date=')) a.date = arg.slice(7);
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else a.paths.push(arg);
  }
  return a;
}

/** Every .pdf under the given files/dirs, absolute, inside the project, sorted. */
function collectPdfs(paths: string[]): string[] {
  const root = resolve(process.cwd()) + sep;
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) if (!name.startsWith('.')) walk(join(p, name));
    } else if (/\.pdf$/i.test(p)) out.push(p);
  };
  for (const raw of paths) {
    const abs = resolve(raw);
    if (!existsSync(abs)) throw new Error(`not found: ${raw}`);
    if (!(abs + sep).startsWith(root) && !abs.startsWith(root)) throw new Error(`must be inside the project: ${raw}`);
    walk(abs);
  }
  return out;
}

const today = () => new Date().toLocaleDateString('en-CA');

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();

  if (args.list) {
    const rows = listLocalIngest(db);
    const pending = rows.filter((r) => r.released_at === null);
    for (const r of rows) {
      const state = r.released_date ? `released ${r.released_date} → inbox #${r.inbox_item_id}` : 'staged';
      console.log(`  #${r.id} [${r.kind}] ${state}  ${relative(process.cwd(), r.path)}`);
    }
    console.log(`ingest:local — ${rows.length} staged in total, ${pending.length} waiting`);
    return;
  }

  if (args.release) {
    const date = args.date ?? today();
    if (args.dryRun) {
      const waiting = listLocalIngest(db).filter((r) => r.released_at === null).slice(0, args.limit);
      for (const r of waiting) console.log(`  [dry-run] would release ${relative(process.cwd(), r.path)}`);
      console.log(`ingest:local --release — would release up to ${args.limit} for ${date}; nothing written`);
      return;
    }
    const released = releaseLocalIngest(db, { limit: args.limit, date, chatId: getCuratorChatId(db) });
    for (const r of released) console.log(`  released ${relative(process.cwd(), r.path)} → inbox #${r.inbox_item_id}`);
    const left = listLocalIngest(db).filter((r) => r.released_at === null).length;
    console.log(`ingest:local --release — ${released.length} released for ${date}, ${left} still staged`);
    return;
  }

  if (args.paths.length === 0) {
    console.log(
      'usage: npm run ingest:local -- <file|dir>... [--kind=paper|talk] [--note="..."] [--now]\n' +
        '       npm run ingest:local -- --vault --site=<disease-site> <file|dir>...\n' +
        '       npm run ingest:local -- --release [--limit=N] [--date=YYYY-MM-DD] [--dry-run] | --list',
    );
    return;
  }

  const pdfs = collectPdfs(args.paths);

  if (args.vault) {
    const site = args.site;
    if (!site || !DISEASE_SITES.some((s) => s.slug === site)) {
      throw new Error(`--vault needs --site=<disease-site slug> (one of: ${DISEASE_SITES.map((s) => s.slug).join(', ')})`);
    }
    const dir = join(PAPERS_ROOT, site);
    for (const p of pdfs) {
      const name = basename(p).replace(/[^A-Za-z0-9._ -]/g, '_');
      if (args.dryRun) {
        console.log(`  [dry-run] would file ${relative(process.cwd(), p)} → data/obsidian/papers/${site}/${name}`);
        continue;
      }
      mkdirSync(dir, { recursive: true });
      copyFileSync(p, join(dir, name));
      console.log(`  filed data/obsidian/papers/${site}/${name}`);
    }
    console.log(`ingest:local --vault — ${pdfs.length} PDF(s) ${args.dryRun ? 'would be ' : ''}filed, no cards`);
    return;
  }

  const note = [args.kind === 'talk' ? TALK_NOTE : null, args.note].filter(Boolean).join(' ') || null;
  let staged = 0;
  const ids: number[] = [];
  for (const p of pdfs) {
    if (args.dryRun) {
      console.log(`  [dry-run] would stage [${args.kind}] ${relative(process.cwd(), p)}`);
      continue;
    }
    const r = enqueueLocalIngest(db, { path: p, kind: args.kind, note });
    ids.push(r.id);
    if (r.created) staged++;
  }
  console.log(
    `ingest:local — ${args.dryRun ? `${pdfs.length} would be` : `${staged} newly`} staged (${pdfs.length - staged} already staged)`,
  );
  if (args.now && !args.dryRun) {
    const released = releaseLocalIngest(db, { limit: ids.length, date: today(), chatId: getCuratorChatId(db), ids });
    console.log(`  --now: released ${released.length} into the inbox for ${today()}. Next: npm run enrich:inbox`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
