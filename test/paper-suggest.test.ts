import { describe, it, expect, vi } from 'vitest';
import {
  recoverTitleQuery,
  titleOverlap,
  suggestAccessibleSource,
  formatSuggestionReply,
  type SuggestDeps,
} from '../src/lib/paper-suggest.ts';

const TITLE = 'Reduced-dose preoperative radiotherapy in myxoid liposarcoma the DOREMY trial';

describe('recoverTitleQuery', () => {
  it('prefers a page title and strips a publisher share-sheet tail', () => {
    expect(recoverTitleQuery(null, `${TITLE} - ScienceDirect`)).toBe(TITLE);
    expect(recoverTitleQuery(null, `${TITLE} | NEJM`)).toBe(TITLE);
  });

  it('mines the message text when there is no page title, dropping the URL', () => {
    const msg = `${TITLE} https://www.sciencedirect.com/science/article/pii/S0360301624000123`;
    expect(recoverTitleQuery(msg, null)).toBe(TITLE);
  });

  it('drops a pasted PMID/DOI token from the query', () => {
    const q = recoverTitleQuery(`${TITLE} PMID: 38123456`, null);
    expect(q).toBe(TITLE);
    expect(q).not.toMatch(/pmid/i);
  });

  it('returns null when there is nothing title-like (too short)', () => {
    expect(recoverTitleQuery('great paper', null)).toBeNull();
    expect(recoverTitleQuery('https://sciencedirect.com/x', null)).toBeNull();
    expect(recoverTitleQuery(null, null)).toBeNull();
  });
});

describe('titleOverlap', () => {
  it('scores a near-identical title high and an unrelated one low', () => {
    expect(titleOverlap(TITLE, TITLE).score).toBe(1);
    const unrelated = titleOverlap(TITLE, 'Adjuvant pembrolizumab in renal cell carcinoma');
    expect(unrelated.shared).toBeLessThan(3);
  });
});

// A PubMed esummary candidate shape (subset the suggester reads).
function summary(pmid: string, title: string, journal: string | null, year: string | null) {
  return { pmid, title, journal, year, pub_date: year };
}

describe('suggestAccessibleSource', () => {
  it('returns a PubMed suggestion with a clean re-ingest link on a confident match', async () => {
    const deps: SuggestDeps = {
      searchPubMed: vi.fn(async () => ({ pmids: ['38123456', '99999999'], total: 2 })) as SuggestDeps['searchPubMed'],
      summarizePmids: vi.fn(async () => [
        summary('99999999', 'A completely unrelated immunotherapy abstract', 'JCO', '2023'),
        summary('38123456', TITLE, 'Int J Radiat Oncol Biol Phys', '2024'),
      ]) as SuggestDeps['summarizePmids'],
      searchCrossref: vi.fn(async () => []) as SuggestDeps['searchCrossref'],
    };
    const s = await suggestAccessibleSource({ pageTitle: `${TITLE} - ScienceDirect` }, deps);
    expect(s).not.toBeNull();
    expect(s!.source).toBe('pubmed');
    expect(s!.url).toBe('https://pubmed.ncbi.nlm.nih.gov/38123456/');
    expect(s!.journal).toBe('Int J Radiat Oncol Biol Phys');
    // The unrelated candidate must not win.
    expect(s!.identifier).toBe('38123456');
    // Crossref is the fallback, never consulted once PubMed is confident.
    expect(deps.searchCrossref).not.toHaveBeenCalled();
  });

  it('does NOT suggest a weak PubMed match, and falls through to Crossref', async () => {
    const searchCrossref = vi.fn(async () => [
      { doi: '10.1101/2024.01.01.24300001', title: TITLE, journal: 'medRxiv', year: '2024', score: 30 },
    ]) as SuggestDeps['searchCrossref'];
    const deps: SuggestDeps = {
      searchPubMed: vi.fn(async () => ({ pmids: ['111'], total: 1 })) as SuggestDeps['searchPubMed'],
      // Only a weak, wrong candidate from PubMed (below the overlap gate).
      summarizePmids: vi.fn(async () => [summary('111', 'Liposarcoma surgery outcomes review', null, '2019')]) as SuggestDeps['summarizePmids'],
      searchCrossref,
    };
    const s = await suggestAccessibleSource({ pageTitle: TITLE }, deps);
    expect(s).not.toBeNull();
    expect(s!.source).toBe('crossref');
    expect(s!.url).toBe('https://doi.org/10.1101/2024.01.01.24300001');
    expect(searchCrossref).toHaveBeenCalled();
  });

  it('returns null (no network calls) when no title can be recovered', async () => {
    const searchPubMed = vi.fn() as SuggestDeps['searchPubMed'];
    const searchCrossref = vi.fn() as SuggestDeps['searchCrossref'];
    const s = await suggestAccessibleSource({ messageText: 'thanks!', pageTitle: null }, { searchPubMed, searchCrossref });
    expect(s).toBeNull();
    expect(searchPubMed).not.toHaveBeenCalled();
    expect(searchCrossref).not.toHaveBeenCalled();
  });

  it('falls through to Crossref when PubMed throws (best-effort)', async () => {
    const deps: SuggestDeps = {
      searchPubMed: vi.fn(async () => {
        throw new Error('NCBI down');
      }) as SuggestDeps['searchPubMed'],
      searchCrossref: vi.fn(async () => [
        { doi: '10.1016/j.x', title: TITLE, journal: 'IJROBP', year: '2024', score: 50 },
      ]) as SuggestDeps['searchCrossref'],
    };
    const s = await suggestAccessibleSource({ pageTitle: TITLE }, deps);
    expect(s!.source).toBe('crossref');
  });

  it('returns null when neither source has a confident match', async () => {
    const deps: SuggestDeps = {
      searchPubMed: vi.fn(async () => ({ pmids: [], total: 0 })) as SuggestDeps['searchPubMed'],
      searchCrossref: vi.fn(async () => []) as SuggestDeps['searchCrossref'],
    };
    expect(await suggestAccessibleSource({ pageTitle: TITLE }, deps)).toBeNull();
  });
});

describe('formatSuggestionReply', () => {
  it('renders the citation, the link, a forward-to-confirm cue, and no em dash', () => {
    const reply = formatSuggestionReply('fetch refused: HTTP 403', {
      title: TITLE,
      journal: 'Int J Radiat Oncol Biol Phys',
      year: '2024',
      url: 'https://pubmed.ncbi.nlm.nih.gov/38123456/',
      source: 'pubmed',
      identifier: '38123456',
      score: 1,
    });
    expect(reply).toContain('https://pubmed.ncbi.nlm.nih.gov/38123456/');
    expect(reply).toContain(TITLE);
    expect(reply).toContain('Int J Radiat Oncol Biol Phys 2024');
    expect(reply).toMatch(/forward/i);
    expect(reply).toMatch(/DOI or PMID/i);
    expect(reply).not.toContain('—'); // VOICE: no em dashes
  });
});
