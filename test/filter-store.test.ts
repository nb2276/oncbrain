// v0.11 PR-2: pure filter-store logic.

import { describe, it, expect } from 'vitest';
import {
  parseDataTagsAttr,
  tokenSlugSet,
  matchesFilter,
  parseFilterUrl,
  buildFilterUrl,
  canonicalForActiveFilters,
  isFilterReceptiveRoute,
} from '../src/lib/filter-store.ts';

describe('parseDataTagsAttr', () => {
  it('parses a multi-token attribute into namespaced tokens', () => {
    const out = parseDataTagsAttr('modality:radiation intent:curative methodology:phase-3-rct');
    expect(out).toEqual([
      { namespace: 'modality', slug: 'radiation' },
      { namespace: 'intent', slug: 'curative' },
      { namespace: 'methodology', slug: 'phase-3-rct' },
    ]);
  });

  it('case-folds both namespace and slug halves', () => {
    const out = parseDataTagsAttr('Modality:Radiation MeETing:ASCO-2026');
    expect(out).toEqual([
      { namespace: 'modality', slug: 'radiation' },
      { namespace: 'meeting', slug: 'asco-2026' },
    ]);
  });

  it('returns empty array for null / undefined / empty input', () => {
    expect(parseDataTagsAttr(null)).toEqual([]);
    expect(parseDataTagsAttr(undefined)).toEqual([]);
    expect(parseDataTagsAttr('')).toEqual([]);
    expect(parseDataTagsAttr('   ')).toEqual([]);
  });

  it('silently drops malformed tokens (no colon, leading colon, trailing colon)', () => {
    const out = parseDataTagsAttr('orphan modality: :radiation modality:radiation');
    expect(out).toEqual([{ namespace: 'modality', slug: 'radiation' }]);
  });

  it('handles arbitrary whitespace between tokens', () => {
    const out = parseDataTagsAttr('  modality:radiation\tintent:curative\n\nmeeting:asco-2026  ');
    expect(out.map((t) => t.slug)).toEqual(['radiation', 'curative', 'asco-2026']);
  });
});

describe('matchesFilter', () => {
  const radPhase3 = new Set(['radiation', 'curative', 'phase-3-rct', 'practice-changing']);

  it('matches every card when filter is empty (no-filter state)', () => {
    expect(matchesFilter(radPhase3, new Set())).toBe(true);
    expect(matchesFilter(new Set(), new Set())).toBe(true);
  });

  it('matches when every active filter slug is present (strict AND)', () => {
    expect(matchesFilter(radPhase3, new Set(['radiation']))).toBe(true);
    expect(matchesFilter(radPhase3, new Set(['radiation', 'phase-3-rct']))).toBe(true);
    expect(matchesFilter(radPhase3, new Set(['practice-changing']))).toBe(true);
  });

  it('does NOT match when any active filter slug is missing', () => {
    expect(matchesFilter(radPhase3, new Set(['surgery']))).toBe(false);
    expect(matchesFilter(radPhase3, new Set(['radiation', 'surgery']))).toBe(false);
    expect(matchesFilter(radPhase3, new Set(['radiation', 'phase-2-trial']))).toBe(false);
  });

  it('a card with no tokens fails any non-empty filter', () => {
    expect(matchesFilter(new Set(), new Set(['radiation']))).toBe(false);
  });
});

describe('parseFilterUrl', () => {
  it('returns the slugs from ?tag=a&tag=b in canonical lowercase set form', () => {
    const url = new URL('https://example.com/?tag=radiation&tag=phase-3-rct');
    const out = parseFilterUrl(url);
    expect(out).toEqual(new Set(['radiation', 'phase-3-rct']));
  });

  it('case-folds mixed-case `?Tag=Radiation`', () => {
    const url = new URL('https://example.com/?Tag=Radiation');
    expect(parseFilterUrl(url)).toEqual(new Set(['radiation']));
  });

  it('dedups duplicate values', () => {
    const url = new URL('https://example.com/?tag=radiation&tag=radiation');
    expect(parseFilterUrl(url)).toEqual(new Set(['radiation']));
  });

  it('returns empty Set for a URL with no `tag` params', () => {
    expect(parseFilterUrl(new URL('https://example.com/'))).toEqual(new Set());
    expect(parseFilterUrl(new URL('https://example.com/?utm_source=tw'))).toEqual(new Set());
  });

  it('silently drops malformed slug shapes (would never match a card)', () => {
    const url = new URL('https://example.com/?tag=Bad+Slug&tag=ALSO BAD&tag=valid-slug');
    expect(parseFilterUrl(url)).toEqual(new Set(['valid-slug']));
  });

  it('ignores `tags` (legacy alias dropped in v0.11 PR-1b)', () => {
    const url = new URL('https://example.com/?tags=radiation');
    expect(parseFilterUrl(url)).toEqual(new Set());
  });
});

describe('buildFilterUrl', () => {
  it('emits sorted ?tag= repeated params for a multi-slug filter', () => {
    const out = buildFilterUrl(
      new URL('https://example.com/sites/breast/'),
      new Set(['phase-3-rct', 'radiation']),
    );
    expect(out.toString()).toBe(
      'https://example.com/sites/breast/?tag=phase-3-rct&tag=radiation',
    );
  });

  it('returns the bare URL when the filter set is empty', () => {
    const out = buildFilterUrl(new URL('https://example.com/?tag=radiation'), new Set());
    expect(out.toString()).toBe('https://example.com/');
  });

  it('strips preexisting `tag` params first', () => {
    const out = buildFilterUrl(
      new URL('https://example.com/?tag=oldslug'),
      new Set(['newslug']),
    );
    expect(out.toString()).toBe('https://example.com/?tag=newslug');
  });

  it('preserves non-filter query params (utm_*, etc.)', () => {
    const out = buildFilterUrl(
      new URL('https://example.com/?utm_source=twitter&tag=oldslug'),
      new Set(['newslug']),
    );
    expect(out.toString()).toBe('https://example.com/?utm_source=twitter&tag=newslug');
  });

  it('does NOT mutate the input URL', () => {
    const input = new URL('https://example.com/?tag=oldslug');
    buildFilterUrl(input, new Set(['newslug']));
    expect(input.toString()).toBe('https://example.com/?tag=oldslug');
  });

  it('strips mixed-case `Tag=` variants too (defense in depth)', () => {
    const out = buildFilterUrl(new URL('https://example.com/?Tag=x&TAG=y'), new Set(['z']));
    expect(out.toString()).toBe('https://example.com/?tag=z');
  });
});

// computeFacetUnionCount tests removed alongside the function — re-add
// in PR-3 or PR-6 when the would-be-count display lands.

describe('canonicalForActiveFilters (PR-5)', () => {
  const allowlist = new Set([
    'curative+radiation',
    'phase-3-rct+radiation',
    'curative+phase-3-rct+radiation',
  ]);
  // Populated single-tag landings (per the namespace map). Codex P1
  // caught the prior version returned bogus slugs as canonical →
  // /tags/<bad>/ → 404. The valid-slug Set closes that gap.
  const validSingles = new Set([
    'radiation',
    'curative',
    'phase-3-rct',
    'surgery',
    'practice-changing',
  ]);

  it('valid single-tag returns the slug unchanged', () => {
    expect(
      canonicalForActiveFilters(new Set(['radiation']), allowlist, validSingles),
    ).toBe('radiation');
    expect(
      canonicalForActiveFilters(new Set(['surgery']), allowlist, validSingles),
    ).toBe('surgery');
  });

  it('INVALID single-tag returns null (no /tags/<bad>/ landing would exist)', () => {
    // Hand-edited URL, stale bookmark, renamed slug, etc. Without
    // gating, the auto-redirect would land the reader on a 404.
    expect(
      canonicalForActiveFilters(new Set(['not-a-real-tag']), allowlist, validSingles),
    ).toBeNull();
    expect(
      canonicalForActiveFilters(new Set(['']), allowlist, validSingles),
    ).toBeNull();
  });

  it('multi-tag set returns the alphabetical canonical when in the allowlist', () => {
    // The active order doesn't matter — canonical is sorted.
    expect(
      canonicalForActiveFilters(
        new Set(['radiation', 'curative']),
        allowlist,
        validSingles,
      ),
    ).toBe('curative+radiation');
    expect(
      canonicalForActiveFilters(
        new Set(['radiation', 'phase-3-rct', 'curative']),
        allowlist,
        validSingles,
      ),
    ).toBe('curative+phase-3-rct+radiation');
  });

  it('multi-tag NOT in the allowlist returns null (below N=3 threshold or 4+ way)', () => {
    expect(
      canonicalForActiveFilters(
        new Set(['radiation', 'surgery']),
        allowlist,
        validSingles,
      ),
    ).toBeNull();
    expect(
      canonicalForActiveFilters(
        new Set(['radiation', 'phase-3-rct', 'surgery']),
        allowlist,
        validSingles,
      ),
    ).toBeNull();
  });

  it('empty active set returns null (no canonical applies)', () => {
    expect(
      canonicalForActiveFilters(new Set(), allowlist, validSingles),
    ).toBeNull();
  });

  it('handles iterable inputs (Set or Array)', () => {
    expect(
      canonicalForActiveFilters(['radiation', 'curative'], allowlist, validSingles),
    ).toBe('curative+radiation');
  });
});

describe('isFilterReceptiveRoute (PR-5)', () => {
  it('returns true for home (/)', () => {
    expect(isFilterReceptiveRoute('/')).toBe(true);
  });

  it('returns true for /tags/<slug>/ landings (single tag)', () => {
    expect(isFilterReceptiveRoute('/tags/radiation/')).toBe(true);
    expect(isFilterReceptiveRoute('/tags/practice-changing/')).toBe(true);
  });

  it('returns true for /tags/<a+b+c>/ intersection landings', () => {
    expect(isFilterReceptiveRoute('/tags/curative+radiation/')).toBe(true);
    expect(
      isFilterReceptiveRoute('/tags/curative+phase-3-rct+radiation/'),
    ).toBe(true);
  });

  it('returns false for /sites/<slug>/ (redirect would drop site scope)', () => {
    expect(isFilterReceptiveRoute('/sites/breast/')).toBe(false);
  });

  it('returns false for /<date>/ pages (redirect would drop date scope)', () => {
    expect(isFilterReceptiveRoute('/2026-05-29/')).toBe(false);
  });

  it('returns false for /tags/ index (no implicit filter scope)', () => {
    expect(isFilterReceptiveRoute('/tags/')).toBe(false);
  });

  it('returns false for /conferences/<slug>/ (out of scope for PR-5)', () => {
    expect(isFilterReceptiveRoute('/conferences/asco-2026/')).toBe(false);
  });

  it('returns false for /about and other content pages', () => {
    expect(isFilterReceptiveRoute('/about/')).toBe(false);
    expect(isFilterReceptiveRoute('/api/')).toBe(false);
  });
});
