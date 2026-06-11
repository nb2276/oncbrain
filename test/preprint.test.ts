import { describe, it, expect } from 'vitest';
import {
  isPreprintSource,
  clampPreprintVerdict,
  PREPRINT_VERDICT_CAP,
  PREPRINT_CAP_RATIONALE,
} from '../src/lib/preprint.ts';

describe('isPreprintSource', () => {
  it('detects bioRxiv / medRxiv by DOI registrant prefix 10.1101', () => {
    expect(isPreprintSource({ doi: '10.1101/2026.01.15.425001' })).toBe(true);
    expect(isPreprintSource({ doi: '10.1101/2026.05.02.589123v2' })).toBe(true);
  });
  it('detects Research Square by DOI prefix 10.21203', () => {
    expect(isPreprintSource({ doi: '10.21203/rs.3.rs-1234567/v1' })).toBe(true);
  });
  it('tolerates a URL-form DOI', () => {
    expect(isPreprintSource({ doi: 'https://doi.org/10.1101/2026.01.15.425001' })).toBe(true);
    expect(isPreprintSource({ doi: 'http://dx.doi.org/10.1101/2026.01.15.425001' })).toBe(true);
  });
  it('detects by host when the DOI is absent (exact host or subdomain only)', () => {
    expect(isPreprintSource({ url: 'https://www.medrxiv.org/content/10.1101/2026.01.15v1' })).toBe(true);
    expect(isPreprintSource({ url: 'https://medrxiv.org/content/abc' })).toBe(true); // bare host
    expect(isPreprintSource({ url: 'https://www.biorxiv.org/content/abc' })).toBe(true);
    expect(isPreprintSource({ url: 'https://www.researchsquare.com/article/rs-1234567/v1' })).toBe(true);
  });
  it('does NOT match a spoofed / wrong-TLD host', () => {
    expect(isPreprintSource({ url: 'https://medrxiv.org.evil.com/x' })).toBe(false); // suffix spoof
    expect(isPreprintSource({ url: 'https://medrxiv.com/x' })).toBe(false); // wrong TLD
    expect(isPreprintSource({ url: 'https://biorxiv.net/x' })).toBe(false);
    expect(isPreprintSource({ url: 'https://researchsquare.org/x' })).toBe(false); // it's .com
    expect(isPreprintSource({ url: 'not a url' })).toBe(false);
    expect(isPreprintSource({ url: 'https://www.thelancet.com/medrxiv-summary' })).toBe(false);
  });
  it('detects by journal/source name when DOI + URL are absent', () => {
    expect(isPreprintSource({ journal: 'medRxiv' })).toBe(true);
    expect(isPreprintSource({ journal: 'Research Square' })).toBe(true);
  });
  it('does NOT flag a peer-reviewed journal', () => {
    expect(isPreprintSource({ doi: '10.1056/NEJMoa2034567', journal: 'N Engl J Med' })).toBe(false);
    expect(isPreprintSource({ doi: '10.1200/JCO.25.01234', journal: 'J Clin Oncol' })).toBe(false);
    expect(isPreprintSource({ url: 'https://www.thelancet.com/article/abc' })).toBe(false);
  });
  it('empty / null inputs are not preprints', () => {
    expect(isPreprintSource({})).toBe(false);
    expect(isPreprintSource({ doi: null, journal: null, url: null })).toBe(false);
    expect(isPreprintSource({ doi: '' })).toBe(false);
  });
  it('does not false-positive on a prefix that merely contains the digits', () => {
    // 10.11016 is a different registrant; only an exact 10.1101 registrant counts.
    expect(isPreprintSource({ doi: '10.11016/j.foo.2026' })).toBe(false);
  });
});

describe('clampPreprintVerdict', () => {
  const v = (soc: string) => ({ soc_implication: soc as never, rationale: 'orig reasoning', audience: null });

  it('caps the three peer-reviewed-strength verdicts at early-signal + rewrites the rationale', () => {
    for (const soc of ['practice-changing', 'challenges-soc', 'confirmatory']) {
      const out = clampPreprintVerdict(v(soc))!;
      expect(out.soc_implication).toBe(PREPRINT_VERDICT_CAP);
      expect(out.rationale).toBe(PREPRINT_CAP_RATIONALE);
      expect(out.rationale).not.toContain('orig reasoning'); // over-confident reasoning dropped
    }
  });
  it('leaves already-restrained verdicts untouched (verdict + rationale)', () => {
    for (const soc of ['early-signal', 'methodologically-limited', 'unclear']) {
      const out = clampPreprintVerdict(v(soc))!;
      expect(out.soc_implication).toBe(soc);
      expect(out.rationale).toBe('orig reasoning');
    }
  });
  it('passes through null / undefined', () => {
    expect(clampPreprintVerdict(undefined)).toBeUndefined();
    expect(clampPreprintVerdict(null)).toBeNull();
  });
});
