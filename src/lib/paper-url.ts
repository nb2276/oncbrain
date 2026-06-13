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

// Oncology trade-press outlets (news coverage of meetings/papers, not primary
// literature). These pages carry NO Highwire citation meta, so enrichment saves
// them as content-hash-keyed articles with the article text as the analyzable
// excerpt (see resolveTradeArticle). SINGLE SOURCE OF TRUTH: the host pattern,
// the display name, and the curator-facing supported-outlets list all derive
// from this table — add an outlet here and nowhere else. dailynews.ascopubs.org
// (ASCO Daily News) lives here, not in JOURNAL_HOST_RE: its subdomain doesn't
// match the (?:www\.)? prefix and its articles are trade coverage, not abstracts.
const TRADE_PRESS_OUTLETS: Array<{ host: string; label: string }> = [
  { host: 'ascopost.com', label: 'The ASCO Post' },
  { host: 'urotoday.com', label: 'UroToday' },
  { host: 'onclive.com', label: 'OncLive' },
  { host: 'targetedonc.com', label: 'Targeted Oncology' },
  { host: 'cancernetwork.com', label: 'Cancer Network' },
  { host: 'healio.com', label: 'Healio' },
  { host: 'medpagetoday.com', label: 'MedPage Today' },
  { host: 'oncodaily.com', label: 'OncoDaily' },
  { host: 'dailynews.ascopubs.org', label: 'ASCO Daily News' },
];

// Match on the PARSED hostname (exact, after dropping a leading www.), never a
// substring/regex against the raw URL — `https://ascopost.com.evil.test/x` must
// NOT count as The ASCO Post. Returns the outlet entry or null.
function tradeOutletFor(url: string): { host: string; label: string } | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null; // not a parseable absolute URL
  }
  return TRADE_PRESS_OUTLETS.find((o) => o.host === hostname) ?? null;
}

// True when the URL points at a known oncology trade-press site.
export function isTradePressUrl(url: string): boolean {
  return tradeOutletFor(url) !== null;
}

// Outlet display name for a trade-press URL, for the papers.journal field —
// most of these sites omit og:site_name (ASCO Post does), so the host is the
// only reliable source of the outlet name. Returns null for non-trade URLs.
export function tradePressLabel(url: string): string | null {
  return tradeOutletFor(url)?.label ?? null;
}

// The curator-facing list of supported trade outlets, for the bot's
// unrecognized-source reply. Derived from the table so it can't drift.
export function tradePressOutletNames(): string[] {
  return TRADE_PRESS_OUTLETS.map((o) => o.label);
}

// Hosts we explicitly do NOT treat as papers (handled elsewhere or noise).
const NON_PAPER_HOST_RE = /https?:\/\/(?:www\.)?(?:twitter|x|t\.co|youtube|youtu\.be|google|bit\.ly)\.[a-z]+/i;

const ANY_URL_RE = /https?:\/\/[^\s<>")]+/gi;

// Cap a matched URL token before the trailing-punctuation trim in
// extractPaperUrls, so the trim stays linear on adversarial input: an unbounded
// run of trim chars mid-token would otherwise backtrack quadratically (a latent
// ReDoS). Real paper URLs are far shorter, and the scheme+host live at the
// front, so capping never affects classification. Mirrors MAX_URL_LEN in
// conference-detect.ts.
const MAX_URL_LEN = 2048;

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

// The URL with its query string and fragment removed — the path-bearing prefix.
// Shared by the DOI-in-path scanners and the trade-press dedup key so they
// canonicalize identically.
export function urlPathOnly(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

// v0.15.3: the public, publishable form of a curator-submitted article URL.
// Scheme + host + path only — the query string and fragment are DROPPED, so any
// tracking tags, session tokens, or signed-access credentials in the curator's
// URL never reach the committed artifact or the public JSON API (codex review
// P1). Returns null for a non-http(s) URL (no javascript:/data: in a rendered
// href — adversarial Finding 1) or unparseable input. Trade-press + publisher
// article URLs are path-addressed, so dropping the query is lossless for them;
// the full URL stays in the DB (papers.source_url) as the local audit trail.
export function toPublicArticleUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

// Tracking/share query params that don't identify the article — stripped so a
// re-send with different campaign tags dedups. Anything else (e.g. a WordPress
// `?p=123` post id) is KEPT, since dropping all query params would merge
// distinct query-addressed articles onto one content-hash.
const TRACKING_PARAM_RE = /^(?:utm_|fbclid$|gclid$|mc_(?:cid|eid)$|igshid$|_hs(?:enc|mi)$|ref(?:_src)?$)/i;

// Canonical form of a trade-press article URL, used as the content-hash dedup
// key so the SAME article re-sent in a surface variant collapses to one row.
// Normalizes the parts a re-send commonly varies: scheme → https, host
// lowercased with a leading www. dropped, a single trailing slash stripped,
// tracking query params removed (identity params kept, sorted for stability),
// fragment removed. Path CASE is preserved (some CMSes are case-sensitive, and
// same-slug-different-case collisions are vanishingly rare). Falls back to a
// bare query/fragment strip on a URL the WHATWG parser rejects.
export function canonicalizeTradeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, ''); // drop trailing slash(es)
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RE.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const qs = kept.length ? '?' + kept.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `https://${host}${path}${qs}`;
  } catch {
    return urlPathOnly(url).replace(/\/+$/, '');
  }
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
  let path = urlPathOnly(url);
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
      const capped = m[0].length > MAX_URL_LEN ? m[0].slice(0, MAX_URL_LEN) : m[0];
      const url = capped.replace(/[.,;)\]]+$/, ''); // trim trailing punctuation
      // Skip what the existing PMID extractor already handles.
      if (new RegExp(PUBMED_URL_RE.source, 'i').test(url)) continue;
      if (NON_PAPER_HOST_RE.test(url)) continue;
      // Accept DOI URLs, PMC URLs, known journal hosts, and trade-press hosts.
      if (
        DOI_URL_RE.test(url) ||
        PMC_URL_RE.test(url) ||
        JOURNAL_HOST_RE.test(url) ||
        isTradePressUrl(url)
      ) {
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
