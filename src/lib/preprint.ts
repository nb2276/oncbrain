// v0.14.5 (E5): preprint detection + verdict cap.
//
// v0.8 ingestion made preprints first-class (paper-url.ts allowlists medRxiv /
// bioRxiv / Research Square; the DOI path resolves their registrant prefixes),
// but nothing flagged them — so a not-yet-peer-reviewed preprint could earn a
// confident standard-of-care verdict. This module is the clinical-safety guard:
// a pure detector + a deterministic verdict clamp (NOT prompt-dependent), used
// at build time to flag the study and cap an over-confident verdict.
import type { SocImplication } from './digest-data.ts';

// Crossref/DataCite registrant prefixes for the major preprint servers:
//   10.1101  — Cold Spring Harbor (bioRxiv + medRxiv)
//   10.21203 — Research Square
const PREPRINT_DOI_PREFIXES = ['10.1101', '10.21203'];

// Canonical preprint-server hosts. Matched by exact host or a dot-suffix
// (so www.medrxiv.org counts), NOT a substring — a naive regex let
// medrxiv.org.evil.com and the wrong-TLD medrxiv.com through (both reviewers).
const PREPRINT_HOSTS = ['medrxiv.org', 'biorxiv.org', 'researchsquare.com'];

// Journal/source name match (the enrichment sometimes records the server name
// as the "journal" with no DOI/URL).
const PREPRINT_NAME_RE = /\b(?:medrxiv|biorxiv|research\s*square)\b/i;

function urlIsPreprintHost(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // not a parseable absolute URL
  }
  return PREPRINT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// True if a paper source is a preprint, by DOI registrant prefix, host, or name.
export function isPreprintSource(src: {
  doi?: string | null;
  journal?: string | null;
  url?: string | null;
}): boolean {
  const doi = (src.doi ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, ''); // tolerate a URL-form DOI
  const registrant = doi.split('/')[0];
  if (PREPRINT_DOI_PREFIXES.includes(registrant)) return true;
  if (urlIsPreprintHost(src.url)) return true;
  if (PREPRINT_NAME_RE.test(src.journal ?? '')) return true;
  return false;
}

// Verdicts that assert a peer-reviewed-strength conclusion. A preprint cannot
// support these, so they cap at `early-signal`. The cautionary verdicts
// (methodologically-limited, unclear) and early-signal itself are left alone —
// they already convey appropriate restraint.
const CAPPED: ReadonlySet<SocImplication> = new Set<SocImplication>([
  'practice-changing',
  'challenges-soc',
  'confirmatory',
]);
export const PREPRINT_VERDICT_CAP: SocImplication = 'early-signal';
// Replaces the LLM rationale when a clamp fires, so the rationale can't argue a
// stronger conclusion than the (capped) verdict. <= 30 words, no em-dash (VOICE).
export const PREPRINT_CAP_RATIONALE =
  'Preprint, not yet peer-reviewed; verdict capped at early-signal pending peer review.';

// Clamp an over-confident verdict on a preprint study. Returns the verdict
// unchanged when there is nothing to cap (or no verdict). Generic over the
// verdict shape so it needn't import StudyVerdict (avoids a type cycle).
export function clampPreprintVerdict<
  V extends { soc_implication: SocImplication; rationale: string },
>(verdict: V | undefined | null): V | undefined | null {
  if (!verdict || !CAPPED.has(verdict.soc_implication)) return verdict;
  return { ...verdict, soc_implication: PREPRINT_VERDICT_CAP, rationale: PREPRINT_CAP_RATIONALE };
}
