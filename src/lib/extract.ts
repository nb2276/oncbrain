import { normalizeDoi } from './doi.ts';
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

/**
 * The ONE DOI a body of source text states, or null.
 *
 * A citation the summariser dropped is a link the reader cannot follow: the eval
 * judge caught a card losing "doi:10.1056/NEJMoa2406909" that its own source
 * tweet supplied. `nct` survives summarisation because the prompt asks for it by
 * name; a DOI arriving in tweet text had nowhere to go.
 *
 * EXACTLY ONE, or nothing. Source text carrying two DOIs describes a study whose
 * own publication cannot be picked without guessing, and a wrong DOI points the
 * reader at someone else's paper. Same rule as the identifier backstop in
 * pdf-meta.ts: a regex is a safety net under the model, never a second opinion
 * to be averaged with it.
 *
 * NORMALISE TO COMPARE, RETURN WHAT THE SOURCE WROTE. normalizeDoi lowercases,
 * which is correct for identity — DOIs resolve case-insensitively, and dedup
 * needs one canonical key — and wrong for a citation the reader will read:
 * "10.1056/NEJMoa2406909" is how the journal writes it, and silently returning
 * "10.1056/nejmoa2406909" alters a quoted identifier. Uniqueness is judged on
 * the normalised form; the verbatim form is what comes back.
 */
export function soleDoiIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const byKey = new Map<string, string>();
  for (const c of extractCitations(text)) {
    if (c.kind !== 'doi') continue;
    const key = normalizeDoi(c.id);
    if (!key) continue;
    // First spelling wins, so a later lowercase mention cannot rewrite the
    // canonical one the source led with.
    if (!byKey.has(key)) byKey.set(key, c.id);
  }
  return byKey.size === 1 ? [...byKey.values()][0]! : null;
}

// Registration cues: the words a paper uses when stating its OWN trial number,
// as opposed to citing someone else's. Re-measured over all 35 NCT-bearing
// sources in the corpus (the earlier count of 15 was stale): the phrasings that
// actually precede a source's own registration are "ClinicalTrials.gov" — with
// the trailing `s` genuinely optional in the wild ("Clinicaltrial.gov ID:") —
// "identifier", "registered", "number", and "Clinical trial information:",
// which JCO-family abstracts use and the first list missed.
const REGISTRATION_CUE =
  /(?:trial\s+registration|clinical\s+trial\s+(?:information|registration)|registered|registration|clinicaltrials?\.gov|ct\.gov|identifier|registry|nct\s*(?:number|no\.?|id))/i;

// PDF text layers carry typographic ligatures, so `pdftotext` yields "identiﬁer"
// (U+FB01) where the cue list has "identifier". That single codepoint silently
// cost a real registration its cue, so fold the ligatures before matching.
const LIGATURES: [RegExp, string][] = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
];

function foldLigatures(s: string): string {
  let out = s;
  for (const [re, to] of LIGATURES) out = out.replace(re, to);
  return out;
}

// How far before an NCT a cue still governs it. Covers "Trial registration:
// ClinicalTrials.gov NCT03367702" and "registered at ClinicalTrials.gov (NCT...)".
const CUE_WINDOW = 60;

/**
 * The trial registrations a source claims as ITS OWN.
 *
 * Trial identity is the strongest signal lineage has — a shared NCT authorises
 * an automatic unpublish where an acronym never can — so an NCT that is merely
 * CITED must not join it. An abstract naming a comparator's registration would
 * otherwise put that trial's identity onto this card and let a later paper about
 * the comparator supersede it.
 *
 * EVERY returned registration must be CUED. There is no exemption for a source
 * that cites exactly one NCT.
 *
 * That exemption used to exist, on the measured claim that a lone NCT is always
 * the source's own. Re-measuring killed it: of 30 single-NCT sources in the
 * corpus, 10 are uncued, and several of those are unambiguously someone else's
 * trial — an ASTRO 2024 SBRT abstract naming RTOG 9408 (NCT00002597) as
 * historical context, a hormone-duration paper naming NRG GU006 (NCT03371719),
 * two pancreatic papers whose only NCT sits in a disclosures block and belongs
 * to a cited article. Each of those cards was carrying another trial's identity,
 * which is precisely the evidence that authorises an automatic unpublish.
 *
 * So: a cue governs the FIRST registration after it, and anything uncited by a
 * cue is not claimed. Abstaining is the safe direction — no identity means no
 * supersession, whereas a wrong identity means the wrong card comes down.
 */
export function ownRegistrations(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = extractCitations(text).filter((c) => c.kind === 'nct');
  const distinct = [...new Set(hits.map((h) => h.id.toUpperCase()))];
  if (distinct.length === 0) return [];

  // A CUE GOVERNS THE FIRST NCT AFTER IT, NOT EVERY NCT NEARBY.
  //
  // Each id used to scan its own preceding window independently, so a cue bled
  // forward across an intervening registration:
  //
  //   "Trial registration: NCT11111111; comparator NCT22222222"
  //
  // returned BOTH, and the comparator then satisfied registered identity — the
  // exact failure this function exists to prevent. The lookback now stops at the
  // end of the previous NCT: whatever sits before that one is that one's
  // context, and a comparator introduced afterwards has to earn its own cue.
  const upper = text.toUpperCase();
  const positions: { id: string; at: number }[] = [];
  for (const id of distinct) {
    let from = 0;
    for (;;) {
      const i = upper.indexOf(id, from);
      if (i < 0) break;
      positions.push({ id, at: i });
      from = i + id.length;
    }
  }
  positions.sort((a, b) => a.at - b.at);

  const cued = new Set<string>();
  let previousEnd = 0;
  for (const { id, at } of positions) {
    const start = Math.max(0, at - CUE_WINDOW, previousEnd);
    if (REGISTRATION_CUE.test(foldLigatures(text.slice(start, at)))) cued.add(id);
    previousEnd = at + id.length;
  }
  return [...cued];
}
