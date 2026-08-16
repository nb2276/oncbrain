// Trial lineage: what to DO when a trial the digest already covered comes back.
//
// Before this module the pipeline had exactly one response to a same-trial
// resubmission — a "previously covered" DM offering to drop one card — which
// collapses three genuinely different situations into one:
//
//   1. The trial reports a DIFFERENT objective. NRG-GU005 published its
//      quality-of-life results and its co-primary efficacy results as separate
//      papers. Those are two findings a subspecialist reads differently; folding
//      them into one card splices two headline numbers together and loses both.
//      → new-card.
//   2. The trial reports the SAME objective, MATURED. An ASTRO abstract becomes
//      a JAMA paper; an interim HR matures; follow-up doubles. The reader wants
//      the newest reading at the top of the feed, not two cards to reconcile.
//      → update.
//   3. The trial reports the same objective and nothing new. A tweet preview of
//      an abstract already covered. → duplicate.
//
// LLM PROPOSES, DETERMINISTIC CODE DECIDES. The facet/maturity fields come from
// an LLM read of the source (source-facet.ts); every branch below is plain code
// over those fields, so the verdict is testable and a model that returns
// nonsense abstains rather than suppressing a published card. This is the same
// split as the figure grounding gate in figure-extract.ts.
//
// ABSTENTION IS THE DEFAULT. A missing facet on either side yields `unrelated`,
// which degrades to the pre-existing nudge. Suppressing a real card because a
// classifier guessed is worse than leaving a duplicate for the curator.

import { studyDedupKey } from './study-dedup.ts';

/** What a source REPORTS about its trial. Two sources with different facets are
 *  different findings even when they are the same trial. */
export const REPORT_FACETS = [
  'primary-efficacy',
  'quality-of-life',
  'long-term-followup',
  'safety-toxicity',
  'subgroup-secondary',
  'translational',
  'health-economic',
] as const;
export type ReportFacet = (typeof REPORT_FACETS)[number];

/** How settled the reading is. A conference abstract superseded by the full
 *  peer-reviewed publication is the canonical `update`. */
export const MATURITIES = ['conference-abstract', 'full-publication'] as const;
export type Maturity = (typeof MATURITIES)[number];

export function isReportFacet(v: unknown): v is ReportFacet {
  return typeof v === 'string' && (REPORT_FACETS as readonly string[]).includes(v);
}
export function isMaturity(v: unknown): v is Maturity {
  return typeof v === 'string' && (MATURITIES as readonly string[]).includes(v);
}

/** Coerce an untrusted value to the enum or to null — never to a near match.
 *  Everything crossing the LLM/DB boundary goes through here, so an off-enum
 *  value abstains instead of being snapped to whichever member it resembles. */
export const parseGuard = {
  facet: (v: unknown): ReportFacet | null => (isReportFacet(v) ? v : null),
  maturity: (v: unknown): Maturity | null => (isMaturity(v) ? v : null),
};

/** One reading of one trial — either a published card or the study being built. */
export type TrialReport = {
  date: string; // YYYY-MM-DD
  slug: string;
  name: string;
  /** Every NCT this reading carries. A set, because a card's identity accretes
   *  from all of its sources, not just whichever one reached the card JSON. */
  ncts: string[];
  /** Trial acronyms the sources declared for the trial THEY report (never a
   *  comparator named in a discussion — see source-facet.ts). Supplements the
   *  key derived from `name`, for a paper that does not name itself in its
   *  title. */
  acronyms?: string[];
  /** Disease site, required to accept an acronym-only match. */
  disease_site: string | null;
  facet: ReportFacet | null;
  maturity: Maturity | null;
  followup_months: number | null;
  /** Primary endpoint name, normalized. */
  endpoint: string | null;
  stat_value: string | null;
  stat_detail: string | null;
};

export type LineageVerdict =
  /** `corroborated` — the two readings share a REGISTERED identity (an NCT), not
   *  just an acronym. Only a corroborated update may unpublish its predecessor;
   *  an uncorroborated one still stamps the supersedes link and asks the curator.
   *  Same bar as `certain` on a duplicate: every destructive action in this
   *  module requires registered identity. */
  /** `blocker` — the specific precondition that refused, when one did. Carried
   *  so the curator DM can state the real reason and decide whether a human
   *  `drop` reply is even a valid resolution for it. */
  | { kind: 'update'; prior: TrialReport; reason: string; corroborated: boolean; blocker?: string | null; identityOnly?: boolean }
  | { kind: 'new-card'; prior: TrialReport; reason: string }
  | { kind: 'duplicate'; prior: TrialReport; reason: string; certain: boolean; blocker?: string | null; identityOnly?: boolean }
  | { kind: 'unrelated' };

/** "Overall survival" / "overall-survival" collapse; "investigator-assessed PFS"
 *  and "CNS PFS by BICR" stay distinct, which is the point. */
export function normalizeEndpoint(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nctSet(r: TrialReport): Set<string> {
  return new Set(r.ncts.map((n) => n.toUpperCase()).filter(Boolean));
}

/** The identity of one reading, reduced to what the guard actually compares.
 *  Both identifiers are SETS: see sameTrialIdentity for why. */
export type TrialIdentity = {
  ncts: Set<string>;
  /** Discriminating acronym keys (studyDedupKey output). */
  keys: Set<string>;
  site: string | null;
};

/**
 * Same trial? NCT overlap or dedup-key equality, with BOTH conflict guards.
 *
 * THE GUARDS MATTER MORE THAN THE MATCHES. A trial can misprint its own
 * registration: RADIOSA publishes ORIOLE's NCT02680587, so an NCT-only rule
 * would confidently attribute one trial's result to the other. Equally, two arms
 * of one program can share an acronym while registering separately. So a
 * DISAGREEMENT on either identifier vetoes the match even when the other agrees.
 *
 * This is the ONE definition of trial identity in the codebase — prior-estimate.ts
 * calls it too, so the "updated from" line on a card and the lineage verdict that
 * suppresses its predecessor can never disagree about which trials are the same.
 *
 * BOTH IDENTIFIERS ARE SETS, because a card's identity accretes across its
 * sources rather than living on the card. The 2026-07-08 NRG-GU005 card carries
 * no NCT in its JSON at all, while the trial's own later publication registers
 * NCT03367702; conversely that publication is TITLED "Stereotactic Body
 * Radiotherapy vs Moderately Hypofractionated IMRT ..." and names its acronym
 * only in the abstract. Neither reading is identifiable from its card alone, and
 * they are the same trial. A single value is the singleton set, so set semantics
 * — overlap is a match, conflict is two NON-EMPTY sets sharing nothing — is a
 * strict generalization that leaves single-value behaviour byte-identical.
 */
export function sameTrialIdentity(a: TrialIdentity, b: TrialIdentity): boolean {
  const nctOverlap = [...a.ncts].some((n) => b.ncts.has(n));
  const nctConflict = a.ncts.size > 0 && b.ncts.size > 0 && !nctOverlap;

  const keyOverlap = [...a.keys].some((k) => b.keys.has(k));
  const keyConflict = a.keys.size > 0 && b.keys.size > 0 && !keyOverlap;

  if (nctConflict || keyConflict) return false;

  // A registration number is definitive, even across disease sites (the site is
  // an LLM classification; the NCT is not).
  if (nctOverlap) return true;

  // An acronym ALONE is not an identifier. Trial acronyms are reused freely
  // across tumour types, so a bare "PRIME" in breast and a bare "PRIME" in
  // prostate are two trials. Require the same disease site to accept one.
  if (!keyOverlap) return false;
  return a.site !== null && b.site !== null && a.site === b.site;
}

/**
 * Acronym keys for a reading.
 *
 * The card's own NAME wins outright when it yields a key. Source-declared
 * acronyms are a FALLBACK for a card that cannot identify itself, never an
 * ADDITION to one that can.
 *
 * That asymmetry is a safety property, not a style choice. `trial_acronyms`
 * comes from an LLM, and keys are compared as SETS where overlap is a match —
 * so unioning model output into a card that already has a name key can only
 * ever WIDEN identity: one hallucinated or misattributed acronym naming some
 * other trial the digest covered would create an overlap the two names would
 * have refused, and on the update path that ends in an already-published card
 * being unpublished. As a fallback it cannot widen anything, because the only
 * cards it applies to had NO key at all — which is exactly the case it exists
 * for (the full NRG-GU005 report, titled "Stereotactic Body Radiotherapy vs
 * Moderately Hypofractionated IMRT ...", names its trial only in the abstract).
 */
export function identityOf(r: TrialReport): TrialIdentity {
  const keys = new Set<string>();
  const fromName = studyDedupKey(r.name);
  if (fromName) {
    keys.add(fromName);
  } else {
    for (const a of r.acronyms ?? []) {
      const k = studyDedupKey(a);
      if (k) keys.add(k);
    }
  }
  return { ncts: nctSet(r), keys, site: r.disease_site };
}

export function sameTrial(a: TrialReport, b: TrialReport): boolean {
  return sameTrialIdentity(identityOf(a), identityOf(b));
}

/** Did the reported magnitude change at all? Compared as the curator's own
 *  strings: any edit to the headline number or its CI is a moved estimate. A
 *  tightened interval counts — a CI crossing back over 1.0 changes the
 *  conclusion even at an identical point estimate.
 *
 *  MISSING IS NOT MOVED. A field present on one side and absent on the other
 *  says the two cards recorded different AMOUNTS of detail, not that the trial
 *  reported a different result — and the empty-string coercion used to call
 *  that a move, so a new card carrying "HR 0.62" with no CI would supersede a
 *  richer prior reading "HR 0.62, 95% CI 0.48-0.92". Only compare fields both
 *  sides actually carry. */
function estimateMoved(a: TrialReport, b: TrialReport): boolean {
  const norm = (s: string | null): string | null => {
    const t = (s ?? '').trim().replace(/\s+/g, ' ');
    return t === '' ? null : t;
  };
  const bothHave = (x: string | null, y: string | null): boolean => x !== null && y !== null;
  const av = norm(a.stat_value);
  const bv = norm(b.stat_value);
  const ad = norm(a.stat_detail);
  const bd = norm(b.stat_detail);
  if (bothHave(av, bv) && av !== bv) return true;
  if (bothHave(ad, bd) && ad !== bd) return true;
  return false;
}

const MATURITY_RANK: Record<Maturity, number> = {
  'conference-abstract': 0,
  'full-publication': 1,
};

/**
 * THE complete precondition list for unpublishing a card. Returns the first
 * unmet condition, or null when every one holds.
 *
 * Everything destructive routes through here — `corroborated` on an update and
 * `certain` on a duplicate are both just "this returned null". Adding a
 * condition here protects every path at once, which is the property the previous
 * per-branch shape did not have.
 *
 * Each entry is a way the two cards can fail to be the same result told twice:
 *   · not the same registered trial;
 *   · a measurement one of them never named;
 *   · the newer reading covering LESS time or being LESS settled than the older
 *     one, in which case "newer" is not better and a human should look.
 */
/** A precondition that refused, with a machine-readable code. The code matters
 *  as much as the message: "is this only an identity gap" is the question that
 *  decides whether the curator DM may offer a one-reply drop, and deciding it by
 *  regex over prose was how a maturity regression got labelled an identity gap. */
export type SuppressionBlocker = {
  code: 'identity' | 'endpoint' | 'followup' | 'maturity' | 'symmetry';
  message: string;
};

/**
 * EVERY precondition for unpublishing a card, evaluated in full.
 *
 * Returns ALL of them, not the first. Short-circuiting on the identity check
 * meant a pair that ALSO failed on endpoint or maturity reported only "no shared
 * registration" — and that is exactly the label the curator DM treats as "a
 * human can resolve this, offer them the drop reply". The drop handler re-runs
 * nothing, so mislabelling one blocker as another is a hole straight through the
 * gate. Collecting them all is what makes `identityOnly` mean what it says.
 */
export function suppressionBlockers(
  current: TrialReport,
  prior: TrialReport,
  bothEndpointsNamed: boolean,
): SuppressionBlocker[] {
  const out: SuppressionBlocker[] = [];
  if (!shareNct(current, prior)) {
    out.push({ code: 'identity', message: 'no shared registration (acronym-only identity)' });
  }
  if (!bothEndpointsNamed) {
    out.push({ code: 'endpoint', message: 'endpoint not named on both readings' });
  }
  // Chronology must not run backwards, and unknown is not equal. A 24-month
  // report does not replace a published 60-month one; a conference abstract does
  // not replace a journal paper; and a reading that never recorded either cannot
  // be shown to be the more settled one.
  if (current.followup_months === null || prior.followup_months === null) {
    out.push({ code: 'followup', message: 'follow-up unknown on one reading' });
  } else if (current.followup_months < prior.followup_months) {
    out.push({
      code: 'followup',
      message: `follow-up regressed (${prior.followup_months}mo → ${current.followup_months}mo)`,
    });
  }
  if (current.maturity === null || prior.maturity === null) {
    out.push({ code: 'maturity', message: 'maturity unknown on one reading' });
  } else if (MATURITY_RANK[current.maturity] < MATURITY_RANK[prior.maturity]) {
    out.push({
      code: 'maturity',
      message: `maturity regressed (${prior.maturity} → ${current.maturity})`,
    });
  }
  return out;
}

/** The single most substantive blocker, for display. Identity is reported LAST
 *  precisely because it is the only one a human can resolve — if anything else
 *  also failed, that is the honest reason to show. */
export function primaryBlocker(bs: SuppressionBlocker[]): SuppressionBlocker | null {
  if (bs.length === 0) return null;
  return bs.find((b) => b.code !== 'identity') ?? bs[0]!;
}

/** Is an identity gap the ONLY thing standing in the way? The one case where a
 *  curator reading both cards can legitimately authorize the drop. */
export function isIdentityOnly(bs: SuppressionBlocker[]): boolean {
  return bs.length > 0 && bs.every((b) => b.code === 'identity');
}

/**
 * Do the two readings share a REGISTERED identity?
 *
 * This is the bar for every destructive action. An acronym match rests on a
 * disease-site classification an LLM made and on trial names that are reused
 * freely across tumour types — two unrelated same-site "PRIME" reports, one an
 * abstract and one a paper, satisfy every other update condition. A registration
 * number does not have that failure mode.
 */
function shareNct(a: TrialReport, b: TrialReport): boolean {
  const bn = nctSet(b);
  return [...nctSet(a)].some((n) => bn.has(n));
}

/**
 * Classify a study being built against every already-published reading.
 *
 * Returns the verdict against the most recent same-trial prior. Ambiguity — no
 * facet on either side, contradictory priors — resolves to `unrelated`, which
 * leaves the pre-existing curator nudge as the only behaviour.
 */
export function classifyAgainstPrior(
  current: TrialReport,
  priors: TrialReport[],
): LineageVerdict {
  const matches = priors.filter((p) => p.date < current.date && sameTrial(current, p));
  if (matches.length === 0) return { kind: 'unrelated' };

  // Every match must be the same trial as every OTHER match. Two earlier cards
  // sharing an acronym but registered differently both "match" the current study
  // while contradicting each other, and picking the more recent one would
  // silently choose a trial. Ambiguity resolves to no lineage.
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      if (!sameTrial(matches[i]!, matches[j]!)) return { kind: 'unrelated' };
    }
  }

  // Pick the newest prior this study could actually supersede, not merely the
  // newest one. With an older efficacy card and a newer quality-of-life card of
  // the same trial, taking the newest meant a later efficacy update compared
  // itself against QoL, returned `new-card`, and never reached its real
  // predecessor. Facet compatibility first, recency second; the ambiguity checks
  // above already ran over ALL matches, so narrowing here cannot smuggle in a
  // contradictory pair.
  const compatible = matches.filter(
    (p) =>
      p.facet === current.facet ||
      (current.facet === 'long-term-followup' && p.facet === 'primary-efficacy'),
  );
  const prior = (compatible.length > 0 ? compatible : matches).reduce((best, p) =>
    p.date > best.date ? p : best,
  );

  // Abstain unless BOTH readings were classified. Without a facet we cannot tell
  // a different objective from a matured one, and the two call for opposite
  // actions (publish alongside vs suppress the earlier card).
  if (current.facet === null || prior.facet === null) return { kind: 'unrelated' };

  // `long-term-followup` IS the matured form of the objective it extends, not a
  // different objective. The prompt classifies "10-year update of X" that way,
  // and treating the facet change as a new card made the canonical
  // longer-follow-up update unreachable for correctly classified sources — the
  // one transition the whole facet vocabulary exists to describe.
  //
  // It matures EXACTLY ONE parent. Written as `prior.facet !== 'long-term-followup'`
  // it matured all six others, so a long-term overall-survival report could
  // supersede a quality-of-life, safety or subgroup card — reproduced against a
  // QoL prior. "10-year update" extends the primary efficacy reading and nothing
  // else; a trial's long-term OS says nothing about its patient-reported outcomes.
  const maturingFollowup =
    current.facet === 'long-term-followup' && prior.facet === 'primary-efficacy';

  if (current.facet !== prior.facet && !maturingFollowup) {
    return {
      kind: 'new-card',
      prior,
      reason: `different objective (${prior.facet} → ${current.facet})`,
    };
  }

  // THE ENDPOINT GUARD RUNS FIRST, BEFORE EVERY BRANCH THAT CAN RETURN `update`.
  //
  // It used to sit below the maturity and follow-up checks, and that ordering was
  // a live defect: a prior conference card reporting OVERALL SURVIVAL and a new
  // full publication reporting PROGRESSION-FREE SURVIVAL share a facet, so the
  // maturity branch returned `update` and the OS card was suppressed by a paper
  // that never reported OS. An OS hazard ratio is not an update of a PFS hazard
  // ratio, and no amount of added maturity or follow-up makes it one — so the
  // measurement has to match before "newer" means anything at all.
  const curEp = normalizeEndpoint(current.endpoint);
  const priEp = normalizeEndpoint(prior.endpoint);
  const bothNamed = curEp !== '' && priEp !== '';

  if (bothNamed && curEp !== priEp) {
    // Same objective measured differently — two readings, not a supersession.
    return {
      kind: 'new-card',
      prior,
      reason: `same objective, different endpoint (${prior.endpoint} → ${current.endpoint})`,
    };
  }

  // ONE gate, evaluated once, for every branch that can unpublish.
  //
  // This used to be a per-branch flag, and that shape is why three review rounds
  // each found a new way through: every branch computed its own subset of the
  // preconditions, so a guard added for the maturity path left the
  // estimate-moved path open, and a guard added there left the duplicate path
  // open. The conditions below are the COMPLETE list, they are checked together,
  // and the first failure is reported so the curator DM can say which one.
  const blockers = suppressionBlockers(current, prior, bothNamed);
  const canSupersede = blockers.length === 0;
  const blocker = primaryBlocker(blockers)?.message ?? null;
  const identityOnly = isIdentityOnly(blockers);

  if (
    current.maturity !== null &&
    prior.maturity !== null &&
    MATURITY_RANK[current.maturity] > MATURITY_RANK[prior.maturity]
  ) {
    return {
      kind: 'update',
      prior,
      reason: `${prior.maturity} → ${current.maturity}` + (blocker ? ` (${blocker})` : ''),
      corroborated: canSupersede,
      blocker,
      identityOnly,
    };
  }

  if (
    current.followup_months !== null &&
    prior.followup_months !== null &&
    current.followup_months > prior.followup_months
  ) {
    return {
      kind: 'update',
      prior,
      reason: `follow-up ${prior.followup_months}mo → ${current.followup_months}mo` + (blocker ? ` (${blocker})` : ''),
      corroborated: canSupersede,
      blocker,
      identityOnly,
    };
  }

  if (bothNamed && estimateMoved(current, prior)) {
    return {
      kind: 'update',
      prior,
      reason:
        `estimate moved (${prior.stat_value ?? 'none'} → ${current.stat_value ?? 'none'})` +
        (blocker ? ` (${blocker})` : ''),
      corroborated: canSupersede,
      blocker,
      identityOnly,
    };
  }

  // Same trial, same facet, and nothing distinguishes the two readings.
  //
  // `certain` demands positive evidence on every axis rather than the absence of
  // a difference:
  //   · registered identity (shared NCT — the same bar `corroborated` applies to
  //     an update, so no destructive branch here rests on an acronym alone);
  //   · the same maturity, both known;
  //   · a NAMED endpoint on both sides carrying a real stat.
  //
  // That last clause is the one the unnamed-endpoint case turns on. Two cards
  // with no endpoint recorded compare "equal" only because both are empty, and
  // absence of a number is not evidence that the number did not move. Those
  // still surface as a duplicate — the curator gets asked — but never
  // auto-suppress.
  // Same gate as an update, plus symmetry: BOTH readings must carry a statistic,
  // and neither may carry detail the other lacks. Requiring a stat only on the
  // CURRENT card let a bare "HR 0.62" unpublish a prior with no statistic at
  // all, and let a card with no CI unpublish the richer prior that had one.
  const stat = (x: string | null): string | null => {
    const t = (x ?? '').trim();
    return t === '' ? null : t;
  };
  const symmetric =
    stat(current.stat_value) !== null &&
    stat(prior.stat_value) !== null &&
    (stat(current.stat_detail) === null) === (stat(prior.stat_detail) === null);
  const certain = canSupersede && symmetric;

  return {
    kind: 'duplicate',
    prior,
    blocker: canSupersede && !symmetric ? 'statistical detail not symmetric' : blocker,
    identityOnly: identityOnly && symmetric,
    reason: bothNamed
      ? `same ${current.facet} reading, estimate unchanged`
      : `same ${current.facet} reading, no endpoint recorded to distinguish them`,
    certain,
  };
}
