import { describe, it, expect } from 'vitest';
import {
  isArchivePage,
  isHome,
  isSearchIndex,
  NAV_FALLBACK_DENYLIST,
  latestDigestDateFromFiles,
  hasOnlyFilterParams,
  stripFilterParams,
} from '../src/lib/pwa-routes.ts';

describe('isArchivePage', () => {
  it('matches dated digest pages (with and without trailing slash)', () => {
    expect(isArchivePage('/2026-05-17/')).toBe(true);
    expect(isArchivePage('/2026-05-17')).toBe(true);
  });

  it('matches the /studies full index (v0.14 T3, with and without trailing slash)', () => {
    expect(isArchivePage('/studies/')).toBe(true);
    expect(isArchivePage('/studies')).toBe(true);
    // but not a deeper or look-alike path
    expect(isArchivePage('/studies/extra/')).toBe(false);
    expect(isArchivePage('/studies-x/')).toBe(false);
  });

  it('matches per-site detail pages', () => {
    expect(isArchivePage('/sites/breast/')).toBe(true);
    expect(isArchivePage('/sites/prostate')).toBe(true);
  });

  it('matches per-conference detail pages', () => {
    expect(isArchivePage('/conferences/asco-2026/')).toBe(true);
  });

  it('v0.10: matches per-tag landing pages (single tag)', () => {
    expect(isArchivePage('/tags/radiation/')).toBe(true);
    expect(isArchivePage('/tags/palliative')).toBe(true);
    expect(isArchivePage('/tags/phase-3-rct/')).toBe(true);
  });

  it('v0.10: matches intersection pages (2-way + 3-way join with +)', () => {
    // /tags/radiation+palliative/ — 2-way intersection
    expect(isArchivePage('/tags/radiation+palliative/')).toBe(true);
    // /tags/confirmatory+palliative+radiation/ — 3-way intersection
    expect(isArchivePage('/tags/confirmatory+palliative+radiation/')).toBe(true);
  });

  it('v0.10: REJECTS unsafe tag URLs (querystring, fragments, uppercase, 4-way, encoded slash, deep nesting)', () => {
    // 4-way intersection over plan cap of 3
    expect(isArchivePage('/tags/a+b+c+d/')).toBe(false);
    // Querystring smuggled in
    expect(isArchivePage('/tags/foo?utm=evil/')).toBe(false);
    expect(isArchivePage('/tags/foo?x=y')).toBe(false);
    // Fragment
    expect(isArchivePage('/tags/foo#frag')).toBe(false);
    // Uppercase (slugs are lowercase by contract)
    expect(isArchivePage('/tags/Radiation/')).toBe(false);
    expect(isArchivePage('/tags/RT/')).toBe(false);
    // %2F-encoded slash
    expect(isArchivePage('/tags/foo%2Fbar/')).toBe(false);
    // Deep nesting beyond a single segment
    expect(isArchivePage('/tags/foo/bar/')).toBe(false);
    // Empty join sides
    expect(isArchivePage('/tags/+/')).toBe(false);
    expect(isArchivePage('/tags/foo+/')).toBe(false);
    expect(isArchivePage('/tags/+foo/')).toBe(false);
    // Spaces, dots
    expect(isArchivePage('/tags/foo bar/')).toBe(false);
    expect(isArchivePage('/tags/.../')).toBe(false);
  });

  it('does NOT match the shell: home, about, sites index, tags index', () => {
    expect(isArchivePage('/')).toBe(false);
    expect(isArchivePage('/about/')).toBe(false);
    expect(isArchivePage('/sites/')).toBe(false);
    expect(isArchivePage('/sites')).toBe(false);
    expect(isArchivePage('/conferences/')).toBe(false);
    // v0.10: bare /tags/ is the shell index page (precached), not an archive
    expect(isArchivePage('/tags/')).toBe(false);
    expect(isArchivePage('/tags')).toBe(false);
  });

  it('does NOT match the API, feed, or search index', () => {
    expect(isArchivePage('/api/v1/digests.json')).toBe(false);
    expect(isArchivePage('/feed.xml')).toBe(false);
    expect(isArchivePage('/search-index.json')).toBe(false);
  });

  it('does NOT match a malformed date or deeper nesting', () => {
    expect(isArchivePage('/2026-5-1/')).toBe(false);
    expect(isArchivePage('/sites/breast/extra/')).toBe(false);
    expect(isArchivePage('/2026-05-17/study/')).toBe(false);
  });
});

describe('isHome', () => {
  it('matches root and index.html, nothing else', () => {
    expect(isHome('/')).toBe(true);
    expect(isHome('/index.html')).toBe(true);
    expect(isHome('/about/')).toBe(false);
    expect(isHome('/2026-05-17/')).toBe(false);
  });
});

describe('isSearchIndex', () => {
  it('matches only the search index path', () => {
    expect(isSearchIndex('/search-index.json')).toBe(true);
    expect(isSearchIndex('/api/v1/digests.json')).toBe(false);
  });
});

describe('NAV_FALLBACK_DENYLIST', () => {
  const denied = (p: string) => NAV_FALLBACK_DENYLIST.some((re) => re.test(p));

  it('denies API, feed, and slide paths from the navigation fallback', () => {
    expect(denied('/api/v1/digest/2026-05-17.json')).toBe(true);
    expect(denied('/feed.xml')).toBe(true);
    expect(denied('/slides/2026-05-17/abc.jpg')).toBe(true);
  });

  it('denies asset requests carrying a file extension', () => {
    expect(denied('/_astro/index.abc123.css')).toBe(true);
    expect(denied('/favicon.svg')).toBe(true);
  });

  it('allows real navigations (digests, sites, home) through to the fallback', () => {
    expect(denied('/2026-05-17/')).toBe(false);
    expect(denied('/sites/breast/')).toBe(false);
    expect(denied('/')).toBe(false);
  });
});

describe('latestDigestDateFromFiles', () => {
  it('returns the newest dated digest filename', () => {
    expect(
      latestDigestDateFromFiles(['2026-05-17.json', '2026-05-21.json', '2026-05-19.json']),
    ).toBe('2026-05-21');
  });

  it('ignores non-digest files', () => {
    expect(
      latestDigestDateFromFiles(['.DS_Store', 'README.md', '2026-05-17.json', 'notes.json']),
    ).toBe('2026-05-17');
  });

  it('returns null when there are no dated digests', () => {
    expect(latestDigestDateFromFiles([])).toBe(null);
    expect(latestDigestDateFromFiles(['index.json', 'foo.txt'])).toBe(null);
  });
});

// v0.11 PR-1b: SW filter-param normalization. These two helpers gate
// the cache strategy: hasOnlyFilterParams decides what gets routed to
// the SW cache; stripFilterParams normalizes the cache key so variants
// share one entry. Both are pure and unit-tested here; integration into
// pwa-sw.ts is verified by the Astro build emitting a valid SW bundle.

describe('hasOnlyFilterParams', () => {
  it('accepts URLs with no query params', () => {
    expect(hasOnlyFilterParams(new URL('https://example.com/sites/breast/'))).toBe(true);
  });

  it('accepts URLs with a single `tag` param', () => {
    expect(hasOnlyFilterParams(new URL('https://example.com/?tag=radiation'))).toBe(true);
  });

  it('accepts URLs with repeated `tag` params (the canonical form for multi-tag filter)', () => {
    expect(
      hasOnlyFilterParams(new URL('https://example.com/?tag=radiation&tag=phase-3-rct')),
    ).toBe(true);
  });

  it('rejects legacy `tags` param (v0.11 standardized on repeated `tag=` only)', () => {
    // No v0.11 surface emits `?tags=`; if a future redirect is needed,
    // re-add then with the redirect handler.
    expect(
      hasOnlyFilterParams(new URL('https://example.com/?tags=radiation+phase-3-rct')),
    ).toBe(false);
  });

  it('accepts mixed-case TAG / Tag / TaG / tAG (case-folded, defense-in-depth)', () => {
    expect(hasOnlyFilterParams(new URL('https://example.com/?TAG=radiation'))).toBe(true);
    expect(hasOnlyFilterParams(new URL('https://example.com/?Tag=radiation'))).toBe(true);
    expect(hasOnlyFilterParams(new URL('https://example.com/?TaG=radiation'))).toBe(true);
    expect(hasOnlyFilterParams(new URL('https://example.com/?tAG=radiation'))).toBe(true);
  });

  it('rejects URLs with utm_* tracking params (fall through to network)', () => {
    expect(
      hasOnlyFilterParams(new URL('https://example.com/?utm_source=twitter')),
    ).toBe(false);
  });

  it('rejects URLs that mix filter + tracking params', () => {
    expect(
      hasOnlyFilterParams(
        new URL('https://example.com/?tag=radiation&utm_source=twitter'),
      ),
    ).toBe(false);
  });

  it('rejects URLs with gclid / fbclid / any other non-filter key', () => {
    expect(hasOnlyFilterParams(new URL('https://example.com/?gclid=abc'))).toBe(false);
    expect(hasOnlyFilterParams(new URL('https://example.com/?fbclid=xyz'))).toBe(false);
    expect(hasOnlyFilterParams(new URL('https://example.com/?ref=hn'))).toBe(false);
  });
});

describe('stripFilterParams', () => {
  it('strips a single `tag` param, returning the bare path URL', () => {
    const out = stripFilterParams(new URL('https://example.com/sites/breast/?tag=radiation'));
    expect(out.toString()).toBe('https://example.com/sites/breast/');
  });

  it('strips all instances of repeated `tag` params (canonical multi-tag form)', () => {
    const out = stripFilterParams(
      new URL('https://example.com/?tag=radiation&tag=phase-3-rct&tag=curative'),
    );
    expect(out.toString()).toBe('https://example.com/');
  });

  it('does NOT strip legacy `tags` param (kept distinct from `tag` per v0.11 URL spec)', () => {
    const out = stripFilterParams(
      new URL('https://example.com/?tag=radiation&tags=phase-3-rct'),
    );
    expect(out.toString()).toBe('https://example.com/?tags=phase-3-rct');
  });

  it('strips mixed-case TAG / Tag / TaG (case-folded)', () => {
    expect(stripFilterParams(new URL('https://example.com/?TAG=Radiation')).toString()).toBe(
      'https://example.com/',
    );
    expect(stripFilterParams(new URL('https://example.com/?Tag=Radiation')).toString()).toBe(
      'https://example.com/',
    );
    expect(stripFilterParams(new URL('https://example.com/?TaG=Radiation')).toString()).toBe(
      'https://example.com/',
    );
  });

  it('strips duplicate-value `tag` params (?tag=foo&tag=foo)', () => {
    // URLSearchParams.delete() removes all entries with that name in one
    // shot — pin the contract so a future runtime change can't regress.
    const out = stripFilterParams(new URL('https://example.com/?tag=foo&tag=foo'));
    expect(out.toString()).toBe('https://example.com/');
  });

  it('removes the trailing `?` artifact when the only param was stripped', () => {
    // PR-2 URL-share code will compare cache-key strings; this exact
    // form (no trailing `?`) is the contract.
    const out = stripFilterParams(new URL('https://example.com/sites/breast/?tag=radiation'));
    expect(out.toString()).toBe('https://example.com/sites/breast/');
    expect(out.search).toBe('');
  });

  it('does NOT touch utm_* or other non-filter params', () => {
    const out = stripFilterParams(
      new URL('https://example.com/?tag=radiation&utm_source=twitter'),
    );
    expect(out.toString()).toBe('https://example.com/?utm_source=twitter');
  });

  it('preserves the hash fragment', () => {
    const out = stripFilterParams(
      new URL('https://example.com/2026-05-17/?tag=radiation#senomac'),
    );
    expect(out.toString()).toBe('https://example.com/2026-05-17/#senomac');
  });

  it('returns a NEW URL object — does not mutate input', () => {
    const input = new URL('https://example.com/?tag=radiation');
    const out = stripFilterParams(input);
    expect(input.search).toBe('?tag=radiation'); // input untouched
    expect(out.search).toBe(''); // output stripped
    expect(out).not.toBe(input);
  });

  it('is idempotent — strip twice yields the same URL', () => {
    const once = stripFilterParams(new URL('https://example.com/?tag=radiation'));
    const twice = stripFilterParams(once);
    expect(twice.toString()).toBe(once.toString());
  });
});
