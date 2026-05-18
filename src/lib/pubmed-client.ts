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
      const pmcXml = await fetchUrl(
        `${EUTILS_BASE}/efetch.fcgi?db=pmc&id=${metadata.pmc_id.replace(/^PMC/, '')}&retmode=xml${apiKey ? `&api_key=${apiKey}` : ''}`,
        fetchImpl,
        timeoutMs,
      );
      fulltext_excerpt_md = extractMethodsAndResults(pmcXml, FULLTEXT_CHAR_CAP);
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
