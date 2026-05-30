// v0.10 tag system — build-time reverse index, intersection cardinality,
// sibling pre-compute, and uniqueness assertion.
//
// SINGLE SOURCE OF TRUTH for tag derivation: this module reads the typed
// fields (study.modality / study.intent / study.methodology /
// study.verdict.soc_implication / digest.conference.slug) and computes the
// unified tag view per study. The published JSON API will read this same
// derive function (api-output.ts in a later PR) — no persisted study.tags[]
// field exists anywhere in data/digests/*.json (eng-review DERIVED lock).
//
// Failure posture: fail-closed on malformed JSON. Unlike digest-data.ts
// listDigests() which skips bad files (correct for the home page, which
// degrades gracefully when one day is bad), the tag index must fail the
// build — a missing digest yields an incomplete reverse index, which yields
// incomplete landing pages + RSS feeds + API endpoints downstream. Better
// to fail loudly pre-deploy than ship navigation gaps.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DigestArtifact, DigestStudy, SocImplication } from './digest-data.ts';
import { assignSlugsForDate } from './slug-resolve.ts';
import {
  isValidModality,
  isValidIntent,
  isValidMethodology,
  findSlugCollision,
  isSafeTagSlug,
  type SlugCollisionResult,
} from './tags.ts';

const DIGEST_ROOT = resolve(process.cwd(), 'data/digests');

// ---------------- Strict digest read (fail-closed) ----------------

/**
 * Like listDigests() but throws on the first malformed file instead of
 * silently skipping. Use for any build-time derivation (tag index, sibling
 * cache, uniqueness assertion, RSS feeds, JSON API) where a partial corpus
 * would yield incomplete navigation surface that ships to readers.
 */
export function listDigestsStrict(): DigestArtifact[] {
  if (!existsSync(DIGEST_ROOT)) return [];
  const entries = readdirSync(DIGEST_ROOT);
  const out: DigestArtifact[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const path = join(DIGEST_ROOT, file);
    const raw = readFileSync(path, 'utf-8');
    let parsed: DigestArtifact;
    try {
      parsed = JSON.parse(raw) as DigestArtifact;
    } catch (e) {
      throw new Error(`tag-index: malformed JSON in ${path} (${(e as Error).message})`);
    }
    out.push(parsed);
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---------------- Tag view derivation ----------------

/**
 * Identifies a single study within the corpus. The {date, resolvedSlug} pair
 * is stable across builds (resolved slug uses slug-resolve.ts which handles
 * within-day collisions deterministically) and survives backfill rebuilds.
 * Object identity is NEVER used as a key — JSON.parse produces fresh objects
 * on every build, so identity-keyed caches would always miss.
 */
export type StudyKey = { date: string; resolvedSlug: string };

export function studyKeyString(k: StudyKey): string {
  return `${k.date}#${k.resolvedSlug}`;
}

/**
 * Derived tag VIEW per study. Read from typed fields on the study + digest.
 * Disease-site is included for the sibling-matching algorithm but is NOT
 * exposed as a tag namespace under /tags/ (disease-site stays at /sites/).
 *
 * Any field is null when the underlying typed field is absent or invalid
 * (the LLM dropped an out-of-enum value, the verdict is missing, the digest
 * has no conference, etc.). Downstream consumers filter null when building
 * reverse-index keys, so a study with null modality simply doesn't appear on
 * the modality landing pages.
 */
export type TagView = {
  modality: string | null;
  intent: string | null;
  methodology: string | null;
  verdict: SocImplication | null;
  meeting: string | null;
  disease_site: string;
};

export function deriveStudyTags(
  study: DigestStudy,
  diseaseSite: string,
  digestConferenceSlug: string | null,
): TagView {
  return {
    modality: study.modality && isValidModality(study.modality) ? study.modality : null,
    intent: study.intent && isValidIntent(study.intent) ? study.intent : null,
    methodology:
      study.methodology && isValidMethodology(study.methodology) ? study.methodology : null,
    verdict: study.verdict?.soc_implication ?? null,
    meeting: digestConferenceSlug ?? null,
    disease_site: diseaseSite,
  };
}

// ---------------- Reverse index ----------------

/**
 * For each tag slug (across all namespaces that surface under /tags/), the
 * set of studies that carry it. Keys are slug-only (matches /tags/<slug>/
 * URL form, the v0.10 URL decision). Values are studyKeyString(...) so the
 * Set semantics actually dedupe.
 *
 * Disease-site is NOT in this index — those pages live at /sites/<slug>/
 * unchanged.
 */
export type ReverseIndex = Map<string, Set<string>>;

export function buildReverseIndex(digests: readonly DigestArtifact[]): ReverseIndex {
  const index: ReverseIndex = new Map();
  for (const digest of digests) {
    const meeting = digest.conference?.slug ?? null;
    for (const site of digest.digest.sites ?? []) {
      const resolvedSlugs = assignSlugsForDate(site.studies);
      site.studies.forEach((study, i) => {
        const key = studyKeyString({ date: digest.date, resolvedSlug: resolvedSlugs[i]! });
        const view = deriveStudyTags(study, site.disease_site, meeting);
        for (const slug of [view.modality, view.intent, view.methodology, view.verdict, view.meeting]) {
          if (!slug) continue;
          let set = index.get(slug);
          if (!set) {
            set = new Set<string>();
            index.set(slug, set);
          }
          set.add(key);
        }
      });
    }
  }
  return index;
}

// ---------------- Intersection cardinality ----------------

export type Intersection = {
  tags: string[]; // sorted alphabetical, canonical URL order
  studyCount: number;
};

/**
 * Enumerate intersection sets up to `maxArity` tags with at least `threshold`
 * shared studies, ordered by count desc, capped at `cap` HTML pages.
 *
 * The cap unit is HTML pages (the static-build emission count). Per-tag RSS
 * feeds + JSON API endpoints are NOT counted against the cap — they're
 * trivially cheap static endpoint emissions.
 *
 * Algorithm: for each k from 2..maxArity, generate sorted tag tuples by
 * combining smaller-arity intersections that share a left prefix. Each tuple
 * is materialized once (canonical alphabetical order); non-canonical orderings
 * are computed at URL classification time (pages/tags/[...slug].astro), not
 * here.
 */
export function computeIntersections(
  index: ReverseIndex,
  opts: { maxArity: 2 | 3; threshold: number; cap: number },
): Intersection[] {
  const { maxArity, threshold, cap } = opts;
  const tagsSorted = [...index.keys()].sort();
  const out: Intersection[] = [];

  // k=2 pass: every ordered pair (a, b) with a < b.
  const pairs: Intersection[] = [];
  for (let i = 0; i < tagsSorted.length; i++) {
    const a = tagsSorted[i]!;
    const setA = index.get(a)!;
    for (let j = i + 1; j < tagsSorted.length; j++) {
      const b = tagsSorted[j]!;
      const setB = index.get(b)!;
      let count = 0;
      for (const key of setA) if (setB.has(key)) count++;
      if (count >= threshold) pairs.push({ tags: [a, b], studyCount: count });
    }
  }
  out.push(...pairs);

  // k=3: only when the {a,b} pair already meets the threshold (anti-monotone
  // shortcut — a 3-way subset can only be ≥threshold if every 2-way subset is).
  if (maxArity === 3) {
    const passingPairs = new Map<string, Intersection>();
    for (const p of pairs) passingPairs.set(p.tags.join('+'), p);
    for (const p of pairs) {
      const [a, b] = p.tags;
      // Extend with a third tag c > b that maintains canonical order.
      const startIdx = tagsSorted.indexOf(b!) + 1;
      for (let k = startIdx; k < tagsSorted.length; k++) {
        const c = tagsSorted[k]!;
        // Anti-monotone: skip if {a,c} or {b,c} didn't pass the 2-way threshold.
        if (!passingPairs.has(`${a}+${c}`)) continue;
        if (!passingPairs.has(`${b}+${c}`)) continue;
        const setA = index.get(a!)!;
        const setB = index.get(b!)!;
        const setC = index.get(c)!;
        let count = 0;
        for (const key of setA) if (setB.has(key) && setC.has(key)) count++;
        if (count >= threshold) out.push({ tags: [a!, b!, c], studyCount: count });
      }
    }
  }

  // Sort by study count desc, then tag tuple asc (deterministic tie-break).
  out.sort((x, y) => {
    if (x.studyCount !== y.studyCount) return y.studyCount - x.studyCount;
    const xt = x.tags.join('+');
    const yt = y.tags.join('+');
    return xt < yt ? -1 : xt > yt ? 1 : 0;
  });

  return out.slice(0, cap);
}

// ---------------- Sibling pre-compute ----------------

/**
 * Pre-computed siblings per study. Key is studyKeyString({date, resolvedSlug});
 * value is up to 3 sibling StudyKeys, sorted date desc then alphabetic.
 *
 * Match algorithm (from design review):
 *   1. Primary: same disease_site + same verdict + same modality
 *   2. Fallback if study has null modality: same disease_site + same verdict
 *   3. Self is always excluded
 *   4. Tie-break: date desc, then resolved slug asc
 *
 * Per eng review: this runs ONCE at build time and is cached. Pages read
 * from the cache instead of recomputing per render (otherwise an O(N²) scan
 * over all studies on every card render).
 */
export type SiblingMap = Map<string, StudyKey[]>;

type EnrichedStudy = {
  key: StudyKey;
  view: TagView;
};

export function computeSiblings(digests: readonly DigestArtifact[]): SiblingMap {
  const enriched: EnrichedStudy[] = [];
  for (const digest of digests) {
    const meeting = digest.conference?.slug ?? null;
    for (const site of digest.digest.sites ?? []) {
      const resolvedSlugs = assignSlugsForDate(site.studies);
      site.studies.forEach((study, i) => {
        enriched.push({
          key: { date: digest.date, resolvedSlug: resolvedSlugs[i]! },
          view: deriveStudyTags(study, site.disease_site, meeting),
        });
      });
    }
  }

  const out: SiblingMap = new Map();
  for (const target of enriched) {
    const matches: EnrichedStudy[] = [];
    for (const candidate of enriched) {
      if (candidate.key.date === target.key.date && candidate.key.resolvedSlug === target.key.resolvedSlug) {
        continue;
      }
      if (candidate.view.disease_site !== target.view.disease_site) continue;
      if (candidate.view.verdict !== target.view.verdict) continue;
      // Modality is required when target has one; relaxed when target lacks one.
      if (target.view.modality !== null && candidate.view.modality !== target.view.modality) {
        continue;
      }
      matches.push(candidate);
    }
    matches.sort((a, b) => {
      if (a.key.date !== b.key.date) return a.key.date < b.key.date ? 1 : -1;
      return a.key.resolvedSlug < b.key.resolvedSlug ? -1 : 1;
    });
    out.set(studyKeyString(target.key), matches.slice(0, 3).map((m) => m.key));
  }
  return out;
}

// ---------------- Meeting slug collection (for uniqueness assertion) ----------------

/**
 * Deduplicated list of every conference slug observed across the corpus.
 * Used as input to findSlugCollision() in the build-time assertion.
 * Conference can be null (a non-meeting day); those are filtered.
 */
export function collectMeetingSlugs(digests: readonly DigestArtifact[]): string[] {
  const seen = new Set<string>();
  for (const d of digests) {
    if (d.conference?.slug) seen.add(d.conference.slug);
  }
  return Array.from(seen);
}

// ---------------- Build-time uniqueness assertion (top-level entry) ----------------

/**
 * Run the cross-namespace uniqueness assertion using the live corpus's
 * meeting slugs and the verdict enum. Call this from build/digest-builder.ts
 * after writing data/digests/<date>.json and before downstream HTML generation.
 *
 * Returns null on success; throws on collision or malformed slug, with a
 * message that pinpoints the offending value across namespaces.
 */
export function assertSlugUniqueness(
  digests: readonly DigestArtifact[],
  verdictSlugs: readonly string[],
): void {
  const meetings = collectMeetingSlugs(digests);
  const result: SlugCollisionResult = findSlugCollision(meetings, verdictSlugs);
  if (result === null) return;
  if (result.kind === 'collision') {
    throw new Error(
      `tag-index: slug collision under /tags/ — "${result.a.slug}" appears in BOTH ` +
        `${result.a.namespace} and ${result.b.namespace} namespaces. ` +
        `Slug-only URLs require global uniqueness across modality + intent + ` +
        `methodology + verdict + meeting. Rename one or change the URL scheme.`,
    );
  }
  throw new Error(
    `tag-index: malformed ${result.namespace} slug "${result.slug}" would yield a broken URL. ` +
      `Slug must match /^[a-z0-9]+(-[a-z0-9]+)*$/ (lowercase alphanumeric + hyphens).`,
  );
}

// Re-export so consumers don't need to import from both tags.ts and tag-index.ts.
export { isSafeTagSlug };
