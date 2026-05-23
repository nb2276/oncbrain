// Paper-URL detection + classification.
//
// Two jobs:
//   1. extractPaperUrls() — ingestion-time detection. Pull DOI/journal/PMC
//      URLs out of a Telegram message that are NOT already caught by the
//      existing extractPaperPmids (which handles pubmed.ncbi URLs + "PMID: N").
//      pull-telegram stores these as type='paper' inbox items with the raw
//      URL as raw_target.
//   2. classifyPaperTarget() — enrichment-time classification. Look at an
//      inbox item's raw_target and decide how to resolve it: bare PMID,
//      bare DOI, or a URL that needs fetch+meta-extract. Resolution runs at
//      enrichment (eng-review decision 1), so this is where the branching
//      lives.

import { normalizeDoi, isBareDoi } from './doi.ts';
import { PUBMED_URL_RE } from './telegram-ingest.ts';

// PMC article URLs. Two forms: the legacy
// www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/ and the current
// pmc.ncbi.nlm.nih.gov/articles/PMC1234567/ (NCBI moved PMC to its own host).
const PMC_URL_RE =
  /https?:\/\/(?:(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc|pmc\.ncbi\.nlm\.nih\.gov)\/articles\/(PMC\d+)/i;

// doi.org resolver URLs.
const DOI_URL_RE = /https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;

// Known journal/publisher hosts whose article pages expose Highwire meta
// tags reliably. Not exhaustive — any https URL that isn't a tweet/pubmed
// can still be tried, but these are the ones we proactively detect at
// ingestion. A bare https URL on a non-listed host is accepted too (the
// curator wouldn't paste a random link), but we keep a denylist of obvious
// non-paper hosts to avoid ingesting tweets-of-tweets etc.
const JOURNAL_HOST_RE = /https?:\/\/(?:www\.)?(?:thelancet|nejm|jamanetwork|annals|nature|sciencedirect|springer|wiley|onlinelibrary\.wiley|academic\.oup|ascopubs|aacrjournals|bmj|cell|medrxiv|biorxiv|researchsquare|tandfonline|karger|frontiersin|mdpi|journals\.lww|ahajournals|atsjournals|ersjournals|jto|redjournal|practicalradonc)\.(?:org|com|net)\b[^\s]*/i;

// Hosts we explicitly do NOT treat as papers (handled elsewhere or noise).
const NON_PAPER_HOST_RE = /https?:\/\/(?:www\.)?(?:twitter|x|t\.co|youtube|youtu\.be|google|bit\.ly)\.[a-z]+/i;

const ANY_URL_RE = /https?:\/\/[^\s<>")]+/gi;

export type PaperTargetKind =
  | { kind: 'pmid'; value: string } // bare digits
  | { kind: 'doi'; value: string } // normalized bare DOI
  | { kind: 'pmc'; value: string } // PMCxxxxxxx
  | { kind: 'url'; value: string }; // journal/other URL needing fetch

// Classify an inbox item's raw_target for enrichment-time resolution.
// Returns null if the target isn't a recognizable paper reference.
export function classifyPaperTarget(raw: string): PaperTargetKind | null {
  const t = raw.trim();
  if (/^\d+$/.test(t)) return { kind: 'pmid', value: t }; // bare PMID (legacy ingest)
  const pmcUrl = t.match(PMC_URL_RE);
  if (pmcUrl && pmcUrl[1]) return { kind: 'pmc', value: pmcUrl[1].toUpperCase() };
  const pubmedUrl = t.match(new RegExp(PUBMED_URL_RE.source, 'i'));
  if (pubmedUrl && pubmedUrl[1]) return { kind: 'pmid', value: pubmedUrl[1] };
  const doiUrl = t.match(DOI_URL_RE);
  if (doiUrl) {
    const norm = normalizeDoi(t);
    if (norm) return { kind: 'doi', value: norm };
  }
  if (isBareDoi(t)) {
    const norm = normalizeDoi(t);
    if (norm) return { kind: 'doi', value: norm };
  }
  if (/^https:\/\//i.test(t) && !NON_PAPER_HOST_RE.test(t)) {
    return { kind: 'url', value: t };
  }
  return null;
}

// Pull a DOI that is embedded in a publisher article URL path so it can be
// resolved via Crossref WITHOUT fetching the page (dodging publisher bot-blocks
// and rate limits). Covers the common `/doi/10.x`, `/doi/full/10.x`, and
// Springer `/article/10.1007/...` shapes. Conservative: the DOI must be a path
// segment (not a query/fragment), and trailing publisher tokens that ride after
// it (/pdf, /full, /abstract, …) are trimmed. Returns a normalized DOI or null.
//
// PII-only URLs (Elsevier/ScienceDirect, Lancet, Cell) carry NO DOI in the path
// and are intentionally not matched here — they need the PDF or a pasted DOI.
export function firstDoiInUrl(url: string): string | null {
  let path = url.split(/[?#]/)[0] ?? url;
  // Decode %2F-encoded DOI paths (e.g. /doi/10.1002%2Fcncr.34567). Keep the raw
  // path if the encoding is malformed (decodeURIComponent throws on a bad %).
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw path
  }
  const m = path.match(/\/(10\.\d{4,9}\/.+)$/i);
  if (!m || !m[1]) return null;
  const candidate = m[1].replace(
    /\/(?:full|fulltext|abstract|pdf|epdf|html|meta|references|citations)\/?$/i,
    '',
  );
  return normalizeDoi(candidate);
}

// Ingestion-time: pull paper URLs out of message text + entities that are
// NOT already covered by extractPaperPmids (pubmed URLs + PMID citations).
// Returns the raw URL strings to store as paper inbox items.
export function extractPaperUrls(
  text: string | undefined,
  entities: Array<{ type: string; url?: string }> = [],
): string[] {
  const found = new Set<string>();
  const consider = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(ANY_URL_RE)) {
      const url = m[0].replace(/[.,;)\]]+$/, ''); // trim trailing punctuation
      // Skip what the existing PMID extractor already handles.
      if (new RegExp(PUBMED_URL_RE.source, 'i').test(url)) continue;
      if (NON_PAPER_HOST_RE.test(url)) continue;
      // Accept DOI URLs, PMC URLs, and known journal hosts.
      if (DOI_URL_RE.test(url) || PMC_URL_RE.test(url) || JOURNAL_HOST_RE.test(url)) {
        found.add(url);
      }
    }
  };
  consider(text);
  for (const e of entities) {
    if ((e.type === 'text_link' || e.type === 'url') && typeof e.url === 'string') {
      consider(e.url);
    }
  }
  return Array.from(found);
}
