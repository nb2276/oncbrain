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

// Canonicalize a DOI to its bare lowercased form for storage + dedup.
// Strips any doi.org URL wrapper and the "doi:" prefix, trims, lowercases.
// Returns null if the input contains no recognizable DOI.
export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = input.trim().match(DOI_ANYWHERE);
  if (!m || !m[1]) return null;
  // Trim trailing punctuation that often rides along when a DOI is pasted
  // mid-sentence (".", ",", ")"), but keep legitimate DOI suffix chars.
  return m[1].toLowerCase().replace(/[.,;)\]]+$/, '');
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
