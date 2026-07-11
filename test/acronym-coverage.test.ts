import { describe, it, expect } from 'vitest';
import {
  buildAcronymCoverageIndex,
  findPriorAcronymCoverage,
  type AcronymCoverageArtifact,
} from '../src/lib/acronym-coverage.ts';

function cov(date: string, names: string[]): AcronymCoverageArtifact {
  return { date, digest: { sites: [{ studies: names.map((name) => ({ name })) }] } };
}

describe('buildAcronymCoverageIndex', () => {
  it('keys by discriminating acronym, newest-first', () => {
    const idx = buildAcronymCoverageIndex([
      cov('2026-05-31', ['ENZARAD (ANZUP 1303)']),
      cov('2026-06-25', ['ENZARAD']),
    ]);
    expect(idx.get('ENZARAD')?.map((e) => e.date)).toEqual(['2026-06-25', '2026-05-31']);
  });

  it('skips names with no discriminating key (bare group / society)', () => {
    const idx = buildAcronymCoverageIndex([
      cov('2026-05-18', ['EORTC', 'ARS Appropriate Use Criteria: Recurrence']),
    ]);
    expect(idx.size).toBe(0);
  });
});

describe('findPriorAcronymCoverage', () => {
  const idx = buildAcronymCoverageIndex([
    cov('2026-05-17', ['RAPCHEM (BOOG 2010-03)']),
    cov('2026-05-31', ['ENZARAD (ANZUP 1303)']),
  ]);

  it('returns coverage strictly before the given date', () => {
    const prior = findPriorAcronymCoverage(idx, ['RAPCHEM'], '2026-06-09');
    expect(prior).toEqual([{ key: 'RAPCHEM', date: '2026-05-17', name: 'RAPCHEM (BOOG 2010-03)' }]);
  });

  it('excludes same-day coverage (no self-trigger on the publish day)', () => {
    expect(findPriorAcronymCoverage(idx, ['ENZARAD'], '2026-05-31')).toEqual([]);
  });

  it('returns nothing for an unknown key', () => {
    expect(findPriorAcronymCoverage(idx, ['NOTATRIAL'], '2026-07-01')).toEqual([]);
  });

  it('dedupes repeated candidate keys', () => {
    const prior = findPriorAcronymCoverage(idx, ['RAPCHEM', 'rapchem', 'RAPCHEM'], '2026-06-09');
    expect(prior).toHaveLength(1);
  });
});
