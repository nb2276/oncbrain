import { describe, it, expect } from 'vitest';
import {
  isArchivePage,
  isHome,
  isSearchIndex,
  NAV_FALLBACK_DENYLIST,
  latestDigestDateFromFiles,
} from '../src/lib/pwa-routes.ts';

describe('isArchivePage', () => {
  it('matches dated digest pages (with and without trailing slash)', () => {
    expect(isArchivePage('/2026-05-17/')).toBe(true);
    expect(isArchivePage('/2026-05-17')).toBe(true);
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
