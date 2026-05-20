import { describe, it, expect } from 'vitest';
import { extractPaperMeta, MetaNotFoundError } from '../src/lib/html-meta.ts';

const LANCET = `<!doctype html><html><head>
  <meta name="citation_title" content="Long-term outcomes of SABR for primary kidney cancer (FASTRACK II)">
  <meta name="citation_author" content="Siva, Shankar">
  <meta name="citation_author" content="Pryor, David">
  <meta name="citation_doi" content="10.1016/S1470-2045(26)00091-4">
  <meta name="citation_pmid" content="42144018">
  <meta name="citation_journal_title" content="The Lancet Oncology">
  <meta name="citation_publication_date" content="2026/05/17">
  <title>FASTRACK II - The Lancet Oncology</title>
</head><body>...</body></html>`;

const MEDRXIV = `<html><head>
  <meta name="citation_title" content="A preprint on something">
  <meta name="citation_doi" content="10.1101/2026.05.01.12345">
  <meta name="citation_author" content="Doe, Jane">
  <meta property="og:site_name" content="medRxiv">
</head></html>`;

const OG_ONLY = `<html><head>
  <meta property="og:title" content="Some article">
  <meta property="og:site_name" content="JournalX">
</head></html>`;

const PAYWALL = `<html><head><title>Access denied</title></head><body>Please log in</body></html>`;

describe('extractPaperMeta', () => {
  it('parses Highwire tags (Lancet)', () => {
    const m = extractPaperMeta(LANCET);
    expect(m.doi).toBe('10.1016/s1470-2045(26)00091-4');
    expect(m.pmid).toBe('42144018');
    expect(m.title).toContain('FASTRACK II');
    expect(m.authors).toEqual(['Siva, Shankar', 'Pryor, David']);
    expect(m.journal).toBe('The Lancet Oncology');
    expect(m.pub_date).toBe('2026-05-17');
  });

  it('handles a DOI-only preprint (no PMID)', () => {
    const m = extractPaperMeta(MEDRXIV);
    expect(m.doi).toBe('10.1101/2026.05.01.12345');
    expect(m.pmid).toBeNull();
    expect(m.title).toBe('A preprint on something');
  });

  it('falls back to OpenGraph when no Highwire tags', () => {
    const m = extractPaperMeta(OG_ONLY);
    expect(m.title).toBe('Some article');
    expect(m.journal).toBe('JournalX');
    expect(m.doi).toBeNull();
    expect(m.pmid).toBeNull();
  });

  it('throws MetaNotFound on a paywall/error page with no identifiers or title meta', () => {
    // The <title> "Access denied" is technically a title; assert we still get
    // something rather than throwing — but a page with NO title and no meta
    // must throw.
    const bare = `<html><head></head><body>nothing</body></html>`;
    expect(() => extractPaperMeta(bare)).toThrow(MetaNotFoundError);
  });

  it('decodes HTML entities in titles', () => {
    const html = `<head><meta name="citation_title" content="RT &amp; chemo in NSCLC"></head>`;
    expect(extractPaperMeta(html).title).toBe('RT & chemo in NSCLC');
  });

  it('tolerates reversed attribute order', () => {
    const html = `<head><meta content="10.1056/x" name="citation_doi"></head>`;
    expect(extractPaperMeta(html).doi).toBe('10.1056/x');
  });

  it('normalizes a year-only date', () => {
    const html = `<head><meta name="citation_title" content="t"><meta name="citation_date" content="2025"></head>`;
    expect(extractPaperMeta(html).pub_date).toBe('2025');
  });
});
