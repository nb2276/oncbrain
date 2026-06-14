// v0.16: study content_type — a first-class classification, orthogonal to
// `methodology` (the study DESIGN) and `verdict` (the SOC-implication triage).
//
// `study_report` — the default. The cluster reports ONE trial / dataset's
//   results (a conference tweet, a primary paper, a trade-press write-up OF a
//   single study). Gets the normal verdict + numeric treatment.
// `review` — a trade-press / survey / state-of-the-art piece that discusses
//   MULTIPLE trials or a general topic, naming several trial acronyms rather
//   than reporting one new result (e.g. a UroToday conference-highlights
//   round-up of the oligomet SBRT landscape). A review carries NO verdict
//   (there is no single SOC implication to triage) and renders its
//   `discussed_trials` acronym list instead of a numbers-first card.
//
// Classified at PHASE 1 (grouping) so a multi-trial review is recognized as its
// own standalone cluster BEFORE Phase 2 — never flattened into, or merged with,
// a single-trial cluster. This is deliberately NOT a /tags/ namespace (it does
// not surface a /tags/<slug>/ landing and is excluded from the global tag-slug
// uniqueness assertion); it lives here, not in tags.ts, for that reason.

export const CONTENT_TYPE_VALUES = ['study_report', 'review'] as const;
export type ContentType = (typeof CONTENT_TYPE_VALUES)[number];

// Back-compat + conservative default: an absent/invalid value is a study
// report. The vast majority of items are single-study; defaulting to `review`
// would strip every legacy study's verdict. The "prefer review when unsure"
// rule (see the grouping prompt) is the LLM's call between the two real
// options, NOT the parser's fallback for a missing field.
export const DEFAULT_CONTENT_TYPE: ContentType = 'study_report';

export function isValidContentType(v: unknown): v is ContentType {
  return typeof v === 'string' && (CONTENT_TYPE_VALUES as readonly string[]).includes(v);
}

// Enforce the review verdict invariant (Codex #9): a `review` study carries no
// verdict — a multi-trial round-up has no single SOC implication to triage, and
// the M0 probe confirmed Phase 2 still emits one, so classification alone does
// not suppress it. The builder calls this AFTER applying curator overrides, so a
// curator verdict edit can't reintroduce one. Structural (not DigestOutput-
// typed) to keep this module a leaf. Mutates in place; returns the count stripped.
export function stripReviewVerdicts(digest: {
  sites: Array<{ studies: Array<{ content_type?: ContentType; verdict?: unknown }> }>;
}): number {
  let stripped = 0;
  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (study.content_type === 'review' && study.verdict != null) {
        study.verdict = undefined;
        stripped++;
      }
    }
  }
  return stripped;
}

// Normalize a raw model value to a ContentType, falling back to the default.
export function parseContentType(raw: unknown): ContentType {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (isValidContentType(v)) return v;
  }
  return DEFAULT_CONTENT_TYPE;
}
