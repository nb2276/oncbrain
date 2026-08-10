// Does a study card agree with ITSELF?
//
// `validateStudyTables` already grounds every table cell against source content,
// so no cell carries a number the paper doesn't contain. That is a different
// question from whether the card's own surfaces agree. Nothing checked that, and
// the v0.42 multi-date quality-eval found it repeatedly:
//
//   "contradicts its own table's 92% whole-group value — the single most
//    visible number on that card isn't the one in its table"
//   "a table that contradicts its own headline number"
//   "fix the 92%→90% RFS slip"
//
// Both numbers are grounded; the card quotes one in its TL;DR and a different
// one in its table. Every existing guard passes and a clinician reads a headline
// figure the card itself disagrees with two lines further down.
//
// THE INVARIANT: when a card renders a table, every value in its TL;DR should
// appear somewhere in the card's own body. The TL;DR is the one line a reader
// takes away; if its number is nowhere else on the card, either the body
// disagrees with it or nothing supports it. On the real example the TL;DR said
// "10-yr RFS 90% overall" while its own table row said 92%.
//
// WHY NOT MATCH ON LABELS. The obvious design — find the table row the prose is
// talking about and compare — was built first and thrown away. Prose and tables
// name the same quantity differently ("RFS" vs "Freedom from biochemical/
// clinical relapse", "overall" vs "Whole group"), so label anchoring missed the
// real slips entirely; loosening it to proximity produced 200 flags over 122
// cards, essentially all spurious, because a row label like "Tamoxifen" appears
// in prose in a dozen unrelated contexts. Traceability needs no synonyms.
//
// CALIBRATED, not guessed. Over the 41 published digests (122 cards, 61 with a
// table) this flags 1. Against the experimental rebuilds where the eval found
// contradictions it flags 3 of 3, including a fabricated POSEIDON subgroup HR
// that a separate eval had independently called out.
//
// SCOPED to cards that render a table, deliberately. Without one, a headline
// number legitimately appears only in the TL;DR, and the same rule flags 11 of
// 122 — mostly cards whose bullets paraphrase rather than repeat. Having a table
// is what makes "should be traceable" a fair expectation.
//
// ADVISORY, never fatal. It logs for the curator the way tag emissions and
// magnitude moves do; a false positive must not be able to block the 1am build.

// Percentages and decimals only. Bare integers are years, doses, arm sizes and
// fraction counts — matching them adds noise without adding signal.
// The trailing guard rejects a following DIGIT, not a following period: a body
// that ends its sentence with the value ("DFS HR 0.54.") must still match, or
// the audit reports the headline as untraceable when the card does support it.
const VALUE_RE = /(\d[\d,]*\.?\d*)\s*%|(?<![\d.])(\d+\.\d+)(?!\d)/g;

export function extractValues(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(VALUE_RE)) {
    out.add(m[1] !== undefined ? `${m[1].replace(/,/g, '')}%` : m[2]!);
  }
  return out;
}

export type UntraceableHeadline = {
  slug: string;
  values: string[];
};

type StudyLike = {
  slug?: string;
  name?: string;
  tldr?: string | null;
  significance?: string | null;
  monday_clinic?: string | null;
  details?: unknown[];
  analysis_sections?: unknown;
  primary_endpoint?: unknown;
  significance_by_specialty?: unknown;
  verdict?: unknown;
};

function hasTable(study: StudyLike): boolean {
  return (study.details ?? []).some(
    (d) => d !== null && typeof d === 'object' && 'table' in (d as object),
  );
}

// Everything on the card EXCEPT the TL;DR. Serialized wholesale on purpose: the
// question is only "does this value appear anywhere the reader can see it",
// which needs no per-field structure and stays correct as fields are added.
function cardBody(study: StudyLike): string {
  return JSON.stringify([
    study.details ?? null,
    study.analysis_sections ?? null,
    study.significance ?? null,
    study.significance_by_specialty ?? null,
    study.monday_clinic ?? null,
    study.primary_endpoint ?? null,
    study.verdict ?? null,
  ]);
}

export function findUntraceableHeadline(study: StudyLike): UntraceableHeadline | null {
  if (!hasTable(study)) return null;
  const headline = extractValues(study.tldr ?? '');
  if (headline.size === 0) return null;
  const body = extractValues(cardBody(study));
  const orphans = [...headline].filter((v) => !body.has(v));
  if (orphans.length === 0) return null;
  return { slug: study.slug ?? study.name ?? '(unnamed)', values: orphans };
}

export function auditDigestSelfConsistency(digest: {
  sites: Array<{ studies: StudyLike[] }>;
}): UntraceableHeadline[] {
  return digest.sites.flatMap((site) =>
    site.studies.map(findUntraceableHeadline).filter((x): x is UntraceableHeadline => x !== null),
  );
}

export function formatUntraceableHeadlines(items: UntraceableHeadline[]): string {
  if (items.length === 0) return "self-consistency: every card's headline number is traceable";
  return [
    `self-consistency: ${items.length} card(s) whose TL;DR states a number the card body never repeats`,
    ...items.map((c) => `    ${c.slug}: ${c.values.join(', ')} — check against the card's own table`),
  ].join('\n');
}
