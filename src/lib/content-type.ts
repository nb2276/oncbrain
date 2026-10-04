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

// `presentation` (v0.59) — a speaker's TALK: slides shared from a session
//   (typically a speaker posting their own deck on X). It argues a framework or
//   a decision ("TARE vs SBRT: which fits which patient") across the evidence
//   rather than reporting one trial's result, so like a review it carries NO
//   verdict, no primary endpoint, no NCT/DOI. Unlike a review it renders a
//   `presentation` block: a summary of the talk's argument plus an adversarial
//   read of where that argument is weakest. Its slides are the figures.
export const CONTENT_TYPE_VALUES = ['study_report', 'review', 'presentation'] as const;
export type ContentType = (typeof CONTENT_TYPE_VALUES)[number];

// Back-compat + conservative default: an absent/invalid value is a study
// report. The vast majority of items are single-study; defaulting to `review`
// would strip every legacy study's verdict. The "prefer review when unsure"
// rule (see the grouping prompt) is the LLM's call between the two real
// options, NOT the parser's fallback for a missing field.
export const DEFAULT_CONTENT_TYPE: ContentType = 'study_report';

// The verdict-less content types: neither a review nor a presentation reports a
// single result, so neither has one SOC implication to triage, an endpoint to
// head the card, or a registration/DOI of its own. One predicate so a new
// surface can't remember `review` and forget `presentation`.
export function isNonStudyContent(ct: unknown): ct is 'review' | 'presentation' {
  return ct === 'review' || ct === 'presentation';
}

export function isValidContentType(v: unknown): v is ContentType {
  return typeof v === 'string' && (CONTENT_TYPE_VALUES as readonly string[]).includes(v);
}

// Enforce the review verdict invariant (Codex #9): a `review` (or, v0.59, a
// `presentation`) study carries no
// verdict — a multi-trial round-up has no single SOC implication to triage, and
// the M0 probe confirmed Phase 2 still emits one, so classification alone does
// not suppress it. The builder calls this AFTER applying curator overrides, so a
// curator verdict edit can't reintroduce one. Structural (not DigestOutput-
// typed) to keep this module a leaf. Mutates in place; returns the count stripped.
// A consensus/guideline document takes the `consensus` verdict, deterministically.
//
// The efficacy taxonomy has no bucket for a paper with no efficacy endpoint, and
// across five BEACON-HCC builds the analyst returned `unclear`,
// `challenges-soc`, `confirmatory`, `confirmatory` and `challenges-soc` for the
// same document — run-to-run variance, not a signal. Both quality-eval personas
// flagged it independently. Adding the enum to VOICE.md and to the prompt was
// not enough on its own: the next build still chose `challenges-soc`.
//
// So enforce it here, the same posture as stripReviewVerdicts. `consensus` is a
// DOCUMENT-TYPE verdict, orthogonal to whether the document agrees with current
// practice — what it changes belongs in the rationale, which is preserved. The
// methodology tag is assigned deterministically upstream, so this is a mapping,
// not a second judgement.
export function coerceConsensusVerdicts(digest: {
  sites: Array<{
    studies: Array<{ methodology?: string | null; verdict?: { soc_implication?: string } | null }>;
  }>;
}): number {
  let coerced = 0;
  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (study.methodology !== 'consensus-guideline') continue;
      if (!study.verdict || study.verdict.soc_implication === 'consensus') continue;
      study.verdict.soc_implication = 'consensus';
      coerced++;
    }
  }
  return coerced;
}

// v0.59: a presentation's single-result fields are forced off at parse, but a
// curator override (or a card reclassified after an override was written) can
// put them back: an NCT link, a CONSORT flow, a methodology tag that lists a
// talk on the guideline landing. Runs post-override beside stripReviewVerdicts,
// so the invariant holds on the published artifact, not only at parse.
export function enforcePresentationInvariants(digest: {
  sites: Array<{
    studies: Array<{
      content_type?: ContentType;
      nct?: string | null;
      doi?: string | null;
      primary_endpoint?: unknown;
      consort?: unknown;
      methodology?: string | null;
    }>;
  }>;
}): number {
  let fixed = 0;
  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (study.content_type !== 'presentation') continue;
      if (study.nct || study.doi || study.primary_endpoint || study.consort || study.methodology) fixed++;
      study.nct = null;
      study.doi = null;
      study.primary_endpoint = null;
      study.consort = null;
      study.methodology = null;
    }
  }
  return fixed;
}

export function stripReviewVerdicts(digest: {
  sites: Array<{ studies: Array<{ content_type?: ContentType; verdict?: unknown }> }>;
}): number {
  let stripped = 0;
  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (isNonStudyContent(study.content_type) && study.verdict != null) {
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
    // The model's own word for a slide deck; same meaning, one stored value.
    if (v === 'talk' || v === 'slides' || v === 'lecture') return 'presentation';
  }
  return DEFAULT_CONTENT_TYPE;
}

// v0.59: the `presentation` block. A talk has no single result to lead with, so
// the card leads with what the speaker ARGUED (`summary`) and then where that
// argument is weakest (`critique`, the adversarial read). `speaker` is only
// ever a name the sources print; null when they don't say who gave the talk.
export type StudyPresentation = {
  speaker: string | null;
  summary: string | null;
  critique: string[];
};

const PRESENTATION_SUMMARY_MIN = 40;
const PRESENTATION_SUMMARY_MAX = 900;
const CRITIQUE_POINT_MIN = 15;
const CRITIQUE_POINT_MAX = 320;
const MAX_CRITIQUE_POINTS = 4;
const SPEAKER_MAX = 80;

// Shape-guard the model's `presentation` object. Abstains (null) when there is
// nothing to render: no summary and no critique point survives.
export function parsePresentation(raw: unknown): StudyPresentation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const clean = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';

  const summaryRaw = clean(o.summary);
  // An over-long summary is cut at a SENTENCE boundary, never mid-text: a raw
  // slice can turn "HR 0.53" into "HR 0.5", a different number that may still
  // pass grounding. No boundary inside the cap means no summary.
  let summary: string | null = summaryRaw.length < PRESENTATION_SUMMARY_MIN ? null : summaryRaw;
  if (summary && summary.length > PRESENTATION_SUMMARY_MAX) {
    const head = summary.slice(0, PRESENTATION_SUMMARY_MAX);
    const cut = head.search(/[.!?](?=\s[^.!?]*$)/);
    summary = cut >= PRESENTATION_SUMMARY_MIN ? head.slice(0, cut + 1) : null;
  }

  const seen = new Set<string>();
  const critique: string[] = [];
  for (const c of Array.isArray(o.critique) ? o.critique : []) {
    const t = clean(c);
    if (t.length < CRITIQUE_POINT_MIN || t.length > CRITIQUE_POINT_MAX) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    critique.push(t);
    if (critique.length >= MAX_CRITIQUE_POINTS) break;
  }

  const speakerRaw = clean(o.speaker);
  const speaker = speakerRaw && speakerRaw.length <= SPEAKER_MAX ? speakerRaw : null;

  if (!summary && critique.length === 0) return null;
  return { speaker, summary, critique };
}

// Deterministic grounding for the presentation block, the surface most exposed
// to invention: an adversarial read invites the model to reach past the slides.
//   - `speaker` survives only when the sources print that name; a guessed
//     attribution is worse than none. A rejected name is SCRUBBED from every
//     prose field on the card (scrubSpeakerName), not just this block: an
//     adversarial read under a misattributed physician's name is a public
//     statement about a real person.
//   - any NUMBER in the summary or a critique point must trace to the sources.
//     The check is injected: the pipeline passes its own table/endpoint
//     verifier (decimal-separator normalization, leading-decimal equivalence,
//     CI-bound adjacency), so this block is held to the same bar as every
//     other numeric surface rather than a weaker private copy. On top of it, a
//     percentage must be a percentage in the source, and a magnitude in words
//     is rejected outright.
//     The finest unit is withheld (one critique point, or the summary), never
//     the whole block, because the rest is still grounded.
// Named-trial grounding (a figure attached to a trial the sources never name)
// is the comparator gate's job and runs over these fields too.
const HONORIFIC_RE = /^(dr|prof|professor)\.?\s+/i;

// Fold what differs between two spellings of one name: case, accents ("José"
// / "Jose"), apostrophe style, a possessive ("Roe's"), and middle initials
// ("Brian I. Rini" prints the same person as "Brian Rini").
function nameWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/'s$/, '').replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 1);
}

function nameTokens(name: string): string[] {
  return nameWords(name.replace(HONORIFIC_RE, ''));
}

// The name must appear in the source as a CONTIGUOUS run of words (initials
// aside). Scattered tokens ("mark" here, "lee" there) are not a name, and a
// bare single token ("Sanford") is never enough on its own.
export function speakerGrounded(speaker: string, sourceText: string): boolean {
  const toks = nameTokens(speaker);
  if (toks.length < 2) return false;
  const words = nameWords(sourceText);
  for (let i = 0; i + toks.length <= words.length; i++) {
    if (toks.every((t, j) => words[i + j] === t)) return true;
  }
  return false;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace a rejected speaker's name with "the speaker" in a piece of prose:
 * the full name (honorific, middle initials, possessive allowed) and an
 * honorific + surname ("Dr. Roe"). Matched on the name AS A NAME, never token
 * by token, so a rejected "Daniel Low" leaves "low-risk" alone.
 */
export function scrubSpeakerName(text: string, speaker: string): string {
  const parts = speaker.replace(HONORIFIC_RE, '').trim().split(/\s+/).filter((w) => w.replace(/\./g, '').length > 1);
  if (parts.length < 2) return text;
  const first = escapeRe(parts[0]!);
  const last = escapeRe(parts[parts.length - 1]!);
  const hon = String.raw`(?:(?:Dr|Prof|Professor)\.?\s+)`;
  const poss = String.raw`(?<poss>['’]s)?`;
  // Up to two capitalized middle words or initials ("Nina Niu Sanford",
  // "Brian I. Rini"); case-sensitive so ordinary lowercase words never join a
  // name.
  const full = new RegExp(String.raw`${hon}?${first}(?:\s+\p{Lu}[\p{L}'’-]*\.?){0,2}\s+${last}${poss}(?![\p{L}])`, 'gu');
  const short = new RegExp(String.raw`${hon}${last}${poss}(?![\p{L}])`, 'gu');
  // Read ONLY the captured possessive: the callback's trailing arguments
  // include the whole input string, so scanning them found any unrelated "'s".
  const swap = (...args: unknown[]): string => {
    const groups = args[args.length - 1] as { poss?: string } | undefined;
    return groups?.poss ? "the speaker's" : 'the speaker';
  };
  const out = text.replace(full, swap).replace(short, swap);
  // Sentence-initial "the speaker" reads as a typo.
  return out.replace(/(^|[.!?]\s+)the speaker/g, (_m, pre: string) => `${pre}The speaker`);
}

// A magnitude written in words dodges a digit check entirely ("ninety-nine
// percent local control", "cuts mortality in half", "one in ten patients").
// Rejected OUTRIGHT, even when the words appear in the source: matching a word
// alone let "nine hundred" ride on a source's "one hundred", and the prompt
// asks for digits, which the numeric verifier can actually check.
//
// Narrow on purpose, measured against the published corpus: a broad version
// tripped on 1.6% of real prose ("twice daily" fractionation, "grade 2 in 13
// pts", idiomatic "half of the question"). Digit forms are left to the numeric
// verifier, and only phrasing that ASSERTS a quantity is caught:
//   - number words from eleven up (and "<word> percent");
//   - multipliers ("threefold", "halved", "doubled");
//   - fractions OF something ("two-thirds", "a third of", "in half");
//   - spelled frequencies ("one in ten", "six out of ten").
const NUM_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten)';
const SPELLED_MAGNITUDE_RE = new RegExp(
  String.raw`\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million` +
    String.raw`|${NUM_WORD}[\s-]+(?:percent|per cent)` +
    String.raw`|halved|doubled|tripled|quadrupled|(?:two|three|four|five|six|seven|eight|nine|ten)-?fold` +
    String.raw`|(?:one|two)-thirds?|(?:one|three)-quarters?|(?:one|two|a)\s+thirds?\s+of|(?:one|three|a)\s+quarters?\s+of|(?:in|by)\s+half|half\s+of\s+(?:all\s+)?(?:patients|pts|cases|men|women)` +
    String.raw`|${NUM_WORD}\s+(?:in|out\s+of)\s+(?:two|three|four|five|six|seven|eight|nine|ten|twenty|a\s+hundred))\b`,
  'gi',
);

function spelledMagnitude(prose: string): string | null {
  const m = prose.match(SPELLED_MAGNITUDE_RE);
  return m ? `spelled-out magnitude "${m[0]}"` : null;
}

// A percentage is a role, not just a number: "84 patients" in the source does
// not ground "84% local control". Every N% in the prose needs N% (or N percent)
// in the sources, and a percentile is not a percentage.
function ungroundedPercent(prose: string, sourceLower: string): string | null {
  // \d* so a leading-decimal ".5%" is read whole, not as "5%"; leading zeros
  // dropped on both sides so ".5%" and "0.5%" are the same value.
  for (const m of prose.matchAll(/(?<![\d.,·])(\d*[.,·]?\d+)\s*(?:%|percent\b|per cent\b|percentage[\s-]+points?\b)/g)) {
    const n = m[1]!.replace(/[,·]/g, '.').replace(/^0+(?=[.\d])/, '');
    const esc = n.replace('.', '[.,·]');
    // The boundary excludes a decimal separator too: "0,5%" must not ground "5%".
    if (!new RegExp(String.raw`(^|[^\d.,·])0*${esc}\s*(%|percent\b|per cent\b|percentage[\s-]+points?\b)`).test(sourceLower)) return `${m[1]}%`;
  }
  return null;
}

// Words in a speaker string that are not the person: credentials, honorifics,
// name particles.
const NON_NAME = new Set(['dr', 'prof', 'professor', 'md', 'phd', 'mph', 'frcpc', 'facr', 'faso', 'de', 'la', 'van', 'von', 'der', 'del', 'da', 'di', 'le']);

/**
 * Does any trace of a rejected speaker's name remain in these strings? Folded
 * like speakerGrounded (case, accents, possessive, apostrophes) and matched
 * per whole word on the surname, or on the only name word when there is one.
 * Deliberately over-inclusive: the caller DROPS the card on a hit rather than
 * publish an adversarial read under a misattributed physician's name.
 */
export function speakerNameRemains(strings: string[], speaker: string): boolean {
  const toks = nameWords(speaker).filter((t) => t.length >= 3 && !NON_NAME.has(t));
  if (toks.length === 0) return false;
  const surname = toks[toks.length - 1]!;
  const words = new Set(strings.flatMap((s) => nameWords(s.replace(/-/g, ' '))));
  return words.has(surname);
}

export function groundPresentation(
  p: StudyPresentation,
  sourceText: string,
  firstUngroundedNumber: (prose: string) => string | null,
): { presentation: StudyPresentation | null; withheld: string[]; rejectedSpeaker: string | null } {
  const withheld: string[] = [];
  const sourceLower = sourceText.toLowerCase();

  let speaker = p.speaker;
  let rejectedSpeaker: string | null = null;
  if (speaker && !speakerGrounded(speaker, sourceText)) {
    withheld.push(`speaker "${speaker}" not in sources`);
    rejectedSpeaker = speaker;
    speaker = null;
  }
  const notIn = (v: string | null): string | null => (v ? `"${v}" not in sources` : null);
  const firstProblem = (prose: string): string | null =>
    notIn(firstUngroundedNumber(prose)) ?? notIn(ungroundedPercent(prose, sourceLower)) ?? spelledMagnitude(prose);
  const scrub = (prose: string): string => (rejectedSpeaker ? scrubSpeakerName(prose, rejectedSpeaker) : prose);

  let summary = p.summary ? scrub(p.summary) : null;
  if (summary) {
    const bad = firstProblem(summary);
    if (bad) {
      withheld.push(`summary: ${bad}`);
      summary = null;
    }
  }

  const critique = p.critique.map(scrub).filter((c, i) => {
    const bad = firstProblem(c);
    if (bad) withheld.push(`critique[${i}]: ${bad}`);
    return !bad;
  });

  const presentation = !summary && critique.length === 0 ? null : { speaker, summary, critique };
  return { presentation, withheld, rejectedSpeaker };
}
