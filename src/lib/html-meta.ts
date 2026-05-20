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
  constructor(message = 'no paper metadata found on page') {
    super(message);
    this.name = 'MetaNotFoundError';
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

// Pull the content of a <meta name="X" content="Y"> (or property="X"),
// tolerating attribute order and single/double quotes. Returns the FIRST
// match (for single-valued tags like citation_doi).
function metaContent(html: string, name: string): string | null {
  // name="..." content="..."  OR  content="..." name="..."
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]*\\b(?:name|property)=["']${esc}["'][^>]*\\bcontent=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\b(?:name|property)=["']${esc}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

// All values for a repeated meta tag (citation_author appears once per author).
function metaContentAll(html: string, name: string): string[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]*\\b(?:name|property)=["']${esc}["'][^>]*\\bcontent=["']([^"']*)["']`, 'gi');
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    if (m[1]) out.push(decodeEntities(m[1].trim()));
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
    metaContent(html, 'citation_publication_date') ?? metaContent(html, 'citation_date'),
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
