// Extract paper metadata from a journal article page's <meta> tags.
//
// Most journal/publisher sites (Lancet, NEJM, JAMA, Nature, medRxiv, etc.)
// emit Highwire Press meta tags — the de-facto standard Google Scholar
// indexes. We read those first; OpenGraph + <title> are the fallback.
//
// We only parse <meta> and <title> with regex (no full DOM parse): the meta
// block is at the top of <head>, well-formed, and we never execute or render
// the page. Regex is sufficient and avoids a heavy HTML-parser dependency.

import { normalizeDoi } from './doi.ts';

export class MetaNotFoundError extends Error {
  // The page title, when the page DID expose one but carried no DOI/PMID to key
  // on. The enrichment failure path uses it to search for an accessible copy of
  // the same paper (see paper-suggest.ts) before falling back to the canned
  // "send the DOI" reply.
  readonly pageTitle?: string;
  constructor(message = 'no paper metadata found on page', pageTitle?: string) {
    super(message);
    this.name = 'MetaNotFoundError';
    this.pageTitle = pageTitle;
  }
}

export type PaperMeta = {
  pmid: string | null;
  doi: string | null; // normalized
  title: string | null;
  authors: string[];
  journal: string | null;
  pub_date: string | null; // YYYY-MM-DD or YYYY when only year is known
};

// The content="…" value capture. The value is delimited by the quote it OPENED
// with (captured, then matched by the \N backref), so an apostrophe inside a
// double-quoted value — content="Patients' survival" — isn't truncated to
// "Patients". `(?:(?!\N)[^>])*` is a tempered token: it consumes anything that
// is neither the delimiter quote nor `>`, so it stays within the tag and runs
// linearly (no catastrophic backtracking on the uncapped 5MB meta path).
const CONTENT_VAL = (group: number) => `content=(["'])((?:(?!\\${group})[^>])*)\\${group}`;

// Pull the content of a <meta name="X" content="Y"> (or property="X"),
// tolerating attribute order and single/double quotes. Returns the FIRST
// match (for single-valued tags like citation_doi). The content value is in
// capture group 2 (group 1 is its opening quote).
function metaContent(html: string, name: string): string | null {
  // name="..." content="..."  OR  content="..." name="..."
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]*\\b(?:name|property)=["']${esc}["'][^>]*\\b${CONTENT_VAL(1)}`, 'i'),
    new RegExp(`<meta[^>]*\\b${CONTENT_VAL(1)}[^>]*\\b(?:name|property)=["']${esc}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[2]) return decodeEntities(m[2].trim());
  }
  return null;
}

// All values for a repeated meta tag (citation_author appears once per author).
function metaContentAll(html: string, name: string): string[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]*\\b(?:name|property)=["']${esc}["'][^>]*\\b${CONTENT_VAL(1)}`, 'gi');
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    if (m[2]) out.push(decodeEntities(m[2].trim()));
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Normalize Highwire citation_date / citation_publication_date to YYYY-MM-DD
// or YYYY. Formats vary: "2026/05/17", "2026-05-17", "2026".
function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const ymd = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2]!.padStart(2, '0')}-${ymd[3]!.padStart(2, '0')}`;
  }
  const y = raw.match(/\b(19|20)\d{2}\b/);
  return y ? y[0] : null;
}

// Parse a fetched article page into PaperMeta. Throws MetaNotFoundError when
// there's no DOI, PMID, or title to anchor on (a paywall splash, an error
// page, or a non-article URL).
export function extractPaperMeta(html: string): PaperMeta {
  const doi = normalizeDoi(metaContent(html, 'citation_doi') ?? metaContent(html, 'dc.identifier'));
  const pmid = metaContent(html, 'citation_pmid');
  const title =
    metaContent(html, 'citation_title') ??
    metaContent(html, 'og:title') ??
    metaContent(html, 'dc.title') ??
    titleTag(html);
  const authors = metaContentAll(html, 'citation_author');
  const journal =
    metaContent(html, 'citation_journal_title') ?? metaContent(html, 'og:site_name');
  const pub_date = normalizeDate(
    metaContent(html, 'citation_publication_date') ??
      metaContent(html, 'citation_date') ??
      metaContent(html, 'article:published_time'), // trade-press pages have only the OG date
  );

  // Need at least one strong identifier (DOI or PMID) or a title to be useful.
  if (!doi && !pmid && !title) {
    throw new MetaNotFoundError();
  }

  return {
    pmid: pmid && /^\d+$/.test(pmid) ? pmid : null,
    doi,
    title,
    authors,
    journal,
    pub_date,
  };
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m && m[1] ? decodeEntities(m[1].trim()) : null;
}

// og:description / meta description — the only summary a trade-press article
// page offers (no citation_abstract exists outside journal sites).
export function extractOgDescription(html: string): string | null {
  return metaContent(html, 'og:description') ?? metaContent(html, 'description');
}

// Cap the HTML handed to the lazy [\s\S]*? regexes below. Those quantifiers
// rescan to end-of-string from every open-tag position when a closing tag is
// absent (the 5MB body cap in ssrf-fetch can also sever one mid-document), so
// on adversarial/malformed input the cost is ~O(n²) — a multi-minute CPU hang
// at 5MB. A trade-article page is tens of KB (a real ASCO Post page is ~60KB
// total, ~12KB of body text); 128KB covers the main <article> with room while
// bounding the pathological worst case to ~300ms on this single-threaded path.
const MAX_ARTICLE_HTML = 128 * 1024;

// Visible article text from a trade-press page, for DOI/NCT scanning and the
// paper's fulltext excerpt. Same regex-only stance as the meta extraction:
// no DOM parse, never executed. Picks the LARGEST <article> region (teaser /
// related-article cards are smaller <article> siblings, and a lazy "first
// match" would grab a teaser or truncate at a nested close); falls back to
// <main>, then body-sans-head. Then strips script/style/chrome subtrees and
// all remaining tags.
export function extractArticleText(html: string): string {
  const capped = html.length > MAX_ARTICLE_HTML ? html.slice(0, MAX_ARTICLE_HTML) : html;
  const region = largestTagContent(capped, 'article') ?? firstTagContent(capped, 'main') ?? stripHead(capped);
  const noSubtrees = region.replace(
    /<(script|style|noscript|template|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  // Every remaining tag becomes a space so adjacent words across tag
  // boundaries (e.g. across a </p><p> or <br>) don't fuse.
  const text = noSubtrees.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function firstTagContent(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'));
  return m && m[1] ? m[1] : null;
}

// The longest content across all <tag>…</tag> blocks. On a page with several
// <article> elements (teaser + body + related cards) this returns the real
// body instead of whichever lazy match comes first. Operates on size-capped
// input, so the global lazy scan is bounded.
function largestTagContent(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  let best: string | null = null;
  for (const m of html.matchAll(re)) {
    const body = m[1];
    if (body && (best === null || body.length > best.length)) best = body;
  }
  return best;
}

function stripHead(html: string): string {
  return html.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ');
}
