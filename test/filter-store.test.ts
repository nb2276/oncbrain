// v0.11 PR-2: pure filter-store logic.

import { describe, it, expect } from 'vitest';
import {
  parseDataTagsAttr,
  tokenSlugSet,
  matchesFilter,
  parseFilterUrl,
  buildFilterUrl,
  computeFacetUnionCount,
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

describe('computeFacetUnionCount', () => {
  // 5 cards, varied tag combinations.
  const cards: ReadonlyArray<ReadonlySet<string>> = [
    new Set(['radiation', 'curative', 'phase-3-rct']),
    new Set(['radiation', 'palliative', 'phase-2-trial']),
    new Set(['surgery', 'curative', 'phase-3-rct']),
    new Set(['radiation', 'curative', 'phase-2-trial']),
    new Set(['systemic', 'palliative', 'phase-3-rct']),
  ];

  it('with empty filter: count is just how many cards have the candidate slug', () => {
    expect(computeFacetUnionCount(cards, new Set(), 'radiation')).toBe(3);
    expect(computeFacetUnionCount(cards, new Set(), 'surgery')).toBe(1);
    expect(computeFacetUnionCount(cards, new Set(), 'phase-3-rct')).toBe(3);
  });

  it('with one active filter: count is cards matching BOTH active AND candidate', () => {
    // Filter active = {phase-3-rct}. Candidate = radiation.
    // Cards with BOTH phase-3-rct AND radiation: index 0 only.
    expect(computeFacetUnionCount(cards, new Set(['phase-3-rct']), 'radiation')).toBe(1);
    // Candidate = surgery (also has phase-3-rct): index 2.
    expect(computeFacetUnionCount(cards, new Set(['phase-3-rct']), 'surgery')).toBe(1);
  });

  it('returns 0 when no card has both the active filters and the candidate', () => {
    // Filter active = {radiation, surgery} — impossible AND combination.
    expect(computeFacetUnionCount(cards, new Set(['radiation', 'surgery']), 'curative')).toBe(0);
  });

  it('returns the current count when the candidate is already in the active filter (no-op extension)', () => {
    // Filter active = {radiation}. Candidate = radiation (no-op).
    // Cards matching: indices 0, 1, 3 (all have radiation).
    expect(computeFacetUnionCount(cards, new Set(['radiation']), 'radiation')).toBe(3);
  });
});
