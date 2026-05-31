// v0.11 PR-2: pure functions powering the client-side filter rail.
//
// The Astro component (TagFilterRail.astro) renders the SSR checkbox
// tree; an inlined client-side script wires `change` / `popstate` /
// `pageshow` event handlers. All of the logic that decides "does this
// card match the current filter?" lives here so it's unit-testable in
// Node (vitest is node-only; DOM integration is PR-6's Playwright job).
//
// Semantics (per the autoplan revisions to the v0.11 plan):
//   - Strict AND across every active filter slug — no intra-namespace
//     OR (Codex pass-2 caught that it broke the canonical-URL strategy).
//   - URL form: repeated `?tag=<slug>` with slug-only values. v0.10's
//     global slug-uniqueness assertion guarantees no namespace
//     ambiguity at the URL boundary.
//   - Case-folded reads: `?Tag=...`, `?TAG=...`, etc. all normalize to
//     lowercase. The matcher only emits lowercase.
//   - Empty data-tags / missing attribute → card is ALWAYS visible
//     regardless of filter state. An untagged card was never
//     categorized; hiding it would silently drop content from the
//     reader's view. Pinned by test/study-data-tags.test.ts.

export type FilterToken = { namespace: string; slug: string };

/**
 * Parse a `data-tags="namespace:slug ..."` attribute string into
 * tokens. Defensive: trims whitespace, drops malformed tokens
 * (no colon), and lowercases both halves. Returns an empty array for
 * empty input — never throws.
 */
export function parseDataTagsAttr(attr: string | null | undefined): FilterToken[] {
  if (!attr) return [];
  const out: FilterToken[] = [];
  for (const raw of attr.split(/\s+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0 || colon === trimmed.length - 1) continue;
    const namespace = trimmed.slice(0, colon).toLowerCase();
    const slug = trimmed.slice(colon + 1).toLowerCase();
    if (!namespace || !slug) continue;
    out.push({ namespace, slug });
  }
  return out;
}

/**
 * Just the slug halves of `parseDataTagsAttr(attr)` as a Set. Used by
 * matchesFilter for O(1) lookup during the strict-AND check.
 */
export function tokenSlugSet(tokens: readonly FilterToken[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) out.add(t.slug);
  return out;
}

/**
 * Strict AND match: returns true iff every active filter slug appears
 * in the card's slug set. An empty filter set (no filters active)
 * matches every card. A card with no tokens — empty `Set` — is hidden
 * by the filter when ANY filter is active; the OUTER decision of
 * "should a card without a data-tags attribute render at all?" is
 * separate (see filter-store.ts header), and is the caller's job.
 */
export function matchesFilter(
  cardSlugs: ReadonlySet<string>,
  filterSlugs: ReadonlySet<string>,
): boolean {
  if (filterSlugs.size === 0) return true;
  for (const slug of filterSlugs) {
    if (!cardSlugs.has(slug)) return false;
  }
  return true;
}

/**
 * Read the active filter slugs from a URL's `tag` query params,
 * case-folded, deduped, with no preserved order. Multiple `?tag=a&tag=a`
 * collapse to one entry; mixed-case `?Tag=...` normalizes. Values that
 * fail `isSafeTagSlug` shape (anything outside `[a-z0-9-]+`) are
 * silently dropped — a malformed slug can't match any card by
 * construction. Returns an empty Set for URLs with no `tag` params.
 */
export function parseFilterUrl(url: URL): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() !== 'tag') continue;
    const slug = value.trim().toLowerCase();
    if (!slug) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) continue;
    out.add(slug);
  }
  return out;
}

/**
 * Build a canonical filter URL by appending `tag=<slug>` params
 * alphabetically. Mutates a clone of `baseUrl`; original is not
 * touched. Strips any preexisting `tag` params first so the result
 * is deterministic regardless of the caller's history-state shape.
 * When `filterSlugs` is empty, returns the bare URL (no `?` artifact).
 */
export function buildFilterUrl(
  baseUrl: URL,
  filterSlugs: ReadonlySet<string> | ReadonlyArray<string>,
): URL {
  const out = new URL(baseUrl.toString());
  // Snapshot keys before mutation: URLSearchParams.delete() removes ALL
  // entries with that name in one shot, but we want to drop both `tag`
  // and any mixed-case variant a third party stuck in here.
  const keys = Array.from(new Set(Array.from(out.searchParams.keys())));
  for (const key of keys) {
    if (key.toLowerCase() === 'tag') out.searchParams.delete(key);
  }
  const sorted = [...filterSlugs].sort();
  for (const slug of sorted) {
    out.searchParams.append('tag', slug);
  }
  return out;
}

/**
 * Facet count math: "what would the visible-card count be if this
 * candidate tag were added to the active filter set?" Used by the
 * filter rail to display would-be counts on unchecked checkboxes
 * (per the autoplan revision's facet count semantics decision).
 *
 * For CHECKED facets (slug already in filterSlugs), the caller passes
 * the current visible count directly — no math needed.
 *
 * For UNCHECKED facets, this returns count(cards that match
 * filterSlugs ∪ {candidate}). Always ≤ current visible count because
 * AND can only narrow.
 *
 * Implementation: pure, O(N × F) where N = cards on page, F = active
 * filters. Sub-millisecond on 41 cards × ~5 tokens × 0-5 filters.
 */
export function computeFacetUnionCount(
  cardSlugSets: ReadonlyArray<ReadonlySet<string>>,
  filterSlugs: ReadonlySet<string>,
  candidateSlug: string,
): number {
  let count = 0;
  for (const card of cardSlugSets) {
    if (!card.has(candidateSlug)) continue;
    let allMatched = true;
    for (const slug of filterSlugs) {
      if (!card.has(slug)) {
        allMatched = false;
        break;
      }
    }
    if (allMatched) count++;
  }
  return count;
}
