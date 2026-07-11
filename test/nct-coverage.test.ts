import { describe, it, expect } from 'vitest';
import { buildNctCoverageIndex, findPriorCoverage, type CoverageArtifact } from '../src/lib/nct-coverage.ts';

function cov(
  date: string,
  studies: Array<{ nct: string | null; name: string; slug?: string }>,
): CoverageArtifact {
  return { date, digest: { sites: [{ studies }] } };
}

describe('buildNctCoverageIndex', () => {
  it('keys by uppercase NCT and orders entries newest-first', () => {
    const idx = buildNctCoverageIndex([
      cov('2026-05-10', [{ nct: 'NCT01', name: 'Old name' }]),
      cov('2026-05-18', [{ nct: 'nct01', name: 'New name' }]),
    ]);
    expect(idx.get('NCT01')?.map((e) => e.date)).toEqual(['2026-05-18', '2026-05-10']);
  });

  it('ignores studies without an NCT', () => {
    const idx = buildNctCoverageIndex([cov('2026-05-18', [{ nct: null, name: 'X' }])]);
    expect(idx.size).toBe(0);
  });
});

describe('findPriorCoverage', () => {
  const idx = buildNctCoverageIndex([
    cov('2026-05-10', [{ nct: 'NCT01', name: 'PRESTIGE-PSMA', slug: 'prestige-psma' }]),
    cov('2026-05-12', [{ nct: 'NCT02', name: 'ARANOTE' }]),
  ]);

  it('returns the newest strictly-prior coverage, carrying the slug', () => {
    expect(findPriorCoverage(idx, ['NCT01'], '2026-05-18')).toEqual([
      { nct: 'NCT01', date: '2026-05-10', name: 'PRESTIGE-PSMA', slug: 'prestige-psma' },
    ]);
  });

  it('defaults slug to empty string when the study has none', () => {
    expect(findPriorCoverage(idx, ['NCT02'], '2026-05-18')[0]!.slug).toBe('');
  });

  it('excludes same-day coverage (strictly before only)', () => {
    expect(findPriorCoverage(idx, ['NCT01'], '2026-05-10')).toEqual([]);
  });

  it('returns nothing for an uncovered NCT', () => {
    expect(findPriorCoverage(idx, ['NCT99'], '2026-05-18')).toEqual([]);
  });

  it('dedupes repeated / mixed-case NCTs in the input', () => {
    expect(findPriorCoverage(idx, ['nct01', 'NCT01'], '2026-05-18')).toHaveLength(1);
  });

  it('matches multiple NCTs and orders by id', () => {
    const r = findPriorCoverage(idx, ['NCT02', 'NCT01'], '2026-05-18');
    expect(r.map((x) => x.nct)).toEqual(['NCT01', 'NCT02']);
  });
});
