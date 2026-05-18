// Extract NCT trial numbers and PubMed citations from free text.
//
// Strictness matters — false positives turn into dead links in the digest,
// which erodes trust faster than missing a real citation. Patterns intentionally
// require the standard prefix (NCT, PMID, doi:) to avoid matching arbitrary numbers.

export type NctMatch = { kind: 'nct'; id: string; url: string };
export type PubmedMatch = { kind: 'pubmed'; id: string; url: string };
export type DoiMatch = { kind: 'doi'; id: string; url: string };
export type CitationMatch = NctMatch | PubmedMatch | DoiMatch;

// NCT followed by exactly 8 digits. ClinicalTrials.gov assigns NCT numbers
// in this format. Case-insensitive, but the canonical form is uppercase.
const NCT_RE = /\bNCT\d{8}\b/gi;

// PMID labels: "PMID: 12345678", "PMID 12345678", "PubMed: 12345678".
// We require the explicit prefix — bare 8-digit numbers are too risky.
// PMIDs range from 1 to 8 digits in practice (highest is currently 9-digit territory).
const PMID_RE = /\b(?:PMID|PubMed)[:\s]\s*(\d{4,9})\b/gi;

// DOI pattern: "doi:10.1234/foo" or "https://doi.org/10.1234/foo".
// DOIs always start with "10." followed by a registrant code, then a slash and identifier.
// We require the doi:/doi.org prefix to filter out arbitrary "10.x/y" strings.
const DOI_RE = /(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,}\/[^\s"<>)]+)/gi;

export function extractCitations(text: string): CitationMatch[] {
  if (!text) return [];

  const matches: CitationMatch[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(NCT_RE)) {
    const id = m[0]!.toUpperCase();
    const key = `nct:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ kind: 'nct', id, url: `https://clinicaltrials.gov/study/${id}` });
  }

  for (const m of text.matchAll(PMID_RE)) {
    const id = m[1]!;
    const key = `pubmed:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ kind: 'pubmed', id, url: `https://pubmed.ncbi.nlm.nih.gov/${id}` });
  }

  for (const m of text.matchAll(DOI_RE)) {
    const id = m[1]!;
    const key = `doi:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ kind: 'doi', id, url: `https://doi.org/${id}` });
  }

  return matches;
}

// Replace each citation in the text with an HTML <a> tag pointing at the canonical URL.
// Used by the digest template to render clickable citation chips inline.
export function linkifyCitations(text: string): string {
  if (!text) return '';

  // Track which indices in the original string have already been linkified
  // so multi-match patterns don't double-wrap.
  type Span = { start: number; end: number; href: string; label: string };
  const spans: Span[] = [];

  const addAll = (re: RegExp, hrefFor: (m: RegExpExecArray) => string, labelFor: (m: RegExpExecArray) => string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0]!.length, href: hrefFor(m), label: labelFor(m) });
    }
  };

  addAll(
    new RegExp(NCT_RE.source, 'gi'),
    (m) => `https://clinicaltrials.gov/study/${m[0]!.toUpperCase()}`,
    (m) => m[0]!.toUpperCase(),
  );
  addAll(
    new RegExp(PMID_RE.source, 'gi'),
    (m) => `https://pubmed.ncbi.nlm.nih.gov/${m[1]!}`,
    (m) => m[0]!,
  );
  addAll(
    new RegExp(DOI_RE.source, 'gi'),
    (m) => `https://doi.org/${m[1]!}`,
    (m) => m[0]!,
  );

  // Process spans left-to-right; drop overlaps (first-wins).
  spans.sort((a, b) => a.start - b.start);
  const filtered: Span[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    filtered.push(s);
    cursor = s.end;
  }

  let out = '';
  let last = 0;
  for (const s of filtered) {
    out += escapeHtml(text.slice(last, s.start));
    out += `<a href="${s.href}" target="_blank" rel="noopener" class="citation">${escapeHtml(s.label)}</a>`;
    last = s.end;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
