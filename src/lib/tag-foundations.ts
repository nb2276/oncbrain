// v0.11 PR-1a foundations: small lookup tables inlined on every page so
// the future filter rail (PR-2) and the canonical-URL redirect (PR-5)
// can resolve `?tag=<slug>` and decide canonical destinations without
// shipping the entire tag index or making any network calls.
//
// Two inlined JSON blobs:
//   1. NAMESPACE MAP    — `slug → namespace`, used by URL → checkbox
//                          hydration to know which namespace group to
//                          tick. Versioned so stale cached pages can
//                          detect mismatches and refresh.
//   2. INTERSECTION     — list of EVERY pre-generated `/tags/<a>+<b>/`
//      ALLOWLIST          and `/tags/<a>+<b>+<c>/` URL. PR-5 reads this
//                          to decide whether the active filter state
//                          matches a canonical landing page (auto-
//                          redirect on home + /tags/ routes only) or
//                          stays on the ?tag= query form (everywhere
//                          else).
//
// Both must come from the same digest corpus the build is rendering
// against, so we compute fresh each Astro build run. A module-level
// cache (same pattern as `_siblingPreviewsCache` in tag-index.ts) avoids
// re-walking the corpus per page render — first call reads + computes,
// every subsequent call within the build returns the memoized value.

import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DigestArtifact } from './digest-data.ts';
import {
  listDigestsStrict,
  buildReverseIndex,
  computeIntersections,
  collectMeetingSlugs,
} from './tag-index.ts';
import {
  MODALITY_VALUES,
  INTENT_VALUES,
  METHODOLOGY_VALUES,
  MODALITY_DEFS,
  INTENT_DEFS,
  METHODOLOGY_DEFS,
  isValidModality,
  isValidIntent,
  isValidMethodology,
} from './tags.ts';
import { VERDICT_META } from './verdict.ts';
import type { DigestStudy } from './digest-data.ts';

// Threshold + cap for /tags/<a>+<b>(+<c>)/ landing-page generation.
// EXPORTED so every consumer (this module's allowlist, getStaticPaths
// in src/pages/tags/[...slug].astro, the matching feed.xml endpoint)
// reads from the same source — Codex PR-5 review caught that
// duplicated literals could drift and produce redirect targets or RSS
// links without artifacts. v0.11 PR-6 centralization.
export const INTERSECTION_THRESHOLD = 3;
export const INTERSECTION_PAGE_CAP = 1000;

export type TagNamespace =
  | 'modality'
  | 'intent'
  | 'methodology'
  | 'verdict'
  | 'meeting';

export type NamespaceMap = {
  version: 1;
  map: Record<string, TagNamespace>;
};

export type IntersectionAllowlist = {
  version: 1;
  // Paths in canonical form (alphabetical, no leading/trailing slash) so
  // PR-5 can do an O(1) lookup against the location.pathname after
  // stripping the leading `/tags/` and trailing `/`.
  paths: string[];
};

export function buildNamespaceMap(
  digests: readonly DigestArtifact[],
): NamespaceMap {
  const map: Record<string, TagNamespace> = {};
  for (const slug of MODALITY_VALUES) map[slug] = 'modality';
  for (const slug of INTENT_VALUES) map[slug] = 'intent';
  for (const slug of METHODOLOGY_VALUES) map[slug] = 'methodology';
  for (const slug of Object.keys(VERDICT_META)) map[slug] = 'verdict';
  for (const slug of collectMeetingSlugs(digests)) map[slug] = 'meeting';
  // Disease-site slugs are intentionally NOT included here. The intent
  // enum `supportive` collides with the disease-site slug `supportive`
  // (caught by v0.11 PR-1a test suite); v0.10's assertSlugUniqueness
  // only enforces uniqueness across the 5 /tags/ namespaces above, not
  // against /sites/. Cross-site narrowing is deferred to v0.12+ if/when
  // we extend slug-uniqueness to disease-site (would require renaming
  // one of the collision pairs).
  return { version: 1, map };
}

export function buildIntersectionAllowlist(
  digests: readonly DigestArtifact[],
): IntersectionAllowlist {
  const reverseIndex = buildReverseIndex(digests);
  const intersections = computeIntersections(reverseIndex, {
    maxArity: 3,
    threshold: INTERSECTION_THRESHOLD,
    cap: INTERSECTION_PAGE_CAP,
  });
  const paths = intersections.map((i) => i.tags.join('+'));
  // computeIntersections already returns sorted-canonical pairs; sort the
  // outer list too so the client's exact-match `Set` lookup is order-
  // independent across builds (otherwise the allowlist contents are
  // stable but order is not, and any consumer that hashes the JSON for
  // cache invalidation would see false positives).
  paths.sort();
  return { version: 1, paths };
}

// Module-level cache: first call within a build run computes; subsequent
// calls return the memoized result. `resetTagFoundationsCache()` is
// exported so tests can drive a clean slate.
let _cache: {
  digestsKey: string;
  namespaceMap: NamespaceMap;
  intersectionAllowlist: IntersectionAllowlist;
} | null = null;

export function resetTagFoundationsCache(): void {
  _cache = null;
}

// Cache key: resolved directory path + sorted (filename, mtime, size)
// tuples. Adversarial review (Codex P1) caught the prior filename-only
// key would (a) cross-contaminate two test fixture dirs whose filename
// sets coincide and (b) miss in-place content edits during astro dev.
// Resolving the dir avoids relative-path confusion; mtime + size covers
// both "file added/removed" and "file replaced with same name."
function computeDigestsKey(dir: string): string {
  if (!existsSync(dir)) return `${dir}::`;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const parts = files.map((f) => {
    const st = statSync(resolve(dir, f));
    return `${f}@${st.mtimeMs}:${st.size}`;
  });
  return `${dir}::${parts.join('|')}`;
}

// A digests dir override is allowed for tests; production code passes
// nothing and reads from the default `data/digests/`.
export function tagFoundations(digestsDir?: string): {
  namespaceMap: NamespaceMap;
  intersectionAllowlist: IntersectionAllowlist;
} {
  const dir = resolve(digestsDir ?? resolve(process.cwd(), 'data/digests'));
  const digestsKey = computeDigestsKey(dir);
  if (_cache && _cache.digestsKey === digestsKey) {
    return {
      namespaceMap: _cache.namespaceMap,
      intersectionAllowlist: _cache.intersectionAllowlist,
    };
  }
  const digests = listDigestsStrict(dir);
  const namespaceMap = buildNamespaceMap(digests);
  const intersectionAllowlist = buildIntersectionAllowlist(digests);
  _cache = { digestsKey, namespaceMap, intersectionAllowlist };
  return { namespaceMap, intersectionAllowlist };
}

// Direct readers (bypass cache) for test ergonomics and for the Astro
// integration's pre-build hook which must run BEFORE the page render
// path warms the cache.
export function readDigestsForFoundations(
  digestsDir?: string,
): DigestArtifact[] {
  const dir = digestsDir ?? resolve(process.cwd(), 'data/digests');
  return listDigestsStrict(dir);
}

// ---------------- PR-2 filter rail option builder ----------------

export type FilterStudyContext = {
  study: DigestStudy;
  conferenceSlug: string | null;
  conferenceLabel: string | null;
};

export type FilterTagOption = {
  slug: string;
  label: string;
  count: number;
};

export type FilterRailOptions = {
  modality: FilterTagOption[];
  intent: FilterTagOption[];
  methodology: FilterTagOption[];
  verdict: FilterTagOption[];
  meeting: FilterTagOption[];
};

const MODALITY_LABEL_BY_SLUG: Record<string, string> = Object.fromEntries(
  MODALITY_DEFS.map((d) => [d.slug, d.label]),
);
const INTENT_LABEL_BY_SLUG: Record<string, string> = Object.fromEntries(
  INTENT_DEFS.map((d) => [d.slug, d.label]),
);
const METHODOLOGY_LABEL_BY_SLUG: Record<string, string> = Object.fromEntries(
  METHODOLOGY_DEFS.map((d) => [d.slug, d.label]),
);

/**
 * Build the per-namespace option arrays the TagFilterRail component
 * consumes. Each entry counts the number of studies on the CURRENT
 * PAGE (not the corpus) that carry that tag — so the rail never offers
 * a zero-count checkbox the reader can never satisfy.
 *
 * The returned arrays are sorted by count desc, then slug asc, so the
 * most populous tags surface first within each namespace.
 *
 * Disease-site is intentionally NOT in the output — see
 * buildNamespaceMap header for the supportive-collision rationale.
 */
export function buildFilterRailOptions(
  studies: ReadonlyArray<FilterStudyContext>,
): FilterRailOptions {
  const modality = new Map<string, FilterTagOption>();
  const intent = new Map<string, FilterTagOption>();
  const methodology = new Map<string, FilterTagOption>();
  const verdict = new Map<string, FilterTagOption>();
  const meeting = new Map<string, FilterTagOption>();

  const bump = (
    bucket: Map<string, FilterTagOption>,
    slug: string,
    label: string,
  ): void => {
    const existing = bucket.get(slug);
    if (existing) {
      existing.count += 1;
    } else {
      bucket.set(slug, { slug, label, count: 1 });
    }
  };

  for (const { study, conferenceSlug, conferenceLabel } of studies) {
    if (study.modality && isValidModality(study.modality)) {
      bump(
        modality,
        study.modality,
        MODALITY_LABEL_BY_SLUG[study.modality] ?? study.modality,
      );
    }
    if (study.intent && isValidIntent(study.intent)) {
      bump(intent, study.intent, INTENT_LABEL_BY_SLUG[study.intent] ?? study.intent);
    }
    if (study.methodology && isValidMethodology(study.methodology)) {
      bump(
        methodology,
        study.methodology,
        METHODOLOGY_LABEL_BY_SLUG[study.methodology] ?? study.methodology,
      );
    }
    const verdictSlug = study.verdict?.soc_implication;
    if (
      verdictSlug &&
      Object.prototype.hasOwnProperty.call(VERDICT_META, verdictSlug)
    ) {
      bump(
        verdict,
        verdictSlug,
        VERDICT_META[verdictSlug as keyof typeof VERDICT_META].label,
      );
    }
    if (conferenceSlug) {
      bump(meeting, conferenceSlug, conferenceLabel ?? conferenceSlug);
    }
  }

  const sortOptions = (m: Map<string, FilterTagOption>): FilterTagOption[] =>
    Array.from(m.values()).sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : a.slug < b.slug
          ? -1
          : a.slug > b.slug
            ? 1
            : 0,
    );

  return {
    modality: sortOptions(modality),
    intent: sortOptions(intent),
    methodology: sortOptions(methodology),
    verdict: sortOptions(verdict),
    meeting: sortOptions(meeting),
  };
}

