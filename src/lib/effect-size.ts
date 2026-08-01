// v0.33 slice 1: the effect-size mark's numeric spine.
//
// Turns a study's ALREADY-VALIDATED primary_endpoint into a typed, drawable
// datum, or abstains. Every number the mark renders comes from here, and every
// field is NUMERIC — nothing user-facing is interpolated as a string, so the
// component can never paint text it didn't compute.
//
// WHAT THIS IS NOT. It does not decide whether a result is good, significant, or
// practice-changing. It reports an estimate and its interval on a log axis. In
// particular it draws a null line at 1.0 because that is where a ratio's null
// sits, NOT as a claim about the trial's hypothesis: several trials in this
// corpus are non-inferiority designs whose margin (e.g. "NI margin 2.12") lives
// in prose the artifact does not model. The mark shows the estimate; the card's
// verdict and prose carry the conclusion.
//
// GROUNDING. Slice 1 draws RATIOS ONLY (HR / OR / RR / subdistribution HR).
// Proportions and medians ("28% vs 21%", "15.8 vs 12.3 mo") are a different
// mark and are deliberately out of scope — parsing them into a forest dot would
// put a value on a log ratio axis where it does not belong. Those abstain.

/** The label the source used. Kept for the mark's accessible description. */
export type RatioKind = 'HR' | 'OR' | 'RR' | 'SHR';

/**
 * v0.33 slice 2. A two-value comparison drawn as paired bars on a LINEAR axis
 * from zero — percentages, months, or points.
 *
 * NO VALENCE. Neither bar is marked better. The endpoint class cannot tell you
 * the direction: `local-control` covers both "local control 95% vs 88%" (higher
 * is better) and "local recurrence 5% vs 12%" (lower is better), and deriving it
 * would mean guessing from the endpoint's NAME. That is the semantic guessing
 * this codebase has been burned by, so the mark reports magnitude and leaves
 * meaning to the reader — the same reasoning that cut the "favors X" spine from
 * the ratio form.
 */
export type PairedDatum = {
  form: 'paired';
  a: { label: string | null; value: number };
  b: { label: string | null; value: number };
  /** Rendered after each value. Null when the source gave no unit. */
  unit: string | null;
  klass: string | null;
  /** Where the numbers came from, for the corpus report and for debugging. */
  origin: 'endpoint' | 'table';
};

export type RatioDatum = {
  form: 'ratio';
  kind: RatioKind;
  /** The point estimate. Always > 0 (a ratio <= 0 abstains). */
  point: number;
  /** Interval bounds, or null when the source reported none. lo <= point <= hi. */
  lo: number | null;
  hi: number | null;
  /** 95, 90, 80 — the corpus carries all three. Null when unstated. */
  ciLevel: number | null;
  /** The endpoint class, kept for reference; the axis buckets on family. */
  klass: string | null;
  /** The endpoint's name, so a datum can name its own axis bucket. */
  endpointName: string | null;
};

export type EffectDatum = RatioDatum | PairedDatum;

/** Minimal shape this module needs; mirrors DigestStudy['primary_endpoint']. */
export type PrimaryEndpointLike = {
  name?: string | null;
  klass?: string | null;
  stat_value?: string | null;
  stat_detail?: string | null;
} | null | undefined;

// Lancet and several EU journals use a MIDDLE DOT as the decimal separator
// ("0·44-0·86"). Ranges arrive with hyphen, en dash, em dash or a unicode
// minus depending on the source. Normalize both before any numeric parse, or
// a real interval silently fails to match and the mark abstains on good data.
function normalizeNumerics(s: string): string {
  return s
    .replace(/[·∙]/g, '.')
    .replace(/[‒–—−]/g, '-');
}

// "HR", "aHR", "adjusted HR", "Sub-HR", "sHR", "OR", "RR", "HR=" ...
// The captured word decides the display kind. `(?<![A-Za-z])` keeps it from
// firing inside a longer token.
const RATIO_RE =
  /(?<![A-Za-z])(?:adjusted\s+|sub-?|s|a)?(HR|OR|RR)\s*[=:]?\s*(\d+(?:\.\d+)?)/i;

// "95% CI 0.41-0.72", "90% CI 0.84 to 2.04", "(95% CI 0.607-0.928)"
const CI_RE =
  /(\d{2})\s*%\s*CI[\s:]*\(?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*\)?/i;

type CiHit = { a: number; b: number; level: number | null };

function toCiHit(m: RegExpMatchArray | null): CiHit | null {
  if (!m) return null;
  const a = Number(m[2]);
  const b = Number(m[3]);
  const level = Number(m[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return { a, b, level: Number.isFinite(level) ? level : null };
}

// How far after a ratio a CI may start and still count as "attached to it".
// "HR 0.750 (95% CI ...)" is ~2 chars; allow a little slack for "HR 0.75, 95% CI".
const CI_ADJACENCY_CHARS = 12;

function findAdjacentCi(text: string, fromIndex: number): CiHit | null {
  const tail = text.slice(fromIndex, fromIndex + CI_ADJACENCY_CHARS + 40);
  const m = CI_RE.exec(tail);
  if (!m || (m.index ?? 0) > CI_ADJACENCY_CHARS) return null;
  return toCiHit(m);
}

/** A CI, only when the text contains exactly one — otherwise association is a guess. */
function findSoleCi(text: string): CiHit | null {
  const all = [...text.matchAll(new RegExp(CI_RE.source, 'gi'))];
  if (all.length !== 1) return null;
  return toCiHit(all[0]!);
}

function ratioKind(raw: string, prefixed: boolean): RatioKind {
  const up = raw.toUpperCase();
  if (up === 'OR') return 'OR';
  if (up === 'RR') return 'RR';
  return prefixed ? 'SHR' : 'HR';
}

/**
 * Parse a primary endpoint into a drawable ratio, or null.
 *
 * Abstains (returns null) on every one of these, by design:
 *   - no ratio anywhere ("28% vs 21%", "Not yet mature", "NR vs 17 mo")
 *   - a non-finite or non-positive ratio (a log axis has no place for it)
 *   - a reversed interval (hi < lo) — corrupt source data
 *   - an interval that does not contain the point estimate — either corrupt, or
 *     a sign we associated the wrong CI with the ratio. Abstaining is the safe
 *     read: a mark drawn from a mis-paired interval is worse than no mark.
 */
export function parseEffectSize(pe: PrimaryEndpointLike): RatioDatum | null {
  if (!pe) return null;
  const value = normalizeNumerics(pe.stat_value ?? '');
  const detail = normalizeNumerics(pe.stat_detail ?? '');
  if (!value && !detail) return null;

  // The ratio is usually in stat_value ("HR 0.54") but often only in the detail
  // ("mDFS 52.7 vs 24.4 mo" + "HR 0.750 (95% CI 0.607-0.928)"). Prefer the
  // value; fall back to the detail. Take the FIRST match either way — a detail
  // can carry a primary AND an adjusted estimate ("HR 0.77 ... adjusted HR
  // 0.72") and the primary is the one the card is reporting.
  const inValue = RATIO_RE.exec(value);
  const m = inValue ?? RATIO_RE.exec(detail);
  if (!m) return null;

  const point = Number(m[2]);
  if (!Number.isFinite(point) || point <= 0) return null;
  const prefixed = /sub-?|^s/i.test(m[0].trim()) && !/^(adjusted|a)\s*HR/i.test(m[0].trim());
  const kind = ratioKind(m[1]!, prefixed);

  // Pick the interval. Containment alone is NOT enough to prove association: a
  // detail like "HR 0.70; 12-mo PFS 0.70 (95% CI 0.60-0.80); HR 95% CI 0.50-0.95"
  // has a rate CI that happens to contain the HR, and pairing them would draw a
  // confidently wrong interval. So a CI is accepted only when the association is
  // UNAMBIGUOUS: either it directly follows the ratio, or it is the only CI in
  // the text. Anything else drops to a point-only mark — the estimate is still
  // trustworthy, the interval is not.
  const ratioInValue = inValue !== null;
  const ratioText = ratioInValue ? value : detail;
  const ratioEnd = m.index + m[0].length;

  const ci =
    // (a) adjacent: the CI opens within a short window after the ratio, which
    //     covers the parenthetical form "HR 0.750 (95% CI 0.607-0.928)".
    findAdjacentCi(ratioText, ratioEnd) ??
    // (b) unambiguous: exactly one CI in the other field. Covers the corpus's
    //     dominant shape, stat_value "HR 0.54" + stat_detail "95% CI 0.41-0.72",
    //     including details where prose precedes the CI.
    findSoleCi(ratioInValue ? detail : value) ??
    // (c) unambiguous within the ratio's own field.
    findSoleCi(ratioText);

  let lo: number | null = null;
  let hi: number | null = null;
  let ciLevel: number | null = null;
  if (ci) {
    const { a, b, level } = ci;
    if (b < a) return null; // reversed bounds: corrupt, do not guess
    // Containment stays as a second guard: it still catches corrupt data and a
    // CI that passed association but cannot belong to this estimate.
    if (point < a || point > b) return null;
    lo = a;
    hi = b;
    ciLevel = level;
  }

  return { form: 'ratio', kind, point, lo, hi, ciLevel, klass: pe.klass ?? null, endpointName: pe.name ?? null };
}

// ── paired values (slice 2) ─────────────────────────────────────────────────

// "28% vs 21%", "61.0% vs 28.6%", "15.8 vs 12.3 mo", "7% vs 7.4% (AHRT vs EHRT)",
// "8.0% vs 9.4% (40 vs 50Gy)". Captures both numbers plus a trailing unit.
const PAIR_RE =
  /(\d+(?:\.\d+)?)\s*(%|mo|months?|pts?|Gy)?\s+vs\.?\s+(\d+(?:\.\d+)?)\s*(%|mo|months?|pts?|Gy)?/i;

// A trailing "(A vs B)" names the arms: "7% vs 7.4% (AHRT vs EHRT)".
const ARMS_RE = /\(([^()]{1,40}?)\s+vs\.?\s+([^()]{1,40}?)\)/i;

// Any SECOND "vs" among the VALUES means three or more arms
// ("3.5% vs 3.7% vs 5.5%"), and a two-bar mark cannot honestly represent three.
// Count only outside parentheses: a trailing "(AHRT vs EHRT)" names the arms and
// its "vs" is not a third value.
function countValueVs(s: string): number {
  return (s.replace(/\([^()]*\)/g, ' ').match(/\bvs\.?\b/gi) ?? []).length;
}

function normUnit(u: string | undefined): string | null {
  if (!u) return null;
  const l = u.toLowerCase();
  if (l === '%') return '%';
  if (l.startsWith('mo') || l.startsWith('month')) return 'mo';
  if (l.startsWith('pt')) return 'pts';
  if (l === 'gy') return 'Gy';
  return null;
}

/**
 * Parse a two-value comparison out of a primary endpoint, or abstain.
 *
 * Only runs when parseEffectSize found no ratio: a study reporting BOTH an HR
 * and two rates is better served by the ratio, which carries its interval.
 *
 * Abstains on: three or more arms, "not reached" (no finite value to plot),
 * prose with no pair, a stated difference rather than two values ("68.9 mm³
 * more plaque"), and equal-and-zero pairs that would draw two empty bars.
 */
export function parsePairedValues(pe: PrimaryEndpointLike): PairedDatum | null {
  if (!pe) return null;
  const value = normalizeNumerics(pe.stat_value ?? '');
  if (!value) return null;

  // "NR vs 17 mo" — not-reached has no position on a linear axis.
  if (/\b(NR|not reached)\b/i.test(value)) return null;
  if (countValueVs(value) !== 1) return null;

  const m = PAIR_RE.exec(value);
  if (!m) return null;
  const av = Number(m[1]);
  const bv = Number(m[3]);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return null;
  if (av < 0 || bv < 0) return null;
  if (av === 0 && bv === 0) return null; // two empty bars carry nothing

  // Two DIFFERENT stated units means these are not two measurements of one
  // endpoint ("28% vs 21 mo"), so they cannot be two bars on one scale.
  const ua = normUnit(m[2]);
  const ub = normUnit(m[4]);
  if (ua && ub && ua !== ub) return null;
  const unit = ua ?? ub;
  // Arm labels only when the source states them; never invented. A purely
  // numeric "label" means the parenthetical held the VALUES, not arm names
  // ("Δ4.8 pts (79.2 vs 74.3)"), so it is not a label.
  //
  // ALL OR NOTHING. "8.0% vs 9.4% (40 vs 50Gy)" captures "40" and "50Gy": the
  // first is numeric and gets dropped, which would leave one bar labelled
  // "50Gy" and the other blank — an asymmetric label reads as if only one arm
  // were identified. Either both sides are real names or neither is used.
  const arms = ARMS_RE.exec(value);
  const labelOf = (raw: string | undefined): string | null => {
    const t = raw?.trim();
    if (!t || /^[\d.,%\s]+$/.test(t)) return null;
    return t;
  };
  const la = labelOf(arms?.[1]);
  const lb = labelOf(arms?.[2]);
  const bothLabelled = la !== null && lb !== null;
  return {
    form: 'paired',
    a: { label: bothLabelled ? la : null, value: av },
    b: { label: bothLabelled ? lb : null, value: bv },
    unit,
    klass: pe.klass ?? null,
    origin: 'endpoint',
  };
}

// ── table gate (slice 2) ────────────────────────────────────────────────────

export type DigestTableLike = { columns?: unknown; rows?: unknown } | null | undefined;

// Headers that name something OTHER than the trial's randomized arms. Drawing
// any of these as two arms is a clinical misrepresentation, and they are the
// MAJORITY shape in this corpus: of 75 tables, 23 name one of these and exactly
// one says "Arm". Surveyed 2026-07-31.
const NON_ARM_AXIS =
  /\b(trial|study|cohort|subgroup|group|setting|site|entity|modality|technique|regimen|status|stage|population|line|histolog|menopaus|feature|failure|grade|morbidity|therapy)\b/i;

// STRONG evidence that a column names a randomized arm: an explicit "Arm X" or
// a comparator name. Either identifies a randomised comparison on its own.
const STRONG_ARM = [
  /^\s*arm\s+[a-z0-9]/i,                           // "Arm A"
  /\b(control|placebo|observation|obs|soc|standard|no\s+\w+|usual care|sham)\b/i,
];

// A bare study/trial acronym: "POP-RT", "PEACE-2", "STAMPEDE". Two of these
// side by side is a trial comparison, not a randomised two-arm result, even
// when both report an n.
const TRIAL_ACRONYM = /^\s*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\s*(?:\(\s*n\s*=[^)]*\))?\s*$/;

// A trailing statistics column ("p", "HR (95% CI), p") is not an arm.
const STAT_COLUMN = /^\s*(p|p-?value|hr|or|rr|95%\s*ci|hr\s*\(95%\s*ci\)|.*\bci\b.*)\s*[,)]?\s*$/i;

export type ArmTable = { armA: string; armB: string; colA: number; colB: number };

/**
 * POSITIVE gate: return the two arm columns ONLY when the table can be
 * identified as an endpoint-by-arm comparison. Returns null otherwise, which is
 * the common case by design.
 *
 * Shape alone is not enough. A 3-column table is just as likely to be
 * trial-vs-trial ("Endpoint | POP-RT | PEACE-2"), stage cohorts
 * ("Cohort | BCLC-0 | BCLC-A") or subgroups ("Menopausal status | ..."), and
 * each of those drawn as arms would be confidently wrong.
 *
 * Requires ALL of:
 *   1. the row-label column is endpoint-like (rows are outcomes, columns arms)
 *   2. exactly two non-statistic value columns remain
 *   3. neither names a non-arm axis
 *   4. at least one carries positive arm evidence (an n=, an "Arm X", or a
 *      control-like name)
 */
export function armColumns(table: DigestTableLike): ArmTable | null {
  if (!table || !Array.isArray(table.columns)) return null;
  const cols = table.columns.filter((c): c is string => typeof c === 'string');
  if (cols.length < 3) return null;

  // 1. rows must be endpoints, so the columns can be arms.
  const rowAxis = cols[0] ?? '';
  if (!/^\s*endpoint\b/i.test(rowAxis)) return null;

  // A parenthetical on the endpoint axis is fine when it is a TIME horizon
  // ("Endpoint (20yr)", "Endpoint (2y)") and disqualifying when it names a
  // POPULATION ("Endpoint (never/former smokers)"). The columns of a
  // subgroup-restricted table really are the arms, but its numbers are that
  // subgroup's, and drawing them beneath the card's headline endpoint would
  // present a subgroup result as the primary one.
  const qualifier = /\(([^)]*)\)/.exec(rowAxis)?.[1]?.trim();
  if (qualifier && !/^\d+\s*-?\s*(y|yr|yrs|year|years|mo|month|months|wk|week|weeks|d|day|days)$/i.test(qualifier)) {
    return null;
  }

  // 2. drop trailing statistic columns.
  const candidates: Array<{ name: string; idx: number }> = [];
  for (let i = 1; i < cols.length; i += 1) {
    const name = cols[i]!;
    if (STAT_COLUMN.test(name)) continue;
    candidates.push({ name, idx: i });
  }
  if (candidates.length !== 2) return null;

  // 3. neither may name a non-arm axis.
  for (const c of candidates) if (NON_ARM_AXIS.test(c.name)) return null;
  // The row-label header itself can disqualify: "Endpoint (never/former smokers)"
  // is a subgroup slice, not the trial's arms.
  if (NON_ARM_AXIS.test(cols[0] ?? '')) return null;

  // 4. positive evidence required — absence of a red flag is not evidence.
  //
  // An "(n=...)" alone is NOT enough: "Endpoint | POP-RT (n=500) | PEACE-2
  // (n=600)" is trial-vs-trial, and both trials report an n. A control-like
  // name or an explicit "Arm X" identifies a randomised comparison; a bare n
  // only counts when at least one column is not a bare study acronym.
  const strong = candidates.some((c) => STRONG_ARM.some((re) => re.test(c.name)));
  const hasN = candidates.some((c) => /\(\s*n\s*=/i.test(c.name));
  const bothAcronyms = candidates.every((c) => TRIAL_ACRONYM.test(c.name));
  if (!strong && !(hasN && !bothAcronyms)) return null;

  return {
    armA: candidates[0]!.name,
    armB: candidates[1]!.name,
    colA: candidates[0]!.idx,
    colB: candidates[1]!.idx,
  };
}

// ANCHORED: the whole cell must be a plain endpoint value. Unanchored, this
// read "50 Gy" as 50 and rendered a radiotherapy dose as a survival result.
// A cell with any other content (a dose unit, a fraction, an interval) is not
// an arm value for this endpoint.
const CELL_NUM = /^\s*(\d+(?:\.\d+)?)\s*(%|mo|months?)?\s*$/i;

/**
 * Does a table row label name the study's primary endpoint?
 *
 * Bare substring matching in BOTH directions is unsafe for short endpoint
 * names: "OS" is a substring of "Dose", so an overall-survival endpoint matched
 * a dose row. Short names must match exactly; longer ones may match on word
 * boundaries.
 */
function rowMatchesEndpoint(rowLabel: string, endpointName: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const row = norm(rowLabel);
  const want = norm(endpointName);
  if (!row || !want) return false;
  if (row === want) return true;
  const [shorter, longer] = want.length <= row.length ? [want, row] : [row, want];
  // Too short to risk a partial match ("OS", "PFS", "IBR").
  if (shorter.length < 5) return false;
  const esc = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${esc}(\\W|$)`).test(longer);
}

/**
 * A paired datum from a gated arm table, matching the study's primary endpoint
 * row. Returns null unless the gate passes AND a row plainly matches the
 * endpoint name AND both cells hold a plain number.
 */
export function parsePairedFromTable(
  pe: PrimaryEndpointLike,
  table: DigestTableLike,
): PairedDatum | null {
  if (!pe?.name) return null;
  const arms = armColumns(table);
  if (!arms || !Array.isArray(table?.rows)) return null;

  const wanted = pe.name;
  for (const row of table.rows as unknown[]) {
    if (!Array.isArray(row)) continue;
    const label = typeof row[0] === 'string' ? row[0] : '';
    if (!label) continue;
    if (!rowMatchesEndpoint(label, wanted)) continue;

    const rawA = row[arms.colA];
    const rawB = row[arms.colB];
    if (typeof rawA !== 'string' || typeof rawB !== 'string') continue;
    // A cell carrying a ratio or an interval is not a plain arm value.
    if (RATIO_RE.test(rawA) || RATIO_RE.test(rawB)) continue;
    if (CI_RE.test(rawA) || CI_RE.test(rawB)) continue;

    const ma = CELL_NUM.exec(normalizeNumerics(rawA));
    const mb = CELL_NUM.exec(normalizeNumerics(rawB));
    if (!ma || !mb) continue;
    const av = Number(ma[1]);
    const bv = Number(mb[1]);
    if (!Number.isFinite(av) || !Number.isFinite(bv) || av < 0 || bv < 0) continue;
    if (av === 0 && bv === 0) continue;

    return {
      form: 'paired',
      a: { label: arms.armA, value: av },
      b: { label: arms.armB, value: bv },
      unit: normUnit(ma[2]) ?? normUnit(mb[2]),
      klass: pe.klass ?? null,
      origin: 'table',
    };
  }
  return null;
}

// ── axis ────────────────────────────────────────────────────────────────────

export type AxisDomain = { lo: number; hi: number };

/**
 * The fixed axis, used on every surface except a date page. Symmetric on the
 * log scale about 1.0, so "half the risk" and "twice the risk" are mirror
 * distances rather than one visually dwarfing the other.
 */
export const FIXED_DOMAIN: AxisDomain = { lo: 0.25, hi: 4 };

const MIN_HALF_WIDTH = Math.log(2); // never tighter than 0.5x-2x

/**
 * The upper bounds a ratio axis is allowed to take. Snapping to this ladder is
 * what makes a corpus-wide axis STABLE: without it, every new study nudges the
 * domain and silently redraws every older card in its bucket. With it, the axis
 * only moves when a genuinely new extreme crosses a rung.
 *
 * It also gives readable ticks — "0.33 / 1.0 / 3" instead of "0.43 / 1.0 / 2.3".
 */
// Extends past 10 so a real but extreme effect still gets a ruler that CONTAINS
// it. Capping at 10 meant a point of, say, 12 produced a domain excluding it,
// which then failed the pointOffScale guard and silently drew nothing — safe,
// but it contradicts the "the axis always contains the estimate" contract.
const DOMAIN_STEPS = [1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 100] as const;

function snapUp(hi: number): number {
  for (const step of DOMAIN_STEPS) if (hi <= step) return step;
  // Past the ladder, round up to the next power of ten so the bound stays a
  // clean tick and still contains the estimate.
  return Math.pow(10, Math.ceil(Math.log10(hi)));
}

/**
 * A shared domain for one date's marks. Symmetric about 1.0 and wide enough to
 * hold every point estimate, so two cards on the same page are comparable at a
 * glance. Intervals may still overflow — that is what the clip indicator is
 * for; letting a single enormous CI set the scale would flatten every other
 * mark on the page to a dot.
 *
 * Callers must pass ONE endpoint class at a time. Mixing an overall-survival HR
 * with a local-control HR on one ruler implies a comparability the numbers do
 * not have.
 */
export function sharedDomain(data: RatioDatum[]): AxisDomain {
  const points = data.map((d) => d.point).filter((p) => Number.isFinite(p) && p > 0);
  if (points.length === 0) return FIXED_DOMAIN;
  const maxLog = Math.max(...points.map((p) => Math.abs(Math.log(p))), MIN_HALF_WIDTH);
  const half = maxLog * 1.15; // 15% breathing room past the most extreme estimate
  // Snap UP to the ladder. Deriving lo as 1/hi keeps the domain exactly
  // symmetric about the null, and snapping keeps the bound exact (exp(log(10))
  // is 10.000000000000002, which would leak into a tick label).
  const hi = snapUp(Math.exp(half));
  return { lo: 1 / hi, hi };
}

/**
 * Endpoint FAMILY — the grouping a shared ruler is allowed to span.
 *
 * The endpoint class alone is too coarse: "surrogate" covers progression-free
 * survival, clinical PFS, imaging PFS, PFS by blinded review, metastasis-free
 * survival, disease-free survival and recurrence-free survival in this corpus
 * alone. Those share a unit but are not the same quantity, and one ruler across
 * them implies a comparison the endpoints do not support.
 *
 * Bucketing by the exact NAME is the opposite failure: 19 rulers for 31 marks,
 * 16 holding a single card, which is per-mark scaling with extra steps.
 *
 * Families are the middle: PFS variants group together (they measure the same
 * thing with different assessment methods), while PFS, MFS and DFS stay apart.
 * Derived from the endpoint name the card already displays above the mark.
 *
 * Order matters — the first match wins, so the more specific patterns lead.
 */
const ENDPOINT_FAMILIES: Array<[RegExp, string]> = [
  [/\bmetastasis-?free\b|\bMFS\b/i, 'mfs'],
  [/\bdisease-?free\b|\bDFS\b/i, 'dfs'],
  [/\bevent-?free\b|\bEFS\b/i, 'efs'],
  // Local/regional recurrence and failure measure the same construct.
  [/\b(locoregional|loco-regional|local)\b.*\b(recurrence|failure|progression|control)\b/i, 'local'],
  [/\b(recurrence|relapse)\b/i, 'recurrence'],
  [/\bbiochemical\b/i, 'biochemical'],
  [/\bprogression-?free\b|\bPFS\b/i, 'pfs'],
  [/\boverall survival\b|\bOS\b/i, 'os'],
  [/\bcomplete response\b|\bpCR\b|\bresponse\b/i, 'response'],
  [/\btoxicity\b|\bgrade\s*[≥>]?\s*\d|\blymphedema\b|\binduration\b|\bplaque\b/i, 'toxicity'],
  [/\bquality of life\b|\bqol\b|\bwell-?being\b|\bcomposite score\b|\bbreast-?q\b/i, 'pro'],
];

export function endpointFamily(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'unknown';
  for (const [re, family] of ENDPOINT_FAMILIES) if (re.test(n)) return family;
  return 'other';
}

/**
 * The bucket a mark shares a ruler with: endpoint FAMILY and ratio KIND.
 *
 * Kind, because an odds ratio and a hazard ratio are not interchangeable.
 * Family rather than class, because class pools quantities that are not
 * comparable (see ENDPOINT_FAMILIES).
 */
export function axisBucket(d: RatioDatum, endpointName?: string | null): string {
  return `${endpointFamily(endpointName ?? d.endpointName)}::${d.kind}`;
}

/**
 * One ruler per (endpoint class, ratio kind), computed across the WHOLE corpus.
 *
 * Why corpus-wide rather than per page: counted over the archive, only 3 date
 * buckets ever hold two comparable marks while 24 hold exactly one, so a
 * per-date axis is identical to a per-mark axis on 89% of dates. The clusters
 * that readers actually compare live on site pages (six prostate surrogate-HR
 * trials on one page). A corpus-wide ruler makes those comparable, makes every
 * card comparable to every other of its type, and removes the cross-surface
 * inconsistency where one study rendered at different widths on different pages.
 *
 * Snapped bounds keep it stable: a new study only moves the ruler when it
 * crosses a rung of the ladder.
 */
export function corpusDomains(data: RatioDatum[]): Map<string, AxisDomain> {
  const byBucket = new Map<string, RatioDatum[]>();
  for (const d of data) {
    const key = axisBucket(d);
    const bucket = byBucket.get(key);
    if (bucket) bucket.push(d);
    else byBucket.set(key, [d]);
  }
  const out = new Map<string, AxisDomain>();
  for (const [key, rows] of byBucket) out.set(key, sharedDomain(rows));
  return out;
}

/**
 * The domain for a SINGLE mark, on every surface except a date page. Derived
 * from the datum so the estimate is always on scale: a hard 0.25-4 window would
 * clamp a real corpus value (OR 5.34) to the axis edge, where it reads as 4.0.
 * Deterministic per datum, so the same study renders identically on the site,
 * tag and per-study pages.
 */
export function domainFor(d: RatioDatum): AxisDomain {
  return sharedDomain([d]);
}

/** Group by endpoint class so a shared axis never spans two of them. */
export function groupByKlass(data: RatioDatum[]): Map<string, RatioDatum[]> {
  const out = new Map<string, RatioDatum[]>();
  for (const d of data) {
    const key = d.klass ?? 'unknown';
    const bucket = out.get(key);
    if (bucket) bucket.push(d);
    else out.set(key, [d]);
  }
  return out;
}

// ── geometry ────────────────────────────────────────────────────────────────

export type MarkGeometry = {
  /** All x positions in [0, width], already clamped to the plot area. */
  pointX: number;
  loX: number | null;
  hiX: number | null;
  nullX: number;
  /** True when the interval ran past the axis and was cut short. */
  clippedLo: boolean;
  clippedHi: boolean;
  /**
   * True when the POINT ESTIMATE itself falls outside the domain. Clamping an
   * interval is honest (the arrowhead says "continues"); clamping the estimate
   * is a lie — the dot would sit at the axis edge and read as that edge's value.
   * Callers must not draw a mark when this is true.
   */
  pointOffScale: boolean;
  /** Tick positions + their labels, low to high. */
  ticks: Array<{ x: number; label: string }>;
};

function fmtTick(v: number): string {
  if (v >= 10) return String(Math.round(v));
  if (v >= 1) return v.toFixed(v % 1 === 0 ? 0 : 1);
  return v.toFixed(2).replace(/0$/, '');
}

/**
 * Map a datum onto a plot of `width` units. The ONLY place coordinates are
 * computed — the inline SVG component and any future satori renderer both call
 * this, so the two can differ in paint but never in math.
 *
 * Log scale, because a ratio's distance from 1.0 is multiplicative: on a linear
 * axis 0.5 and 2.0 (equal and opposite effects) would sit at wildly different
 * distances from the null.
 */
export function markGeometry(
  datum: RatioDatum,
  domain: AxisDomain,
  width: number,
): MarkGeometry {
  // Defensive: an exported function should not emit NaN/Infinity because a
  // future caller handed it a degenerate domain.
  const safe =
    Number.isFinite(domain.lo) && Number.isFinite(domain.hi) &&
    domain.lo > 0 && domain.hi > domain.lo && Number.isFinite(width) && width > 0
      ? domain
      : FIXED_DOMAIN;
  const plotWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const logLo = Math.log(safe.lo);
  const logHi = Math.log(safe.hi);
  const span = logHi - logLo;
  const x = (v: number) => ((Math.log(v) - logLo) / span) * plotWidth;
  const clamp = (n: number) => Math.min(plotWidth, Math.max(0, n));

  const clippedLo = datum.lo != null && datum.lo < safe.lo;
  const clippedHi = datum.hi != null && datum.hi > safe.hi;
  const pointOffScale = datum.point < safe.lo || datum.point > safe.hi;

  return {
    pointX: clamp(x(datum.point)),
    loX: datum.lo != null ? clamp(x(datum.lo)) : null,
    hiX: datum.hi != null ? clamp(x(datum.hi)) : null,
    nullX: clamp(x(1)),
    clippedLo,
    clippedHi,
    pointOffScale,
    ticks: [
      { x: clamp(x(safe.lo)), label: fmtTick(safe.lo) },
      { x: clamp(x(1)), label: '1.0' },
      { x: clamp(x(safe.hi)), label: fmtTick(safe.hi) },
    ],
  };
}

export type PairedGeometry = {
  /** Bar widths in [0, width]. Linear from zero — bar length IS the value. */
  aW: number;
  bW: number;
  /** The axis maximum the bars are scaled against. */
  max: number;
};

/**
 * Paired bars use a LINEAR axis anchored at ZERO, not a log one. These are
 * magnitudes (a rate, a duration), so bar length must be proportional to value:
 * a bar twice as long has to mean twice as much. Starting anywhere but zero
 * would exaggerate a small difference, which is the classic misleading chart.
 */
export function pairedGeometry(d: PairedDatum, width: number): PairedGeometry {
  const plotWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const peak = Math.max(d.a.value, d.b.value);
  // Percentages get a 100 ceiling so two rates are comparable card to card;
  // everything else scales to its own peak with a little headroom.
  const max = d.unit === '%' ? Math.max(100, peak) : peak * 1.05 || 1;
  const w = (v: number) => Math.max(0, Math.min(plotWidth, (v / max) * plotWidth));
  return { aW: w(d.a.value), bW: w(d.b.value), max };
}

/**
 * The one entry point a caller needs: the best available mark for a study, or
 * null. Ratio first — it carries an interval and a null reference, so it says
 * strictly more than two bars. Paired values are the fallback, and a gated arm
 * table is the last resort.
 */
export function effectForStudy(
  pe: PrimaryEndpointLike,
  tables: DigestTableLike[] = [],
): EffectDatum | null {
  const ratio = parseEffectSize(pe);
  if (ratio) return ratio;
  const paired = parsePairedValues(pe);
  if (paired) return paired;
  for (const t of tables) {
    const fromTable = parsePairedFromTable(pe, t);
    if (fromTable) return fromTable;
  }
  return null;
}

/**
 * Plain-language description, for a caption or a title attribute. The mark
 * itself is aria-hidden (the estimate and interval are already in the card's
 * text, and a screen reader should not hear them twice), so this exists for
 * sighted-hover and for tests, not as an accessibility substitute.
 */
export function describeEffect(d: EffectDatum): string {
  if (d.form === 'paired') {
    const u = d.unit ?? '';
    const a = d.a.label ? `${d.a.label} ` : '';
    const b = d.b.label ? `${d.b.label} ` : '';
    return `${a}${d.a.value}${u} versus ${b}${d.b.value}${u}`;
  }
  const ci =
    d.lo != null && d.hi != null
      ? `, ${d.ciLevel ?? 95}% CI ${d.lo} to ${d.hi}`
      : '';
  return `${d.kind} ${d.point}${ci}`;
}
