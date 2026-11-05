import { describe, expect, it } from 'vitest';
import {
  highlightParts,
  queryTokens,
  searchEntries,
  studySearchBody,
  type SearchEntry,
} from '../src/lib/search.ts';
import type { DigestStudy } from '../src/lib/digest-data.ts';

function entry(over: Partial<SearchEntry>): SearchEntry {
  return {
    date: '2026-11-01',
    site: 'prostate',
    site_label: 'Prostate',
    site_emoji: '',
    site_rationale: '',
    name: 'X',
    slug: 'x',
    tldr: '',
    nct: null,
    body: '',
    ...over,
  };
}

describe('studySearchBody', () => {
  it('collects every text surface of a card', () => {
    const study = {
      name: 'DASL-HiCaP',
      tldr: 'MFS HR 0.42.',
      details: [
        'plain bullet darolutamide',
        { text: 'nested', subdetails: ['pelvic nodal RT'] },
        { text: 'table', table: { columns: ['Arm', 'MFS'], rows: [['Daro', '95%']] } },
      ],
      primary_endpoint: { name: 'Metastasis-free survival', klass: 'surrogate', stat_value: 'HR 0.42', stat_detail: '0.27-0.66' },
      analysis_sections: [{ label: 'Radiotherapy', body: 'Salvage or definitive RT' }],
      significance: 'Why it matters text',
      significance_by_specialty: { medonc: 'medonc read' },
      discussed_trials: ['ENZARAD'],
      doi: '10.1000/xyz',
      nct: null,
      tweet_ids: [],
    } as unknown as DigestStudy;
    const body = studySearchBody(study, 'ESMO Congress 2026');
    for (const s of [
      'MFS HR 0.42.',
      'darolutamide',
      'pelvic nodal RT',
      'Daro 95%',
      'Metastasis-free survival',
      'Salvage or definitive RT',
      'Why it matters text',
      'medonc read',
      'ENZARAD',
      '10.1000/xyz',
      'ESMO Congress 2026',
    ]) {
      expect(body).toContain(s);
    }
  });
});

describe('searchEntries', () => {
  const titleHit = entry({ slug: 'title', name: 'Prostate SBRT hypofractionation trial' });
  const bodyHit = entry({
    slug: 'body',
    name: 'PACE-C',
    tldr: 'Short TL;DR without the words.',
    body: 'Short TL;DR without the words. In the analysis, moderate hypofractionation was the comparator arm for prostate RT.',
  });
  const miss = entry({ slug: 'miss', name: 'Breast trial', body: 'hypofractionation in breast' , site_label: 'Breast'});

  it('finds a card whose match is only in the body text', () => {
    const hits = searchEntries('hypofractionation', [bodyHit]);
    expect(hits.map((h) => h.entry.slug)).toEqual(['body']);
    expect(hits[0]!.snippet).toContain('hypofractionation');
  });

  it('requires every word, in any order, across fields', () => {
    const slugs = searchEntries('prostate hypofractionation', [titleHit, bodyHit, miss]).map((h) => h.entry.slug);
    expect(slugs).toContain('title');
    expect(slugs).toContain('body');
    expect(slugs).not.toContain('miss'); // has hypofractionation, not prostate
  });

  it('ranks a title match above a body-only match', () => {
    const slugs = searchEntries('hypofractionation', [bodyHit, titleHit]).map((h) => h.entry.slug);
    expect(slugs).toEqual(['title', 'body']);
  });

  it('keeps index order (newest first) on equal scores', () => {
    const a = entry({ slug: 'a', body: 'enzalutamide' });
    const b = entry({ slug: 'b', body: 'enzalutamide' });
    expect(searchEntries('enzalutamide', [a, b]).map((h) => h.entry.slug)).toEqual(['a', 'b']);
  });

  it('shows no snippet when the row already shows every match', () => {
    const hits = searchEntries('sbrt', [titleHit]);
    expect(hits[0]!.snippet).toBeNull();
  });

  it('still matches NCT and site label', () => {
    const e = entry({ slug: 'n', nct: 'NCT04214067' });
    expect(searchEntries('nct04214067', [e])).toHaveLength(1);
    expect(searchEntries('prostate', [e])).toHaveLength(1);
  });

  it('returns nothing for a blank query', () => {
    expect(searchEntries('   ', [titleHit])).toEqual([]);
  });
});

describe('queryTokens / highlightParts', () => {
  it('dedupes and lowercases tokens', () => {
    expect(queryTokens('  SBRT sbrt Prostate ')).toEqual(['sbrt', 'prostate']);
  });

  it('marks hits case-insensitively and leaves markup to the caller', () => {
    const parts = highlightParts('PSMA <b> psma', ['psma']);
    expect(parts).toEqual([
      { text: 'PSMA', hit: true },
      { text: ' <b> ', hit: false },
      { text: 'psma', hit: true },
    ]);
  });

  it('treats regex characters in a query literally', () => {
    const parts = highlightParts('HR 0.42 (0.27-0.66)', ['(0.27']);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['(0.27']);
  });
});
