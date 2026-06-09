import { describe, it, expect } from 'vitest';
import {
  classifyPaperTarget,
  extractPaperUrls,
  firstDoiInUrl,
  isTradePressUrl,
  tradePressLabel,
  tradePressOutletNames,
  canonicalizeTradeUrl,
  urlPathOnly,
} from '../src/lib/paper-url.ts';

describe('classifyPaperTarget', () => {
  it('bare digits → pmid', () => {
    expect(classifyPaperTarget('42144018')).toEqual({ kind: 'pmid', value: '42144018' });
  });
  it('pubmed URL → pmid', () => {
    expect(classifyPaperTarget('https://pubmed.ncbi.nlm.nih.gov/42144018/')).toEqual({
      kind: 'pmid',
      value: '42144018',
    });
  });
  it('PMC URL (legacy host) → pmc', () => {
    expect(classifyPaperTarget('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9876543/')).toEqual({
      kind: 'pmc',
      value: 'PMC9876543',
    });
  });
  it('PMC URL (current pmc.ncbi host) → pmc', () => {
    expect(classifyPaperTarget('https://pmc.ncbi.nlm.nih.gov/articles/PMC10326730/')).toEqual({
      kind: 'pmc',
      value: 'PMC10326730',
    });
  });
  it('doi.org URL → normalized doi', () => {
    expect(classifyPaperTarget('https://doi.org/10.1056/NEJMoa2024001')).toEqual({
      kind: 'doi',
      value: '10.1056/nejmoa2024001',
    });
  });
  it('bare DOI → normalized doi', () => {
    expect(classifyPaperTarget('10.1016/S1470-2045(26)00091-4')).toEqual({
      kind: 'doi',
      value: '10.1016/s1470-2045(26)00091-4',
    });
  });
  it('journal URL → url (needs fetch)', () => {
    const r = classifyPaperTarget('https://www.thelancet.com/journals/lanonc/article/PIIS1470/fulltext');
    expect(r?.kind).toBe('url');
  });
  it('rejects a tweet URL', () => {
    expect(classifyPaperTarget('https://x.com/foo/status/123')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(classifyPaperTarget('hello world')).toBeNull();
  });
});

describe('firstDoiInUrl', () => {
  it('extracts a DOI from a Wiley /doi/ path', () => {
    expect(firstDoiInUrl('https://onlinelibrary.wiley.com/doi/10.3322/caac.70082')).toBe(
      '10.3322/caac.70082',
    );
  });
  it('extracts a DOI from an ASCO /doi/full/ path', () => {
    expect(firstDoiInUrl('https://ascopubs.org/doi/full/10.1200/JCO.23.01234')).toBe(
      '10.1200/jco.23.01234',
    );
  });
  it('extracts a DOI from a Springer /article/ path', () => {
    expect(firstDoiInUrl('https://link.springer.com/article/10.1007/s00330-024-10001')).toBe(
      '10.1007/s00330-024-10001',
    );
  });
  it('trims a trailing publisher token after the DOI', () => {
    expect(firstDoiInUrl('https://onlinelibrary.wiley.com/doi/10.1002/cncr.34567/pdf')).toBe(
      '10.1002/cncr.34567',
    );
  });
  it('ignores a query string after the DOI', () => {
    expect(firstDoiInUrl('https://ahajournals.org/doi/10.1161/CIR.0000000000001?af=R')).toBe(
      '10.1161/cir.0000000000001',
    );
  });
  it('decodes a %2F-encoded DOI path', () => {
    expect(firstDoiInUrl('https://onlinelibrary.wiley.com/doi/10.1002%2Fcncr.34567')).toBe(
      '10.1002/cncr.34567',
    );
  });
  it('does not pull a DOI out of a query parameter', () => {
    // firstDoiInUrl only inspects the path; a related-DOI query param is ignored.
    expect(firstDoiInUrl('https://www.sciencedirect.com/science/article/pii/S123?ref=10.1056/x')).toBeNull();
  });
  it('returns null for a PII URL with no DOI (Elsevier/ScienceDirect)', () => {
    expect(
      firstDoiInUrl('https://www.sciencedirect.com/science/article/abs/pii/S0360301625058948'),
    ).toBeNull();
  });
  it('returns null for a Nature article-id URL (DOI not in path)', () => {
    expect(firstDoiInUrl('https://www.nature.com/articles/s41586-024-00001-2')).toBeNull();
  });
});

describe('extractPaperUrls', () => {
  it('pulls a DOI URL', () => {
    expect(extractPaperUrls('great paper https://doi.org/10.1056/NEJMoa1 worth a read')).toEqual([
      'https://doi.org/10.1056/NEJMoa1',
    ]);
  });
  it('pulls a journal URL', () => {
    const urls = extractPaperUrls('https://www.nejm.org/doi/full/10.1056/NEJMoa2024001');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('nejm.org');
  });
  it('pulls a PMC URL (legacy host)', () => {
    expect(extractPaperUrls('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/')).toHaveLength(1);
  });
  it('pulls a PMC URL (current pmc.ncbi host)', () => {
    expect(extractPaperUrls('https://pmc.ncbi.nlm.nih.gov/articles/PMC10326730/')).toHaveLength(1);
  });
  it('skips pubmed URLs (handled by extractPaperPmids)', () => {
    expect(extractPaperUrls('https://pubmed.ncbi.nlm.nih.gov/42144018/')).toEqual([]);
  });
  it('skips tweet/youtube/non-paper hosts', () => {
    expect(extractPaperUrls('https://x.com/a/status/1 and https://youtube.com/watch?v=x')).toEqual([]);
  });
  it('trims trailing punctuation off the URL', () => {
    const urls = extractPaperUrls('see https://doi.org/10.1056/NEJMoa1.');
    expect(urls[0]).toBe('https://doi.org/10.1056/NEJMoa1');
  });
  it('reads URLs from entities (text_link)', () => {
    const urls = extractPaperUrls('click here', [
      { type: 'text_link', url: 'https://www.thelancet.com/article/x/fulltext' },
    ]);
    expect(urls).toHaveLength(1);
  });
  it('returns empty for no paper URLs', () => {
    expect(extractPaperUrls('just a note, no links')).toEqual([]);
  });

  it('pulls a trade-press URL (ASCO Post)', () => {
    const urls = extractPaperUrls(
      'big readout https://ascopost.com/issues/june-10-2026/some-trial-readout/',
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('ascopost.com');
  });
  it('pulls trade-press URLs from UroToday and OncLive', () => {
    const urls = extractPaperUrls(
      'https://www.urotoday.com/conference-highlights/asco-2026/x.html and https://www.onclive.com/view/y',
    );
    expect(urls).toHaveLength(2);
  });
  it('pulls an ASCO Daily News URL (dailynews.ascopubs.org subdomain)', () => {
    expect(extractPaperUrls('https://dailynews.ascopubs.org/do/some-coverage')).toHaveLength(1);
  });
});

describe('isTradePressUrl', () => {
  it.each([
    'https://ascopost.com/issues/june-10-2026/x/',
    'https://www.ascopost.com/news/y',
    'https://www.urotoday.com/conference-highlights/z.html',
    'https://www.onclive.com/view/a',
    'https://www.targetedonc.com/view/b',
    'https://www.cancernetwork.com/view/c',
    'https://www.healio.com/news/hematology-oncology/d',
    'https://www.medpagetoday.com/hematologyoncology/e',
    'https://oncodaily.com/f',
    'https://dailynews.ascopubs.org/do/g',
  ])('matches %s', (url) => {
    expect(isTradePressUrl(url)).toBe(true);
  });
  it('does not match journal or social hosts', () => {
    expect(isTradePressUrl('https://www.nejm.org/doi/full/10.1056/NEJMoa1')).toBe(false);
    expect(isTradePressUrl('https://ascopubs.org/doi/10.1200/JCO.1')).toBe(false);
    expect(isTradePressUrl('https://x.com/foo/status/123')).toBe(false);
  });
  it('rejects a host that merely SUFFIXES a trade host (spoof guard)', () => {
    // The attacker host ends with "ascopost.com." — an exact-hostname check must
    // not treat this as The ASCO Post.
    expect(isTradePressUrl('https://ascopost.com.attacker.example/article')).toBe(false);
    expect(tradePressLabel('https://ascopost.com.attacker.example/article')).toBeNull();
    expect(isTradePressUrl('https://notascopost.com/article')).toBe(false);
    expect(isTradePressUrl('https://ascopost.com.evil/x')).toBe(false);
  });
  it('classifyPaperTarget routes a trade URL to the fetch path', () => {
    expect(classifyPaperTarget('https://ascopost.com/issues/june-10-2026/x/')?.kind).toBe('url');
  });
});

describe('tradePressLabel', () => {
  it.each([
    ['https://ascopost.com/issues/june-10-2026/x/', 'The ASCO Post'],
    ['https://www.urotoday.com/conference-highlights/z.html', 'UroToday'],
    ['https://www.onclive.com/view/a', 'OncLive'],
    ['https://www.targetedonc.com/view/b', 'Targeted Oncology'],
    ['https://www.cancernetwork.com/view/c', 'Cancer Network'],
    ['https://www.healio.com/news/hematology-oncology/d', 'Healio'],
    ['https://www.medpagetoday.com/hematologyoncology/e', 'MedPage Today'],
    ['https://oncodaily.com/f', 'OncoDaily'],
    ['https://dailynews.ascopubs.org/do/g', 'ASCO Daily News'],
  ])('labels %s → %s', (url, label) => {
    expect(tradePressLabel(url)).toBe(label);
  });
  it('returns null for a non-trade host', () => {
    expect(tradePressLabel('https://www.nejm.org/doi/full/10.1056/NEJMoa1')).toBeNull();
    expect(tradePressLabel('https://x.com/foo/status/123')).toBeNull();
  });
});

describe('tradePressOutletNames', () => {
  it('returns the display names for the reply text, drawn from the same table', () => {
    const names = tradePressOutletNames();
    expect(names).toContain('The ASCO Post');
    expect(names).toContain('OncLive');
    expect(names).toContain('ASCO Daily News');
    // Every host that isTradePressUrl accepts must be represented (no drift).
    expect(names.length).toBe(9);
  });
});

describe('urlPathOnly', () => {
  it('strips query and fragment', () => {
    expect(urlPathOnly('https://x.org/a/b?utm=1#frag')).toBe('https://x.org/a/b');
  });
  it('is a no-op when there is no query/fragment', () => {
    expect(urlPathOnly('https://x.org/a/b')).toBe('https://x.org/a/b');
  });
});

describe('canonicalizeTradeUrl', () => {
  it('collapses utm / trailing-slash / www / scheme variants to one key', () => {
    const canonical = 'https://urotoday.com/conference-highlights/asco-2026/aranote.html';
    expect(canonicalizeTradeUrl('https://www.urotoday.com/conference-highlights/asco-2026/aranote.html?utm_source=tw')).toBe(canonical);
    expect(canonicalizeTradeUrl('http://www.urotoday.com/conference-highlights/asco-2026/aranote.html/')).toBe(canonical);
    expect(canonicalizeTradeUrl('https://urotoday.com/conference-highlights/asco-2026/aranote.html#top')).toBe(canonical);
  });
  it('preserves path case (case-sensitive CMS slugs must not collide)', () => {
    expect(canonicalizeTradeUrl('https://ascopost.com/Issues/Trial-X/')).toBe(
      'https://ascopost.com/Issues/Trial-X',
    );
  });
  it('keeps genuinely different paths distinct', () => {
    expect(canonicalizeTradeUrl('https://onclive.com/view/a')).not.toBe(
      canonicalizeTradeUrl('https://onclive.com/view/b'),
    );
  });
  it('keeps identity query params but strips tracking params', () => {
    // ?p=ID addresses distinct articles — must NOT collapse to one key.
    expect(canonicalizeTradeUrl('https://ascopost.com/?p=123')).not.toBe(
      canonicalizeTradeUrl('https://ascopost.com/?p=456'),
    );
    // utm_* is tracking — stripping it dedups a re-send.
    expect(canonicalizeTradeUrl('https://ascopost.com/?p=123&utm_source=tw')).toBe(
      canonicalizeTradeUrl('https://ascopost.com/?p=123'),
    );
  });
  it('falls back to a bare strip on a malformed URL', () => {
    expect(canonicalizeTradeUrl('not a url?x=1')).toBe('not a url');
  });
});
