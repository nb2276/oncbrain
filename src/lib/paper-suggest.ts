// Accessible-source suggester for papers we couldn't ingest.
//
// When a paper URL can't be processed (a publisher page that 403s, e.g.
// ScienceDirect / Elsevier journals like the Red Journal, or a fetched page
// that has a title but no DOI/PMID to key on), this finds an ACCESSIBLE copy of
// the same paper from its title and hands the curator a clean re-ingest link.
// The curator confirms by forwarding that link back to the bot, which re-runs
// ingestion through the reliable PubMed/Crossref path (resolved by id, never by
// fetching the blocked publisher page).
//
// Two sources, in order: PubMed (primary, covers MEDLINE-indexed journals which
// is nearly every blocked publisher case) then Crossref bibliographic search
// (secondary, catches preprints / non-MEDLINE journals PubMed lacks).
//
// SAFETY: we never auto-ingest a fuzzy match. A candidate is suggested only when
// its title overlaps the recovered query strongly (an overlap-coefficient gate
// plus a minimum shared-token count), and the reply is framed "likely the same
// paper, forward to confirm" so a near-miss is caught by the curator's eye, not
// silently published. A wrong number in this digest is the worst failure mode,
// so the bar to suggest is deliberately high.

import { searchPubMed, summarizePmids, type FetchOptions as PubMedFetchOptions } from './pubmed-client.ts';
import { searchCrossrefByTitle } from './crossref-client.ts';

export type Suggestion = {
  title: string;
  journal: string | null;
  year: string | null;
  url: string; // clean re-ingest link (pubmed.ncbi.nlm.nih.gov/<pmid> or doi.org/<doi>)
  source: 'pubmed' | 'crossref';
  identifier: string; // pmid or DOI, for logging
  score: number; // title-overlap score that cleared the gate
};

export type SuggestDeps = {
  searchPubMed?: typeof searchPubMed;
  summarizePmids?: typeof summarizePmids;
  searchCrossref?: typeof searchCrossrefByTitle;
  pubmedOpts?: PubMedFetchOptions; // throttle/clock injection for tests
};

// A note shorter than this almost certainly isn't a paper title; searching on it
// would only invite a weak, possibly-wrong match. A real article title clears
// both bounds comfortably.
const MIN_QUERY_CHARS = 20;
const MIN_QUERY_WORDS = 4;

// The suggestion gate. shared = count of significant tokens common to the query
// and a candidate title; score = shared / min(token-set sizes) (overlap
// coefficient, which tolerates a truncated/subtitled query better than Jaccard).
const MIN_SHARED_TOKENS = 3;
const MIN_OVERLAP_SCORE = 0.6;

// Cap the esearch term so a very long title doesn't over-constrain to zero hits.
const MAX_QUERY_TOKENS = 12;

const URL_RE = /https?:\/\/[^\s<>")]+/gi;
// Strip an id the curator pasted alongside the link out of the title query.
const ID_NOISE_RE = /\b(?:pmid|doi|pmc(?:id)?)\b\s*[:#]?\s*\S+/gi;

// A share-sheet tail a mobile browser appends to the page title, e.g.
// "Article Title - ScienceDirect" or "Article Title | NEJM". Stripped (possibly
// repeated) so the query is the bare title.
const SITE_SUFFIX_RE =
  /\s*[-|·]\s*(?:sciencedirect|science\s*direct|pubmed|ncbi|nejm|the\s+lancet|lancet\b[^|·-]*|jama(?:\s*network)?|nature|springer(?:link)?|wiley(?:\s+online\s+library)?|oxford\s+academic|cell\b[^|·-]*|bmj|frontiers|mdpi|medrxiv|biorxiv|elsevier|redjournal|the\s+red\s+journal)\s*$/i;

// Minimal stopword set: articles, conjunctions, prepositions, and a couple of
// ubiquitous trial-vocabulary words that carry no discriminating signal. Kept
// SMALL on purpose — over-pruning a short title can drop it below the
// shared-token floor and suppress a real match.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'without',
  'vs', 'versus', 'is', 'are', 'at', 'by', 'as', 'from', 'study', 'trial',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Derive a title to search from. Prefer the page title (when the page parsed but
// lacked an id); otherwise mine the curator's message text, which on a mobile
// share commonly carries "Title - Publisher" even when the curator typed nothing.
// Returns null when there isn't enough to form a trustworthy query.
export function recoverTitleQuery(
  messageText: string | null | undefined,
  pageTitle: string | null | undefined,
): string | null {
  let raw = (pageTitle ?? '').trim();
  if (!raw && messageText) {
    raw = messageText.replace(URL_RE, ' ').replace(ID_NOISE_RE, ' ');
  }
  let title = raw.replace(/\s+/g, ' ').trim();

  // Drop a trailing publisher tail, possibly stacked ("Title - Journal - ScienceDirect").
  let prev = '';
  while (title !== prev) {
    prev = title;
    title = title.replace(SITE_SUFFIX_RE, '').trim();
  }
  // Trim leading/trailing separators left behind.
  title = title.replace(/^[\s\-|·]+|[\s\-|·]+$/g, '').trim();

  const wordCount = title.split(/\s+/).filter(Boolean).length;
  if (title.length < MIN_QUERY_CHARS || wordCount < MIN_QUERY_WORDS) return null;
  return title;
}

// The esearch term: the significant title tokens (capped), ANDed across all
// fields by Entrez. Precision comes from the title-overlap gate below, not from
// over-tagging the query, which is brittle when PubMed's title differs by a word.
function pubmedQuery(title: string): string {
  return tokens(title).slice(0, MAX_QUERY_TOKENS).join(' ');
}

// Overlap of the query's significant tokens against a candidate title.
export function titleOverlap(query: string, candidateTitle: string): { score: number; shared: number } {
  const q = new Set(tokens(query));
  const c = new Set(tokens(candidateTitle));
  if (q.size === 0 || c.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const t of q) if (c.has(t)) shared++;
  return { score: shared / Math.min(q.size, c.size), shared };
}

function passesGate(score: number, shared: number): boolean {
  return shared >= MIN_SHARED_TOKENS && score >= MIN_OVERLAP_SCORE;
}

// Find the best accessible source for a paper we couldn't ingest, or null when
// there's no recoverable title or no confident match. Never throws — every
// network step is best-effort and a failure yields null so the caller falls back
// to the canned "send the DOI" reply.
export async function suggestAccessibleSource(
  input: { messageText?: string | null; pageTitle?: string | null },
  deps: SuggestDeps = {},
): Promise<Suggestion | null> {
  const query = recoverTitleQuery(input.messageText, input.pageTitle);
  if (!query) return null;
  return (await suggestFromPubMed(query, deps)) ?? (await suggestFromCrossref(query, deps));
}

async function suggestFromPubMed(query: string, deps: SuggestDeps): Promise<Suggestion | null> {
  const doSearch = deps.searchPubMed ?? searchPubMed;
  const doSummary = deps.summarizePmids ?? summarizePmids;
  const opts = deps.pubmedOpts ?? {};
  try {
    const res = await doSearch(pubmedQuery(query), { ...opts, retmax: 5 });
    if (res.pmids.length === 0) return null;
    const summaries = await doSummary(res.pmids.slice(0, 5), opts);
    let best: Suggestion | null = null;
    for (const s of summaries) {
      const { score, shared } = titleOverlap(query, s.title);
      if (!passesGate(score, shared)) continue;
      if (!best || score > best.score) {
        best = {
          title: s.title,
          journal: s.journal,
          year: s.year,
          url: `https://pubmed.ncbi.nlm.nih.gov/${s.pmid}/`,
          source: 'pubmed',
          identifier: s.pmid,
          score,
        };
      }
    }
    return best;
  } catch {
    return null; // best-effort: PubMed unavailable → fall through to Crossref
  }
}

async function suggestFromCrossref(query: string, deps: SuggestDeps): Promise<Suggestion | null> {
  const doSearch = deps.searchCrossref ?? searchCrossrefByTitle;
  try {
    const candidates = await doSearch(query, { rows: 5 });
    let best: Suggestion | null = null;
    for (const c of candidates) {
      if (!c.title) continue;
      const { score, shared } = titleOverlap(query, c.title);
      if (!passesGate(score, shared)) continue;
      if (!best || score > best.score) {
        best = {
          title: c.title,
          journal: c.journal,
          year: c.year,
          url: `https://doi.org/${c.doi}`,
          source: 'crossref',
          identifier: c.doi,
          score,
        };
      }
    }
    return best;
  } catch {
    return null; // best-effort: Crossref unavailable → no suggestion
  }
}

// The curator-facing reply when we DID find a likely accessible copy. The link
// is a clean PubMed/DOI URL that re-ingests through the reliable id path when
// forwarded back. No em dashes (VOICE), commas/parentheses only.
export function formatSuggestionReply(failureMessage: string, s: Suggestion): string {
  const cite = [s.journal, s.year].filter(Boolean).join(' ');
  const citeLine = cite ? `${s.title} (${cite})` : s.title;
  return (
    `Couldn't ingest that page directly (${failureMessage}).\n\n` +
    `Likely the same paper, from an accessible source:\n` +
    `${citeLine}\n` +
    `${s.url}\n\n` +
    `Forward that link back to me to ingest it. Not a match? Send the DOI or PMID instead.`
  );
}
