import { describe, it, expect, vi } from 'vitest';
import { parsePdfMeta, extractPaperMetaFromText } from '../src/lib/pdf-meta.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';

describe('parsePdfMeta', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      title: 'A Randomized Trial',
      authors: ['Smith J', 'Doe A'],
      journal: 'NEJM',
      pub_date: '2026',
      doi: '10.1056/x',
      pmid: '123456',
      abstract: 'Background: ...',
      disease_site: 'prostate',
    });
    const m = parsePdfMeta(raw);
    expect(m.title).toBe('A Randomized Trial');
    expect(m.authors).toEqual(['Smith J', 'Doe A']);
    expect(m.journal).toBe('NEJM');
    expect(m.disease_site).toBe('prostate');
    expect(m.doi).toBe('10.1056/x');
    expect(m.pmid).toBe('123456');
  });

  it('falls back disease_site to "other" for an invalid slug', () => {
    const m = parsePdfMeta(JSON.stringify({ title: 'X', disease_site: 'not-a-site' }));
    expect(m.disease_site).toBe('other');
  });

  it('uses a text-derived title when the LLM omits one', () => {
    const m = parsePdfMeta(JSON.stringify({ authors: [] }), 'A Long Enough First Line\nbody text');
    expect(m.title).toBe('A Long Enough First Line');
  });

  it('degrades to minimal meta on malformed JSON', () => {
    const m = parsePdfMeta('this is not json', 'Salvageable Title Line here');
    expect(m.title).toBe('Salvageable Title Line here');
    expect(m.disease_site).toBe('other');
    expect(m.doi).toBeNull();
    expect(m.authors).toEqual([]);
  });

  it('normalizes a doi.org-prefixed DOI', () => {
    const m = parsePdfMeta(JSON.stringify({ title: 'X', doi: 'https://doi.org/10.1056/ABC' }));
    expect(m.doi).toBe('10.1056/abc');
  });

  it('rejects a non-numeric pmid', () => {
    const m = parsePdfMeta(JSON.stringify({ title: 'X', pmid: 'not-a-pmid' }));
    expect(m.pmid).toBeNull();
  });

  it('normalizes pub_date to YYYY when given a longer string', () => {
    const m = parsePdfMeta(JSON.stringify({ title: 'X', pub_date: 'Published 2026 May' }));
    expect(m.pub_date).toBe('2026');
  });
});

describe('extractPaperMetaFromText (regex backstop)', () => {
  const fakeClient = (response: string): LlmClient =>
    ({ complete: vi.fn(async () => response) }) as unknown as LlmClient;

  it('fills a DOI the LLM missed from the raw text', async () => {
    const client = fakeClient(JSON.stringify({ title: 'X', authors: [], disease_site: 'other' }));
    const m = await extractPaperMetaFromText(
      'Body ... available at https://doi.org/10.1056/NEJMoa2034577 ... end',
      { client },
    );
    expect(m.doi).toBe('10.1056/nejmoa2034577');
  });

  it('fills a PMID the LLM missed from the raw text', async () => {
    const client = fakeClient(JSON.stringify({ title: 'X', authors: [], disease_site: 'other' }));
    const m = await extractPaperMetaFromText('footer ... PMID: 40123456 ...', { client });
    expect(m.pmid).toBe('40123456');
  });

  it('keeps the LLM DOI when present (no backstop override)', async () => {
    const client = fakeClient(
      JSON.stringify({ title: 'X', authors: [], doi: '10.1000/fromllm', disease_site: 'breast' }),
    );
    const m = await extractPaperMetaFromText('no identifiers in this text', { client });
    expect(m.doi).toBe('10.1000/fromllm');
    expect(m.disease_site).toBe('breast');
  });
});
