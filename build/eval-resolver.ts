// v0.17 (T7): precision-first eval for the review-trial RESOLVER's rerank gate.
//
//   npm run eval:resolver            # default backend (LLM_BACKEND)
//   npm run eval:resolver -- --threshold=0.75
//
// Feeds the rerank LLM each labeled case's RECORDED candidate set and checks its
// pick against the expected answer. The curator gates publication, so this is a
// QUALITY gate (good candidates), not a safety gate — but a FALSE POSITIVE (a
// pick on a collision case that should be NONE) is the worst outcome, so the
// pass rule is: ZERO false positives, AND recall over the positive cases above a
// threshold. The candidate sets are fixed (recorded) so only the LLM varies.

import 'dotenv/config';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from '../src/lib/llm-client.ts';
import { makeRerankFromLlm, type RerankFn } from '../src/lib/review-trial-resolver.ts';
import type { PubMedSummary } from '../src/lib/pubmed-client.ts';

export type EvalCase = {
  acronym: string;
  disease: string;
  expected: string | null; // expected PMID, or null = NONE (collision)
  candidates: Array<{ pmid: string; title: string; journal: string | null; year: string | null }>;
};

export type CaseResult = { case: EvalCase; picked: string | null };

export type EvalReport = {
  total: number;
  positives: number; // cases with a real expected PMID
  collisions: number; // cases expecting NONE
  correct: number; // picked === expected (incl. correct NONE)
  falsePositives: number; // expected null but picked something (the worst)
  wrongPicks: number; // expected a PMID, picked a DIFFERENT one
  falseNegatives: number; // expected a PMID, picked NONE
  picksMade: number; // cases where a PMID was picked
  precision: number; // correct positive picks / picks made
  recall: number; // correct positive picks / positives
  pass: boolean;
};

const DEFAULT_MIN_RECALL = 0.75;

// Pure scoring — unit-tested without the LLM.
export function scoreResolverEval(results: CaseResult[], minRecall = DEFAULT_MIN_RECALL): EvalReport {
  let positives = 0,
    collisions = 0,
    correct = 0,
    falsePositives = 0,
    wrongPicks = 0,
    falseNegatives = 0,
    picksMade = 0,
    correctPositivePicks = 0;

  for (const { case: c, picked } of results) {
    if (picked !== null) picksMade += 1;
    if (c.expected === null) {
      collisions += 1;
      if (picked === null) correct += 1;
      else falsePositives += 1;
    } else {
      positives += 1;
      if (picked === c.expected) {
        correct += 1;
        correctPositivePicks += 1;
      } else if (picked === null) {
        falseNegatives += 1;
      } else {
        wrongPicks += 1;
      }
    }
  }

  const precision = picksMade > 0 ? correctPositivePicks / picksMade : 1;
  const recall = positives > 0 ? correctPositivePicks / positives : 1;
  // Precision-first: a collision false-positive is disqualifying regardless of recall.
  const pass = falsePositives === 0 && recall >= minRecall;

  return {
    total: results.length,
    positives,
    collisions,
    correct,
    falsePositives,
    wrongPicks,
    falseNegatives,
    picksMade,
    precision,
    recall,
    pass,
  };
}

const FIXTURE = 'test/fixtures/review-trial-resolver-cases.json';

function loadCases(): EvalCase[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE), 'utf-8')) as { cases: EvalCase[] };
  return raw.cases;
}

async function runCase(rerank: RerankFn, c: EvalCase): Promise<CaseResult> {
  const candidates: PubMedSummary[] = c.candidates.map((x) => ({ ...x, pub_date: null }));
  const verdict = await rerank({
    acronym: c.acronym,
    diseaseQuery: c.disease,
    reviewContext: '',
    candidates,
  });
  return { case: c, picked: verdict.pmid };
}

async function main(): Promise<void> {
  const threshold = Number.parseFloat(
    process.argv.find((a) => a.startsWith('--threshold='))?.split('=')[1] ?? '',
  );
  const minRecall = Number.isFinite(threshold) ? threshold : DEFAULT_MIN_RECALL;

  const cases = loadCases();
  const rerank = makeRerankFromLlm(createLlmClient());
  console.log(`Resolver eval: ${cases.length} case(s), min recall ${minRecall}`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.acronym} (${c.disease}) → `);
    const r = await runCase(rerank, c);
    results.push(r);
    const verdict =
      c.expected === null
        ? r.picked === null
          ? 'NONE ✓'
          : `\x1b[31mFALSE-POSITIVE ${r.picked}\x1b[0m`
        : r.picked === c.expected
          ? `${r.picked} ✓`
          : r.picked === null
            ? `\x1b[33mmissed (NONE)\x1b[0m`
            : `\x1b[31mwrong ${r.picked} (want ${c.expected})\x1b[0m`;
    console.log(verdict);
  }

  const report = scoreResolverEval(results, minRecall);
  console.log('━'.repeat(56));
  console.log(
    `precision ${report.precision.toFixed(2)} · recall ${report.recall.toFixed(2)} · ` +
      `${report.falsePositives} false-positive(s) · ${report.wrongPicks} wrong · ${report.falseNegatives} missed`,
  );
  if (report.pass) {
    console.log(`\x1b[32mPASS\x1b[0m`);
  } else {
    console.log(
      `\x1b[31mFAIL\x1b[0m — ${report.falsePositives > 0 ? 'a collision was mis-picked (precision)' : `recall ${report.recall.toFixed(2)} < ${minRecall}`}`,
    );
    process.exit(1);
  }
}

// Only run main() when invoked as a CLI, so the test can import
// scoreResolverEval without triggering an LLM run (mirrors digest-builder.ts).
function isInvokedAsScript(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isInvokedAsScript()) {
  main().catch((err) => {
    console.error(`eval-resolver failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
