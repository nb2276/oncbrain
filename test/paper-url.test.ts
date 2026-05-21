import { describe, it, expect } from 'vitest';
import { classifyPaperTarget, extractPaperUrls } from '../src/lib/paper-url.ts';

describe('classifyPaperTarget', () => {
  it('bare digits → pmid', () => {
    expect(classifyPaperTarget('42144018')).toEqual({ kind: 'pmid', value: '42144018' });
  });
  it('pubmed URL → pmid', () => {
    expect(classifyPaperTarget('https://pubmed.ncbi.nlm.nih.gov/42144018/')).toEqual({
      kind: 'pmid',
      value: '42144018',
    });
  });
  it('PMC URL (legacy host) → pmc', () => {
    expect(classifyPaperTarget('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9876543/')).toEqual({
      kind: 'pmc',
      value: 'PMC9876543',
    });
  });
  it('PMC URL (current pmc.ncbi host) → pmc', () => {
    expect(classifyPaperTarget('https://pmc.ncbi.nlm.nih.gov/articles/PMC10326730/')).toEqual({
      kind: 'pmc',
      value: 'PMC10326730',
    });
  });
  it('doi.org URL → normalized doi', () => {
    expect(classifyPaperTarget('https://doi.org/10.1056/NEJMoa2024001')).toEqual({
      kind: 'doi',
      value: '10.1056/nejmoa2024001',
    });
  });
  it('bare DOI → normalized doi', () => {
    expect(classifyPaperTarget('10.1016/S1470-2045(26)00091-4')).toEqual({
      kind: 'doi',
      value: '10.1016/s1470-2045(26)00091-4',
    });
  });
  it('journal URL → url (needs fetch)', () => {
    const r = classifyPaperTarget('https://www.thelancet.com/journals/lanonc/article/PIIS1470/fulltext');
    expect(r?.kind).toBe('url');
  });
  it('rejects a tweet URL', () => {
    expect(classifyPaperTarget('https://x.com/foo/status/123')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(classifyPaperTarget('hello world')).toBeNull();
  });
});

describe('extractPaperUrls', () => {
  it('pulls a DOI URL', () => {
    expect(extractPaperUrls('great paper https://doi.org/10.1056/NEJMoa1 worth a read')).toEqual([
      'https://doi.org/10.1056/NEJMoa1',
    ]);
  });
  it('pulls a journal URL', () => {
    const urls = extractPaperUrls('https://www.nejm.org/doi/full/10.1056/NEJMoa2024001');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('nejm.org');
  });
  it('pulls a PMC URL (legacy host)', () => {
    expect(extractPaperUrls('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/')).toHaveLength(1);
  });
  it('pulls a PMC URL (current pmc.ncbi host)', () => {
    expect(extractPaperUrls('https://pmc.ncbi.nlm.nih.gov/articles/PMC10326730/')).toHaveLength(1);
  });
  it('skips pubmed URLs (handled by extractPaperPmids)', () => {
    expect(extractPaperUrls('https://pubmed.ncbi.nlm.nih.gov/42144018/')).toEqual([]);
  });
  it('skips tweet/youtube/non-paper hosts', () => {
    expect(extractPaperUrls('https://x.com/a/status/1 and https://youtube.com/watch?v=x')).toEqual([]);
  });
  it('trims trailing punctuation off the URL', () => {
    const urls = extractPaperUrls('see https://doi.org/10.1056/NEJMoa1.');
    expect(urls[0]).toBe('https://doi.org/10.1056/NEJMoa1');
  });
  it('reads URLs from entities (text_link)', () => {
    const urls = extractPaperUrls('click here', [
      { type: 'text_link', url: 'https://www.thelancet.com/article/x/fulltext' },
    ]);
    expect(urls).toHaveLength(1);
  });
  it('returns empty for no paper URLs', () => {
    expect(extractPaperUrls('just a note, no links')).toEqual([]);
  });
});
