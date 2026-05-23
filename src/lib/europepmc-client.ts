// Europe PMC client (v0.9): an OA full-text + abstract source keyed by DOI or
// PMID. Crossref frequently has no abstract and never has full text; Europe PMC
// fills both for open-access papers, giving the build-time study agent real
// Methods/Results instead of just a title.
//
// REST API (free, no key): /europepmc/webservices/rest/search?query=... returns
// core metadata incl. abstractText, isOpenAccess, inEPMC, pmcid. For OA papers
// whose full text is hosted in EPMC we then pull /<pmcid>/fullTextXML (JATS) and
// strip its <body> to text.

import { normalizeDoi } from './doi.ts';

export class EuropePmcError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'not_found' | 'rate_limit' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EuropePmcError';
  }
}

export type EuropePmcResult = {
  pmid: string | null;
  pmcid: string | null; // e.g. PMC1234567
  isOpenAccess: boolean;
  abstract: string | null;
  fullText: string | null; // OA full text, JATS-stripped; null if not OA/available
};

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const DEFAULT_TIMEOUT_MS = 12_000;
const POLITE_UA =
  'oncbrain/0.9 (https://oncbrain.oncologytoolkit.com; mailto:oncbrain@oncologytoolkit.com)';
// Bound the JATS payload we parse + return; the caller slices further for storage.
const MAX_FULLTEXT_CHARS = 40_000;

export type EuropePmcFetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  // Skip the (larger) full-text fetch when only an abstract is needed.
  fullText?: boolean;
};

// Resolve a paper by DOI (preferred) or PMID. Returns nulls in the result for
// fields Europe PMC doesn't have; throws EuropePmcError only on transport/parse
// failures (callers treat backfill as best-effort and swallow those).
export async function fetchEuropePmc(
  ids: { doi?: string | null; pmid?: string | null },
  opts: EuropePmcFetchOptions = {},
): Promise<EuropePmcResult> {
  // Normalize/validate at the boundary so a malformed id can't distort the
  // query (the DOI charset from normalizeDoi excludes quotes, so the DOI:"..."
  // phrase can't be broken out of).
  const doiArg = ids.doi ? normalizeDoi(ids.doi) : null;
  const pmidArg = ids.pmid && /^\d{1,9}$/.test(ids.pmid) ? ids.pmid : null;
  const query = doiArg
    ? `DOI:"${doiArg}"`
    : pmidArg
      ? `EXT_ID:${pmidArg} AND SRC:MED`
      : null;
  if (!query) throw new EuropePmcError('no valid DOI or PMID to query', 'parse');

  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    query,
    format: 'json',
    resultType: 'core',
    pageSize: '1',
  });
  const body = await getJson(`${BASE}/search?${params.toString()}`, fetchImpl, opts.timeoutMs);

  const result = (body as { resultList?: { result?: EuropePmcWork[] } }).resultList?.result?.[0];
  if (!result) {
    return { pmid: null, pmcid: null, isOpenAccess: false, abstract: null, fullText: null };
  }

  const pmid = strOrNull(result.pmid);
  const pmcid = strOrNull(result.pmcid);
  const isOpenAccess = result.isOpenAccess === 'Y';
  const abstract = stripJats(strOrNull(result.abstractText));

  // Only fetch full text when the article is BOTH open access (license — so we
  // may store the text) AND actually hosted in Europe PMC (inEPMC — so the XML
  // exists). isOpenAccess alone is a license flag; inEPMC alone could in
  // principle expose non-OA text. Requiring both is the safe intersection.
  let fullText: string | null = null;
  if (isOpenAccess && result.inEPMC === 'Y' && pmcid && opts.fullText !== false) {
    fullText = await fetchOaFullText(pmcid, fetchImpl, opts.timeoutMs);
  }

  return { pmid, pmcid, isOpenAccess, abstract, fullText };
}

type EuropePmcWork = {
  pmid?: string;
  pmcid?: string;
  isOpenAccess?: string; // 'Y' | 'N' — license flag
  inEPMC?: string; // 'Y' | 'N' — full text actually hosted in Europe PMC
  abstractText?: string; // may contain light HTML/JATS
};

// OA full text lives at /PMC/<pmcid>/fullTextXML as JATS XML. A 404 here just
// means the OA flag was set but no machine-readable full text is deposited —
// not an error worth failing on, so return null.
async function fetchOaFullText(
  pmcid: string,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<string | null> {
  // The timer stays armed through the body read (clearTimeout is in finally), so
  // a slow/huge JATS download is aborted, not just a slow connect.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE}/${encodeURIComponent(pmcid)}/fullTextXML`, {
      signal: controller.signal,
      redirect: 'error', // fixed-host API; a redirect is unexpected → fail closed
      headers: { 'User-Agent': POLITE_UA, Accept: 'application/xml' },
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw new EuropePmcError('Europe PMC rate limit', 'rate_limit', 429);
    if (!res.ok) throw new EuropePmcError(`Europe PMC returned ${res.status}`, 'network', res.status);
    const xml = await res.text();
    return stripJats(jatsBody(xml)) || null;
  } catch (err) {
    if (err instanceof EuropePmcError) throw err;
    throw new EuropePmcError(`network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': POLITE_UA, Accept: 'application/json' },
    });
    if (res.status === 429) throw new EuropePmcError('Europe PMC rate limit', 'rate_limit', 429);
    if (!res.ok) throw new EuropePmcError(`Europe PMC returned ${res.status}`, 'network', res.status);
    try {
      return await res.json();
    } catch (err) {
      throw new EuropePmcError(`bad JSON: ${(err as Error).message}`, 'parse');
    }
  } catch (err) {
    if (err instanceof EuropePmcError) throw err;
    throw new EuropePmcError(`network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

// Isolate the JATS <body> (the actual article text) and drop <front> (title,
// authors, abstract, funding) and <back> (references, acknowledgements). Returns
// '' when there's no <body> — better to store no full text than to fall back to
// the whole document and reintroduce front/back-matter pollution.
function jatsBody(xml: string): string {
  const m = xml.match(/<body\b[\s\S]*?<\/body>/i);
  return m ? m[0] : '';
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// Strip JATS/XML/HTML tags to plain text, capped for storage. Drops boilerplate
// front/back matter tags but keeps their text — good enough for the study agent.
export function stripJats(input: string | null): string | null {
  if (!input) return null;
  const text = input
    .replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text.slice(0, MAX_FULLTEXT_CHARS) : null;
}
