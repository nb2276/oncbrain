// The build-time half of trial lineage: turn a verdict into an action.
//
// trial-lineage.ts decides WHAT a same-trial resubmission is; this module reads
// the inputs that decision needs out of the artifacts + the source DB, and
// applies the consequence. It is deliberately separate so the decision table
// stays a pure function with no I/O to mock.
//
// WHY IDENTITY IS ASSEMBLED HERE RATHER THAN READ OFF THE CARD. A published card
// records `nct` and `name` and nothing else about which trial it is. That is not
// enough: the 2026-07-08 NRG-GU005 card has `nct: null`, and the same trial's
// full publication is titled "Stereotactic Body Radiotherapy vs Moderately
// Hypofractionated IMRT ..." with no acronym in the title at all. Each reading is
// unidentifiable from its own card, so identity is accreted from the SOURCES
// behind the card — their registered NCTs and the acronyms they declared for the
// trial they report.

import type Database from 'better-sqlite3';
import { ownRegistrations } from './extract.ts';
import {
  classifyAgainstPrior,
  isMaturity,
  isReportFacet,
  normalizeEndpoint,
  sameTrial,
  type LineageVerdict,
  type TrialReport,
} from './trial-lineage.ts';

export type LineageStudy = {
  slug?: string;
  name: string;
  nct?: string | null;
  source_ids?: { type: 'tweet' | 'paper' | 'slide'; id: number }[];
  primary_endpoint?: { name?: string | null; stat_value?: string | null; stat_detail?: string | null } | null;
};

export type LineageArtifact = {
  date: string;
  digest: { sites: { disease_site?: string | null; studies: LineageStudy[] }[] };
};

type FacetRow = {
  report_facet: string | null;
  maturity: string | null;
  followup_months: number | null;
  trial_acronyms_json: string | null;
  text: string | null;
};

/**
 * Read the lineage inputs for one card's sources: the facet/maturity the
 * enrichment classifier assigned, plus the NCTs and trial acronyms those sources
 * carry.
 *
 * Where sources disagree, the strongest wins: the most mature maturity and the
 * longest follow-up. A card is one finding, and if any of its sources is the
 * peer-reviewed full publication then the card reports a full publication.
 */
export function sourceFacts(
  db: Database.Database,
  refs: { type: 'tweet' | 'paper' | 'slide'; id: number }[],
): {
  facet: string | null;
  facetConflict: string[];
  unclassifiedSources: number;
  maturity: string | null;
  followup_months: number | null;
  ncts: string[];
  acronyms: string[];
} {
  const out = {
    facet: null as string | null,
    /** The distinct facets found when sources DISAGREE — empty otherwise.
     *  Distinguishes "unclassified" from "merges two objectives", which are the
     *  same null facet but very different situations for the curator. */
    facetConflict: [] as string[],
    /** Substantive sources the classifier could not read. Any of these makes the
     *  card's objective unknown, so `facet` stays null. */
    unclassifiedSources: 0,
    maturity: null as string | null,
    followup_months: null as number | null,
    ncts: [] as string[],
    acronyms: [] as string[],
  };
  const ncts = new Set<string>();
  const acronyms = new Set<string>();
  const facetVotes: string[] = [];
  // Papers and tweets carry an objective; a slide is a photograph attached to a
  // study another source establishes, so it is not expected to vote.
  let substantiveSources = 0;

  for (const ref of refs) {
    const table = ref.type === 'paper' ? 'papers' : ref.type === 'tweet' ? 'bookmarks' : null;
    if (!table) continue;
    substantiveSources++;
    let row: FacetRow | undefined;
    try {
      row = db
        .prepare(
          table === 'papers'
            ? `SELECT report_facet, maturity, followup_months, trial_acronyms_json,
                      COALESCE(title,'') || ' ' || COALESCE(abstract,'') AS text
                 FROM papers WHERE id = ?`
            : `SELECT report_facet, maturity, followup_months, trial_acronyms_json,
                      COALESCE(tweet_text,'') AS text
                 FROM bookmarks WHERE id = ?`,
        )
        .get(ref.id) as FacetRow | undefined;
    } catch {
      continue; // a DB that predates the facet migration reads as unclassified
    }
    if (!row) continue;

    if (isReportFacet(row.report_facet)) facetVotes.push(row.report_facet);
    if (isMaturity(row.maturity)) {
      // full-publication outranks conference-abstract
      if (row.maturity === 'full-publication' || out.maturity === null) out.maturity = row.maturity;
    }
    if (typeof row.followup_months === 'number' && Number.isFinite(row.followup_months)) {
      if (out.followup_months === null || row.followup_months > out.followup_months) {
        out.followup_months = row.followup_months;
      }
    }
    if (row.trial_acronyms_json) {
      try {
        const arr = JSON.parse(row.trial_acronyms_json);
        if (Array.isArray(arr)) for (const a of arr) if (typeof a === 'string') acronyms.add(a);
      } catch {
        // malformed sidecar JSON — ignore, identity just stays narrower
      }
    }
    // Only the registrations this source claims as ITS OWN. A shared NCT
    // authorises an automatic unpublish where an acronym never can, so a
    // comparator's number cited in an abstract must not join this card's
    // identity — otherwise a later paper about that comparator could supersede
    // this study.
    if (row.text) for (const id of ownRegistrations(row.text)) ncts.add(id);
  }

  // A card with sources reporting DIFFERENT facets is exactly the case Phase 1
  // should have split into two cards. Refuse to pick one: an ambiguous facet
  // abstains, so lineage never acts on a card whose own objective is unclear.
  //
  // This is load-bearing, not defensive. The live 2026-07-08 NRG-GU005 card was
  // built from the trial's quality-of-life paper AND its co-primary efficacy
  // paper, and the full efficacy publication that arrived later supersedes only
  // ONE of those. Suppressing the merged card would silently take the QoL
  // reading down with it, so the correct action is no action plus a warning.
  //
  // UNANIMITY IS REQUIRED, NOT A PLURALITY OF THE CLASSIFIED. `facetVotes` only
  // collects sources the classifier actually read, so one classified efficacy
  // source sitting beside an UNCLASSIFIED quality-of-life source used to look
  // exactly like a single-source efficacy card — one vote, no conflict — and the
  // whole merged card became suppressible. Silence from a source is not
  // agreement with the others. Any substantive source we could not classify
  // makes the card's own objective unknown.
  const distinct = [...new Set(facetVotes)];
  const allClassified = facetVotes.length === substantiveSources;
  out.facet = distinct.length === 1 && allClassified ? distinct[0]! : null;
  out.facetConflict = distinct.length > 1 ? distinct.sort() : [];
  out.unclassifiedSources = Math.max(0, substantiveSources - facetVotes.length);

  out.ncts = [...ncts];
  out.acronyms = [...acronyms];
  return out;
}

/** Assemble a TrialReport for one card, accreting identity from its sources. */
export function toTrialReport(
  db: Database.Database,
  date: string,
  disease_site: string | null,
  study: LineageStudy,
): TrialReport | null {
  if (!study.slug) return null; // a card we cannot link to or suppress by slug
  const facts = sourceFacts(db, study.source_ids ?? []);
  const ncts = new Set(facts.ncts);
  if (study.nct) ncts.add(study.nct.toUpperCase());
  return {
    date,
    slug: study.slug,
    name: study.name,
    ncts: [...ncts],
    acronyms: facts.acronyms,
    disease_site,
    facet: isReportFacet(facts.facet) ? facts.facet : null,
    maturity: isMaturity(facts.maturity) ? facts.maturity : null,
    followup_months: facts.followup_months,
    endpoint: study.primary_endpoint?.name ?? null,
    stat_value: study.primary_endpoint?.stat_value ?? null,
    stat_detail: study.primary_endpoint?.stat_detail ?? null,
  };
}

/** Flatten published artifacts into prior readings. Shape-guarded at every
 *  level: these are files off disk, and a hand-edited or older-schema artifact
 *  must degrade to "no prior" rather than throw inside build:day. */
export function priorReports(db: Database.Database, artifacts: LineageArtifact[]): TrialReport[] {
  const out: TrialReport[] = [];
  for (const a of artifacts) {
    if (!a || typeof a.date !== 'string' || !Array.isArray(a.digest?.sites)) continue;
    for (const site of a.digest.sites) {
      if (!Array.isArray(site?.studies)) continue;
      for (const st of site.studies) {
        if (!st || typeof st.name !== 'string') continue;
        const r = toTrialReport(db, a.date, site.disease_site ?? null, st);
        if (r) out.push(r);
      }
    }
  }
  return out;
}

export type LineageAction = {
  verdict: LineageVerdict;
  /** The study on the date being built. */
  slug: string;
  /** Suppress this prior card, or null when the action is non-destructive.
   *  Carries the card's PROVENANCE as well as its name/NCT: suppressing removes
   *  it from the published artifact, so the next rebuild cannot hold its slug
   *  and will rename it — and name alone cannot re-find it once one trial has
   *  two cards. See DigestOverrides.identity. */
  suppress: {
    date: string;
    slug: string;
    name: string;
    nct: string | null;
    source_ids: { type: string; id: number }[];
  } | null;
  /** Why the suppression was declined, when a verdict called for one. */
  declined: string | null;
  /** Was an identity gap the ONLY blocker? The single case where a curator
   *  reading both cards can legitimately authorize a drop the machine refused. */
  identityOnly: boolean;
  /** Did the evidence gate authorize a suppression, independent of whether
   *  policy let it act? True + `suppress: null` means the machine vouched for
   *  the drop and the default-off policy withheld it — the one case where
   *  offering the curator a one-reply `drop` is safe, because nothing was
   *  refused on evidence. */
  gateAuthorized: boolean;
};

/** Papers + tweets behind a card. Slides are photographs attached to a study
 *  another source establishes, so they never make a card ambiguous. */
export function substantiveCount(st: { source_ids?: { type: string }[] }): number {
  return (st.source_ids ?? []).filter((r) => r.type !== 'slide').length;
}

/**
 * The objective an ALREADY-PUBLISHED card reports, read back from its sources.
 *
 * The coverage indexes the enrich-time nudge uses carry only date/name/slug, so
 * the prior's facet has to be recovered from the artifact. Returns null when the
 * card cannot be found or its sources disagree — both of which mean "unknown",
 * which callers must treat as incompatible rather than as a match.
 */
export function publishedFacet(
  db: Database.Database,
  artifacts: LineageArtifact[],
  date: string,
  slug: string,
): string | null {
  for (const a of artifacts) {
    if (!a || a.date !== date) continue;
    for (const site of a.digest?.sites ?? []) {
      for (const st of site?.studies ?? []) {
        if (st?.slug !== slug) continue;
        return sourceFacts(db, st.source_ids ?? []).facet;
      }
    }
  }
  return null;
}

/** The source rows behind one published card — the identity a suppress override
 *  needs in order to survive the rename that suppression itself causes. */
export function sourceIdsOf(
  artifact: LineageArtifact,
  slug: string,
): { type: string; id: number }[] {
  for (const site of artifact.digest?.sites ?? []) {
    for (const st of site?.studies ?? []) {
      if (st?.slug === slug) return st.source_ids ?? [];
    }
  }
  return [];
}

/**
 * How many studies a published date would still carry if `slug` were suppressed.
 * Suppressing a date's LAST study leaves an orphaned headline — a published day
 * whose top_line describes studies the page no longer renders. The correct fix
 * for a genuinely empty day is to remove the artifact, which is not something an
 * automatic pass should do behind the curator's back.
 */
export function remainingAfterSuppress(
  artifact: LineageArtifact,
  slugs: string | string[],
  alreadySuppressed: readonly string[] = [],
): number {
  // Takes a SET, not one slug. Checking one suppression at a time was the bug:
  // when two cards on a prior date are each superseded in the same build, both
  // checks independently see one survivor, both are approved, and the builder
  // then writes both — leaving the date at zero. `alreadySuppressed` folds in the
  // date's existing override so a second run cannot finish the job the first one
  // started.
  const gone = new Set([...(Array.isArray(slugs) ? slugs : [slugs]), ...alreadySuppressed]);
  let n = 0;
  for (const site of artifact.digest?.sites ?? []) {
    for (const st of site?.studies ?? []) {
      if (st?.slug && !gone.has(st.slug)) n++;
    }
  }
  return n;
}

/**
 * Decide the action for every study on the date being built.
 *
 * Pure with respect to the filesystem: it reads the source DB and returns what
 * SHOULD happen. The caller writes overrides and queues rebuilds, so the policy
 * is testable without a repo on disk.
 */
export function planLineage(
  db: Database.Database,
  date: string,
  digest: { sites: { disease_site?: string | null; studies: LineageStudy[] }[] },
  artifacts: LineageArtifact[],
  /** Slugs each prior date ALREADY hides via a durable override. Folded into the
   *  empty-day guard so successive runs cannot together empty a date that no
   *  single run would have. */
  suppressedByDate: Map<string, readonly string[]> = new Map(),
  /** Policy: may this build unpublish a card on its own?
   *
   * DEFAULT OFF, deliberately. Four adversarial review rounds each found a new
   * route to a wrongful unpublish, and the guards that closed them left the
   * destructive path so narrow it effectively never fires — `followup_months`
   * alone is absent from most sources. Rather than ship "safe because six
   * preconditions rarely align", the narrowness is stated policy: lineage
   * detects, links and asks; a human authorizes removal. Flip it with
   * TRIAL_LINEAGE_AUTOSUPPRESS=on once the path has had a quieter review. */
  autoSuppress = false,
): LineageAction[] {
  const priors = priorReports(
    db,
    artifacts.filter((a) => a.date < date),
  );
  if (priors.length === 0) return [];

  const byDate = new Map(artifacts.map((a) => [a.date, a]));
  // How many PAPER sources each published card was assembled from. A card built
  // from two papers may be a Phase 1 merge of two different endpoints under one
  // facet, and nothing on the card can tell us otherwise.
  const priorPaperCount = new Map<string, number>();
  for (const a of artifacts) {
    for (const site of a.digest?.sites ?? []) {
      for (const st of site?.studies ?? []) {
        if (!st?.slug) continue;
        priorPaperCount.set(`${a.date}/${st.slug}`, substantiveCount(st));
      }
    }
  }
  const actions: LineageAction[] = [];

  for (const site of digest.sites) {
    for (const study of site.studies) {
      const current = toTrialReport(db, date, site.disease_site ?? null, study);
      if (!current) continue;
      const verdict = classifyAgainstPrior(current, priors);
      if (verdict.kind === 'unrelated') continue;

      let suppress: LineageAction['suppress'] = null;
      let declined: string | null = null;

      // EVERY destructive branch requires REGISTERED identity. An update used to
      // suppress unconditionally while a duplicate demanded a shared NCT — the
      // two rules disagreed, and the weaker one was doing the unpublishing. Two
      // unrelated same-site "PRIME" reports, one an abstract and one a paper,
      // met every other update condition and took a live card down. An
      // uncorroborated verdict still stamps the supersedes link on the new card;
      // the curator is asked before anything is removed.
      // A facet is coarser than an endpoint. OS, DFS, PFS and local control ALL
      // classify as `primary-efficacy`, so a card mistakenly merged from an OS
      // paper and a DFS paper passes the unanimity check — and the endpoint
      // comparison is card-level, so a later OS publication matches the card's
      // one recorded endpoint and removes the whole thing, DFS finding included.
      //
      // We cannot tell from the card which paper contributed which endpoint, so
      // a prior assembled from MORE THAN ONE paper is not safe to remove
      // automatically. Tweets and slides don't count: a tweet-plus-paper card is
      // one result told twice, which is the common legitimate shape.
      // BOTH SIDES. Counting only the prior left the mirror hole open: a current
      // card assembled from two papers can borrow `full-publication` or a longer
      // follow-up from its DFS paper while its card-level endpoint reads OS, and
      // then supersede the prior OS card although OS never matured. And counting
      // only PAPERS missed a prior assembled from several tweets, which is just
      // as ambiguous. Any card built from more than one substantive source may be
      // a Phase 1 merge, and nothing on the card says which source contributed
      // the endpoint we matched on.
      const priorPapers = priorPaperCount.get(`${verdict.prior.date}/${verdict.prior.slug}`) ?? 0;
      const currentSubstantive = substantiveCount(study);
      const ambiguousSide =
        priorPapers > 1 ? `prior card (${priorPapers} sources)`
        : currentSubstantive > 1 ? `new card (${currentSubstantive} sources)`
        : null;
      const multiPaperPrior = ambiguousSide !== null;

      // TWO SEPARATE QUESTIONS. `gateAuthorized` is "is the evidence sufficient";
      // `wantsSuppress` is "and are we allowed to act on it". Keeping them apart
      // is what lets the DM offer a one-reply drop for a policy hold without
      // ever offering one for an evidence refusal.
      const gateAuthorized =
        ((verdict.kind === 'update' && verdict.corroborated) ||
          (verdict.kind === 'duplicate' && verdict.certain)) &&
        !multiPaperPrior;
      const wantsSuppress = gateAuthorized && autoSuppress;

      // The REAL reason, not a catch-all. Labelling every blocked update
      // "no shared registration" turned the centralized gate into theatre: the
      // curator DM offers a `drop` reply for an identity gap, and
      // executeDedupDrop suppresses WITHOUT consulting suppressionBlocker — so a
      // maturity regression or an unnamed endpoint was handed to the human as
      // "just confirm the identity", and confirming it bypassed the gate that
      // had refused. Only an identity gap is a question a human can actually
      // answer from the card; everything else is evidence the two readings are
      // not the same result, and no reply makes them so.
      if (verdict.kind === 'update' && !verdict.corroborated) {
        declined = verdict.blocker ?? 'not authorized';
      } else if (verdict.kind === 'duplicate' && !verdict.certain) {
        declined = verdict.blocker ?? 'duplicate not certain';
      } else if (multiPaperPrior) {
        declined = `${ambiguousSide} merges multiple sources — may combine two endpoints`;
      } else if (gateAuthorized && !autoSuppress) {
        declined = 'auto-suppress disabled (TRIAL_LINEAGE_AUTOSUPPRESS=on to enable)';
      }

      if (wantsSuppress) {
        const priorArtifact = byDate.get(verdict.prior.date);
        // Everything this run has ALREADY decided to drop from that date, plus
        // whatever a previous run's override already hides. The guard has to see
        // the aggregate: two cards on one prior date, each superseded by a
        // different study today, each look survivable alone.
        const plannedForDate = actions
          .filter((a) => a.suppress?.date === verdict.prior.date)
          .map((a) => a.suppress!.slug);
        const existing = suppressedByDate.get(verdict.prior.date) ?? [];

        if (!priorArtifact) {
          declined = `prior artifact ${verdict.prior.date} not readable`;
        } else if (
          remainingAfterSuppress(
            priorArtifact,
            [...plannedForDate, verdict.prior.slug],
            existing,
          ) === 0
        ) {
          declined = `would empty ${verdict.prior.date} (last surviving study)`;
        } else {
          suppress = {
            date: verdict.prior.date,
            slug: verdict.prior.slug,
            name: verdict.prior.name,
            nct: verdict.prior.ncts[0] ?? null,
            source_ids: sourceIdsOf(priorArtifact, verdict.prior.slug),
          };
          declined = null;
        }
      }

      const identityOnly =
        (verdict.kind === 'update' || verdict.kind === 'duplicate') &&
        verdict.identityOnly === true &&
        !multiPaperPrior;
      actions.push({ verdict, slug: current.slug, suppress, declined, gateAuthorized, identityOnly });
    }
  }
  return actions;
}

/**
 * Priors that are the same trial as something being built today but whose OWN
 * objective is ambiguous, because they were built from sources reporting
 * different facets.
 *
 * Lineage deliberately takes no action on these — see sourceFacts — but silence
 * would be the wrong report. A merged card is a live defect: its headline number
 * splices two findings together, and it is also the reason a genuine
 * supersession could not be applied. Surfacing it is how the curator learns the
 * card wants splitting.
 */
export function findMergedPriors(
  db: Database.Database,
  date: string,
  digest: { sites: { disease_site?: string | null; studies: LineageStudy[] }[] },
  artifacts: LineageArtifact[],
): { date: string; slug: string; name: string; facets: string[] }[] {
  const out: { date: string; slug: string; name: string; facets: string[] }[] = [];
  const seen = new Set<string>();

  const currents: TrialReport[] = [];
  for (const site of digest.sites) {
    for (const study of site.studies) {
      const r = toTrialReport(db, date, site.disease_site ?? null, study);
      if (r) currents.push(r);
    }
  }
  if (currents.length === 0) return out;

  for (const a of artifacts) {
    if (!a || typeof a.date !== 'string' || a.date >= date || !Array.isArray(a.digest?.sites)) continue;
    for (const site of a.digest.sites) {
      if (!Array.isArray(site?.studies)) continue;
      for (const st of site.studies) {
        if (!st?.slug) continue;
        const facts = sourceFacts(db, st.source_ids ?? []);
        if (facts.facetConflict.length === 0) continue;
        const prior = toTrialReport(db, a.date, site.disease_site ?? null, st);
        if (!prior) continue;
        // Only report a merged card that is the SAME TRIAL as something being
        // built today. A general audit of the back catalogue is a separate job.
        if (!currents.some((c) => sameTrial(c, prior))) continue;
        const id = `${a.date}/${st.slug}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ date: a.date, slug: st.slug, name: st.name, facets: facts.facetConflict });
      }
    }
  }
  return out;
}

/** What the card shows: the reading this one supersedes. */
export function supersedesFrom(
  v: LineageVerdict,
  /** Whether the predecessor was actually unpublished. False when identity was
   *  acronym-only, or a guard refused — the link still shows, but the curator is
   *  asked before anything comes down. */
  autoDropped: boolean,
  /** WHY it was withheld, when it was. The two reasons need different curator
   *  copy: an identity gap is a question only they can answer, whereas the
   *  empty-day refusal must NOT invite a manual `drop` — that command has no
   *  empty-day guard of its own, so offering it there hands over the exact
   *  footgun the automatic path just refused. */
  declined: string | null = null,
  /** May the curator DM offer a one-reply drop? True only when the evidence gate
   *  passed (policy held it) or an identity gap was the SOLE blocker. Computed
   *  from structured verdict flags, never from the wording of `declined`. */
  droppable = false,
): {
  date: string;
  slug: string;
  stat_value: string | null;
  stat_detail: string | null;
  auto_dropped: boolean;
  declined_reason: string | null;
  droppable: boolean;
} | null {
  if (v.kind !== 'update') return null;
  return {
    date: v.prior.date,
    slug: v.prior.slug,
    stat_value: v.prior.stat_value,
    stat_detail: v.prior.stat_detail,
    auto_dropped: autoDropped,
    declined_reason: autoDropped ? null : declined,
    droppable: !autoDropped && droppable,
  };
}

export { normalizeEndpoint };
