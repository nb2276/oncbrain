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

export type EffectDatum = {
  form: 'ratio';
  kind: RatioKind;
  /** The point estimate. Always > 0 (a ratio <= 0 abstains). */
  point: number;
  /** Interval bounds, or null when the source reported none. lo <= point <= hi. */
  lo: number | null;
  hi: number | null;
  /** 95, 90, 80 — the corpus carries all three. Null when unstated. */
  ciLevel: number | null;
  /** The endpoint class, passed through for the day-axis same-class guard. */
  klass: string | null;
};

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
export function parseEffectSize(pe: PrimaryEndpointLike): EffectDatum | null {
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

  return { form: 'ratio', kind, point, lo, hi, ciLevel, klass: pe.klass ?? null };
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
export function sharedDomain(data: EffectDatum[]): AxisDomain {
  const points = data.map((d) => d.point).filter((p) => Number.isFinite(p) && p > 0);
  if (points.length === 0) return FIXED_DOMAIN;
  const maxLog = Math.max(...points.map((p) => Math.abs(Math.log(p))), MIN_HALF_WIDTH);
  const half = maxLog * 1.15; // 15% breathing room past the most extreme estimate
  // Clamp the BOUND, not the log, so the cap is exact: exp(log(10)) is
  // 10.000000000000002, which would leak a float artifact into a tick label.
  // Deriving lo as 1/hi keeps the domain exactly symmetric about the null.
  const hi = Math.min(Math.exp(half), 10);
  return { lo: 1 / hi, hi };
}

/**
 * The domain for a SINGLE mark, on every surface except a date page. Derived
 * from the datum so the estimate is always on scale: a hard 0.25-4 window would
 * clamp a real corpus value (OR 5.34) to the axis edge, where it reads as 4.0.
 * Deterministic per datum, so the same study renders identically on the site,
 * tag and per-study pages.
 */
export function domainFor(d: EffectDatum): AxisDomain {
  return sharedDomain([d]);
}

/** Group by endpoint class so a shared axis never spans two of them. */
export function groupByKlass(data: EffectDatum[]): Map<string, EffectDatum[]> {
  const out = new Map<string, EffectDatum[]>();
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
  datum: EffectDatum,
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

/**
 * Plain-language description, for a caption or a title attribute. The mark
 * itself is aria-hidden (the estimate and interval are already in the card's
 * text, and a screen reader should not hear them twice), so this exists for
 * sighted-hover and for tests, not as an accessibility substitute.
 */
export function describeEffect(d: EffectDatum): string {
  const ci =
    d.lo != null && d.hi != null
      ? `, ${d.ciLevel ?? 95}% CI ${d.lo} to ${d.hi}`
      : '';
  return `${d.kind} ${d.point}${ci}`;
}
