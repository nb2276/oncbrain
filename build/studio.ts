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
import { deriveSlug } from '../src/lib/slug.ts';
import { verdictMetaFor } from '../src/lib/verdict.ts';

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
      }>;
    }>;
  };
};

type StudyRow = { slug: string; name: string; site: string; emoji: string };

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

async function manageStudies(): Promise<void> {
  const date = await pickDate('Manage which date?');
  if (!date) return;
  const action = await p.select({
    message: `${date}`,
    options: [
      { value: 'suppress', label: 'Suppress / restore studies', hint: 'delete from the published digest' },
      { value: 'edit', label: "Edit a study's TL;DR" },
      { value: 'clear', label: 'Clear all overrides for this date' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (cancelled(action) || action === 'back') return;
  if (action === 'suppress') await suppressStudies(date);
  else if (action === 'edit') await editTldr(date);
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

async function main(): Promise<void> {
  p.intro('oncbrain studio');
  for (;;) {
    const action = await p.select({
      message: 'What do you want to do?',
      options: [
        { value: 'manage', label: 'Manage studies (suppress / edit)' },
        { value: 'build', label: 'Build a day' },
        { value: 'ingest', label: 'Pull + enrich inbox' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (p.isCancel(action) || action === 'quit') break;
    if (action === 'manage') await manageStudies();
    else if (action === 'build') await buildADay();
    else if (action === 'ingest') await ingest();
  }
  p.outro('Done.');
}

main();
