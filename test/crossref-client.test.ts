import { describe, it, expect } from 'vitest';
import { fetchCrossrefPaper, parseCrossrefWork, CrossrefError } from '../src/lib/crossref-client.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('parseCrossrefWork', () => {
  it('parses title, authors, journal, date', () => {
    const p = parseCrossrefWork(
      {
        title: ['A randomized trial of X'],
        author: [
          { given: 'Jane', family: 'Doe' },
          { given: 'John', family: 'Smith' },
        ],
        'container-title': ['Journal of Oncology'],
        published: { 'date-parts': [[2026, 5, 17]] },
      },
      '10.1056/x',
    );
    expect(p.title).toBe('A randomized trial of X');
    expect(p.authors).toEqual([{ name: 'Doe, Jane' }, { name: 'Smith, John' }]);
    expect(p.journal).toBe('Journal of Oncology');
    expect(p.pub_date).toBe('2026-05-17');
  });

  it('handles missing abstract (the common case)', () => {
    const p = parseCrossrefWork({ title: ['t'] }, '10.1056/x');
    expect(p.abstract).toBeNull();
  });

  it('strips JATS tags from an abstract when present', () => {
    const p = parseCrossrefWork(
      { title: ['t'], abstract: '<jats:p>Background: <jats:bold>RT</jats:bold> works.</jats:p>' },
      '10.1056/x',
    );
    expect(p.abstract).toBe('Background: RT works.');
  });

  it('handles year-only date', () => {
    const p = parseCrossrefWork({ published: { 'date-parts': [[2025]] } }, '10.1056/x');
    expect(p.pub_date).toBe('2025');
  });

  it('handles literal author name field', () => {
    const p = parseCrossrefWork({ author: [{ name: 'The TROG Collaborative' }] }, '10.1056/x');
    expect(p.authors).toEqual([{ name: 'The TROG Collaborative' }]);
  });
});

describe('fetchCrossrefPaper', () => {
  it('fetches + parses a 200', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: { title: ['Paper'], 'container-title': ['J'] } })) as unknown as typeof fetch;
    const p = await fetchCrossrefPaper('10.1056/NEJMoa1', { fetchImpl });
    expect(p.title).toBe('Paper');
    expect(p.doi).toBe('10.1056/nejmoa1');
  });

  it('sends the polite User-Agent with mailto', async () => {
    let seenUA = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenUA = (init.headers as Record<string, string>)['User-Agent'];
      return jsonResponse({ message: { title: ['x'] } });
    }) as unknown as typeof fetch;
    await fetchCrossrefPaper('10.1056/x', { fetchImpl });
    expect(seenUA).toContain('mailto:');
  });

  it('throws not_found on 404', async () => {
    const fetchImpl = (async () => jsonResponse({}, 404)) as unknown as typeof fetch;
    await expect(fetchCrossrefPaper('10.1056/missing', { fetchImpl })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('throws rate_limit on 429', async () => {
    const fetchImpl = (async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    await expect(fetchCrossrefPaper('10.1056/x', { fetchImpl })).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('rejects a non-DOI input', async () => {
    await expect(fetchCrossrefPaper('not-a-doi')).rejects.toBeInstanceOf(CrossrefError);
  });
});
