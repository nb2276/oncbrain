import { describe, it, expect } from 'vitest';
import {
  extractPaperMeta,
  extractArticleText,
  extractOgDescription,
  MetaNotFoundError,
} from '../src/lib/html-meta.ts';

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

  it('does not truncate a double-quoted value at an inner apostrophe', () => {
    const html = `<head><meta name="citation_title" content="Patients' survival improved with RT"></head>`;
    expect(extractPaperMeta(html).title).toBe("Patients' survival improved with RT");
  });

  it('does not truncate a single-quoted value at an inner double-quote', () => {
    const html = `<head><meta property='og:title' content='The "PRESTIGE" trial readout'></head>`;
    expect(extractPaperMeta(html).title).toBe('The "PRESTIGE" trial readout');
  });

  it('tolerates reversed attribute order', () => {
    const html = `<head><meta content="10.1056/x" name="citation_doi"></head>`;
    expect(extractPaperMeta(html).doi).toBe('10.1056/x');
  });

  it('normalizes a year-only date', () => {
    const html = `<head><meta name="citation_title" content="t"><meta name="citation_date" content="2025"></head>`;
    expect(extractPaperMeta(html).pub_date).toBe('2025');
  });

  it('falls back to article:published_time for the date (trade-press pages)', () => {
    const html = `<head><meta property="og:title" content="t"><meta property="article:published_time" content="2026-06-05T14:30:00Z"></head>`;
    expect(extractPaperMeta(html).pub_date).toBe('2026-06-05');
  });
});

const TRADE_PAGE = `<!doctype html><html><head>
  <meta property="og:title" content="PRESTIGE-PSMA Improves rPFS in mCRPC">
  <meta property="og:site_name" content="The ASCO Post">
  <meta property="og:description" content="The phase 3 trial met its primary endpoint.">
  <title>PRESTIGE-PSMA | The ASCO Post</title>
  <style>.nav { color: red }</style>
</head><body>
  <nav><a href="/issues/">All issues &raquo;</a></nav>
  <div class="sidebar">Trending: unrelated piece</div>
  <article>
    <h1>PRESTIGE-PSMA Improves rPFS in mCRPC</h1>
    <script>window.track('view')</script>
    <p>The phase 3 PRESTIGE-PSMA trial (NCT05000001) showed a median rPFS of
    11.2 vs 8.1 months (HR = 0.62).</p>
    <p>DOI: 10.1200/JCO.2026.44.16_suppl.5000</p>
  </article>
  <footer>Copyright</footer>
</body></html>`;

describe('extractArticleText', () => {
  it('prefers the <article> region and drops nav/sidebar/footer chrome', () => {
    const text = extractArticleText(TRADE_PAGE);
    expect(text).toContain('median rPFS of 11.2 vs 8.1 months');
    expect(text).not.toContain('All issues');
    expect(text).not.toContain('Trending');
    expect(text).not.toContain('Copyright');
  });
  it('strips script/style content inside the article', () => {
    expect(extractArticleText(TRADE_PAGE)).not.toContain('window.track');
  });
  it('keeps citations (NCT, DOI) intact for downstream extraction', () => {
    const text = extractArticleText(TRADE_PAGE);
    expect(text).toContain('NCT05000001');
    expect(text).toContain('10.1200/JCO.2026.44.16_suppl.5000');
  });
  it('falls back to <main> then body-sans-head when there is no <article>', () => {
    const mainOnly = `<html><head><title>x</title></head><body><main><p>main text</p></main></body></html>`;
    expect(extractArticleText(mainOnly)).toBe('main text');
    const bodyOnly = `<html><head><style>p{}</style></head><body><p>body text</p></body></html>`;
    expect(extractArticleText(bodyOnly)).toBe('body text');
  });
  it('decodes entities and collapses whitespace', () => {
    const html = `<article><p>RT &amp; chemo</p>\n\n<p>in   NSCLC</p></article>`;
    expect(extractArticleText(html)).toBe('RT & chemo in NSCLC');
  });

  it('picks the LARGEST <article> when a teaser/promo article precedes the body', () => {
    const html = `<body>
      <article><p>Teaser NCT00000001</p></article>
      <article><p>The real article body with the substantive findings and the
      trial of interest NCT05000002 and effect sizes worth keeping.</p></article>
    </body>`;
    const text = extractArticleText(html);
    expect(text).toContain('NCT05000002'); // the real body won
    expect(text).not.toContain('NCT00000001'); // the teaser did not truncate it
  });

  it('does not let a related-article <article> leak its ids over the main body', () => {
    const html = `<body>
      <article><p>Main coverage of the pivotal trial NCT05000002 with the full
      writeup, the comparator arm, and the discussion of where it fits.</p></article>
      <article class="related"><p>Related: NCT09999999</p></article>
    </body>`;
    const text = extractArticleText(html);
    expect(text).toContain('NCT05000002');
    expect(text).not.toContain('NCT09999999');
  });

  it('stays bounded on a huge malformed input (ReDoS guard — does not hang)', () => {
    // Many unmatched open tags would be O(n^2) on the lazy subtree-strip regex
    // without the size cap. Assert it COMPLETES (returns a string) rather than
    // hanging, and within a generous ceiling.
    const huge = '<nav>'.repeat(400_000) + '<article><p>body NCT05000002</p></article>';
    const start = Date.now();
    const text = extractArticleText(huge);
    expect(typeof text).toBe('string');
    // Uncapped this is ~90s on 2M chars; the 128KB cap bounds it to well under a
    // second nominally. The ceiling is deliberately generous (was 3s, which
    // flaked under full-suite parallel load at ~4.5s) — it only needs to
    // distinguish "cap engaged" from "uncapped multi-minute hang", not assert a
    // tight latency. The 20s explicit test timeout below is the hang backstop.
    expect(Date.now() - start).toBeLessThan(15000);
  }, 20000);
});

describe('extractOgDescription', () => {
  it('reads og:description', () => {
    expect(extractOgDescription(TRADE_PAGE)).toBe('The phase 3 trial met its primary endpoint.');
  });
  it('falls back to meta description, else null', () => {
    expect(extractOgDescription(`<head><meta name="description" content="plain desc"></head>`)).toBe(
      'plain desc',
    );
    expect(extractOgDescription('<head></head>')).toBeNull();
  });
});
