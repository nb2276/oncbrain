// CLI: run the LLM digest pipeline against recorded fixtures and grade the output.
//
// Usage:
//   npm run eval                                      # run all fixtures
//   npm run eval -- --fixture=sample-mcrpc            # one fixture
//   npm run eval -- --threshold=8                     # override pass threshold (default 8)
//   npm run eval -- --save-baseline                   # write current run as baseline
//   npm run eval -- --compare-baseline                # diff against saved baseline
//
// Fixture files live in test/fixtures/eval-cases/*.json.
// Eval reports are written to eval/runs/<timestamp>.json.
// Baselines are written to eval/baselines/<prompt-version>.json.
//
// Exit code: 0 if mean overall_score >= threshold (default 8), 1 otherwise.
// Used as a quality gate before shipping a prompt change.

import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { buildDigest, type DigestOutput } from '../src/lib/llm-pipeline.ts';
import {
  judgeDigest,
  summarize,
  type EvalFixture,
  type EvalCaseReport,
} from '../src/lib/eval.ts';

const PROMPT_VERSION = 'digest-v1';
const FIXTURE_DIR = 'test/fixtures/eval-cases';
const RUN_DIR = 'eval/runs';
const BASELINE_DIR = 'eval/baselines';

type Args = {
  fixture?: string;
  threshold: number;
  saveBaseline: boolean;
  compareBaseline: boolean;
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
    fixture: typeof args.fixture === 'string' ? args.fixture : undefined,
    threshold: typeof args.threshold === 'string' ? parseFloat(args.threshold) : 8,
    saveBaseline: !!args['save-baseline'],
    compareBaseline: !!args['compare-baseline'],
    model: typeof args.model === 'string' ? args.model : undefined,
  };
}

function loadFixtures(filter?: string): { name: string; fixture: EvalFixture }[] {
  if (!existsSync(FIXTURE_DIR)) {
    throw new Error(`Fixture directory not found: ${FIXTURE_DIR}`);
  }
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  const out: { name: string; fixture: EvalFixture }[] = [];
  for (const f of files) {
    const name = basename(f, '.json');
    if (filter && name !== filter) continue;
    const raw = readFileSync(resolve(FIXTURE_DIR, f), 'utf-8');
    out.push({ name, fixture: JSON.parse(raw) as EvalFixture });
  }
  if (out.length === 0) {
    throw new Error(filter ? `No fixture named '${filter}' found` : 'No fixtures found');
  }
  return out;
}

function fmtScore(score: number): string {
  if (score >= 8) return `\x1b[32m${score.toFixed(1)}\x1b[0m`; // green
  if (score >= 6) return `\x1b[33m${score.toFixed(1)}\x1b[0m`; // yellow
  return `\x1b[31m${score.toFixed(1)}\x1b[0m`; // red
}

function printCase(report: EvalCaseReport): void {
  const r = report.result;
  console.log(`\n── ${report.fixture_name} ──`);
  console.log(`  factual_accuracy:     ${fmtScore(r.factual_accuracy.score)}   ${r.factual_accuracy.notes}`);
  console.log(`  clinical_relevance:   ${fmtScore(r.clinical_relevance.score)}   ${r.clinical_relevance.notes}`);
  console.log(`  citation_correctness: ${fmtScore(r.citation_correctness.score)}   ${r.citation_correctness.notes}`);
  console.log(`  clustering_quality:   ${fmtScore(r.clustering_quality.score)}   ${r.clustering_quality.notes}`);
  if (r.hallucinations_detected.length > 0) {
    console.log(`  \x1b[31mhallucinations:\x1b[0m`);
    for (const h of r.hallucinations_detected) console.log(`    - ${h}`);
  }
  console.log(`  overall: ${fmtScore(r.overall_score)}   ${r.verdict}`);
}

function compareToBaseline(report: EvalCaseReport): void {
  const baselinePath = resolve(BASELINE_DIR, `${PROMPT_VERSION}__${report.fixture_name}.json`);
  if (!existsSync(baselinePath)) {
    console.log(`  baseline: \x1b[90mnone yet (--save-baseline to set)\x1b[0m`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as EvalCaseReport;
  const delta = report.result.overall_score - baseline.result.overall_score;
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const color = delta < -0.5 ? '\x1b[31m' : delta > 0.5 ? '\x1b[32m' : '\x1b[90m';
  console.log(
    `  baseline: ${baseline.result.overall_score.toFixed(1)} ${color}${arrow} ${delta.toFixed(1)}\x1b[0m`,
  );
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const fixtures = loadFixtures(args.fixture);
  const cases: EvalCaseReport[] = [];

  console.log(`Eval: ${fixtures.length} fixture(s), threshold ${args.threshold}, prompt ${PROMPT_VERSION}`);

  for (const { name, fixture } of fixtures) {
    process.stdout.write(`\n  building digest for ${name}...`);
    let digest: DigestOutput;
    try {
      digest = await buildDigest(fixture.tweets, {
        conferenceName: fixture.conference_name,
        conferenceDay: fixture.conference_day,
        model: args.model,
      });
    } catch (err) {
      console.log(` \x1b[31mFAIL\x1b[0m\n  build error: ${(err as Error).message}`);
      continue;
    }
    process.stdout.write(' done. judging...');

    let result;
    try {
      result = await judgeDigest(fixture, digest, { model: args.model });
    } catch (err) {
      console.log(` \x1b[31mFAIL\x1b[0m\n  judge error: ${(err as Error).message}`);
      continue;
    }
    console.log(' done.');

    const report: EvalCaseReport = {
      fixture_name: name,
      prompt_path: 'prompts/digest-v1.txt',
      model: args.model ?? 'claude-sonnet-4-6',
      judge_model: args.model ?? 'claude-sonnet-4-6',
      digest,
      result,
      generated_at: Date.now(),
    };
    cases.push(report);
    printCase(report);
    if (args.compareBaseline) compareToBaseline(report);
  }

  const summary = summarize(cases, args.threshold);

  ensureDir(RUN_DIR);
  const runPath = resolve(RUN_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(runPath, JSON.stringify(summary, null, 2) + '\n');

  console.log(`\n${'━'.repeat(60)}`);
  console.log(`Mean overall: ${fmtScore(summary.mean_overall_score)} (threshold ${args.threshold})`);
  console.log(`Report: ${runPath}`);

  if (args.saveBaseline) {
    ensureDir(BASELINE_DIR);
    for (const c of cases) {
      const baselinePath = resolve(BASELINE_DIR, `${PROMPT_VERSION}__${c.fixture_name}.json`);
      writeFileSync(baselinePath, JSON.stringify(c, null, 2) + '\n');
      console.log(`Baseline saved: ${baselinePath}`);
    }
  }

  if (!summary.passed) {
    console.log(`\n\x1b[31mFAIL\x1b[0m — mean score below threshold.`);
    process.exit(1);
  }
  console.log(`\n\x1b[32mPASS\x1b[0m`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
