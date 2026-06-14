// oncbrain studio — interactive terminal UI for curating the digest.
//
//   npm run studio
//
// Wraps the same plumbing as the flag-based CLIs (manage-overrides, build:day,
// pull/enrich) behind an arrow-key menu. "Deleting" a study means suppressing it
// via the durable override sidecar (data/overrides/<date>.json), which survives
// the LLM rebuild — same mechanism as `npm run override -- --suppress`.
import * as p from '@clack/prompts';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadOverrides,
  saveOverrides,
  overridesPath,
  type DigestOverrides,
} from '../src/lib/digest-overrides.ts';
import { openDb, listAllSourceDates } from '../src/lib/db.ts';
import { deriveSlug } from '../src/lib/slug.ts';
import { verdictMetaFor } from '../src/lib/verdict.ts';
import { runResolve, runReview, runList } from './resolve-review-trials.ts';

const DIGESTS_DIR = resolve('data/digests');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type DigestArtifactLite = {
  digest: {
    sites: Array<{
      disease_site: string;
      studies: Array<{
        name: string;
        slug?: string;
        verdict?: { soc_implication?: string } | null;
        // v0.13: studio needs open_questions to drive the per-question
        // suppress menu, and related_trials to show the populated count.
        open_questions?: string[] | null;
        related_trials?: Array<{ nct: string; answers_question: string }> | null;
      }>;
    }>;
  };
};

type StudyRow = {
  slug: string;
  name: string;
  site: string;
  emoji: string;
  openQuestions: string[];
  relatedTrialsCount: number;
};

function readArtifact(date: string): DigestArtifactLite | null {
  const fp = resolve(DIGESTS_DIR, `${date}.json`);
  if (!existsSync(fp)) return null;
  return JSON.parse(readFileSync(fp, 'utf8')) as DigestArtifactLite;
}

function listDates(): Array<{ date: string; count: number }> {
  if (!existsSync(DIGESTS_DIR)) return [];
  return readdirSync(DIGESTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const date = f.replace(/\.json$/, '');
      const art = readArtifact(date);
      const count = (art?.digest.sites ?? []).reduce((n, s) => n + s.studies.length, 0);
      return { date, count };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function listStudies(date: string): StudyRow[] {
  const art = readArtifact(date);
  if (!art) return [];
  const rows: StudyRow[] = [];
  for (const site of art.digest.sites) {
    for (const st of site.studies) {
      rows.push({
        slug: st.slug ?? deriveSlug(st.name),
        name: st.name,
        site: site.disease_site,
        emoji: verdictMetaFor((st.verdict?.soc_implication ?? null) as never)?.emoji ?? '·',
        openQuestions: st.open_questions ?? [],
        relatedTrialsCount: st.related_trials?.length ?? 0,
      });
    }
  }
  return rows;
}

// Run a command, streaming its output, resolving on exit 0.
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    );
  });
}

// Cancel guard: clack returns a symbol on Ctrl+C. Type predicate so the
// non-cancelled value narrows (drops the symbol) after the guard returns.
function cancelled<T>(v: T | symbol): v is symbol {
  if (p.isCancel(v)) {
    p.log.warn('Cancelled.');
    return true;
  }
  return false;
}

async function maybeRebuild(date: string): Promise<void> {
  const yes = await p.confirm({ message: `Rebuild ${date} now? (build:day + astro build)`, initialValue: true });
  if (cancelled(yes) || !yes) {
    p.log.info(`Skipped rebuild. Apply later: npm run build:day -- --date=${date} && npm run build`);
    return;
  }
  try {
    await run('npm', ['run', 'build:day', '--', `--date=${date}`]);
    await run('npm', ['run', 'build']);
    p.log.success(`Rebuilt ${date}. Commit data/digests/${date}.json + data/obsidian/${date}*.md to publish.`);
  } catch (err) {
    p.log.error((err as Error).message);
  }
}

async function pickDate(message: string): Promise<string | null> {
  const dates = listDates();
  if (dates.length === 0) {
    p.log.warn('No built digests found in data/digests/.');
    return null;
  }
  const choice = await p.select({
    message,
    options: dates.map((d) => ({
      value: d.date,
      label: d.date,
      hint: `${d.count} stud${d.count === 1 ? 'y' : 'ies'}`,
    })),
  });
  if (cancelled(choice)) return null;
  return choice as string;
}

async function suppressStudies(date: string): Promise<void> {
  const rows = listStudies(date);
  if (rows.length === 0) {
    p.log.warn('No studies in this digest.');
    return;
  }
  const ov: DigestOverrides = loadOverrides(date) ?? {};
  const current = new Set(ov.suppress ?? []);
  const selected = await p.multiselect({
    message: 'Checked = suppressed (hidden from the published digest). Space toggles, enter applies.',
    options: rows.map((r) => ({ value: r.slug, label: `${r.emoji} ${r.name}`, hint: r.site })),
    initialValues: rows.filter((r) => current.has(r.slug)).map((r) => r.slug),
    required: false,
  });
  if (cancelled(selected)) return;
  const sel = selected as string[];
  if (sel.length > 0) ov.suppress = sel;
  else delete ov.suppress;
  saveOverrides(date, ov);
  p.log.success(sel.length > 0 ? `Suppressing ${sel.length}: ${sel.join(', ')}` : 'No studies suppressed.');
  await maybeRebuild(date);
}

async function editTldr(date: string): Promise<void> {
  const rows = listStudies(date);
  if (rows.length === 0) {
    p.log.warn('No studies in this digest.');
    return;
  }
  const slug = await p.select({
    message: 'Edit which study?',
    options: rows.map((r) => ({ value: r.slug, label: `${r.emoji} ${r.name}`, hint: r.site })),
  });
  if (cancelled(slug)) return;
  const ov: DigestOverrides = loadOverrides(date) ?? {};
  const currentEdit = ov.edits?.[slug as string]?.tldr ?? '';
  const tldr = await p.text({
    message: 'New TL;DR (one sentence, headline number verbatim)',
    initialValue: currentEdit,
    placeholder: 'leave empty to cancel',
  });
  if (cancelled(tldr)) return;
  const text = (tldr as string).trim();
  if (!text) {
    p.log.info('Empty — no change.');
    return;
  }
  ov.edits = { ...(ov.edits ?? {}), [slug as string]: { ...(ov.edits?.[slug as string] ?? {}), tldr: text } };
  saveOverrides(date, ov);
  p.log.success(`Override set for ${slug}.`);
  await maybeRebuild(date);
}

async function clearOverrides(date: string): Promise<void> {
  const fp = overridesPath(date);
  if (!existsSync(fp)) {
    p.log.info('No overrides for this date.');
    return;
  }
  const ok = await p.confirm({ message: `Delete ALL overrides for ${date}?`, initialValue: false });
  if (cancelled(ok) || !ok) return;
  rmSync(fp);
  p.log.success(`Removed ${fp}`);
  await maybeRebuild(date);
}

// v0.13: edit the "Trials to watch" affordance for one study. The TUI
// covers the common cases (suppress all, suppress one question, clear);
// pinning a vetted set with the full RelatedTrial structure is pointed at
// the CLI since the JSON blob is unwieldy to paste in a TUI prompt.
async function editTrialsToWatch(date: string): Promise<void> {
  const rows = listStudies(date);
  if (rows.length === 0) {
    p.log.warn('No studies in this digest.');
    return;
  }
  // Show all studies, not just those with related_trials populated, so the
  // curator can pin a set when the orchestrator returned nothing for the
  // study (codex round-2 #26).
  const slug = await p.select({
    message: "Edit which study's trials-to-watch?",
    options: rows.map((r) => ({
      value: r.slug,
      label: `${r.emoji} ${r.name}`,
      hint: `${r.site} · ${r.relatedTrialsCount} trial${r.relatedTrialsCount === 1 ? '' : 's'} · ${r.openQuestions.length} open Q`,
    })),
  });
  if (cancelled(slug)) return;
  const row = rows.find((r) => r.slug === slug)!;

  const action = await p.select({
    message: `${row.name}: choose action`,
    options: [
      { value: 'suppress-all', label: 'Hide all trials for this study', hint: `currently ${row.relatedTrialsCount}` },
      {
        value: 'suppress-question',
        label: 'Hide trials under one open question',
        hint: row.openQuestions.length === 0 ? 'no open questions on this study' : `${row.openQuestions.length} questions`,
      },
      { value: 'pin-set', label: 'Pin a curated trial set', hint: 'opens CLI hint (JSON blob)' },
      { value: 'clear', label: 'Clear any related-trials override' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (cancelled(action) || action === 'back') return;

  const ov: DigestOverrides = loadOverrides(date) ?? {};
  const map = { ...(ov.related_trials ?? {}) };

  if (action === 'suppress-all') {
    map[slug as string] = { kind: 'suppress' };
    ov.related_trials = map;
    saveOverrides(date, ov);
    p.log.success(`Suppressed all trials for ${slug}.`);
    await maybeRebuild(date);
    return;
  }

  if (action === 'suppress-question') {
    if (row.openQuestions.length === 0) {
      p.log.warn('No open questions on this study; nothing to suppress per-question.');
      return;
    }
    const question = await p.select({
      message: 'Which open question?',
      options: row.openQuestions.map((q) => ({ value: q, label: q })),
    });
    if (cancelled(question)) return;
    map[slug as string] = { kind: 'suppress', questions: [question as string] };
    ov.related_trials = map;
    saveOverrides(date, ov);
    p.log.success(`Suppressed trials under "${question}".`);
    await maybeRebuild(date);
    return;
  }

  if (action === 'pin-set') {
    // Pasting a full RelatedTrial array in a single TUI prompt is awful;
    // point the curator at the CLI instead. Shown verbatim so they can
    // copy-paste the example.
    p.log.info(
      [
        'To pin a curated trial set, use the CLI with a JSON array of',
        'RelatedTrial objects:',
        '',
        `  npm run override -- --date=${date} --related-trials-set=${slug} \\`,
        `    --json='[{"nct":"NCT05123456","brief_title":"...","overall_status":"RECRUITING",`,
        `             "phase":["PHASE3"],"enrollment_count":1200,`,
        `             "primary_completion_date":"2027-03","brief_summary":null,`,
        `             "conditions":[],"interventions":[],"eligibility_brief":null,`,
        `             "answers_question":"<EXACT text from open_questions>",`,
        `             "relevance_phrase":"<= 60 chars"}]'`,
        '',
        'Build-time validation drops entries with bad NCT format, stale',
        'answers_question, dup NCTs, or > 5 total. Warnings surface in the',
        'override summary line.',
      ].join('\n'),
    );
    return;
  }

  if (action === 'clear') {
    if (!(slug in map)) {
      p.log.info(`No related-trials override on ${slug}.`);
      return;
    }
    delete map[slug as string];
    if (Object.keys(map).length === 0) {
      delete ov.related_trials;
    } else {
      ov.related_trials = map;
    }
    saveOverrides(date, ov);
    p.log.success(`Cleared related-trials override for ${slug}.`);
    await maybeRebuild(date);
  }
}

async function manageStudies(): Promise<void> {
  const date = await pickDate('Manage which date?');
  if (!date) return;
  const action = await p.select({
    message: `${date}`,
    options: [
      { value: 'suppress', label: 'Suppress / restore studies', hint: 'delete from the published digest' },
      { value: 'edit', label: "Edit a study's TL;DR" },
      { value: 'trials', label: 'Edit trials-to-watch', hint: 'v0.13: per-question suppress, pin set, clear' },
      { value: 'clear', label: 'Clear all overrides for this date' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (cancelled(action) || action === 'back') return;
  if (action === 'suppress') await suppressStudies(date);
  else if (action === 'edit') await editTldr(date);
  else if (action === 'trials') await editTrialsToWatch(date);
  else if (action === 'clear') await clearOverrides(date);
}

async function buildADay(): Promise<void> {
  const dates = listDates();
  const choice = await p.select({
    message: 'Build which date?',
    options: [
      { value: '__other', label: 'Other date…', hint: 'type YYYY-MM-DD' },
      ...dates.map((d) => ({ value: d.date, label: d.date, hint: `${d.count} stud${d.count === 1 ? 'y' : 'ies'}` })),
    ],
  });
  if (cancelled(choice)) return;
  let date = choice as string;
  if (date === '__other') {
    const typed = await p.text({
      message: 'Date (YYYY-MM-DD)',
      validate: (v) => (DATE_RE.test((v ?? '').trim()) ? undefined : 'Use YYYY-MM-DD'),
    });
    if (cancelled(typed)) return;
    date = (typed as string).trim();
  }
  try {
    await run('npm', ['run', 'build:day', '--', `--date=${date}`]);
    await run('npm', ['run', 'build']);
    p.log.success(`Built ${date}.`);
  } catch (err) {
    p.log.error((err as Error).message);
  }
}

async function ingest(): Promise<void> {
  try {
    await run('npm', ['run', 'pull:telegram']);
    await run('npm', ['run', 'enrich:inbox']);
    p.log.success('Ingest complete. Use "Build a day" to publish.');
  } catch (err) {
    p.log.error((err as Error).message);
  }
}

// v0.17 P3: the review-discussed-trial resolution manifest, surfaced in studio
// (the standalone CLI is `npm run resolve:review-trials`). Resolve searches
// PubMed for the trials a review names and records candidate picks as `pending`;
// nothing publishes until the curator approves a pick here, after which it
// enters the next build as an ordinary source. Calls the CLI's run* functions
// directly (each manages its own DB connection).
async function resolveReviewTrials(): Promise<void> {
  const action = await p.select({
    message: 'Resolve review-discussed trials (v0.17): search PubMed → manifest',
    options: [
      { value: 'resolve', label: 'Resolve a date', hint: 'PubMed search + rerank → manifest (pending)' },
      { value: 'list', label: 'List the manifest', hint: 'one date' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (cancelled(action) || action === 'back') return;
  try {
    if (action === 'resolve') {
      const date = await pickDate('Resolve which date? (reviews on a built digest)');
      if (!date) return;
      await runResolve(date);
      p.log.success(`Resolved ${date}. Use "Review resolved trials" to approve the picks.`);
    } else if (action === 'list') {
      const date = await pickDate('List the manifest for which date?');
      if (!date) return;
      runList(date);
    }
  } catch (err) {
    p.log.error((err as Error).message);
  }
}

// v0.17 P3: the curator review/approval process — walk the pending + failed
// queue and approve/reject each resolved trial. A dedicated top-level option
// (the recurring curator action, separate from the search step above). Approved
// trials enter the next build as study cards; nothing publishes until then.
async function reviewResolvedTrials(): Promise<void> {
  try {
    await runReview();
  } catch (err) {
    p.log.error((err as Error).message);
  }
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Per-date max source timestamp (Unix seconds) across bookmarks/papers/slides.
// Used to decide if a digest is stale relative to its sources.
function maxSourceTimestampByDate(db: ReturnType<typeof openDb>): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT d, MAX(c) AS m FROM (
         SELECT bookmark_date AS d, created_at AS c FROM bookmarks
         UNION ALL SELECT bookmark_date, created_at FROM papers
         UNION ALL SELECT bookmark_date, created_at FROM slide_uploads
       ) GROUP BY d`,
    )
    .all() as { d: string; m: number }[];
  return new Map(rows.map((r) => [r.d, r.m]));
}

// Read just the `generated_at` (Unix ms) off a digest JSON. Returns null if
// the digest file is missing/unparseable.
function digestGeneratedAt(date: string): number | null {
  const fp = resolve(DIGESTS_DIR, `${date}.json`);
  if (!existsSync(fp)) return null;
  try {
    const j = JSON.parse(readFileSync(fp, 'utf8')) as { generated_at?: number };
    return typeof j.generated_at === 'number' ? j.generated_at : null;
  } catch {
    return null;
  }
}

// Same flow as scripts/daily-build.sh, minus git + notify. After ingest, picks
// every back date whose sources are unreflected in the published digest:
//   - missing: source date with no digest JSON at all
//   - stale:   digest exists but a source row's created_at is newer than the
//              digest's generated_at (late-arriving back-dated content)
// Union with yesterday + today (always rebuilt for fresh content).
async function dailyBuild(): Promise<void> {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const todayStr = localDateStr(today);
  const yesterdayStr = localDateStr(yesterday);
  try {
    await run('npm', ['run', 'pull:telegram']);
    await run('npm', ['run', 'enrich:inbox']);

    const db = openDb();
    const sourceDates = listAllSourceDates(db);
    const sourceMaxAt = maxSourceTimestampByDate(db);

    const missing: string[] = [];
    const stale: string[] = [];
    for (const date of sourceDates) {
      const generatedAtMs = digestGeneratedAt(date);
      if (generatedAtMs === null) {
        missing.push(date);
        continue;
      }
      const sourceMaxMs = (sourceMaxAt.get(date) ?? 0) * 1000;
      if (sourceMaxMs > generatedAtMs) stale.push(date);
    }

    const datesToBuild = Array.from(
      new Set([...missing, ...stale, yesterdayStr, todayStr]),
    ).sort();

    if (missing.length > 0) {
      p.log.info(`Catching up ${missing.length} unbuilt date(s): ${missing.join(', ')}`);
    }
    if (stale.length > 0) {
      p.log.info(`Rebuilding ${stale.length} stale date(s): ${stale.join(', ')}`);
    }

    for (const date of datesToBuild) {
      await run('npm', ['run', 'build:day', '--', `--date=${date}`]);
    }
    await run('npm', ['run', 'build']);
    p.log.success(`Daily build complete (${datesToBuild.length} date(s)).`);
  } catch (err) {
    p.log.error((err as Error).message);
  }
}

async function main(): Promise<void> {
  p.intro('oncbrain studio');
  for (;;) {
    const action = await p.select({
      message: 'What do you want to do?',
      options: [
        { value: 'manage', label: 'Manage studies (suppress / edit)' },
        { value: 'daily', label: 'Daily build', hint: 'pull + enrich + build yesterday & today + index' },
        { value: 'build', label: 'Build a day' },
        { value: 'ingest', label: 'Pull + enrich inbox' },
        { value: 'review-trials', label: 'Resolve review trials', hint: 'v0.17: search PubMed for trials a review names' },
        { value: 'review-approve', label: 'Review resolved trials', hint: 'curator: approve / reject the pending queue' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (p.isCancel(action) || action === 'quit') break;
    if (action === 'manage') await manageStudies();
    else if (action === 'daily') await dailyBuild();
    else if (action === 'build') await buildADay();
    else if (action === 'ingest') await ingest();
    else if (action === 'review-trials') await resolveReviewTrials();
    else if (action === 'review-approve') await reviewResolvedTrials();
  }
  p.outro('Done.');
}

main();
