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

import { readdirSync, existsSync } from 'node:fs';
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
} from './tags.ts';
import { VERDICT_META } from './verdict.ts';

// Must agree with the threshold + cap baked into
// `src/pages/tags/[...slug].astro:getStaticPaths` — the allowlist must
// list exactly the URLs the build actually generated. If those change,
// update both call sites in lockstep.
const INTERSECTION_THRESHOLD = 3;
const INTERSECTION_PAGE_CAP = 1000;

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

// Lightweight cache key: the sorted-joined digest filenames currently
// on disk. If the file set hasn't changed since the last call within
// this build, return the cached value. A digests dir override is
// allowed for tests; production code passes nothing and reads from the
// default `data/digests/`.
export function tagFoundations(digestsDir?: string): {
  namespaceMap: NamespaceMap;
  intersectionAllowlist: IntersectionAllowlist;
} {
  const dir = digestsDir ?? resolve(process.cwd(), 'data/digests');
  const filesKey = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .join('|')
    : '';
  if (_cache && _cache.digestsKey === filesKey) {
    return {
      namespaceMap: _cache.namespaceMap,
      intersectionAllowlist: _cache.intersectionAllowlist,
    };
  }
  const digests = listDigestsStrict(dir);
  const namespaceMap = buildNamespaceMap(digests);
  const intersectionAllowlist = buildIntersectionAllowlist(digests);
  _cache = { digestsKey: filesKey, namespaceMap, intersectionAllowlist };
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

