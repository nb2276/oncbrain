// Crossref client: fetch paper metadata for a DOI that didn't resolve to a
// PMID (preprints, non-MEDLINE journals). Used as the DOI-keyed fallback in
// enrichPaperItem.
//
// Crossref's REST API (api.crossref.org/works/<doi>) is free, no key. The
// "polite pool" gives more stable throughput in exchange for a User-Agent
// with a contact (mailto). Abstracts are frequently ABSENT (publishers
// don't deposit them), so callers must handle a null abstract gracefully —
// that's the documented DOI-availability reality (codex finding 6).

import { normalizeDoi } from './doi.ts';

export class CrossrefError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'not_found' | 'rate_limit' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CrossrefError';
  }
}

export type CrossrefPaper = {
  doi: string; // normalized
  title: string | null;
  authors: Array<{ name: string }>;
  journal: string | null;
  pub_date: string | null; // YYYY-MM-DD or YYYY
  abstract: string | null; // OFTEN null — publishers rarely deposit abstracts
};

const CROSSREF_BASE = 'https://api.crossref.org/works';
const DEFAULT_TIMEOUT_MS = 10_000;
// Polite-pool contact. Crossref asks for a mailto so they can reach you if a
// query misbehaves; it also routes you to the more stable pool.
const POLITE_UA = 'oncbrain/0.8 (https://oncbrain.oncologytoolkit.com; mailto:oncbrain@oncologytoolkit.com)';

export type CrossrefFetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function fetchCrossrefPaper(
  doiInput: string,
  opts: CrossrefFetchOptions = {},
): Promise<CrossrefPaper> {
  const doi = normalizeDoi(doiInput);
  if (!doi) throw new CrossrefError(`not a valid DOI: ${doiInput}`, 'parse');

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(`${CROSSREF_BASE}/${encodeURIComponent(doi)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': POLITE_UA, Accept: 'application/json' },
    });
  } catch (err) {
    throw new CrossrefError(`network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) throw new CrossrefError(`DOI not in Crossref: ${doi}`, 'not_found', 404);
  if (res.status === 429) throw new CrossrefError('Crossref rate limit', 'rate_limit', 429);
  if (!res.ok) throw new CrossrefError(`Crossref returned ${res.status}`, 'network', res.status);

  let body: { message?: CrossrefWork };
  try {
    body = (await res.json()) as { message?: CrossrefWork };
  } catch (err) {
    throw new CrossrefError(`bad JSON: ${(err as Error).message}`, 'parse');
  }
  if (!body.message) throw new CrossrefError('Crossref response missing message', 'parse');

  return parseCrossrefWork(body.message, doi);
}

type CrossrefWork = {
  DOI?: string; // present on /works search items (not echoed by /works/<doi>)
  score?: number; // relevance score on a bibliographic search
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  'container-title'?: string[];
  published?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  abstract?: string; // JATS XML when present
};

// A lightweight bibliographic-search hit. Used by the failed-paper suggester to
// propose an accessible copy (a DOI that resolves via Crossref, no publisher
// fetch) for a paper whose URL was blocked and that PubMed didn't surface
// (preprints, non-MEDLINE journals).
export type CrossrefCandidate = {
  doi: string; // normalized
  title: string | null;
  journal: string | null;
  year: string | null;
  score: number; // Crossref relevance score (higher is a closer match)
};

export type CrossrefSearchOptions = CrossrefFetchOptions & { rows?: number };

// Free-text bibliographic search (api.crossref.org/works?query.bibliographic=…).
// Returns the top candidates ranked by Crossref's own relevance score. Callers
// MUST still gate on their own title-similarity check before suggesting a hit —
// Crossref returns its best guess even for a weak query. Throws CrossrefError on
// transport/parse failure; the suggester treats the whole step as best-effort.
export async function searchCrossrefByTitle(
  query: string,
  opts: CrossrefSearchOptions = {},
): Promise<CrossrefCandidate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rows = Math.min(Math.max(opts.rows ?? 5, 1), 20);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(rows),
    select: 'DOI,title,container-title,issued,score',
  });

  let res: Response;
  try {
    res = await fetchImpl(`${CROSSREF_BASE}?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': POLITE_UA, Accept: 'application/json' },
    });
  } catch (err) {
    throw new CrossrefError(`network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) throw new CrossrefError('Crossref rate limit', 'rate_limit', 429);
  if (!res.ok) throw new CrossrefError(`Crossref returned ${res.status}`, 'network', res.status);

  let body: { message?: { items?: CrossrefWork[] } };
  try {
    body = (await res.json()) as { message?: { items?: CrossrefWork[] } };
  } catch (err) {
    throw new CrossrefError(`bad JSON: ${(err as Error).message}`, 'parse');
  }

  const items = body.message?.items ?? [];
  const out: CrossrefCandidate[] = [];
  for (const work of items) {
    const doi = normalizeDoi(work.DOI ?? null);
    if (!doi) continue;
    const parsed = parseCrossrefWork(work, doi);
    out.push({
      doi,
      title: parsed.title,
      journal: parsed.journal,
      year: parsed.pub_date ? (parsed.pub_date.match(/\b(\d{4})\b/)?.[1] ?? null) : null,
      score: typeof work.score === 'number' ? work.score : 0,
    });
  }
  return out;
}

export function parseCrossrefWork(work: CrossrefWork, doi: string): CrossrefPaper {
  const title = work.title?.[0]?.trim() ?? null;
  const authors = (work.author ?? [])
    .map((a) => {
      if (a.name) return { name: a.name.trim() };
      const full = [a.family, a.given].filter(Boolean).join(', ');
      return full ? { name: full } : null;
    })
    .filter((a): a is { name: string } => a !== null);

  const journal = work['container-title']?.[0]?.trim() ?? null;

  const dateParts =
    work.published?.['date-parts']?.[0] ??
    work['published-print']?.['date-parts']?.[0] ??
    work['published-online']?.['date-parts']?.[0];
  const pub_date = formatDateParts(dateParts);

  // Crossref abstracts (when present) are JATS XML. Strip tags to plain text.
  const abstract = work.abstract ? stripJats(work.abstract) : null;

  return { doi, title, authors, journal, pub_date, abstract };
}

function formatDateParts(parts: number[] | undefined): string | null {
  if (!parts || parts.length === 0) return null;
  const [y, m, d] = parts;
  if (!y) return null;
  if (m && d) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (m) return `${y}-${String(m).padStart(2, '0')}`;
  return String(y);
}

function stripJats(jats: string): string {
  return jats
    .replace(/<[^>]+>/g, ' ') // drop JATS/XML tags
    .replace(/\s+/g, ' ')
    .trim();
}
