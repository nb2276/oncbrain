// CLI: manage a date's durable digest overrides (data/overrides/<date>.json).
//
// build:day regenerates data/digests/<date>.json from scratch via the LLM, so
// hand-edits there are lost on the next rebuild. This sidecar is applied at
// build time instead, so suppressions and text edits persist.
//
// Usage:
//   npm run override -- --date=2026-05-20 --list
//   npm run override -- --date=2026-05-20 --suppress=<slug>
//   npm run override -- --date=2026-05-20 --unsuppress=<slug>
//   npm run override -- --date=2026-05-20 --edit=<slug> --tldr="..." [--name="..."] [--nct=NCT...]
//   npm run override -- --date=2026-05-20 --edit=<slug> --modality=radiation [--intent=palliative] [--methodology=phase-3-rct]
//   npm run override -- --date=2026-05-20 --edit=<slug> --modality=    # empty value clears the LLM emission
//   npm run override -- --date=2026-05-20 --top-line="..." [--digest-tldr="..."]
//   npm run override -- --date=2026-05-20 --clear
//
// For complex edits (bullets, tables, verdict), hand-edit the JSON file: each
// key under "edits" is a study slug; provided fields replace the generated ones.
// After any change: npm run build:day -- --date=<date> && npm run build
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { overridesPath, type DigestOverrides, type StudyEdit } from '../src/lib/digest-overrides.ts';
import {
  MODALITY_VALUES,
  INTENT_VALUES,
  METHODOLOGY_VALUES,
  isValidModality,
  isValidIntent,
  isValidMethodology,
  type ModalityTag,
  type IntentTag,
  type MethodologyTag,
} from '../src/lib/tags.ts';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]!] = m[2] ?? true;
  }
  return out;
}

function readOverrides(path: string): DigestOverrides {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as DigestOverrides;
}

function writeOverrides(path: string, ov: DigestOverrides): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ov, null, 2) + '\n');
}

function printStudySlugs(date: string): void {
  const digestPath = resolve('data/digests', `${date}.json`);
  if (!existsSync(digestPath)) {
    console.log('\n(no built digest yet — run build:day to see study slugs)');
    return;
  }
  const art = JSON.parse(readFileSync(digestPath, 'utf8')) as {
    digest: { sites: Array<{ disease_site: string; studies: Array<{ name: string; slug?: string }> }> };
  };
  console.log('\nStudies in the current build (target these slugs):');
  for (const s of art.digest.sites) {
    for (const st of s.studies) {
      console.log(`  [${s.disease_site}] ${st.slug ?? '(no slug)'} — ${st.name}`);
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv);
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(
      'Usage: npm run override -- --date=YYYY-MM-DD ' +
        '[--list | --suppress=slug | --unsuppress=slug | --edit=slug (--tldr=.. --name=.. --nct=..) | --top-line=.. --digest-tldr=.. | --clear]',
    );
    process.exit(1);
  }
  const path = overridesPath(date);

  if (args.clear) {
    if (existsSync(path)) {
      rmSync(path);
      console.log(`Removed ${path}`);
    } else {
      console.log('No overrides file to clear.');
    }
    return;
  }

  const ov = readOverrides(path);

  // --list (or a bare --date) just inspects current state.
  const onlyDate = Object.keys(args).length === 1 && typeof args.date === 'string';
  if (args.list || onlyDate) {
    console.log(`Overrides for ${date}:`);
    console.log(JSON.stringify(ov, null, 2));
    printStudySlugs(date);
    return;
  }

  let changed = false;

  if (typeof args.suppress === 'string') {
    const set = new Set(ov.suppress ?? []);
    set.add(args.suppress);
    ov.suppress = [...set];
    changed = true;
    console.log(`+ suppress ${args.suppress}`);
  }

  if (typeof args.unsuppress === 'string') {
    ov.suppress = (ov.suppress ?? []).filter((s) => s !== args.unsuppress);
    if (ov.suppress.length === 0) delete ov.suppress;
    changed = true;
    console.log(`- suppress ${args.unsuppress}`);
  }

  if (typeof args.edit === 'string') {
    const slug = args.edit;
    const edit: StudyEdit = { ...(ov.edits?.[slug] ?? {}) };
    if (typeof args.tldr === 'string') edit.tldr = args.tldr;
    if (typeof args.name === 'string') edit.name = args.name;
    if (typeof args.nct === 'string') edit.nct = args.nct;
    // v0.10: tag field overrides. Empty value clears the LLM emission
    // (sets to null). Invalid enum value errors out so curator catches the
    // typo at CLI time rather than seeing it silently no-op on the next
    // build. Enum lists come from src/lib/tags.ts (single source of truth).
    const tagFlags: ReadonlyArray<{
      flag: keyof typeof args;
      field: 'modality' | 'intent' | 'methodology';
      validator: ((s: string) => boolean);
      allowed: readonly string[];
    }> = [
      { flag: 'modality', field: 'modality', validator: isValidModality, allowed: MODALITY_VALUES },
      { flag: 'intent', field: 'intent', validator: isValidIntent, allowed: INTENT_VALUES },
      { flag: 'methodology', field: 'methodology', validator: isValidMethodology, allowed: METHODOLOGY_VALUES },
    ];
    for (const { flag, field, validator, allowed } of tagFlags) {
      const raw = args[flag];
      if (typeof raw !== 'string') continue;
      const v = raw.trim();
      if (v === '') {
        // Empty value → explicit null. Curator is overriding the LLM's
        // emission with "no value" (study disappears from this namespace's
        // landing pages).
        edit[field] = null;
        continue;
      }
      if (!validator(v)) {
        console.error(`Error: invalid --${flag}="${raw}".`);
        console.error(`Allowed values: ${allowed.join(', ')}`);
        console.error(`Or use --${flag}= (empty) to clear the LLM's emission.`);
        process.exit(1);
      }
      // The validator is a type guard, so TypeScript narrows v to the enum
      // type. The assertion below documents the narrowing for human readers.
      if (field === 'modality') edit.modality = v as ModalityTag;
      else if (field === 'intent') edit.intent = v as IntentTag;
      else if (field === 'methodology') edit.methodology = v as MethodologyTag;
    }
    ov.edits = { ...(ov.edits ?? {}), [slug]: edit };
    changed = true;
    console.log(`~ edit ${slug}: {${Object.keys(edit).join(', ')}}`);
  }

  if (typeof args['top-line'] === 'string' || typeof args['digest-tldr'] === 'string') {
    ov.digest = { ...(ov.digest ?? {}) };
    if (typeof args['top-line'] === 'string') ov.digest.top_line = args['top-line'];
    if (typeof args['digest-tldr'] === 'string') ov.digest.tldr = args['digest-tldr'];
    changed = true;
    console.log(`~ digest: {${Object.keys(ov.digest).join(', ')}}`);
  }

  if (!changed) {
    console.log('No changes specified. Use --list to inspect available slugs.');
    return;
  }

  writeOverrides(path, ov);
  console.log(`\nWrote ${path}`);
  console.log(`Apply with: npm run build:day -- --date=${date} && npm run build`);
}

main();
