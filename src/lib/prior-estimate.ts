// v0.37 (E5): longitudinal magnitude — when a trial the digest already covered
// comes back reporting a DIFFERENT effect size, say so instead of losing it.
//
// WHY THIS IS A BUILD-TIME PASS, NOT AN ENRICH-TIME ONE. The enrich-time nudge
// (notifyPriorCoverage) fires when a SOURCE matches earlier coverage, but at
// that moment the new study has no magnitude yet: `primary_endpoint` is produced
// by the Phase 2 agent at build time. Both numbers only exist together here, so
// one detection pass feeds both the curator notification and the card.
//
// WHY IT EXISTS AT ALL. The v0.26 dedup workflow treats a re-covered trial as a
// duplicate to SUPPRESS. That is right when the second card says the same thing,
// and wrong when the estimate moved: an interim HR that matures, or a CI that
// tightens across the significance line, is exactly what a subspecialist wants
// flagged. This pass separates those two cases.
//
// MATCHING IS DELIBERATELY STRICT. Attributing "updated from HR 0.71" to the
// wrong trial is a clinical error, not a cosmetic one, so every ambiguity
// resolves to "no prior" rather than a guess. See the conflict guards below.

import {
  parseEffectSize,
  type RatioDatum,
  type PrimaryEndpointLike,
} from './effect-size.ts';
import { studyDedupKey } from './study-dedup.ts';

/** What the card and the curator DM show: the earlier reading, verbatim. */
export type PriorEstimate = {
  /** The earlier digest date (YYYY-MM-DD). */
  date: string;
  /** The earlier study's slug, so the card can link back to it. */
  slug: string;
  /** The earlier estimate exactly as it was published ("HR 0.71"). */
  stat_value: string;
  stat_detail: string | null;
  /** Parsed point estimate, so a renderer can place it on the same axis. */
  point: number;
  lo: number | null;
  hi: number | null;
};

export type PriorIndexStudy = {
  date: string;
  slug: string;
  name: string;
  nct: string | null;
  /** Disease site the study was filed under. Guards acronym-only matches. */
  disease_site?: string | null;
  primary_endpoint: PrimaryEndpointLike;
};

type Indexed = {
  date: string;
  slug: string;
  nct: string | null;
  key: string | null;
  site: string | null;
  /** Normalized endpoint name. Family is too coarse to call an update. */
  endpoint: string;
  datum: RatioDatum;
  stat_value: string;
  stat_detail: string | null;
};

// "Overall survival" / "overall-survival" collapse; "investigator-assessed PFS"
// and "CNS PFS by BICR" stay distinct, which is the point.
function normalizeEndpoint(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Index every published study that carries a parseable RATIO. Paired values are
 * out of scope: "1.5% vs 9.8%" against a later "2.1% vs 9.4%" is a comparison of
 * four numbers with no single magnitude to call updated.
 */
export function buildPriorIndex(studies: PriorIndexStudy[]): Indexed[] {
  const out: Indexed[] = [];
  for (const s of studies) {
    const datum = parseEffectSize(s.primary_endpoint);
    if (!datum) continue;
    const pe = s.primary_endpoint;
    if (!pe || !pe.stat_value) continue;
    out.push({
      date: s.date,
      slug: s.slug,
      nct: s.nct ?? null,
      key: studyDedupKey(s.name),
      site: s.disease_site ?? null,
      endpoint: normalizeEndpoint(pe.name),
      datum,
      stat_value: pe.stat_value,
      stat_detail: pe.stat_detail ?? null,
    });
  }
  return out;
}

/** Flatten published artifacts into the shape the index wants. Studies without
 *  a slug are skipped: the card links back by slug, and a prior we cannot link
 *  to is a claim the reader has no way to check. */
export function studiesFromArtifacts(
  artifacts: {
    date: string;
    digest: { sites: { disease_site?: string | null; studies: { name: string; slug?: string; nct?: string | null; primary_endpoint?: PrimaryEndpointLike }[] }[] };
  }[],
): PriorIndexStudy[] {
  const out: PriorIndexStudy[] = [];
  for (const a of artifacts) {
    // Shape-guard every level: these are artifacts off disk, and a hand-edited
    // or older-schema file must degrade to "no prior" rather than throw inside
    // build:day, which would fail the nightly digest for the whole day.
    if (!a || typeof a.date !== 'string' || !Array.isArray(a.digest?.sites)) continue;
    for (const site of a.digest.sites) {
      if (!Array.isArray(site?.studies)) continue;
      for (const st of site.studies) {
        if (!st || typeof st.name !== 'string' || !st.slug) continue;
        out.push({
          date: a.date,
          slug: st.slug,
          name: st.name,
          nct: st.nct ?? null,
          disease_site: site.disease_site ?? null,
          primary_endpoint: st.primary_endpoint,
        });
      }
    }
  }
  return out;
}

/**
 * Same trial? NCT equality or dedup-key equality, with BOTH conflict guards.
 *
 * The guards matter more than the matches. A trial can misprint its own
 * registration: RADIOSA publishes ORIOLE's NCT02680587, so an NCT-only rule
 * would confidently attribute one trial's estimate to the other. Equally, two
 * arms of one program can share an acronym while registering separately. So a
 * DISAGREEMENT on either identifier vetoes the match even when the other agrees.
 */
function sameTrial(a: Indexed, b: Indexed): boolean {
  const nctConflict = a.nct !== null && b.nct !== null && a.nct !== b.nct;
  const keyConflict = a.key !== null && b.key !== null && a.key !== b.key;
  if (nctConflict || keyConflict) return false;
  const nctMatch = a.nct !== null && b.nct !== null && a.nct === b.nct;
  if (nctMatch) return true; // a registration number is definitive, even across
  // disease sites (the site is an LLM classification; the NCT is not)
  const keyMatch = a.key !== null && b.key !== null && a.key === b.key;
  // An acronym ALONE is not an identifier. Trial acronyms are reused freely
  // across tumour types, so a bare "PRIME" in breast and a bare "PRIME" in
  // prostate are two trials. Require the same disease site to accept one.
  if (!keyMatch) return false;
  return a.site !== null && b.site !== null && a.site === b.site;
}

/** Did the reported magnitude actually move? A tightened interval counts: a CI
 *  crossing back over 1.0 changes the conclusion even at an identical point. */
function differs(a: RatioDatum, b: RatioDatum): boolean {
  return a.point !== b.point || a.lo !== b.lo || a.hi !== b.hi;
}

/**
 * The most recent EARLIER reading of the same trial's same endpoint, when it
 * differs from the current one. Null when there is no prior, when the estimate
 * is unchanged (nothing longitudinal to report), or when anything is ambiguous.
 *
 * The endpoint bucket must match: an OS hazard ratio is not an update of a PFS
 * hazard ratio, and presenting one as the other would invent a result.
 */
export function findPriorEstimate(
  current: PriorIndexStudy,
  index: Indexed[],
): PriorEstimate | null {
  const [self] = buildPriorIndex([current]);
  if (!self) return null;

  const matches: Indexed[] = [];
  for (const cand of index) {
    if (cand.date >= current.date) continue; // strictly earlier; a rebuild of an
    // old date must never adopt a later date's number as its "prior"
    // Same ratio KIND and the same NAMED endpoint. Deliberately not the
    // axisBucket family used for sharing an axis: that collapses every PFS
    // variant into one bucket, which is the right grain for a shared ruler and
    // the wrong grain for claiming an update, where "investigator-assessed PFS"
    // and "CNS PFS by BICR" are different results. An unnamed endpoint abstains
    // rather than assume two blank names describe the same measurement.
    if (cand.datum.kind !== self.datum.kind) continue;
    if (cand.endpoint === '' || cand.endpoint !== self.endpoint) continue;
    if (!sameTrial(self, cand)) continue;
    matches.push(cand);
  }
  if (matches.length === 0) return null;

  // Every match must be the same trial as every OTHER match. Two earlier cards
  // sharing an acronym but registered differently both "match" the current
  // study while contradicting each other, and picking the more recent one would
  // silently choose a trial. Ambiguity resolves to no prior.
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      if (!sameTrial(matches[i]!, matches[j]!)) return null;
    }
  }

  let best: Indexed | null = null;
  for (const cand of matches) {
    if (!differs(self.datum, cand.datum)) continue;
    if (!best || cand.date > best.date) best = cand;
  }
  if (!best) return null;
  return {
    date: best.date,
    slug: best.slug,
    stat_value: best.stat_value,
    stat_detail: best.stat_detail,
    point: best.datum.point,
    lo: best.datum.lo,
    hi: best.datum.hi,
  };
}
