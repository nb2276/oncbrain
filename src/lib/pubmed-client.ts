// NCBI E-utilities client for PubMed paper enrichment.
//
// Two calls:
//   esummary  → metadata (title, authors, journal, year, doi, pmc_id, mesh terms)
//   efetch    → abstract (db=pubmed retmode=xml) and, if PMC ID present,
//               full text body (db=pmc retmode=xml) section-filtered to
//               Methods + Results, char-capped to ~8000 chars (≈2000 tokens
//               per codex v0.5 review revision down from 8000 tokens).
//
// Rate limit: 3 req/sec without API key, 10/sec with key. Solo-curator
// volume is well within either. No key required for v0.5; add NCBI_API_KEY
// to .env to bump throughput later.
//
// All output is plain text/structured metadata. No HTML injection paths.

export type PubMedMetadata = {
  pmid: string;
  doi: string | null;
  pmc_id: string | null;
  title: string;
  authors: Array<{ name: string; affiliation?: string }>;
  journal: string | null;
  pub_date: string | null; // YYYY-MM-DD or YYYY-MM when full date missing
  mesh_terms: string[];
};

export type PubMedPaper = {
  metadata: PubMedMetadata;
  abstract: string | null;
  fulltext_excerpt_md: string | null; // section-filtered Methods + Results
};

export class PubMedClientError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'not_found' | 'rate_limit' | 'parse' | 'empty',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PubMedClientError';
  }
}

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const DEFAULT_TIMEOUT_MS = 10_000;
const FULLTEXT_CHAR_CAP = 8000; // ~2000 tokens at 4 chars/token

export type FetchOptions = {
  fetchImpl?: typeof fetch;
  apiKey?: string; // NCBI_API_KEY for higher rate limit (optional)
  timeoutMs?: number;
  // v0.17 (T2): a REAL requests-per-second throttle for NCBI (codex review #19:
  // a concurrency cap is not an rps cap). All E-utility calls below route
  // through acquireNcbiSlot, which serializes requests to one per
  // minIntervalMs. Injectable clock + sleep so unit tests run instantly; the
  // resolver's per-acronym fan-out (T3) is what this protects.
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  minIntervalMs?: number; // override the apiKey-derived default
  retmax?: number; // esearch page size (default 10)
};

// Fetch metadata + abstract + (if available) section-filtered full text for
// a single PMID. Throws PubMedClientError on any unrecoverable failure.
export async function fetchPubMedPaper(
  pmid: string,
  opts: FetchOptions = {},
): Promise<PubMedPaper> {
  if (!/^\d+$/.test(pmid)) {
    throw new PubMedClientError(`invalid PMID: ${pmid}`, 'parse');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = opts.apiKey ?? process.env.NCBI_API_KEY;

  // efetch with retmode=xml gives us metadata + abstract + MeSH in one call.
  // esummary returns slightly different shape (json) but the XML route is
  // more complete and we already need an XML parser for PMC anyway.
  // review fix #3: route BOTH efetch legs (article + PMC) through the rps gate
  // too — codex #19 was only half-closed (search/summary throttled, efetch not),
  // so a build-time approved-paper fan-out could still exceed NCBI's 3 req/s.
  await acquireNcbiSlot(opts);
  const articleXml = await fetchUrl(
    `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml${apiKey ? `&api_key=${apiKey}` : ''}`,
    fetchImpl,
    timeoutMs,
  );

  const metadata = parsePubMedArticleXml(articleXml, pmid);
  const abstract = parseAbstractFromXml(articleXml);

  let fulltext_excerpt_md: string | null = null;
  if (metadata.pmc_id) {
    try {
      await acquireNcbiSlot(opts);
      const pmcXml = await fetchUrl(
        `${EUTILS_BASE}/efetch.fcgi?db=pmc&id=${metadata.pmc_id.replace(/^PMC/, '')}&retmode=xml${apiKey ? `&api_key=${apiKey}` : ''}`,
        fetchImpl,
        timeoutMs,
      );
      fulltext_excerpt_md = extractMethodsAndResults(pmcXml, FULLTEXT_CHAR_CAP);
      // v0.24 (Tier A): append figure + table CAPTIONS (dropped from the
      // Methods/Results excerpt) so caption-embedded numbers reach the study
      // agent. Given their own budget so they don't crowd out Methods/Results.
      const captions = extractFigureCaptions(pmcXml);
      if (captions) {
        const block = `## Figure & table captions\n\n${captions}`;
        fulltext_excerpt_md = fulltext_excerpt_md
          ? `${fulltext_excerpt_md}\n\n${block}`
          : block;
      }
    } catch (err) {
      // PMC fetch failure is non-fatal — paper still ships with abstract.
      // The error becomes a degraded-state disclosure in Phase E.
      if (err instanceof PubMedClientError) {
        console.warn(`  [pubmed] PMC fetch failed for ${metadata.pmc_id}: ${err.message}`);
      } else throw err;
    }
  }

  return { metadata, abstract, fulltext_excerpt_md };
}

async function fetchUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (res.status === 404) {
      throw new PubMedClientError(`PMID not found: ${url}`, 'not_found', 404);
    }
    if (res.status === 429) {
      throw new PubMedClientError(`Rate limited by NCBI: ${url}`, 'rate_limit', 429);
    }
    if (!res.ok) {
      throw new PubMedClientError(`NCBI returned ${res.status}: ${url}`, 'network', res.status);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof PubMedClientError) throw err;
    throw new PubMedClientError(`Network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

// Lightweight XML extraction. NCBI's PubMed XML schema is well-known and
// stable; we use targeted regex rather than a full XML parser to keep the
// dependency surface minimal. If schema drift bites later, swap to fast-xml-parser.
export function parsePubMedArticleXml(xml: string, pmid: string): PubMedMetadata {
  if (!xml.includes('<PubmedArticle') && !xml.includes('<PubmedBookArticle')) {
    throw new PubMedClientError('PubMed XML missing PubmedArticle root', 'empty');
  }

  const title = pickText(xml, /<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/);
  const journal = pickText(xml, /<Title>([\s\S]*?)<\/Title>/);

  // Authors: <Author><LastName>X</LastName><Initials>YZ</Initials></Author>
  const authors: PubMedMetadata['authors'] = [];
  const authorRe = /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?(?:<Initials>([^<]+)<\/Initials>)?[\s\S]*?<\/Author>/g;
  for (const m of xml.matchAll(authorRe)) {
    const last = (m[1] ?? '').trim();
    const initials = (m[2] ?? '').trim();
    if (last) authors.push({ name: initials ? `${last} ${initials}` : last });
  }
  // CollectiveName fallback (group authors)
  const collectiveRe = /<CollectiveName>([^<]+)<\/CollectiveName>/g;
  for (const m of xml.matchAll(collectiveRe)) {
    const name = (m[1] ?? '').trim();
    if (name) authors.push({ name });
  }

  // DOI: <ArticleId IdType="doi">10.xxx/xxx</ArticleId>
  const doi = pickAttr(xml, /<ArticleId\s+IdType="doi"[^>]*>([^<]+)<\/ArticleId>/i);
  const pmc_id = pickAttr(xml, /<ArticleId\s+IdType="pmc"[^>]*>([^<]+)<\/ArticleId>/i);

  // Pub date: prefer <PubDate><Year>2026</Year><Month>May</Month><Day>15</Day></PubDate>
  const yearMatch = xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>[\s\S]*?<\/PubDate>/);
  const monthMatch = xml.match(/<PubDate>[\s\S]*?<Month>([^<]+)<\/Month>[\s\S]*?<\/PubDate>/);
  const dayMatch = xml.match(/<PubDate>[\s\S]*?<Day>(\d{1,2})<\/Day>[\s\S]*?<\/PubDate>/);
  let pub_date: string | null = null;
  if (yearMatch) {
    const y = yearMatch[1]!;
    const m = monthMatch ? normalizeMonth(monthMatch[1]!) : null;
    const d = dayMatch ? dayMatch[1]!.padStart(2, '0') : null;
    pub_date = d && m ? `${y}-${m}-${d}` : m ? `${y}-${m}` : y;
  }

  // MeSH terms: <MeshHeading><DescriptorName>X</DescriptorName>...</MeshHeading>
  const mesh_terms: string[] = [];
  const meshRe = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g;
  for (const m of xml.matchAll(meshRe)) {
    const t = (m[1] ?? '').trim();
    if (t) mesh_terms.push(t);
  }

  return {
    pmid,
    doi: doi ? doi.trim() : null,
    pmc_id: pmc_id ? (pmc_id.startsWith('PMC') ? pmc_id.trim() : `PMC${pmc_id.trim()}`) : null,
    title: title ? decodeHtmlEntities(stripTags(title)) : '(no title)',
    authors,
    journal: journal ? decodeHtmlEntities(journal) : null,
    pub_date,
    mesh_terms,
  };
}

// Abstract is either a single <Abstract><AbstractText>...</AbstractText></Abstract>
// or sectioned: <AbstractText Label="OBJECTIVE">...</AbstractText> repeated.
// Join all AbstractText elements with newlines, prefixing labels when present.
export function parseAbstractFromXml(xml: string): string | null {
  const parts: string[] = [];
  const abstractTextRe = /<AbstractText(?:\s+Label="([^"]+)")?[^>]*>([\s\S]*?)<\/AbstractText>/g;
  for (const m of xml.matchAll(abstractTextRe)) {
    const label = (m[1] ?? '').trim();
    const text = stripTags(m[2] ?? '').trim();
    if (text) parts.push(label ? `${label}: ${text}` : text);
  }
  if (parts.length === 0) return null;
  return decodeHtmlEntities(parts.join('\n\n'));
}

// PMC full text: extract Methods + Results sections only. JATS schema uses
// <sec sec-type="methods"> and <sec sec-type="results">; also fall back to
// title-based matching (<title>Methods</title>, etc.) for older articles.
// Returns concatenated plain text (paragraph-broken), capped at maxChars.
export function extractMethodsAndResults(pmcXml: string, maxChars: number = FULLTEXT_CHAR_CAP): string | null {
  const sections: { label: string; body: string }[] = [];

  // Pattern 1: sec-type attribute (newer JATS).
  const typedRe = /<sec[^>]*sec-type="(methods?|materials-?methods?|results)"[^>]*>([\s\S]*?)<\/sec>/gi;
  for (const m of pmcXml.matchAll(typedRe)) {
    const label = (m[1] ?? '').toLowerCase().includes('result') ? 'Results' : 'Methods';
    sections.push({ label, body: stripJatsBodyToText(m[2] ?? '') });
  }
  if (sections.length === 0) {
    // Pattern 2: <sec><title>Methods</title>...</sec> by title-text match.
    const sectionByTitleRe = /<sec[^>]*>\s*<title>([^<]+)<\/title>([\s\S]*?)<\/sec>/gi;
    for (const m of pmcXml.matchAll(sectionByTitleRe)) {
      const title = (m[1] ?? '').toLowerCase().trim();
      if (/^(methods?|materials and methods|study design)$/.test(title)) {
        sections.push({ label: 'Methods', body: stripJatsBodyToText(m[2] ?? '') });
      } else if (/^results?$/.test(title)) {
        sections.push({ label: 'Results', body: stripJatsBodyToText(m[2] ?? '') });
      }
    }
  }
  if (sections.length === 0) return null;

  let combined = '';
  for (const sec of sections) {
    const chunk = `## ${sec.label}\n\n${sec.body.trim()}\n\n`;
    if (combined.length + chunk.length > maxChars) {
      // Truncate this section to fit, then stop.
      const remaining = Math.max(0, maxChars - combined.length - 20);
      if (remaining > 100) {
        combined += chunk.slice(0, remaining) + '…';
      }
      break;
    }
    combined += chunk;
  }
  return combined.trim() || null;
}

// v0.24 (Tier A): pull FIGURE + TABLE captions out of the PMC nxml. Authors
// routinely print the numbers we want (KM medians, HRs, n-at-risk, effect sizes)
// in figure/table caption text, and stripJatsBodyToText drops <fig>/<table-wrap>
// from the Methods/Results excerpt, so they'd otherwise be lost. This is a
// text-only, no-fetch, cross-platform win (works for ANY PMC full text, not just
// the OA subset). Returns a labeled bullet list capped at maxChars, or null.
export function extractFigureCaptions(pmcXml: string, maxChars = 2000): string | null {
  const items: string[] = [];
  const blockRe = /<(fig|table-wrap)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of pmcXml.matchAll(blockRe)) {
    const inner = m[2] ?? '';
    const labelRaw = pickText(inner, /<label>([\s\S]*?)<\/label>/i);
    const capMatch = inner.match(/<caption>([\s\S]*?)<\/caption>/i);
    if (!capMatch) continue;
    // Replace tags with a SPACE (not ''), so an inner <title>…</title><p>…</p>
    // doesn't concatenate into one run-on word.
    const captionText = decodeHtmlEntities((capMatch[1] ?? '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!captionText) continue;
    const label = labelRaw ? decodeHtmlEntities(stripTags(labelRaw)).replace(/\s+/g, ' ').trim() : '';
    items.push(label ? `- ${label}: ${captionText}` : `- ${captionText}`);
  }
  if (items.length === 0) return null;
  let out = '';
  for (const line of items) {
    if (out.length + line.length + 1 > maxChars) {
      // Truncate this over-long line to the remaining room rather than breaking
      // outright — otherwise a single huge first caption would drop ALL captions.
      const room = maxChars - out.length - (out ? 1 : 0);
      if (room > 40) out += (out ? '\n' : '') + line.slice(0, room);
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out || null;
}

function stripJatsBodyToText(jats: string): string {
  // Drop xref / table / fig / graphic tags entirely (references, figures aren't
  // useful in a token-capped excerpt). Keep paragraph structure as newlines.
  let s = jats.replace(/<(xref|table-wrap|fig|graphic|media|object-id|inline-formula|disp-formula|sub|sup)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/p>\s*<p[^>]*>/g, '\n\n');
  s = s.replace(/<\/?p[^>]*>/g, '');
  s = stripTags(s);
  s = decodeHtmlEntities(s);
  return s.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function pickText(xml: string, re: RegExp): string | null {
  const m = xml.match(re);
  return m && m[1] ? m[1] : null;
}

function pickAttr(xml: string, re: RegExp): string | null {
  const m = xml.match(re);
  return m && m[1] ? m[1] : null;
}

const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
function normalizeMonth(m: string): string {
  const lower = m.toLowerCase().slice(0, 3);
  if (MONTH_MAP[lower]) return MONTH_MAP[lower];
  if (/^\d{1,2}$/.test(m)) return m.padStart(2, '0');
  return '01';
}

// ────────────────────────────────────────────────────────────────────────────
// v0.17 (T2): PubMed SEARCH layer — esearch + esummary + a real rps throttle.
//
// The review-trial resolver (T3) fans out one esearch + one esummary per
// discussed-trial acronym across every review on a date. NCBI allows 3 req/s
// without a key (10/s with NCBI_API_KEY); exceeding it earns a 429 + an IP
// block. A concurrency cap (the ct.gov pattern) does NOT bound rps (codex #19),
// so this is a min-interval gate: each call reserves the next time slot and
// waits for it, serializing all E-utility traffic to one request per interval.
// ────────────────────────────────────────────────────────────────────────────

const NCBI_BASE_INTERVAL_MS = 334; // 3 req/s (no key)
const NCBI_KEYED_INTERVAL_MS = 110; // ~9 req/s (key; NCBI caps at 10)

// Module-level next-allowed timestamp. Concurrent callers get staggered slots.
let _ncbiNextAllowedAt = 0;

// Test seam: reset the gate between tests so a prior test's reserved slot
// doesn't make the next test wait.
export function _resetNcbiThrottleForTests(): void {
  _ncbiNextAllowedAt = 0;
}

async function acquireNcbiSlot(opts: FetchOptions): Promise<void> {
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval =
    opts.minIntervalMs ??
    ((opts.apiKey ?? process.env.NCBI_API_KEY) ? NCBI_KEYED_INTERVAL_MS : NCBI_BASE_INTERVAL_MS);
  const now = clock();
  const slot = Math.max(now, _ncbiNextAllowedAt);
  _ncbiNextAllowedAt = slot + interval;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

export type PubMedSearchResult = {
  pmids: string[];
  total: number; // total matches (may exceed pmids.length when capped by retmax)
};

// esearch: a free-text PubMed query (e.g. `STOMP[Title] AND oligometastatic prostate`)
// → candidate PMIDs. Returns the PMID list (capped at retmax) + the total count.
// An empty result is NOT an error (returns { pmids: [], total: 0 }) — that is the
// resolver's "leave it as plain text" signal.
export async function searchPubMed(term: string, opts: FetchOptions = {}): Promise<PubMedSearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = opts.apiKey ?? process.env.NCBI_API_KEY;
  const retmax = opts.retmax ?? 10;

  await acquireNcbiSlot(opts);
  const url =
    `${EUTILS_BASE}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}` +
    `&term=${encodeURIComponent(term)}${apiKey ? `&api_key=${apiKey}` : ''}`;
  const body = await fetchUrl(url, fetchImpl, timeoutMs);

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new PubMedClientError(`esearch returned non-JSON: ${(err as Error).message}`, 'parse');
  }
  const er = (json as { esearchresult?: { idlist?: unknown; count?: unknown } }).esearchresult;
  const pmids = Array.isArray(er?.idlist)
    ? er!.idlist.filter((x): x is string => typeof x === 'string' && /^\d+$/.test(x))
    : [];
  const total = typeof er?.count === 'string' ? Number.parseInt(er.count, 10) || 0 : 0;
  return { pmids, total };
}

export type PubMedSummary = {
  pmid: string;
  title: string;
  journal: string | null;
  year: string | null;
  pub_date: string | null;
};

// esummary: batch-fetch lightweight metadata (title, journal, year) for a set of
// PMIDs in ONE request. The resolver shows these to the curator and ranks them
// BEFORE a heavier efetch (codex #8: gating needs candidate metadata, not just
// PMIDs). Non-numeric ids are dropped; an empty input is a no-op (no request).
export async function summarizePmids(pmids: string[], opts: FetchOptions = {}): Promise<PubMedSummary[]> {
  const ids = pmids.filter((p) => /^\d+$/.test(p));
  if (ids.length === 0) return [];

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = opts.apiKey ?? process.env.NCBI_API_KEY;

  await acquireNcbiSlot(opts);
  const url =
    `${EUTILS_BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}` +
    `${apiKey ? `&api_key=${apiKey}` : ''}`;
  const body = await fetchUrl(url, fetchImpl, timeoutMs);

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new PubMedClientError(`esummary returned non-JSON: ${(err as Error).message}`, 'parse');
  }
  const result = (json as { result?: Record<string, unknown> }).result;
  if (!result) return [];
  const uids = Array.isArray((result as { uids?: unknown }).uids)
    ? ((result as { uids: unknown[] }).uids.filter((u): u is string => typeof u === 'string'))
    : [];

  const out: PubMedSummary[] = [];
  for (const uid of uids) {
    const r = result[uid] as
      | { title?: string; fulljournalname?: string; source?: string; pubdate?: string }
      | undefined;
    if (!r) continue;
    const pub_date = typeof r.pubdate === 'string' ? r.pubdate : null;
    out.push({
      pmid: uid,
      title: r.title ? decodeHtmlEntities(stripTags(r.title)).trim() : '(no title)',
      journal: r.fulljournalname || r.source || null,
      year: pub_date ? (pub_date.match(/\b(\d{4})\b/)?.[1] ?? null) : null,
      pub_date,
    });
  }
  return out;
}
