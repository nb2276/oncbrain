import { describe, it, expect } from 'vitest';
import { extractCitations, linkifyCitations } from '../src/lib/extract.ts';

describe('extractCitations', () => {
  describe('NCT trial numbers', () => {
    it('extracts a single NCT number', () => {
      const result = extractCitations('Results from NCT04567890 are practice-changing.');
      expect(result).toEqual([
        { kind: 'nct', id: 'NCT04567890', url: 'https://clinicaltrials.gov/study/NCT04567890' },
      ]);
    });

    it('extracts multiple NCT numbers', () => {
      const result = extractCitations('Comparing NCT01234567 to NCT99887766');
      expect(result.filter((c) => c.kind === 'nct')).toHaveLength(2);
    });

    it('deduplicates repeated NCTs', () => {
      const result = extractCitations('NCT00000001 appears here. And NCT00000001 again.');
      expect(result.filter((c) => c.kind === 'nct')).toHaveLength(1);
    });

    it('normalizes case to uppercase', () => {
      const result = extractCitations('nct04567890 lowercase form');
      expect(result[0]!.id).toBe('NCT04567890');
    });

    it('requires exactly 8 digits — rejects 7 or 9', () => {
      expect(extractCitations('NCT1234567 too short')).toEqual([]);
      // 9 digits: regex matches first 8, leaving a trailing digit. That trailing
      // digit means the match isn't bounded by \b on the right, so it should fail.
      const nine = extractCitations('NCT123456789 too long');
      expect(nine.filter((c) => c.kind === 'nct')).toEqual([]);
    });

    it('rejects bare 8-digit numbers without NCT prefix', () => {
      expect(extractCitations('Patient cohort of 12345678 people')).toEqual([]);
    });
  });

  describe('PubMed IDs', () => {
    it('extracts PMID with colon separator', () => {
      const result = extractCitations('See PMID: 12345678 for details.');
      expect(result).toContainEqual({
        kind: 'pubmed',
        id: '12345678',
        url: 'https://pubmed.ncbi.nlm.nih.gov/12345678',
      });
    });

    it('extracts PMID with space separator', () => {
      const result = extractCitations('PMID 87654321 supports this.');
      expect(result).toHaveLength(1);
      expect(result[0]!.kind).toBe('pubmed');
    });

    it('extracts "PubMed:" form', () => {
      const result = extractCitations('PubMed: 11122233 has the original paper.');
      expect(result[0]!.kind).toBe('pubmed');
      expect(result[0]!.id).toBe('11122233');
    });

    it('rejects bare numbers without PMID/PubMed prefix', () => {
      expect(extractCitations('The study enrolled 12345678 patients')).toEqual([]);
    });

    it('rejects PMIDs shorter than 4 digits', () => {
      expect(extractCitations('PMID: 12 too short')).toEqual([]);
    });
  });

  describe('DOIs', () => {
    it('extracts a doi: prefixed DOI', () => {
      const result = extractCitations('doi:10.1056/NEJMoa1234567');
      expect(result[0]).toEqual({
        kind: 'doi',
        id: '10.1056/NEJMoa1234567',
        url: 'https://doi.org/10.1056/NEJMoa1234567',
      });
    });

    it('extracts a doi.org URL', () => {
      const result = extractCitations('See https://doi.org/10.1200/JCO.2026.44.16_suppl.LBA1');
      expect(result[0]!.kind).toBe('doi');
      expect(result[0]!.id).toBe('10.1200/JCO.2026.44.16_suppl.LBA1');
    });

    it('extracts dx.doi.org URLs', () => {
      const result = extractCitations('https://dx.doi.org/10.1038/s41586-024-12345-6');
      expect(result[0]!.kind).toBe('doi');
    });

    it('rejects plain "10.x/y" strings without doi prefix', () => {
      expect(extractCitations('The ratio was 10.1234/foo')).toEqual([]);
    });

    it('deduplicates DOIs case-insensitively on the identifier', () => {
      const result = extractCitations('doi:10.1056/NEJMoa1234567 and doi:10.1056/nejmoa1234567');
      expect(result.filter((c) => c.kind === 'doi')).toHaveLength(1);
    });
  });

  describe('mixed and edge cases', () => {
    it('extracts mixed NCT + PMID + DOI in one text', () => {
      const text = 'See NCT04567890, PMID: 99887766, and doi:10.1056/NEJMoa2024999 for details.';
      const result = extractCitations(text);
      expect(result).toHaveLength(3);
      expect(result.map((c) => c.kind).sort()).toEqual(['doi', 'nct', 'pubmed']);
    });

    it('returns empty array for empty input', () => {
      expect(extractCitations('')).toEqual([]);
    });

    it('returns empty array for null-ish input', () => {
      // @ts-expect-error testing defensive behavior
      expect(extractCitations(null)).toEqual([]);
    });

    it('returns empty array when nothing matches', () => {
      expect(extractCitations('Just plain text with no citations.')).toEqual([]);
    });
  });
});

describe('linkifyCitations', () => {
  it('wraps NCT in an anchor tag', () => {
    const result = linkifyCitations('See NCT04567890 for details.');
    expect(result).toContain('<a href="https://clinicaltrials.gov/study/NCT04567890"');
    expect(result).toContain('>NCT04567890</a>');
  });

  it('escapes HTML in surrounding text', () => {
    const result = linkifyCitations('<script>alert("xss")</script> NCT00000001');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
    expect(result).toContain('<a href');
  });

  it('handles text with no citations', () => {
    expect(linkifyCitations('No citations here.')).toBe('No citations here.');
  });

  it('handles empty input', () => {
    expect(linkifyCitations('')).toBe('');
  });

  it('linkifies multiple citations of different kinds', () => {
    const result = linkifyCitations('NCT01234567 and PMID: 99887766');
    const anchors = result.match(/<a /g) || [];
    expect(anchors).toHaveLength(2);
  });

  it('does not double-wrap overlapping matches', () => {
    // edge case: an NCT inside a longer block of text should still produce exactly one anchor
    const result = linkifyCitations('NCT04567890');
    const anchors = result.match(/<a /g) || [];
    expect(anchors).toHaveLength(1);
  });
});
