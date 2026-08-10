// The same number, emphasized twice, one line apart.
//
// Since v0.30 the card is endpoint-forward: `primary_endpoint.stat_value`
// renders in its own slot (StudyCard `.endpoint-stat`) and the TL;DR renders
// directly beneath it. Both run through `emphasizeStats`, and both promote
// their FIRST effect-size token to the `.stat-key` hero class. Measured over
// the 122 published cards, the endpoint's stat_value appears verbatim inside
// its own TL;DR on 52% of the cards that carry one (27/52) — so on half the
// corpus the reader's eye lands on the identical bolded "HR 0.62" twice in
// adjacent lines, which spends the card's scarcest resource (at-rest
// attention) on nothing.
//
// WHY THIS IS A DISPLAY FIX AND NOT A PROMPT RULE. The obvious alternative is
// to tell Phase 2 "don't restate the endpoint statistic in the TL;DR", which is
// the shape of the existing don't-restate-the-trial-name rule. It would be
// wrong here: the TL;DR is rendered ALONE, with no endpoint block beside it, in
// the RSS feed (`feed.ts`), the search index, the flat RecentFeed on the home
// and /studies pages, and the Obsidian export. Stripping the number from the
// stored field to de-duplicate ONE surface would silently strip it from four
// others. So the field keeps the number and the card decides how to paint it.
//
// WHAT IT DOES, DELIBERATELY MINIMAL: it removes the duplicate's EMPHASIS, not
// the duplicate's TEXT. Deleting the fragment would risk an ungrammatical
// sentence ("mPFS 14.2 vs 9.8mo favoring X" happens to read, plenty of others
// would not), and the TL;DR still has to stand alone in an RSS reader. The
// sentence stays whole and readable; only the second bolding goes away, so the
// hero number is emphasized once, in the slot the card designates for it.

// Case, spacing and trailing punctuation vary between the two fields for the
// same quantity ("HR 0.62" vs "hr 0.62." vs "HR  0.62"). Everything else is
// left alone: this must NOT strip the CI or the operator, because "HR 0.62"
// and "HR 0.62 (0.48-0.79)" are different amounts of information and only an
// actual duplicate should lose its emphasis.
export function normalizeStat(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:]+|[\s.,;:]+$/g, '')
    .trim();
}

// A MEASURE-ANCHORED quantity: a number welded to what it measures. "HR 0.48",
// "64.5%", "20.4 mo" are atoms; a naked "0.48" is not.
//
// Comparing atoms rather than whole strings is what makes this work on real
// data. The endpoint slot routinely carries a COMPOUND stat — the corpus has
// `35.8 vs 20.4 mo, HR 0.48` in one field — while the TL;DR repeats just one of
// its components, and often abbreviates differently (`64.5% v 62.3%` in the
// endpoint against `64.5% vs 62.3%` in the TL;DR). Neither string contains the
// other, so string containment reports "not a duplicate" on precisely the cases
// a reader sees as one. Atoms compare the quantities and ignore the prose.
//
// Anchoring is also what makes it SAFE. "HR 0.6" and "HR 0.62" are simply
// different atoms, so a shorter decimal can never swallow a longer one's
// emphasis — the failure mode that would silently demote a real result.
const ATOM_PATTERNS: RegExp[] = [
  /\b(a?hr|or|rr|irr)\s*[=:]?\s*(\d+\.?\d*)/g, // ratio + its measure
  /(\d+\.?\d*)\s*%/g, // percentage
  /(\d+\.?\d*)\s*(mo|months?|yrs?|years?|wks?|weeks?)\b/g, // duration
];

export function statAtoms(text: string): Set<string> {
  const s = normalizeStat(text);
  const out = new Set<string>();
  for (const re of ATOM_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      out.add(
        m[2] !== undefined && /[a-z]/.test(m[1] ?? '')
          ? `${m[1]} ${m[2]}` // "hr 0.48"
          : m[2] !== undefined
            ? `${m[1]} ${m[2]}` // "20.4 mo"
            : `${m[1]}%`, // "64.5%"
      );
    }
  }
  return out;
}

// Is `token` (a stat picked out of the TL;DR) restating a quantity the endpoint
// block already shows directly above it?
//
// True when they share at least one atom. A token with no measure-anchored
// quantity at all (a bare "0.62", a lone p-value) never matches: un-emphasizing
// the WRONG number is worse than leaving a duplicate bold, so anything
// ambiguous is left exactly as it was.
export function isDuplicateStat(token: string, endpointStat: string | null | undefined): boolean {
  if (!token || !endpointStat) return false;
  const a = statAtoms(token);
  if (a.size === 0) return false;
  const b = statAtoms(endpointStat);
  for (const x of a) if (b.has(x)) return true;
  return false;
}
