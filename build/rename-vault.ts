// v0.62: rename the existing vault PDFs to `<year>-<first author>-<short title>`
// (pdf-storage vaultBaseName), the scheme new filings use.
//
//   npx tsx build/rename-vault.ts [--dry-run]
//
// For every paper row with a pdf_path: move the file within its site folder,
// update papers.pdf_path, and rewrite the old path wherever the committed
// artifacts recorded it (data/obsidian/*.md wikilinks, data/digests/*.json
// pdf_path). Vault-only files with no paper row (protocols filed by
// ingest:local --vault) get a cleaned kebab-case version of their own name.
// _unsorted/ is left alone (those are named by content hash on purpose).
// Idempotent: a file already on its target name is skipped.

import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openDb } from '../src/lib/db.ts';
import { PAPERS_ROOT, freeName, vaultBaseName } from '../src/lib/pdf-storage.ts';

const dryRun = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const REL_PREFIX = 'data/obsidian/papers/';

type Row = { id: number; pdf_path: string; title: string | null; authors_json: string | null; pub_date: string | null };

function authorsOf(json: string | null): string[] {
  try {
    return (JSON.parse(json ?? '[]') as Array<{ name?: string } | string>)
      .map((a) => (typeof a === 'string' ? a : (a.name ?? '')))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const kebab = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.pdf$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/, '');

function main(): void {
  const db = openDb();
  const moves: Array<{ from: string; to: string; id: number | null }> = [];
  const claimed = new Set<string>();

  const plan = (fromRel: string, base: string, id: number | null) => {
    const site = dirname(fromRel).slice(REL_PREFIX.length);
    let name = `${base}.pdf`;
    if (basename(fromRel) === name) return; // already named
    // Skip names taken on disk or earlier in this plan; the file's own bytes
    // never count as a collision with itself.
    const buf = readFileSync(join(ROOT, fromRel));
    name = freeName(site, base, buf);
    for (let n = 2; claimed.has(`${site}/${name}`); n++) name = freeName(site, `${base}-${n}`, buf);
    const toRel = `${REL_PREFIX}${site}/${name}`;
    if (toRel === fromRel) return;
    claimed.add(`${site}/${name}`);
    moves.push({ from: fromRel, to: toRel, id });
  };

  const rows = db.prepare('SELECT id, pdf_path, title, authors_json, pub_date FROM papers WHERE pdf_path IS NOT NULL').all() as Row[];
  const referenced = new Set<string>();
  for (const r of rows) {
    if (!r.pdf_path.startsWith(REL_PREFIX) || r.pdf_path.startsWith(`${REL_PREFIX}_unsorted/`)) continue;
    if (!existsSync(join(ROOT, r.pdf_path))) {
      console.warn(`  missing on disk, skipped: ${r.pdf_path}`);
      continue;
    }
    if (referenced.has(r.pdf_path)) continue; // two rows sharing one file: rename once
    referenced.add(r.pdf_path);
    plan(r.pdf_path, vaultBaseName({ title: r.title, authors: authorsOf(r.authors_json), pubDate: r.pub_date }), r.id);
  }

  // Vault-only documents (no paper row): clean up their own name.
  for (const site of readdirSync(PAPERS_ROOT)) {
    if (site === '_unsorted' || site.startsWith('.')) continue;
    for (const f of readdirSync(join(PAPERS_ROOT, site))) {
      const rel = `${REL_PREFIX}${site}/${f}`;
      if (!/\.pdf$/i.test(f) || referenced.has(rel)) continue;
      const base = kebab(f);
      if (base) plan(rel, base, null);
    }
  }

  for (const m of moves) console.log(`  ${m.from.slice(REL_PREFIX.length)}\n    → ${m.to.slice(REL_PREFIX.length)}`);
  if (dryRun) {
    console.log(`rename-vault — ${moves.length} file(s) would be renamed [dry-run, nothing changed]`);
    return;
  }

  // 1. Files + DB together: a DB row must never point at a path that is gone.
  const update = db.prepare('UPDATE papers SET pdf_path = ? WHERE pdf_path = ?');
  for (const m of moves) {
    renameSync(join(ROOT, m.from), join(ROOT, m.to));
    if (m.id !== null) update.run(m.to, m.from);
  }

  // 2. Rewrite the recorded paths in the committed artifacts. The md wikilinks
  // carry the vault-relative form (papers/<site>/<file>), the digests the repo
  // form (data/obsidian/papers/...); replacing the papers/... tail covers both.
  let touched = 0;
  const rewrite = (dir: string, ext: string) => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(ext)) continue;
      const p = join(dir, f);
      const before = readFileSync(p, 'utf8');
      let after = before;
      for (const m of moves) after = after.split(m.from.slice('data/obsidian/'.length)).join(m.to.slice('data/obsidian/'.length));
      if (after !== before) {
        writeFileSync(p, after);
        touched++;
      }
    }
  };
  rewrite(join(ROOT, 'data/obsidian'), '.md');
  rewrite(join(ROOT, 'data/digests'), '.json');
  console.log(`rename-vault — ${moves.length} file(s) renamed, ${touched} note/artifact file(s) updated`);
}

main();
