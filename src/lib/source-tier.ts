// v0.26 (Thread 1): the deterministic figure-sourced classifier.
//
// A digest bullet's number is marked `source_tier: 'figure'` when it was read
// from a figure (KM curve / forest plot / image-rendered table), NOT the
// abstract. This is a TRUST signal on the shareable card, so it is computed
// deterministically here — never asserted by the LLM. The check is
// value-membership: a significant number that appears in the study's figure OCR
// (unioned across ALL its source papers) and does NOT appear in its abstract.
//
// Named "figure-sourced", never "verified": value-membership proves a number is
// PRESENT in the figure, not that it's attached to the right arm/endpoint. That
// weaker-but-honest claim is exactly what membership can prove (see the
// grounding-gate-spoofable-boundary learning). The abstract-exclusion keeps the
// claim literally true: "read from the figure, not the abstract."
//
// Pure + dependency-free so it unit-tests without a DB. The builder supplies the
// figure/abstract text (unioned across source papers) and calls
// markFigureSourcedDetails on each study's details.

import { detailAllText, withSourceTier, type DigestDetail } from './llm-pipeline.ts';

// A "significant" number: a decimal (8.7, 0.62) or a 2+ digit integer (95, 340).
// Bare single digits (arm counts, "2 arms") are excluded so a trivial axis label
// can't earn a bullet a figure-sourced mark.
const SIGNIFICANT_NUM_RE = /\d+\.\d+|\d{2,}/g;

// The significant numeric tokens in a blob of text, as bare magnitude strings
// ("8.7", "0.62", "95", "340"). Percent signs / units are dropped so "95%" in a
// figure matches "95" in a bullet — membership is on the magnitude.
export function numericTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(SIGNIFICANT_NUM_RE) ?? [];
}

// Mark each detail figure-sourced when one of its significant numbers is present
// in the figure OCR union AND absent from the abstract. When the study has no
// figure OCR there is nothing to vouch for, so every detail is returned untagged
// (and any stale tier is cleared, so a rebuild can only ever REMOVE an
// unsupported mark, never leave one).
export function markFigureSourcedDetails(
  details: DigestDetail[],
  ctx: { figureText: string | null | undefined; abstractText: string | null | undefined },
): DigestDetail[] {
  const figNums = new Set(numericTokens(ctx.figureText));
  if (figNums.size === 0) return details.map((d) => withSourceTier(d, null));
  const absNums = new Set(numericTokens(ctx.abstractText));
  return details.map((d) => {
    const nums = detailAllText(d).flatMap((t) => numericTokens(t));
    const figureSourced = nums.some((n) => figNums.has(n) && !absNums.has(n));
    return withSourceTier(d, figureSourced ? 'figure' : null);
  });
}
