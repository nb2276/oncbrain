// Comparator grounding: a trial the digest NAMES must be a trial the digest was
// GIVEN.
//
// Phase 2 is asked for comparative context — "how this result sits against the
// trials that currently define practice" — and the trials that define practice
// are, by construction, not in the day's sources. So the prompt was asking the
// model to reach into training memory, and it did: the eval judge found
// "VISION (NEJM 2021): Lu-PSMA-617 monotherapy rPFS HR 0.40 vs SOC in
// post-taxane mCRPC" and "DESTINY-Breast04 (post-chemo HER2-low)" cited as
// grounded comparators, with a trial, a publication, a setting and an effect
// size that appear in no input. One run also flipped EMBARK's population from
// nmCRPC to castration-sensitive — a clinically opposite hormone-sensitivity
// status.
//
// CLAUDE.md already states the rule: "Comparative claims must be grounded — if
// uncertain a comparator trial is real, omit rather than hallucinate." This
// enforces it, because a prompt is a request and a gate is a guarantee. Same
// posture as the figure grounding gate in figure-extract.ts: audit the output
// against the source's own token stream and WITHHOLD what cannot be traced,
// rather than trusting the model to have complied.
//
// THE UNIT IS A NUMBER ATTACHED TO AN UNSOURCED TRIAL, not the trial name alone.
//
// That scope was measured, not assumed. Withholding every surface that merely
// NAMES a trial absent from its sources fires on 105 of 124 published cards —
// because naming prior trials as context is what the comparative sections are
// FOR, and CLAUDE.md asks for exactly that ("comparisons to recent / historic
// literature"). A rule that deletes 85% of the corpus is a broken rule, however
// well-intentioned.
//
// What is not defensible is a STATISTIC attached to a trial the analyst was
// never given: "VISION ... rPFS HR 0.40" states a number no source contains, and
// the reader has no way to know it came from model memory rather than a paper.
// CLAUDE.md draws the same line — "Don't add a number to a digest that isn't in
// a source tweet/image." Naming PEACE-2 as context is editorial judgment;
// asserting PEACE-2's hazard ratio from memory is fabrication.

import { ACRONYM_BLACKLIST, ACRONYM_PATTERN_BLACKLIST } from './source-association.ts';

// A trial-name candidate: an all-caps run of 3+ characters, plus any hyphenated
// continuations. Matches VISION, PRESTIGE-PSMA, DESTINY-Breast04, PEACE-2,
// NRG-GU005. Does not match a leading-digit compound (177Lu-PSMA-617), a
// single-letter lead (T-DXd), or ordinary prose.
const TRIAL_NAME_RE = /\b[A-Z][A-Z0-9]{2,}(?:-[A-Za-z0-9]+)*/g;

// Tokens that look like trial acronyms but never are. ACRONYM_BLACKLIST already
// covers endpoints, statistics, modalities, genes and disease shorthand; these
// are the additions this surface needs — comparative prose cites journals and
// drug classes, and neither is a trial whose absence from the sources should
// withhold a section.
const EXTRA_NON_TRIAL = new Set([
  // Journals and publishers
  'NEJM', 'JAMA', 'JCO', 'LANCET', 'BMJ', 'ANNALS', 'EJC', 'IJROBP', 'RADIOTHER',
  'ESMO', 'ASCO', 'ASTRO', 'AACR', 'SABCS', 'NCCN', 'EAU', 'ESTRO', 'ARS',
  // Drug classes and mechanisms that read as acronyms
  'ARPI', 'ARTA', 'ARSI', 'SOC', 'BSC', 'PSA', 'LHRH', 'GNRH', 'ADC', 'MAB',
  // Study-design shorthand
  'RCT', 'PRISMA', 'CONSORT', 'ITT', 'QOL', 'HRQOL', 'PRO', 'PROS', 'MCID',
  // Capitalised English the analyst bolds for emphasis. Measured against the
  // corpus: "BEFORE" was read as a trial name.
  'BEFORE', 'AFTER', 'NOT', 'ONLY', 'BOTH', 'ALL', 'NONE', 'MORE', 'LESS',
  'NEW', 'OLD', 'YES', 'NO', 'AND', 'THE', 'FOR', 'WITH', 'WITHOUT', 'VERSUS',
  // Treatment modalities beyond those ACRONYM_BLACKLIST lists. Measured: "SRS"
  // (stereotactic radiosurgery) was read as a trial on the FIRESTORM card.
  'SRS', 'SIB', 'IMPT', 'PBT', 'HDR', 'LDR', 'IORT', 'TBI', 'CSI', 'MDT',
  // Dosing schedules and routes — "BID" is bis in die, not a trial.
  'BID', 'TID', 'QID', 'QDS', 'PRN', 'IVF', 'SUB', 'PER',
  // Biomarkers, assays and pathways beyond those ACRONYM_BLACKLIST lists.
  'HRR', 'HRD', 'MMR', 'DDR', 'ATM', 'PTEN', 'CDH1', 'AKT', 'MTOR', 'VEGF',
  'CTC', 'CTDNA', 'IHC', 'ISH', 'FISH', 'NGS', 'WES', 'WGS', 'OCR', 'AUC',
  // Care-setting and process shorthand.
  'MDT', 'ICU', 'ITU', 'LOS', 'QALY', 'ICER', 'FDA', 'EMA', 'NHS', 'NICE',
]);

// Roman numerals: a trial PHASE or a disease STAGE, never a trial name.
// Measured: "III" was read as a trial on a DBCG card.
const ROMAN_RE = /^(?:I{2,3}|IV|VI{0,3}|IX|XI{0,3})[A-C]?$/;

// TNM-style staging descriptors ("N0M0", "T3N1", "M1a"), which are anatomy, not
// trials. Also measured: "N0M0" was read as a trial name on two cards.
const STAGING_RE = /^(?:[TNM]\d+[A-Z]?)+$/;

/** Compare on letters and digits only, so "DESTINY-Breast04" and
 *  "destiny breast 04" are the same token and "DESTINY-Breast06" is not. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTrialCandidate(raw: string): boolean {
  const lead = raw.split('-')[0]!.toUpperCase();
  if (lead.length < 3) return false;
  if (ACRONYM_BLACKLIST.has(lead)) return false;
  if (ACRONYM_PATTERN_BLACKLIST.test(lead)) return false;
  if (EXTRA_NON_TRIAL.has(lead)) return false;
  if (STAGING_RE.test(lead)) return false;
  if (ROMAN_RE.test(lead)) return false;
  // A bare year or a pure number is not a name.
  if (/^\d+$/.test(lead)) return false;
  return true;
}

/** Trial names a piece of prose asserts, verbatim and de-duplicated. */
export function namedTrialsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Map<string, string>();
  for (const m of text.matchAll(TRIAL_NAME_RE)) {
    const raw = m[0];
    if (!isTrialCandidate(raw)) continue;
    const key = normalize(raw);
    if (key.length < 3) continue;
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()];
}

/**
 * Trial names the prose asserts that the source text never mentions.
 *
 * Substring containment on the normalized forms, so a source writing
 * "NRG-GU005" grounds prose writing "NRG GU005", while a source writing
 * "DESTINY-Breast06" does NOT ground prose writing "DESTINY-Breast04" — the
 * distinction the dedup-key path cannot make, because both reduce to the key
 * "DESTINY" and a fabricated sibling trial would pass.
 */
export function ungroundedTrials(
  prose: string | null | undefined,
  sourceText: string,
): string[] {
  const haystack = normalize(sourceText);
  if (!haystack) return namedTrialsIn(prose);
  return namedTrialsIn(prose).filter((name) => !haystack.includes(normalize(name)));
}

// A sentence carries a statistic when it states an effect size, an interval, a
// p-value, a percentage, a median or an n. Used to find the clauses where an
// unsourced trial name is doing factual work rather than giving context.
const STAT_RE =
  /\b(?:a?HR|OR|RR|SHR)\s*[=:]?\s*\d|\d{2}\s*%\s*CI|\bp\s*[=<>]\s*\.?\d|\d+(?:\.\d+)?\s*%|\bmedian\b[^.;]{0,40}?\d|\bn\s*=\s*\d/i;

// How far past a trial name a figure still reads as belonging to it. Covers the
// dominant shapes measured in the corpus — a parenthetical immediately after the
// name, "TALAPRO-2 (all-comer mCRPC 1L, HR 0.63)", and a colon-introduced claim,
// "vs SWOG S8814: ... LRR was 1.5%".
const ATTACH_CHARS = 90;

// Significant numbers, matching the figure-tier convention: decimals, or
// integers of 2+ digits. A bare "3 sites" is not an effect size.
const SIGNIFICANT_NUM_RE = /\d+\.\d+|\d{2,}/g;

function significantNumbers(text: string): string[] {
  return [...(text.match(SIGNIFICANT_NUM_RE) ?? [])];
}

/** Split prose into sentence-ish clauses, so one bad claim withholds one claim
 *  rather than a whole paragraph of grounded analysis. */
function clauses(text: string): string[] {
  return text
    .replace(/\*\*/g, '')
    .split(/(?<=[.;])\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Does this prose attach a NUMBER to a trial its sources never mention?
 *
 * Returns the offending trial names. Empty when the prose is clean — including
 * the common, legitimate case of naming a prior trial as qualitative context
 * with no statistic attached, and the case of restating THIS study's own
 * numbers alongside a comparator's name.
 */
export function ungroundedComparatorClaims(
  prose: string | null | undefined,
  sourceText: string,
): string[] {
  if (!prose) return [];
  const haystack = normalize(sourceText);
  const sourceNums = new Set(significantNumbers(sourceText));
  const bad = new Map<string, string>();

  for (const clause of clauses(prose)) {
    if (!STAT_RE.test(clause)) continue; // context without a number is allowed
    for (const name of namedTrialsIn(clause)) {
      if (haystack.includes(normalize(name))) continue; // the source names it
      // The number must be ATTACHED to the trial, not merely in the same
      // sentence. Clause-level co-occurrence conflates "that trial's number"
      // with "this study's number sitting next to that trial's name": measured
      // against the corpus it flagged "A 100% LC figure is in line with ...
      // (IROCK pooled analyses report high LC)", where the 100% is the card's
      // own result and IROCK is named with no figure at all. Attachment is what
      // makes the claim a claim.
      const at = clause.indexOf(name);
      if (at < 0) continue;
      const attached = clause.slice(at + name.length, at + name.length + ATTACH_CHARS);
      const invented = significantNumbers(attached).filter((n) => !sourceNums.has(n));
      if (invented.length > 0) bad.set(normalize(name), name);
    }
  }
  return [...bad.values()];
}

/** One withheld surface, for the build log. */
export type GroundingWithhold = {
  slug: string;
  surface: string;
  trials: string[];
};

type AuditStudy = {
  slug?: string;
  name: string;
  details?: unknown[];
  analysis_sections?: { label: string; body: string }[] | null;
  significance?: string | null;
  significance_by_specialty?: Record<string, string> | null;
  monday_clinic?: string | null;
  interpretation?: string | null;
};

function detailText(d: unknown): string {
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && typeof (d as { text?: unknown }).text === 'string') {
    return (d as { text: string }).text;
  }
  return '';
}

/**
 * Withhold every prose surface that names a trial the sources never mention.
 *
 * Mutates the study and returns what was removed. Withholding is at the FINEST
 * unit that contains the claim — the offending bullet, not the whole bullet
 * list; the offending section, not the whole fold — because the rest of the
 * card is grounded and still worth publishing.
 *
 * Every long-form surface is audited, not just the comparative section. A
 * fabricated comparator is just as wrong in `Discussion`, in the why-it-matters
 * callout or in the standalone-page interpretation, and auditing only the
 * surface where it was first measured is how a fix ends up guarding the
 * mechanism while leaving the other doors open.
 */
export function withholdUngroundedComparators(
  study: AuditStudy,
  sourceText: string,
): GroundingWithhold[] {
  const out: GroundingWithhold[] = [];
  const slug = study.slug ?? study.name;
  const check = (prose: string | null | undefined): string[] =>
    ungroundedComparatorClaims(prose, sourceText);

  if (Array.isArray(study.details)) {
    const kept: unknown[] = [];
    study.details.forEach((d, i) => {
      const bad = check(detailText(d));
      if (bad.length === 0) kept.push(d);
      else out.push({ slug, surface: `details[${i}]`, trials: bad });
    });
    study.details = kept;
  }

  if (Array.isArray(study.analysis_sections)) {
    const kept: { label: string; body: string }[] = [];
    for (const sec of study.analysis_sections) {
      const bad = check(sec?.body);
      if (bad.length === 0) kept.push(sec);
      else out.push({ slug, surface: `section:${sec.label}`, trials: bad });
    }
    study.analysis_sections = kept.length > 0 ? kept : null;
  }

  for (const key of ['significance', 'monday_clinic', 'interpretation'] as const) {
    const bad = check(study[key]);
    if (bad.length > 0) {
      out.push({ slug, surface: key, trials: bad });
      study[key] = null;
    }
  }

  if (study.significance_by_specialty && typeof study.significance_by_specialty === 'object') {
    const kept: Record<string, string> = {};
    for (const [spec, prose] of Object.entries(study.significance_by_specialty)) {
      const bad = check(prose);
      if (bad.length === 0) kept[spec] = prose;
      else out.push({ slug, surface: `significance:${spec}`, trials: bad });
    }
    study.significance_by_specialty = Object.keys(kept).length > 0 ? kept : null;
  }

  return out;
}

export function formatGroundingWithholds(items: GroundingWithhold[]): string {
  if (items.length === 0) return 'comparator grounding: every named trial is in source';
  const lines = items.map(
    (w) => `    ${w.slug} · ${w.surface}: withheld — ${w.trials.join(', ')} not in source`,
  );
  return [
    `comparator grounding: withheld ${items.length} surface(s) naming an unsourced trial`,
    ...lines,
  ].join('\n');
}
