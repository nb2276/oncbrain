import { describe, it, expect } from 'vitest';
import { normalizeDoi, isBareDoi, extractDois } from '../src/lib/doi.ts';

describe('normalizeDoi', () => {
  it('returns null for empty/garbage', () => {
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi('')).toBeNull();
    expect(normalizeDoi('not a doi')).toBeNull();
  });

  it('passes a bare DOI through, lowercased', () => {
    expect(normalizeDoi('10.1016/S1470-2045(26)00091-4')).toBe('10.1016/s1470-2045(26)00091-4');
  });

  it('strips the doi.org URL wrapper', () => {
    expect(normalizeDoi('https://doi.org/10.1056/NEJMoa2024001')).toBe('10.1056/nejmoa2024001');
    expect(normalizeDoi('http://dx.doi.org/10.1056/NEJMoa2024001')).toBe('10.1056/nejmoa2024001');
  });

  it('strips the "doi:" prefix', () => {
    expect(normalizeDoi('doi: 10.1001/jama.2026.1234')).toBe('10.1001/jama.2026.1234');
  });

  it('trims trailing sentence punctuation', () => {
    expect(normalizeDoi('see 10.1001/jama.2026.1234.')).toBe('10.1001/jama.2026.1234');
    expect(normalizeDoi('(10.1001/jama.2026.1234)')).toBe('10.1001/jama.2026.1234');
  });

  it('is idempotent — the index and lookup paths must agree', () => {
    const once = normalizeDoi('https://doi.org/10.1016/S1470-2045(26)00091-4');
    const twice = normalizeDoi(once);
    expect(twice).toBe(once);
  });

  it('two spellings of the same DOI normalize identically (dedup invariant)', () => {
    const a = normalizeDoi('10.1016/S1470-2045(26)00091-4');
    const b = normalizeDoi('https://doi.org/10.1016/s1470-2045(26)00091-4');
    expect(a).toBe(b);
  });

  it('extracts a DOI embedded in a publisher article URL', () => {
    expect(normalizeDoi('https://onlinelibrary.wiley.com/doi/10.3322/caac.70082')).toBe(
      '10.3322/caac.70082',
    );
    expect(normalizeDoi('https://www.nejm.org/doi/full/10.1056/NEJMoa2024001')).toBe(
      '10.1056/nejmoa2024001',
    );
    expect(normalizeDoi('https://ascopubs.org/doi/full/10.1200/JCO.23.01234')).toBe(
      '10.1200/jco.23.01234',
    );
  });

  it('strips a single trailing publisher view-mode token (/pdf, /full, /abstract)', () => {
    expect(normalizeDoi('https://onlinelibrary.wiley.com/doi/10.1002/cncr.34567/pdf')).toBe(
      '10.1002/cncr.34567',
    );
    expect(normalizeDoi('https://www.nejm.org/doi/10.1056/NEJMoa2024001/full')).toBe(
      '10.1056/nejmoa2024001',
    );
    expect(normalizeDoi('10.1002/cncr.34567/abstract')).toBe('10.1002/cncr.34567');
  });

  it('strips stacked trailing publisher tokens (/full/abstract)', () => {
    expect(normalizeDoi('10.1056/NEJMoa2024001/full/abstract')).toBe('10.1056/nejmoa2024001');
    expect(normalizeDoi('https://example.com/doi/10.1234/x/epdf/references')).toBe('10.1234/x');
  });

  it('decodes %2F-encoded slashes inside the DOI', () => {
    expect(normalizeDoi('https://onlinelibrary.wiley.com/doi/10.1002%2Fcncr.34567')).toBe(
      '10.1002/cncr.34567',
    );
    // Mixed case: %2f also decoded
    expect(normalizeDoi('10.1002%2fcncr.34567')).toBe('10.1002/cncr.34567');
  });

  it('drops a query string or fragment after the DOI', () => {
    expect(normalizeDoi('https://ahajournals.org/doi/10.1161/CIR.0000000000001?af=R')).toBe(
      '10.1161/cir.0000000000001',
    );
    expect(normalizeDoi('https://example.com/doi/10.1056/x#section-2')).toBe('10.1056/x');
  });

  it('four spellings of the same DOI all collapse to one key (dedup invariant)', () => {
    // The whole point: a paper forwarded twice as different URL variants
    // must produce identical dedup keys, or the papers UNIQUE index splits.
    const variants = [
      '10.1002/cncr.34567',
      'doi:10.1002/cncr.34567',
      'https://doi.org/10.1002/cncr.34567',
      'https://onlinelibrary.wiley.com/doi/10.1002/cncr.34567/pdf',
      'https://onlinelibrary.wiley.com/doi/10.1002%2Fcncr.34567',
    ];
    const normalized = variants.map(normalizeDoi);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('10.1002/cncr.34567');
  });
});

describe('isBareDoi', () => {
  it('true for a standalone DOI', () => {
    expect(isBareDoi('10.1056/NEJMoa2024001')).toBe(true);
  });
  it('false when embedded in prose or wrapped in a URL', () => {
    expect(isBareDoi('see 10.1056/NEJMoa2024001 for details')).toBe(false);
    expect(isBareDoi('https://doi.org/10.1056/NEJMoa2024001')).toBe(false);
  });
});

describe('extractDois', () => {
  it('pulls multiple DOIs and normalizes them', () => {
    const text = 'Compare 10.1056/NEJMoa1 with https://doi.org/10.1016/J.X and doi:10.1001/Y';
    expect(extractDois(text).sort()).toEqual(
      ['10.1001/y', '10.1016/j.x', '10.1056/nejmoa1'].sort(),
    );
  });
  it('dedupes repeated DOIs', () => {
    expect(extractDois('10.1056/A and 10.1056/A again')).toEqual(['10.1056/a']);
  });
  it('returns empty for no DOIs', () => {
    expect(extractDois('just text')).toEqual([]);
  });
});
