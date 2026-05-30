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
import type {
  DigestArtifact,
  DigestStudy,
  DigestArtifactPaper,
  DigestArtifactSlide,
  DigestSourceRef,
  SocImplication,
} from './digest-data.ts';
import { assignSlugsForDate } from './slug-resolve.ts';
import {
  isValidModality,
  isValidIntent,
  isValidMethodology,
  findSlugCollision,
  isSafeTagSlug,
  MODALITY_DEFS,
  INTENT_DEFS,
  METHODOLOGY_DEFS,
  type SlugCollisionResult,
} from './tags.ts';
import { VERDICT_META } from './verdict.ts';

const DIGEST_ROOT = resolve(process.cwd(), 'data/digests');

// ---------------- Strict digest read (fail-closed) ----------------

/**
 * Like listDigests() but throws on the first malformed file instead of
 * silently skipping. Use for any build-time derivation (tag index, sibling
 * cache, uniqueness assertion, RSS feeds, JSON API) where a partial corpus
 * would yield incomplete navigation surface that ships to readers.
 */
export function listDigestsStrict(digestsDir: string = DIGEST_ROOT): DigestArtifact[] {
  if (!existsSync(digestsDir)) return [];
  const entries = readdirSync(digestsDir);
  const out: DigestArtifact[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const path = join(digestsDir, file);
    const raw = readFileSync(path, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`tag-index: malformed JSON in ${path} (${(e as Error).message})`);
    }
    // Shape validation: a malformed artifact missing .date or .digest.sites
    // would otherwise propagate as a confusing TypeError downstream (Codex
    // adversarial-review finding). Reject loudly with the file path so
    // recovery is obvious: delete the bad file and rerun.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`tag-index: ${path} root is not an object — delete the file and rerun`);
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.date !== 'string' || obj.date.length === 0) {
      throw new Error(`tag-index: ${path} missing .date — delete the file and rerun`);
    }
    if (!obj.digest || typeof obj.digest !== 'object') {
      throw new Error(`tag-index: ${path} missing .digest — delete the file and rerun`);
    }
    const inner = obj.digest as Record<string, unknown>;
    if (!Array.isArray(inner.sites)) {
      throw new Error(`tag-index: ${path} missing .digest.sites array — delete the file and rerun`);
    }
    out.push(parsed as DigestArtifact);
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

/**
 * Walk one digest as a single per-DATE pass: flatten studies across every
 * disease-site section, resolve slugs once over the whole list (matching how
 * pages/[date].astro renders), then yield {study, site, resolvedSlug} tuples in
 * site render order. This is the SINGLE source of truth for per-date slug
 * resolution used by buildReverseIndex + computeSiblings.
 *
 * Why this exists: assignSlugsForDate dedupes WITHIN its input list. Calling
 * it once per site (the naive pattern) leaves cross-site name collisions
 * undeduplicated — two studies named "Trial" in different disease-site
 * sections would both resolve to "trial" and collide on the {date, slug} key,
 * silently overwriting each other in the reverse index Set. Page rendering
 * handles this correctly by flattening across sites first; this iterator
 * does the same for build-time derivation.
 */
type WalkedStudy = {
  study: DigestStudy;
  diseaseSite: string;
  resolvedSlug: string;
};

function* walkStudiesPerDate(digest: DigestArtifact): IterableIterator<WalkedStudy> {
  const sites = digest.digest?.sites ?? [];
  // Flatten across sites in render order, preserving the (study, site) pairing
  // so deriveStudyTags can read disease_site off the parent site.
  const flat: Array<{ study: DigestStudy; diseaseSite: string }> = [];
  for (const site of sites) {
    for (const study of site.studies ?? []) {
      flat.push({ study, diseaseSite: site.disease_site });
    }
  }
  const resolvedSlugs = assignSlugsForDate(flat.map((f) => f.study));
  for (let i = 0; i < flat.length; i++) {
    yield {
      study: flat[i]!.study,
      diseaseSite: flat[i]!.diseaseSite,
      resolvedSlug: resolvedSlugs[i]!,
    };
  }
}

export function buildReverseIndex(digests: readonly DigestArtifact[]): ReverseIndex {
  const index: ReverseIndex = new Map();
  for (const digest of digests) {
    const meeting = digest.conference?.slug ?? null;
    for (const { study, diseaseSite, resolvedSlug } of walkStudiesPerDate(digest)) {
      const key = studyKeyString({ date: digest.date, resolvedSlug });
      const view = deriveStudyTags(study, diseaseSite, meeting);
      for (const slug of [view.modality, view.intent, view.methodology, view.verdict, view.meeting]) {
        if (!slug) continue;
        let set = index.get(slug);
        if (!set) {
          set = new Set<string>();
          index.set(slug, set);
        }
        set.add(key);
      }
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
  // Input guards: a negative cap would silently truncate via Array.slice(0, -1)
  // returning all-but-last (adversarial-review finding). A non-integer cap is
  // similarly malformed. Treat invalid input as "no pages" so the build emits
  // nothing rather than something wrong.
  if (!Number.isInteger(cap) || cap < 0) return [];
  if (!Number.isInteger(threshold) || threshold < 1) return [];
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

  // Sort: lower-arity first, THEN by study count desc, then tag tuple asc.
  // Critical for cap correctness: anti-monotone guarantees count(3-way) ≤
  // count(2-way subset). Sorting 2-way before 3-way means every retained
  // 3-way's 2-way subsets are ALSO retained — so the breadcrumb's
  // remove-filter "×" link can never 404 because of cap truncation. Codex
  // review surfaced this: without arity-first ordering, a 3-way could
  // survive at the cap boundary while a constituent 2-way got cut, breaking
  // the reduced-intersection navigation.
  out.sort((x, y) => {
    if (x.tags.length !== y.tags.length) return x.tags.length - y.tags.length;
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
    for (const { study, diseaseSite, resolvedSlug } of walkStudiesPerDate(digest)) {
      enriched.push({
        key: { date: digest.date, resolvedSlug },
        view: deriveStudyTags(study, diseaseSite, meeting),
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

// ---------------- Tag occurrence resolution (for landing pages + RSS + JSON) ----------------

/**
 * One study's appearance under a tag, with sources resolved. Mirrors the
 * SiteStudyOccurrence shape so the same StudyCard renderer works for both
 * /sites/<slug>/ and /tags/<slug>/.
 *
 * resolvedSlug is the per-DATE slug (so same-day siblings get -2/-3 suffixes
 * just like the date page). diseaseSite is preserved so the landing page can
 * show the disease-site emoji on each card.
 */
export type TagOccurrence = {
  date: string;
  conference: DigestArtifact['conference'];
  diseaseSite: string;
  resolvedSlug: string;
  study: DigestStudy;
  bookmarks: DigestArtifact['bookmarks'];
  papers?: DigestArtifactPaper[];
  slides?: DigestArtifactSlide[];
};

/**
 * For every tag slug observed in the corpus (modality, intent, methodology,
 * verdict, meeting — but NOT disease-site, which lives at /sites/), return
 * the date-desc list of TagOccurrence entries. Used by:
 *   - pages/tags/[...slug].astro getStaticPaths (single-tag URL set)
 *   - pages/tags/index.astro (top-level namespace listing with counts)
 *   - pages/tags/[...slug]/feed.xml.ts (per-tag RSS feed)
 *   - pages/api/v1/tag/[slug].json.ts (per-tag JSON API)
 *
 * Resolution mirrors listSiteSummaries(): typed refs from source_ids dispatch
 * to bookmarks/papers/slides; v0.4 back-compat falls through tweet_ids.
 */
export function listTagSummaries(
  digests: readonly DigestArtifact[],
): Map<string, TagOccurrence[]> {
  const out = new Map<string, TagOccurrence[]>();

  for (const digest of digests) {
    const meeting = digest.conference?.slug ?? null;
    const bookmarkById = new Map(digest.bookmarks.map((b) => [b.id, b]));
    const papersById = new Map((digest.papers ?? []).map((p) => [p.id, p]));
    const slidesById = new Map((digest.slides ?? []).map((s) => [s.id, s]));

    for (const { study, diseaseSite, resolvedSlug } of walkStudiesPerDate(digest)) {
      // v0.5: typed refs preferred; tweet_ids is the back-compat fallback.
      const refs: DigestSourceRef[] =
        study.source_ids ?? study.tweet_ids.map((id) => ({ type: 'tweet' as const, id }));
      const studyBookmarks = refs
        .filter((r): r is { type: 'tweet'; id: number } => r.type === 'tweet')
        .map((r) => bookmarkById.get(r.id))
        .filter((b): b is NonNullable<typeof b> => Boolean(b));
      const studyPapers = refs
        .filter((r): r is { type: 'paper'; id: number } => r.type === 'paper')
        .map((r) => papersById.get(r.id))
        .filter((p): p is DigestArtifactPaper => Boolean(p));
      const studySlides = refs
        .filter((r): r is { type: 'slide'; id: number } => r.type === 'slide')
        .map((r) => slidesById.get(r.id))
        .filter((s): s is DigestArtifactSlide => Boolean(s));

      const occurrence: TagOccurrence = {
        date: digest.date,
        conference: digest.conference,
        diseaseSite,
        resolvedSlug,
        study,
        bookmarks: studyBookmarks,
        papers: studyPapers.length > 0 ? studyPapers : undefined,
        slides: studySlides.length > 0 ? studySlides : undefined,
      };

      const view = deriveStudyTags(study, diseaseSite, meeting);
      for (const slug of [
        view.modality,
        view.intent,
        view.methodology,
        view.verdict,
        view.meeting,
      ]) {
        if (!slug) continue;
        let list = out.get(slug);
        if (!list) {
          list = [];
          out.set(slug, list);
        }
        list.push(occurrence);
      }
    }
  }

  // Sort each list newest first; within a date, preserve render order (already
  // emitted in render order by walkStudiesPerDate).
  for (const list of out.values()) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  return out;
}

/**
 * Intersection occurrences: every study that appears under ALL of the given
 * tag slugs, in date-desc render order. Used by intersection landing pages.
 *
 * The set semantics are derived from the buildReverseIndex() Set keying
 * ({date, resolvedSlug}), so a per-date occurrence appears at most once even
 * across multiple disease-site sections — matching the URL semantics readers
 * see.
 */
export function intersectTagOccurrences(
  summaries: Map<string, TagOccurrence[]>,
  tagSlugs: readonly string[],
): TagOccurrence[] {
  if (tagSlugs.length === 0) return [];
  // Start from the smallest list — every subsequent filter only narrows.
  const lists = tagSlugs.map((s) => summaries.get(s) ?? []);
  if (lists.some((l) => l.length === 0)) return [];
  lists.sort((a, b) => a.length - b.length);

  const occurrenceKey = (o: TagOccurrence) => `${o.date}#${o.resolvedSlug}`;
  const requiredKeys = lists.slice(1).map((list) => new Set(list.map(occurrenceKey)));

  const out: TagOccurrence[] = [];
  const seen = new Set<string>();
  for (const occ of lists[0]!) {
    const key = occurrenceKey(occ);
    if (seen.has(key)) continue;
    let inAll = true;
    for (const required of requiredKeys) {
      if (!required.has(key)) {
        inAll = false;
        break;
      }
    }
    if (inAll) {
      seen.add(key);
      out.push(occ);
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

// ---------------- Canonical URL parsing for intersection pages ----------------

/**
 * Parse the [...slug] catch-all into a canonical tag tuple.
 * Returns:
 *   - { ok: true, tags: [...] } when the slug is one segment ('+'-joined)
 *     containing 1-3 safe slugs in alphabetical order.
 *   - { ok: false } on non-canonical ordering, unsafe slug shape, 4+ way
 *     joins, empty parts, or deep nesting. Page returns 404.
 *
 * Non-canonical orderings (e.g. /tags/b+a/) deliberately do NOT redirect —
 * Astro static can't dynamically redirect, and emitting permutations would
 * double the page count per intersection. Bookmarks to the canonical form
 * (which is what every breadcrumb + chip emits) work; ad-hoc orderings 404.
 */
export type ParsedTagSlug =
  | { ok: true; tags: string[] }
  | { ok: false };

export function parseTagPageSlug(rawSlug: string | string[] | undefined): ParsedTagSlug {
  // Astro [...slug] catch-all delivers either a string (single segment, no
  // slashes) or string[] (when the URL has slashes — which we reject).
  if (rawSlug === undefined) return { ok: false };
  const segment = typeof rawSlug === 'string' ? rawSlug : Array.isArray(rawSlug) && rawSlug.length === 1 ? rawSlug[0]! : null;
  if (segment === null || segment.length === 0) return { ok: false };
  const parts = segment.split('+');
  if (parts.length < 1 || parts.length > 3) return { ok: false };
  // Every part is a complete slug shape.
  for (const p of parts) {
    if (!isSafeTagSlug(p)) return { ok: false };
  }
  // Canonical: alphabetical, no duplicates.
  const sorted = [...parts].sort();
  for (let i = 0; i < parts.length; i++) if (parts[i] !== sorted[i]) return { ok: false };
  for (let i = 1; i < parts.length; i++) if (parts[i] === parts[i - 1]) return { ok: false };
  return { ok: true, tags: parts };
}

// ---------------- Display labels ----------------

/**
 * Resolve a tag slug to its display label + namespace. Single namespace per
 * slug is guaranteed by the build-time uniqueness assertion (assertSlugUniqueness),
 * so a slug found in modality definitions can never also be a verdict slug.
 *
 * Meeting slugs need an occurrence sample to recover the human-readable
 * conference name from `digest.conference.name`; verdict slugs use
 * VERDICT_META; modality/intent/methodology use the static def tables.
 *
 * Returns null when the slug doesn't match any known namespace AND the
 * occurrence list is empty (caller should 404). When occurrences exist but
 * the namespace is unknown, treats it as a meeting fallback and renders the
 * conference name from the first occurrence — defensive against new meeting
 * slugs the curator adds before the static enum.
 */
export type TagDisplay = {
  namespace: TagNamespaceLabel;
  label: string;
  emoji: string | null;
};

export type TagNamespaceLabel = 'modality' | 'intent' | 'methodology' | 'verdict' | 'meeting';

export function resolveTagDisplay(
  slug: string,
  occurrences: readonly TagOccurrence[] = [],
): TagDisplay | null {
  // Static enum lookups first (single Map<slug, def> per namespace).
  const modality = MODALITY_DEFS.find((d) => d.slug === slug);
  if (modality) return { namespace: 'modality', label: modality.label, emoji: null };
  const intent = INTENT_DEFS.find((d) => d.slug === slug);
  if (intent) return { namespace: 'intent', label: intent.label, emoji: null };
  const methodology = METHODOLOGY_DEFS.find((d) => d.slug === slug);
  if (methodology) return { namespace: 'methodology', label: methodology.label, emoji: null };

  // Verdict slugs come from the SocImplication enum. Use hasOwnProperty.call
  // (not `slug in VERDICT_META`) because `in` walks the prototype chain — a
  // slug of 'toString' / 'hasOwnProperty' / '__proto__' would otherwise match
  // and return a prototype function as the verdict meta, rendering the pill
  // with undefined label + emoji.
  if (Object.prototype.hasOwnProperty.call(VERDICT_META, slug)) {
    const meta = VERDICT_META[slug as SocImplication];
    return { namespace: 'verdict', label: meta.label, emoji: meta.emoji };
  }

  // Meeting fallback: pull the conference name from the first occurrence
  // that has a matching conference slug.
  for (const occ of occurrences) {
    if (occ.conference && occ.conference.slug === slug) {
      return { namespace: 'meeting', label: occ.conference.name, emoji: null };
    }
  }

  // Unknown slug AND no occurrence sample — caller should 404.
  return null;
}

// ---------------- Per-study chip + sibling helpers (StudyCard surface) ----------------

/**
 * Tag slugs to render as chips on a StudyCard, in stable order:
 * modality → intent → methodology → verdict → meeting. Disease-site is NOT
 * included — that taxonomy renders via the existing emoji vocabulary on the
 * card head and lives at /sites/, not /tags/.
 *
 * Null-valued namespaces are filtered. Callers (the per-date / per-site / per-
 * tag pages) compose chip rows by iterating this list and linking each slug
 * to /tags/<slug>/.
 */
export function studyTagSlugs(
  study: DigestStudy,
  conferenceSlug: string | null,
): string[] {
  const out: string[] = [];
  if (study.modality && isValidModality(study.modality)) out.push(study.modality);
  if (study.intent && isValidIntent(study.intent)) out.push(study.intent);
  if (study.methodology && isValidMethodology(study.methodology)) out.push(study.methodology);
  if (study.verdict?.soc_implication) out.push(study.verdict.soc_implication);
  if (conferenceSlug) out.push(conferenceSlug);
  return out;
}

/**
 * "Studies like this" preview: a sibling rendered in a card's depth fold.
 * Just the fields the row template needs (no resolved sources, no figures).
 */
export type SiblingPreview = {
  date: string;
  resolvedSlug: string;
  name: string;
  tldr: string;
  verdictEmoji: string | null;
};

/**
 * Pre-computed sibling previews per study. Keyed by studyKeyString. Pages
 * call this ONCE at build time and look up the per-card list from the map;
 * StudyCard reads from its prop, no per-render computation.
 *
 * The map only carries entries for studies that have ≥1 sibling — a card
 * with no siblings omits the footer entirely (no empty "STUDIES LIKE THIS"
 * label).
 */
export function buildSiblingPreviews(
  digests: readonly DigestArtifact[],
): Map<string, SiblingPreview[]> {
  const siblings = computeSiblings(digests);
  type Enriched = { name: string; tldr: string; verdictEmoji: string | null };
  const enriched = new Map<string, Enriched>();
  for (const digest of digests) {
    for (const { study, resolvedSlug } of walkStudiesPerDate(digest)) {
      const verdictMeta = study.verdict?.soc_implication
        ? VERDICT_META[study.verdict.soc_implication]
        : null;
      enriched.set(studyKeyString({ date: digest.date, resolvedSlug }), {
        name: study.name,
        tldr: study.tldr,
        verdictEmoji: verdictMeta?.emoji ?? null,
      });
    }
  }

  const out = new Map<string, SiblingPreview[]>();
  for (const [key, siblingKeys] of siblings) {
    if (siblingKeys.length === 0) continue;
    const previews: SiblingPreview[] = [];
    for (const sk of siblingKeys) {
      const skKey = studyKeyString(sk);
      const info = enriched.get(skKey);
      if (!info) continue; // defensive — siblings derived from same corpus
      previews.push({
        date: sk.date,
        resolvedSlug: sk.resolvedSlug,
        name: info.name,
        tldr: info.tldr,
        verdictEmoji: info.verdictEmoji,
      });
    }
    if (previews.length > 0) out.set(key, previews);
  }
  return out;
}

// Re-export so consumers don't need to import from both tags.ts and tag-index.ts.
export { isSafeTagSlug };
