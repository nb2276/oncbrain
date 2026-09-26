// A DOI that resolves via Crossref but carries no abstract (the Elsevier/Red
// Journal conference-abstract case, e.g. ASTRO's IJROBP supplement) has
// nothing for the study agent to analyze. npm run watch:doi registers it and
// re-checks nightly for a richer record instead of publishing a title-only
// stub. See build/doi-watch.ts's header for the full design.
import { describe, it, expect } from 'vitest';
import { parseWatchFileBlock, parseWatchFile, checkOne } from '../build/doi-watch.ts';
import type { DoiWatchEntry } from '../src/lib/db.ts';

describe('parseWatchFileBlock', () => {
  it('parses a trial-name line + a doi.org URL line, hashtag and all', () => {
    const block =
      'SWOG S1827 MAVERICK — MRI surveillance ± PCI, SCLC\n' +
      'https://doi.org/10.1016/j.ijrobp.2026.06.2463 #ASTRO26';
    expect(parseWatchFileBlock(block)).toEqual({
      doi: '10.1016/j.ijrobp.2026.06.2463',
      title: 'SWOG S1827 MAVERICK — MRI surveillance ± PCI, SCLC',
      note: block,
    });
  });

  it('parses a bare DOI (no URL wrapper) the same way', () => {
    const block = 'Some Trial\n10.1016/j.ijrobp.2026.02.001';
    expect(parseWatchFileBlock(block)).toMatchObject({
      doi: '10.1016/j.ijrobp.2026.02.001',
      title: 'Some Trial',
    });
  });

  it('returns null for a block with no DOI (the file header line)', () => {
    expect(
      parseWatchFileBlock('ASTRO 2026 abstract DOIs (Red Journal supplement) — one per Telegram message'),
    ).toBeNull();
  });

  it('title is null when the block is nothing but an identifier', () => {
    expect(parseWatchFileBlock('https://doi.org/10.1016/j.ijrobp.2026.06.2463')).toMatchObject({
      title: null,
    });
  });

  it('normalizes the DOI (lowercased) even when the title line mentions it in a different case', () => {
    const block = 'NEJMoa trial\nhttps://doi.org/10.1056/NEJMoa2024001';
    expect(parseWatchFileBlock(block)!.doi).toBe('10.1056/nejmoa2024001');
    // The mixed-case URL line is still correctly excluded from being picked as
    // the title (case-sensitive .includes() would have missed it).
    expect(parseWatchFileBlock(block)!.title).toBe('NEJMoa trial');
  });
});

describe('parseWatchFile', () => {
  it('splits on blank lines, skips the header, keeps every DOI block', () => {
    const content =
      'ASTRO 2026 abstract DOIs — one per message\n\n' +
      'Trial A\nhttps://doi.org/10.1016/j.ijrobp.2026.06.001 #ASTRO26\n\n' +
      'Trial B\nhttps://doi.org/10.1016/j.ijrobp.2026.06.002 #ASTRO26\n';
    const entries = parseWatchFile(content);
    expect(entries.map((e) => e.doi)).toEqual([
      '10.1016/j.ijrobp.2026.06.001',
      '10.1016/j.ijrobp.2026.06.002',
    ]);
    expect(entries.map((e) => e.title)).toEqual(['Trial A', 'Trial B']);
  });

  it('returns an empty array for a file with no DOI anywhere', () => {
    expect(parseWatchFile('just some notes\n\nnothing to see here')).toEqual([]);
  });
});

function watchEntry(overrides: Partial<DoiWatchEntry> = {}): DoiWatchEntry {
  return {
    doi: '10.1016/j.ijrobp.2026.06.2463',
    title: 'SWOG S1827 MAVERICK',
    note: null,
    added_at: Date.now(),
    last_checked_at: null,
    attempts: 0,
    ...overrides,
  };
}

describe('checkOne', () => {
  it('promotes (no title search needed) once Crossref gains an abstract on the same DOI', async () => {
    const result = await checkOne(watchEntry(), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.2463',
        title: 'SWOG S1827 MAVERICK',
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: 'Background: ... Results: ...',
      }),
      suggestAccessibleSource: async () => {
        throw new Error('must not be called — Crossref already answered');
      },
    });
    expect(result).toEqual({ kind: 'promote' });
  });

  it('still waiting: no abstract, no title anywhere to search by', async () => {
    const result = await checkOne(watchEntry({ title: null }), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.2463',
        title: null,
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: null,
      }),
    });
    expect(result).toEqual({ kind: 'waiting' });
  });

  it('searches on the REAL Crossref title, not the curator note, once it has one', async () => {
    // The curator's short trial-name note is what's stored on the watch entry,
    // but the search should use Crossref's own (longer, more specific) title —
    // that distinction is why the naive version false-matched most of the real
    // ASTRO26 list (see the module header).
    let searchedWith: string | undefined;
    const result = await checkOne(watchEntry({ title: 'GETUG P05 — brachy vs EBRT boost' }), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.018',
        title: 'GETUG-AFU P05: Prostate Brachytherapy Boost vs EBRT Boost, a Randomised Trial',
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: null,
      }),
      suggestAccessibleSource: async (input) => {
        searchedWith = input.pageTitle ?? undefined;
        return null;
      },
    });
    expect(searchedWith).toBe(
      'GETUG-AFU P05: Prostate Brachytherapy Boost vs EBRT Boost, a Randomised Trial',
    );
    expect(result).toEqual({ kind: 'waiting' });
  });

  it('a title-search hit is a SUGGESTION, never an auto-promotion', async () => {
    const suggestion = {
      title: 'SWOG S1827/MAVERICK: ...',
      journal: 'IJROBP',
      year: '2026',
      url: 'https://pubmed.ncbi.nlm.nih.gov/99999999/',
      source: 'pubmed' as const,
      identifier: '99999999',
      score: 0.9,
    };
    const result = await checkOne(watchEntry(), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.2463',
        title: 'SWOG S1827/MAVERICK: A Randomized Phase III Trial ...',
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: null,
      }),
      suggestAccessibleSource: async () => suggestion,
    });
    expect(result).toEqual({ kind: 'suggest', suggestion });
  });

  it('a Crossref-by-title hit that is just the SAME DOI is not new information', async () => {
    const result = await checkOne(watchEntry(), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.2463',
        title: 'SWOG S1827 MAVERICK',
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: null,
      }),
      suggestAccessibleSource: async () => ({
        title: 'SWOG S1827 MAVERICK',
        journal: 'IJROBP',
        year: '2026',
        url: 'https://doi.org/10.1016/j.ijrobp.2026.06.2463',
        source: 'crossref',
        identifier: '10.1016/j.ijrobp.2026.06.2463', // same doi we already watch
        score: 1,
      }),
    });
    expect(result).toEqual({ kind: 'waiting' });
  });

  it('a Crossref-by-title hit with a DIFFERENT identifier is still only a suggestion', async () => {
    const result = await checkOne(watchEntry(), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.2463',
        title: 'SWOG S1827 MAVERICK',
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: null,
      }),
      suggestAccessibleSource: async () => ({
        title: 'SWOG S1827 MAVERICK (published version)',
        journal: 'JCO',
        year: '2026',
        url: 'https://doi.org/10.1200/jco.other',
        source: 'crossref',
        identifier: '10.1200/jco.other',
        score: 0.8,
      }),
    });
    expect(result.kind).toBe('suggest');
  });

  it('is best-effort: a Crossref throw falls through to the title search on the stored note', async () => {
    const result = await checkOne(watchEntry(), {
      fetchCrossrefPaper: async () => {
        throw new Error('network blip');
      },
      suggestAccessibleSource: async () => null,
    });
    expect(result).toEqual({ kind: 'waiting' });
  });

  it('a title-search throw also degrades to waiting, not a crash', async () => {
    const result = await checkOne(watchEntry(), {
      fetchCrossrefPaper: async () => ({
        doi: '10.1016/j.ijrobp.2026.06.2463',
        title: 'SWOG S1827 MAVERICK',
        authors: [],
        journal: 'IJROBP',
        pub_date: '2026-09',
        abstract: null,
      }),
      suggestAccessibleSource: async () => {
        throw new Error('rate limited');
      },
    });
    expect(result).toEqual({ kind: 'waiting' });
  });
});
