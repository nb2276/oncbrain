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
//   npm run override -- --date=2026-05-20 --edit=<slug> --curator-note="Your take on this study."
//   npm run override -- --date=2026-05-20 --edit=<slug> --curator-note=    # empty clears the note
//   npm run override -- --date=2026-05-20 --edit=<slug> --modality=radiation [--intent=palliative] [--methodology=phase-3-rct]
//   npm run override -- --date=2026-05-20 --edit=<slug> --modality=    # empty value clears the LLM emission
//   npm run override -- --date=2026-05-20 --top-line="..." [--digest-tldr="..."]
//   npm run override -- --date=2026-05-20 --clear
//
// v0.13 (trials to watch):
//   # hide all "trials watching" trials for a study
//   npm run override -- --date=2026-05-20 --related-trials-suppress=<slug>
//   # hide trials under one specific open question (text must be exact)
//   npm run override -- --date=2026-05-20 --related-trials-suppress=<slug> \
//     --question="Optimal sequencing vs cabazitaxel"
//   # pin a curator-vetted set; --json is the array of trial objects
//   npm run override -- --date=2026-05-20 --related-trials-set=<slug> \
//     --json='[{"nct":"NCT05123456","brief_title":"...","overall_status":"RECRUITING",
//              "phase":["PHASE3"],"enrollment_count":1200,"primary_completion_date":"2027-03",
//              "brief_summary":null,"conditions":[],"interventions":[],
//              "eligibility_brief":null,"answers_question":"Optimal sequencing vs cabazitaxel",
//              "relevance_phrase":"head-to-head darolutamide vs enzalutamide"}]'
//   # remove ALL related-trials overrides for one slug
//   npm run override -- --date=2026-05-20 --related-trials-clear=<slug>
//
// For complex edits (bullets, tables, verdict), hand-edit the JSON file: each
// key under "edits" is a study slug; provided fields replace the generated ones.
// After any change: npm run build:day -- --date=<date> && npm run build
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  overridesPath,
  parseTagFlag,
  type DigestOverrides,
  type RelatedTrialsOverride,
  type StudyEdit,
  type TagFlagField,
} from '../src/lib/digest-overrides.ts';
import type { RelatedTrial } from '../src/lib/llm-pipeline.ts';
import type { ModalityTag, IntentTag, MethodologyTag } from '../src/lib/tags.ts';

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
        '[--list | --suppress=slug | --unsuppress=slug | --edit=slug (--tldr=.. --name=.. --nct=.. --curator-note=..) | --top-line=.. --digest-tldr=.. | --clear]',
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
    // v0.27: curator's own study-level note (human editor's voice, rendered as
    // its own callout). Empty value clears it (mapped to null).
    if (typeof args['curator-note'] === 'string') {
      edit.curator_note = args['curator-note'].trim() === '' ? null : args['curator-note'];
    }
    // v0.10: tag field overrides. parseTagFlag (shared with the unit tests
    // and with applyOverrides' sidecar-validation layer) handles case
    // normalization, bareword detection, whitespace-only typo guard, and
    // enum validation. Single source of truth for the rules so the CLI and
    // sidecar paths can't drift.
    const tagFields: ReadonlyArray<{ flag: string; field: TagFlagField }> = [
      { flag: 'modality', field: 'modality' },
      { flag: 'intent', field: 'intent' },
      { flag: 'methodology', field: 'methodology' },
    ];
    for (const { flag, field } of tagFields) {
      if (!(flag in args)) continue;
      const result = parseTagFlag(field, args[flag]);
      if (!result.ok) {
        console.error(`Error (--edit=${slug} on ${date}): ${result.error}`);
        process.exit(1);
      }
      if (field === 'modality') edit.modality = result.value as ModalityTag | null;
      else if (field === 'intent') edit.intent = result.value as IntentTag | null;
      else if (field === 'methodology') edit.methodology = result.value as MethodologyTag | null;
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

  // v0.13: trials-to-watch overrides.
  // Mutual exclusion: suppress + set + clear on the same slug are
  // contradictory in one invocation. Catch this before either write so a
  // fat-finger doesn't silently apply the last branch and lose the others
  // (claude PR-3 MEDIUM #7).
  const rtFlagCount =
    (typeof args['related-trials-suppress'] === 'string' ? 1 : 0) +
    (typeof args['related-trials-set'] === 'string' ? 1 : 0) +
    (typeof args['related-trials-clear'] === 'string' ? 1 : 0);
  if (rtFlagCount > 1) {
    console.error(
      'Error: only one of --related-trials-suppress / --related-trials-set / --related-trials-clear per invocation.',
    );
    process.exit(1);
  }
  // --json without --related-trials-set is a useless input on this CLI;
  // surface it as an explicit error instead of silently no-op'ing (codex
  // PR-3 P3).
  if (
    typeof args.json === 'string' &&
    typeof args['related-trials-set'] !== 'string'
  ) {
    console.error('Error: --json is only valid alongside --related-trials-set=<slug>.');
    process.exit(1);
  }

  if (typeof args['related-trials-suppress'] === 'string') {
    const slug = args['related-trials-suppress'];
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const next: RelatedTrialsOverride = question
      ? { kind: 'suppress', questions: [question] }
      : { kind: 'suppress' };
    ov.related_trials = { ...(ov.related_trials ?? {}), [slug]: next };
    changed = true;
    console.log(`+ related-trials-suppress ${slug}${question ? ` (question: "${question}")` : ' (all)'}`);
  }

  if (typeof args['related-trials-set'] === 'string') {
    const slug = args['related-trials-set'];
    const jsonRaw = typeof args.json === 'string' ? args.json : '';
    if (!jsonRaw) {
      console.error(`Error: --related-trials-set=${slug} requires --json='[...]'`);
      process.exit(1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch (err) {
      console.error(`Error: --json could not be parsed: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error('Error: --json must be a JSON array of RelatedTrial objects');
      process.exit(1);
    }
    const next: RelatedTrialsOverride = { kind: 'set', trials: parsed as RelatedTrial[] };
    ov.related_trials = { ...(ov.related_trials ?? {}), [slug]: next };
    changed = true;
    console.log(`+ related-trials-set ${slug} (${parsed.length} trials; build-time validation will WARN on rejects)`);
  }

  if (typeof args['related-trials-clear'] === 'string') {
    const slug = args['related-trials-clear'];
    const map = { ...(ov.related_trials ?? {}) };
    if (slug in map) {
      delete map[slug];
      changed = true;
      console.log(`- related-trials override cleared for ${slug}`);
    } else {
      console.log(`No related-trials override to clear for ${slug}`);
    }
    if (Object.keys(map).length === 0) {
      delete ov.related_trials;
    } else {
      ov.related_trials = map;
    }
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
