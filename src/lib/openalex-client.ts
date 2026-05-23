// OpenAlex client (v0.9): an abstract fallback keyed by DOI. When Crossref has
// no abstract and the paper isn't open-access in Europe PMC, OpenAlex often
// still has one — stored as an inverted index (word → positions) that we
// reconstruct into prose. Free, no key; a mailto routes us to the polite pool.

import { normalizeDoi } from './doi.ts';

export class OpenAlexError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'not_found' | 'rate_limit' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAlexError';
  }
}

const BASE = 'https://api.openalex.org/works';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAILTO = 'oncbrain@oncologytoolkit.com';
const POLITE_UA =
  'oncbrain/0.9 (https://oncbrain.oncologytoolkit.com; mailto:oncbrain@oncologytoolkit.com)';

export type OpenAlexResult = {
  abstract: string | null;
};

export type OpenAlexFetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Look up a work by DOI and return its (reconstructed) abstract, or null.
export async function fetchOpenAlex(
  doiInput: string,
  opts: OpenAlexFetchOptions = {},
): Promise<OpenAlexResult> {
  const doi = normalizeDoi(doiInput); // boundary: reject a malformed DOI locally
  if (!doi) throw new OpenAlexError(`not a valid DOI: ${doiInput}`, 'parse');

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // OpenAlex accepts a DOI as a full doi.org URL in the path. mailto = polite pool.
  const url = `${BASE}/https://doi.org/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`;
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error', // fixed-host API; a redirect is unexpected → fail closed
      headers: { 'User-Agent': POLITE_UA, Accept: 'application/json' },
    });
    if (res.status === 404) throw new OpenAlexError(`DOI not in OpenAlex: ${doi}`, 'not_found', 404);
    if (res.status === 429) throw new OpenAlexError('OpenAlex rate limit', 'rate_limit', 429);
    if (!res.ok) throw new OpenAlexError(`OpenAlex returned ${res.status}`, 'network', res.status);
    let body: { abstract_inverted_index?: Record<string, number[]> };
    try {
      body = (await res.json()) as { abstract_inverted_index?: Record<string, number[]> };
    } catch (err) {
      throw new OpenAlexError(`bad JSON: ${(err as Error).message}`, 'parse');
    }
    return { abstract: abstractFromInvertedIndex(body.abstract_inverted_index) };
  } catch (err) {
    if (err instanceof OpenAlexError) throw err;
    throw new OpenAlexError(`network error: ${(err as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

// Rebuild prose from OpenAlex's inverted index: { "the": [0,5], "trial": [1] }
// → place each word at each of its positions, then join in position order.
export function abstractFromInvertedIndex(
  inv: Record<string, number[]> | undefined | null,
): string | null {
  if (!inv || typeof inv !== 'object') return null;
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === 'number') slots.push([pos, word]);
    }
  }
  if (slots.length === 0) return null;
  slots.sort((a, b) => a[0] - b[0]);
  const text = slots.map(([, w]) => w).join(' ').trim();
  return text.length > 0 ? text : null;
}
