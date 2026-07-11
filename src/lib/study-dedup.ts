// Cross-day duplicate detection (v0.26).
//
// The problem: the same trial can get TWO study cards on TWO different dates —
// a conference-tweet preview (often with NO NCT), then weeks later a full-paper
// card of the same trial. The cross-day NCT nudge (nct-coverage.ts) can't link
// them because the preview has no NCT to match on, so nothing reconciles the
// pair and the digest carries a duplicate. (Cleaned by hand 2026-07-11 for
// HYDRA / ENZARAD / RAPCHEM.)
//
// This module derives a DISCRIMINATING acronym key from a curated study name
// and uses it (plus shared NCT) to surface candidate cross-date duplicates for
// human review. It is a DETECTOR, never an auto-merger: trial acronyms are
// ambiguous (EORTC ran 22033 AND 22922; PEACE-2 ≠ PEACE-V; NRG is a group, not
// a trial), so an automatic suppress would collapse distinct science. The whole
// codebase already treats acronyms as soft signals for exactly this reason
// (source-association.ts: "over-merge destroys trust"). Output is candidates +
// suggested override commands; the curator decides.

import {
  ACRONYM_BLACKLIST,
  ACRONYM_RE,
  ACRONYM_PATTERN_BLACKLIST,
} from './source-association.ts';

// Cooperative trial groups: a BARE group name can't identify one trial (EORTC
// ran many), but group + a study number IS a canonical trial id (EORTC 22922,
// NRG-GU005, RTOG 0539). So for these: bare → no key; group+suffix → key.
// Extend as new groups appear in real study names.
export const COOPERATIVE_GROUPS = new Set([
  'EORTC', 'NRG', 'RTOG', 'DBCG', 'ANZUP', 'SWOG', 'GETUG', 'NSABP', 'GOG',
  'CALGB', 'ALLIANCE', 'NCIC', 'CCTG', 'TROG', 'MRC', 'BOOG', 'IBCSG', 'BIG',
  'SAKK', 'JCOG', 'KROG', 'RADCOMP', 'NCCTG', 'SWENOTECA', 'CTG',
]);

// Societies / conferences / guideline bodies: the leading token names WHO said
// it (a guideline or a conference-year tag), never a trial. Any name that leads
// with one of these yields no dedup key — so "ARS Appropriate Use Criteria: …"
// and "ASTRO 2024: SBRT for …" never form a spurious cross-date match.
export const SOCIETY_PREFIXES = new Set([
  'ARS', 'ASTRO', 'ASCO', 'ESMO', 'AACR', 'ASH', 'SABCS', 'NCCN', 'EAU',
  'ESTRO', 'GUCS', 'GICS', 'ESGO', 'SGO', 'AUA', 'RSNA',
]);

// Derive a DISCRIMINATING dedup key from a curated study name, or null when the
// name has no trial-specific leading identifier. The key normalizes separators
// so "EORTC 22922", "EORTC-22922", "EORTC22922" collapse to one — while keeping
// distinct suffixes distinct ("PEACE-2" → PEACE2 ≠ "PEACE-V" → PEACEV).
export function studyDedupKey(name: string): string | null {
  if (!name) return null;
  // Leading trial identifier: a run of ALL-CAPS/digit tokens joined by spaces or
  // hyphens, anchored at the start. Stops at the first lowercase word, paren,
  // colon, etc. "ENZARAD (ANZUP 1303)" → "ENZARAD"; "EORTC 22922 (…)" →
  // "EORTC 22922"; "10-yr SBRT …" → no match (leads with a digit).
  //
  // The `(?![a-z])` after each caps run rejects the stray capital of a
  // Titlecase word — without it, "NRG Oncology RTOG 0539" grabbed the "O" of
  // "Oncology" into "NRG O" → key "NRGO", colliding with the unrelated
  // "NRG Oncology RTOG 0848", and "EXTEND Trial" became "EXTENDT". A
  // continuation token must be a genuine all-caps word/number.
  const m = name.trim().match(/^[A-Z][A-Z0-9]*(?![a-z])(?:[-\s][A-Z0-9]+(?![a-z]))*/);
  if (!m) return null;
  const lid = m[0];
  const firstToken = lid.split(/[-\s]/)[0]!.toUpperCase();
  const key = lid.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.length < 3) return null;
  if (ACRONYM_BLACKLIST.has(firstToken)) return null; // endpoint / gene / stat
  if (ACRONYM_PATTERN_BLACKLIST.test(firstToken)) return null; // PHASE3 / COVID19
  if (SOCIETY_PREFIXES.has(firstToken)) return null; // guideline / conference tag
  // Bare cooperative-group name with no discriminating suffix (key === group).
  if (COOPERATIVE_GROUPS.has(firstToken) && key === firstToken) return null;
  return key;
}

// Extract candidate dedup keys from FREE TEXT (a tweet, an abstract) — used by
// the enrich-time acronym nudge (acronym-coverage.ts). Conservative by design:
// it only pulls single contiguous all-caps tokens that survive studyDedupKey,
// so a bare cooperative-group mention or an endpoint token never produces a
// key. Missing "EORTC 22922" (two space-separated tokens) is acceptable — a
// missed nudge is cheaper than a spurious one.
export function extractTextAcronymKeys(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(ACRONYM_RE)) {
    const key = studyDedupKey(m[0]);
    if (key) out.add(key);
  }
  return out;
}

// ---- cross-date duplicate detector (Tier 1) ----

export type DedupStudyInput = {
  slug?: string;
  name: string;
  nct?: string | null;
  content_type?: string;
};

export type DedupArtifact = {
  date: string; // YYYY-MM-DD
  digest: { sites: Array<{ studies: DedupStudyInput[] }> };
};

export type DedupOccurrence = {
  date: string;
  slug: string;
  name: string;
  nct: string | null;
  isReview: boolean; // content_type === 'review' → likely intentional re-coverage
};

export type DuplicateCandidate = {
  matchKey: string; // the NCT id or the acronym key that grouped these
  reason: 'shared-nct' | 'shared-acronym';
  occurrences: DedupOccurrence[]; // ≥2, spanning ≥2 dates, oldest first
};

function toOccurrence(date: string, s: DedupStudyInput): DedupOccurrence {
  return {
    date,
    slug: s.slug ?? '',
    name: s.name,
    nct: s.nct ?? null,
    isReview: s.content_type === 'review',
  };
}

const occId = (o: DedupOccurrence): string => `${o.date}/${o.slug}`;
const byDateAsc = (a: DedupOccurrence, b: DedupOccurrence): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;

// Find same-trial study cards that appear on MORE THAN ONE date. Groups by
// shared NCT (strong) and by discriminating acronym key (medium); an acronym
// group whose every occurrence is already covered by an NCT group is dropped as
// redundant. Same-day repeats are ignored (that's Phase 1 clustering's job, not
// a cross-day duplicate). Newest digests should be passed first or last — order
// doesn't matter; occurrences are sorted oldest-first per candidate.
export function findCrossDateDuplicates(artifacts: DedupArtifact[]): DuplicateCandidate[] {
  const byNct = new Map<string, DedupOccurrence[]>();
  const byKey = new Map<string, DedupOccurrence[]>();

  for (const a of artifacts) {
    for (const site of a.digest.sites) {
      for (const study of site.studies) {
        const occ = toOccurrence(a.date, study);
        if (occ.nct) {
          const k = occ.nct.toUpperCase();
          const list = byNct.get(k);
          if (list) list.push(occ);
          else byNct.set(k, [occ]);
        }
        const key = studyDedupKey(study.name);
        if (key) {
          const list = byKey.get(key);
          if (list) list.push(occ);
          else byKey.set(key, [occ]);
        }
      }
    }
  }

  const spansMultipleDates = (list: DedupOccurrence[]): boolean =>
    new Set(list.map((o) => o.date)).size >= 2;

  const out: DuplicateCandidate[] = [];
  const emitted = new Set<string>(); // occId's already surfaced by an NCT candidate

  for (const [nct, list] of byNct) {
    if (!spansMultipleDates(list)) continue;
    const occurrences = [...list].sort(byDateAsc);
    out.push({ matchKey: nct, reason: 'shared-nct', occurrences });
    for (const o of occurrences) emitted.add(occId(o));
  }

  for (const [key, list] of byKey) {
    if (!spansMultipleDates(list)) continue;
    const occurrences = [...list].sort(byDateAsc);
    // Skip if the NCT pass already surfaced this exact set of cards.
    if (occurrences.every((o) => emitted.has(occId(o)))) continue;
    out.push({ matchKey: key, reason: 'shared-acronym', occurrences });
  }

  // Most-recent activity first, so the freshest likely-duplicate is at the top.
  return out.sort((a, b) => {
    const la = a.occurrences[a.occurrences.length - 1]!.date;
    const lb = b.occurrences[b.occurrences.length - 1]!.date;
    return la < lb ? 1 : la > lb ? -1 : a.matchKey < b.matchKey ? -1 : 1;
  });
}
