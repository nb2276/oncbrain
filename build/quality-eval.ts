// CLI: multi-persona quality eval of one day's digest.
//
// Usage:
//   npm run quality-eval                       # today's digest (latest in data/digests/)
//   npm run quality-eval -- --date=2026-06-05  # specific date
//   npm run quality-eval -- --date=... --dry-run   # print prompts, no LLM calls
//   npm run quality-eval -- --out-dir=/tmp/eval    # override report output dir
//
// Reads data/digests/<date>.json. Runs three personas (designer, oncologist,
// trainee) in parallel against the artifact. Writes a dated markdown report
// to ~/.gstack/projects/nb2276-oncbrain/quality-reports/<date>.md and
// console-prints the summary.
//
// Distinct from `npm run eval`: this is a curator-facing reading tool, not a
// CI gate. No threshold, no pass/fail. Just structured multi-persona feedback
// the curator can act on before the next build:day.

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DigestArtifact } from '../src/lib/digest-data.ts';
import {
  runQualityEval,
  formatReportMarkdown,
  buildPersonaPrompt,
  QUALITY_PERSONAS,
  QUALITY_AXES,
  type QualityReport,
} from '../src/lib/quality-eval.ts';

const DEFAULT_OUT_DIR = resolve(homedir(), '.gstack/projects/nb2276-oncbrain/quality-reports');

type Args = {
  date?: string;
  outDir: string;
  dryRun: boolean;
  model?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]!] = m[2] ?? true;
  }
  return {
    date: typeof args.date === 'string' ? args.date : undefined,
    outDir: typeof args['out-dir'] === 'string' ? args['out-dir'] : DEFAULT_OUT_DIR,
    dryRun: !!args['dry-run'],
    model: typeof args.model === 'string' ? args.model : undefined,
  };
}

function latestDateFromDigests(): string {
  const dir = 'data/digests';
  if (!existsSync(dir)) throw new Error(`No digest directory at ${dir}; run build:day first.`);
  const dates = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  if (dates.length === 0) throw new Error('No digests found in data/digests/; run build:day first.');
  return dates[dates.length - 1]!;
}

function loadArtifact(date: string): { artifact: DigestArtifact; path: string } {
  const path = resolve('data/digests', `${date}.json`);
  if (!existsSync(path)) {
    throw new Error(`Artifact not found: ${path}`);
  }
  const artifact = JSON.parse(readFileSync(path, 'utf-8')) as DigestArtifact;
  return { artifact, path };
}

function fmtScore(score: number): string {
  if (score >= 8) return `\x1b[32m${score.toFixed(1)}\x1b[0m`; // green
  if (score >= 6) return `\x1b[33m${score.toFixed(1)}\x1b[0m`; // yellow
  return `\x1b[31m${score.toFixed(1)}\x1b[0m`; // red
}

function printSummary(report: QualityReport): void {
  console.log(`\n${report.date}: overall mean ${fmtScore(report.overall_mean_score)} / 10`);
  console.log('');
  console.log('Axis means:');
  for (const axis of QUALITY_AXES) {
    console.log(`  ${axis.padEnd(20)} ${fmtScore(report.mean_axes[axis])}`);
  }
  console.log('');
  console.log('Per-persona overall:');
  for (const p of report.personas) {
    console.log(`  ${p.persona.padEnd(12)} ${fmtScore(p.overall_score)}  ${p.verdict}`);
  }
  // Surface the union of each persona's top_issues so the curator sees the
  // most consequential concerns inline. Strict dedup by trimmed string.
  const allTopIssues = new Set<string>();
  for (const p of report.personas) for (const i of p.top_issues) allTopIssues.add(i.trim());
  if (allTopIssues.size > 0) {
    console.log('');
    console.log('Top issues across personas:');
    for (const issue of Array.from(allTopIssues).slice(0, 9)) {
      console.log(`  - ${issue}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const date = args.date ?? latestDateFromDigests();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Invalid --date=${date}. Expected YYYY-MM-DD.`);
    process.exit(1);
  }

  const { artifact, path } = loadArtifact(date);
  console.log(`Loaded ${path}`);

  if (args.dryRun) {
    // Print the rendered prompt for each persona so the curator can inspect
    // what the judge would see without paying the LLM call. Useful for
    // debugging template substitution.
    for (const persona of QUALITY_PERSONAS) {
      console.log(`\n══════ ${persona.toUpperCase()} PROMPT ══════`);
      console.log(buildPersonaPrompt(persona, artifact));
    }
    return;
  }

  console.log(`Running quality eval (${QUALITY_PERSONAS.length} personas in parallel)…`);
  const report = await runQualityEval(artifact, path, { model: args.model });

  // Write the markdown report.
  if (!existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });
  const reportPath = resolve(args.outDir, `${date}.md`);
  writeFileSync(reportPath, formatReportMarkdown(report));
  console.log(`\nWrote ${reportPath}`);

  printSummary(report);
}

main().catch((err) => {
  console.error('quality-eval failed:', (err as Error).message);
  process.exit(1);
});
