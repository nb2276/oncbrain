// Open-access enrichment coordinator (v0.9). After a paper resolves via
// Crossref/PubMed/URL, its abstract is often null (Crossref rarely deposits
// them) and it has no full text. This backfills BOTH from free scholarly APIs:
//   1. Europe PMC — abstract + OA full text (by DOI or PMID).
//   2. OpenAlex   — abstract fallback (by DOI) when Europe PMC has none.
//
// Best-effort by contract: every API call is wrapped so a network/parse failure
// degrades to "no backfill" rather than failing the enrichment. Makes no calls
// when nothing is missing or no identifier is available.

import { fetchEuropePmc, type EuropePmcResult } from './europepmc-client.ts';
import { fetchOpenAlex, type OpenAlexResult } from './openalex-client.ts';

export type OaBackfillInput = {
  doi: string | null;
  pmid: string | null;
  abstract: string | null;
  fulltext: string | null;
};

export type OaBackfillResult = {
  abstract: string | null;
  fulltext: string | null;
  // Which source supplied a newly-filled field, for fetched_via bookkeeping/logs.
  filled: { abstract: 'europepmc' | 'openalex' | null; fulltext: 'europepmc' | null };
};

export type OaBackfillOptions = {
  // Injection seams for tests; default to the real HTTP clients.
  europePmc?: (ids: { doi?: string | null; pmid?: string | null }) => Promise<EuropePmcResult>;
  openAlex?: (doi: string) => Promise<OpenAlexResult>;
};

export async function backfillOpenAccess(
  input: OaBackfillInput,
  opts: OaBackfillOptions = {},
): Promise<OaBackfillResult> {
  let abstract = nonEmpty(input.abstract);
  let fulltext = nonEmpty(input.fulltext);
  const filled: OaBackfillResult['filled'] = { abstract: null, fulltext: null };

  // Nothing to fill, or nothing to query by → no network calls.
  if ((abstract && fulltext) || (!input.doi && !input.pmid)) {
    return { abstract, fulltext, filled };
  }

  const europePmc = opts.europePmc ?? ((ids) => fetchEuropePmc(ids, { fullText: !fulltext }));
  const openAlex = opts.openAlex ?? ((doi) => fetchOpenAlex(doi));

  try {
    const epmc = await europePmc({ doi: input.doi, pmid: input.pmid });
    if (!abstract && epmc.abstract) {
      abstract = epmc.abstract;
      filled.abstract = 'europepmc';
    }
    if (!fulltext && epmc.fullText) {
      fulltext = epmc.fullText;
      filled.fulltext = 'europepmc';
    }
  } catch {
    // best-effort: Europe PMC unavailable → fall through to OpenAlex / no-op
  }

  if (!abstract && input.doi) {
    try {
      const oa = await openAlex(input.doi);
      if (oa.abstract) {
        abstract = oa.abstract;
        filled.abstract = 'openalex';
      }
    } catch {
      // best-effort: OpenAlex unavailable → leave abstract null
    }
  }

  return { abstract, fulltext, filled };
}

function nonEmpty(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}
