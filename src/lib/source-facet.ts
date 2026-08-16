// What a source REPORTS about its trial (facet + maturity), extracted at enrich
// time so the build can tell a matured re-reading from a different objective.
//
// This is the LLM half of the trial-lineage split: it proposes structure, and
// trial-lineage.ts decides what to do with it in plain code. The fields are
// deliberately thin — a closed facet enum, a two-value maturity, a follow-up
// number, the reported trial's own acronyms — because everything downstream of
// them is a deterministic branch, and a wide free-text field would smuggle model
// judgment into a decision that can unpublish a card.
//
// ABSTENTION IS A CORRECT ANSWER. Guidelines, reviews, editorials and consensus
// statements report no trial outcome, so `facet: null` is the right output for
// them, and any value the model returns that is not in the enum parses to null
// rather than being coerced to the nearest match. A null facet makes
// classifyAgainstPrior return `unrelated`, which leaves the pre-existing curator
// nudge as the only behaviour — the safe direction to fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLlmClient, type LlmClient } from './llm-client.ts';
import {
  isReportFacet,
  isMaturity,
  type ReportFacet,
  type Maturity,
} from './trial-lineage.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '../../prompts/source-facet-v1.txt');

// The facet and the trial's own acronyms live in the title/abstract/methods. The
// discussion — where comparator acronyms live — is exactly what we do NOT want
// the model reading for `trial_acronyms`, so cap well below the full text.
const MAX_PROMPT_CHARS = 12_000;

export type SourceFacet = {
  facet: ReportFacet | null;
  maturity: Maturity | null;
  followup_months: number | null;
  trial_acronyms: string[];
};

export const EMPTY_FACET: SourceFacet = {
  facet: null,
  maturity: null,
  followup_months: null,
  trial_acronyms: [],
};

export type ExtractFacetOptions = {
  client?: LlmClient;
  model?: string;
};

/**
 * Classify one source. Never throws on a malformed LLM response — an unparseable
 * answer abstains. Re-throws only if the LLM CALL fails (network/backend), which
 * the caller treats as retryable, matching extractPaperMetaFromText.
 */
export async function extractSourceFacet(
  text: string,
  opts: ExtractFacetOptions = {},
): Promise<SourceFacet> {
  if (!text || !text.trim()) return EMPTY_FACET;
  const client = opts.client ?? createLlmClient();
  const template = readFileSync(PROMPT_PATH, 'utf-8');
  const prompt = template.replace('{{SOURCE_TEXT}}', text.slice(0, MAX_PROMPT_CHARS));

  const raw = await client.complete([{ role: 'user', content: prompt }], {
    model: opts.model,
    maxTokens: 400,
    temperature: 0,
  });

  return parseSourceFacet(raw);
}

/** Parse the LLM JSON. Every field independently validated; anything off-enum,
 *  out of range, or the wrong type becomes null/[] rather than a coerced guess. */
export function parseSourceFacet(raw: string): SourceFacet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return EMPTY_FACET;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_FACET;
  const o = parsed as Record<string, unknown>;

  return {
    facet: isReportFacet(o.facet) ? o.facet : null,
    maturity: isMaturity(o.maturity) ? o.maturity : null,
    followup_months: followupMonths(o.followup_months),
    trial_acronyms: Array.isArray(o.trial_acronyms)
      ? [
          ...new Set(
            o.trial_acronyms
              .filter((a): a is string => typeof a === 'string')
              .map((a) => a.trim())
              .filter((a) => a.length > 0 && a.length <= 64),
          ),
        ]
      : [],
  };
}

// A follow-up must be a finite, non-negative, plausible number of months. The
// upper bound rejects a model that answered in DAYS: 3650 "months" is 304 years,
// and a bogus large value would read as "longer follow-up" and wrongly supersede
// a card. 50 years is beyond any oncology trial's reporting horizon.
function followupMonths(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > 600) return null;
  return Math.round(v * 10) / 10;
}

function stripFences(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}
