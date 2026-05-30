// DOI helpers. Shared by the URL classifier, the papers-table unique-index
// population + lookup, and the Crossref client.
//
// CRITICAL invariant (eng-review decision 3): normalizeDoi() is the SINGLE
// source of DOI canonicalization. The `lower(doi)` unique index and the
// dedup lookup query must both run a DOI through this same function, or two
// spellings of the same DOI ("10.1016/X" vs "https://doi.org/10.1016/x")
// land as separate rows and dedup silently breaks.

// DOIs are case-insensitive per the DOI spec; the registrant half is
// commonly mixed-case but resolves case-insensitively. We lowercase for a
// stable dedup key. Always starts with "10." followed by a registrant code.
const DOI_CORE = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;

// Match a DOI anywhere in a string, including doi.org URL forms and the
// "doi:" prefix. Group 1 is the bare DOI.
const DOI_ANYWHERE = /(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;

// Publisher path tokens that ride AFTER a DOI in journal URLs
// (e.g. /doi/10.1002/cncr.34567/pdf, .../full/abstract). The DOI's own
// suffix is opaque (article number / publisher code) and effectively
// never legitimately ends in these words, so stripping them collapses
// every publisher's view-mode variant onto the same canonical DOI. The
// `+` allows stacked tokens — `.../full/abstract` strips both.
const TRAILING_PUBLISHER_TOKEN =
  /(?:\/(?:full|fulltext|abstract|pdf|epdf|html|meta|references|citations))+\/?$/i;

// Canonicalize a DOI to its bare lowercased form for storage + dedup.
// Accepts any surface form a curator could plausibly forward:
//   - bare DOI:                10.1056/NEJMoa2024001
//   - doi: prefix:             doi:10.1001/jama.2026.1234
//   - doi.org resolver:        https://doi.org/10.1056/NEJMoa2024001
//   - publisher article URL:   https://www.nejm.org/doi/full/10.1056/NEJMoa2024001
//   - URL + view-mode suffix:  https://onlinelibrary.wiley.com/doi/10.1002/cncr.34567/pdf
//   - URL-encoded slash:       https://onlinelibrary.wiley.com/doi/10.1002%2Fcncr.34567
//   - in-prose with punct:     "see 10.1001/jama.2026.1234."
// All of the above must collapse to the same canonical key so the
// papers(lower(doi)) unique index dedups a paper forwarded twice via
// two surface forms (DOI then journal URL, journal URL then PDF, etc.).
// Returns null if the input contains no recognizable DOI.
export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  // Decode %2F-encoded slashes so a journal URL that escapes the DOI's
  // internal slash still matches the bare-DOI regex below. Targeted at
  // %2F only (not a full decodeURIComponent) so we never double-decode a
  // legitimate %25 inside a registrant code.
  const decoded = input.trim().replace(/%2F/gi, '/');
  const m = decoded.match(DOI_ANYWHERE);
  if (!m || !m[1]) return null;
  // Strip publisher view-mode tokens (/pdf, /full, /abstract, …) AFTER
  // the DOI. The greedy DOI regex matches them too because `/` is in its
  // character class.
  const stripped = m[1].replace(TRAILING_PUBLISHER_TOKEN, '');
  // Trim trailing punctuation that often rides along when a DOI is pasted
  // mid-sentence (".", ",", ")"), but keep legitimate DOI suffix chars.
  return stripped.toLowerCase().replace(/[.,;)\]]+$/, '');
}

// True when the string, on its own, IS a bare DOI (not embedded in prose).
export function isBareDoi(s: string): boolean {
  const t = s.trim();
  const m = t.match(DOI_CORE);
  return m !== null && m[0].length === t.length;
}

// Pull every distinct DOI out of a blob of text (curator note, message body).
// Returns normalized (bare, lowercased) DOIs.
export function extractDois(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = new RegExp(DOI_ANYWHERE.source, 'gi');
  for (const m of text.matchAll(re)) {
    const norm = normalizeDoi(m[0]);
    if (norm) out.add(norm);
  }
  return Array.from(out);
}
