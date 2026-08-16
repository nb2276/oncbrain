import { describe, it, expect } from 'vitest';
import {
  buildAcronymCoverageIndex,
  findPriorAcronymCoverage,
  type AcronymCoverageArtifact,
} from '../src/lib/acronym-coverage.ts';
import { extractTextAcronymKeys } from '../src/lib/study-dedup.ts';

function cov(date: string, names: string[]): AcronymCoverageArtifact {
  return {
    date,
    digest: {
      sites: [{ studies: names.map((name) => ({ name, slug: name.toLowerCase().split(/[\s(]/)[0] })) }],
    },
  };
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

  it('returns coverage strictly before the given date, carrying date/name/slug', () => {
    const prior = findPriorAcronymCoverage(idx, ['RAPCHEM'], '2026-06-09');
    expect(prior).toEqual([
      { key: 'RAPCHEM', date: '2026-05-17', name: 'RAPCHEM (BOOG 2010-03)', slug: 'rapchem' },
    ]);
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

// Regression: the acronym channel used to read a paper's TITLE only, and a
// trial's primary publication routinely does not name itself in its title. The
// full NRG-GU005 report is titled "Stereotactic Body Radiotherapy vs Moderately
// Hypofractionated IMRT for Localized Intermediate-Risk Prostate Cancer" and
// names the trial in its abstract. With the earlier GU005 card carrying no NCT
// either, a title-only read left BOTH identity channels dead and a full JAMA
// publication looked like a brand-new trial. getSubjectText now includes the
// abstract; the discussion still stays out, since that is where comparator
// acronyms live.
describe('acronym identity from a primary publication', () => {
  const TITLE =
    'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT for Localized Intermediate-Risk Prostate Cancer';
  const ABSTRACT =
    'Importance: NRG-GU005 compared SBRT with moderately hypofractionated IMRT. Trial registration: NCT03367702.';

  const idx = buildAcronymCoverageIndex([cov('2026-07-08', ['NRG-GU005'])]);

  it('finds nothing from the title alone', () => {
    expect(extractTextAcronymKeys(TITLE).size).toBe(0);
    expect(findPriorAcronymCoverage(idx, extractTextAcronymKeys(TITLE), '2026-08-14')).toEqual([]);
  });

  it('matches the earlier card once the abstract is included', () => {
    const keys = extractTextAcronymKeys(`${TITLE} ${ABSTRACT}`);
    expect(keys.has('NRGGU005')).toBe(true);
    const hits = findPriorAcronymCoverage(idx, keys, '2026-08-14');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.date).toBe('2026-07-08');
  });
});
