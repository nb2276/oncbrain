import { describe, it, expect, vi } from 'vitest';
import { fetchEuropePmc, stripJats, EuropePmcError } from '../src/lib/europepmc-client.ts';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
function xmlRes(xml: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => xml,
    json: async () => ({}),
  } as unknown as Response;
}

const coreResult = (over: Record<string, unknown> = {}) => ({
  resultList: {
    result: [
      { pmid: '42166701', pmcid: 'PMC9999999', isOpenAccess: 'Y', inEPMC: 'Y', abstractText: 'A trial abstract.', ...over },
    ],
  },
});

describe('fetchEuropePmc', () => {
  it('queries by DOI and returns core metadata + OA full text', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('fullTextXML')
        ? xmlRes('<article><body><p>Real methods and results.</p></body></article>')
        : jsonRes(coreResult()),
    ) as unknown as typeof fetch;

    const r = await fetchEuropePmc({ doi: '10.1056/x' }, { fetchImpl });
    expect(r.pmid).toBe('42166701');
    expect(r.pmcid).toBe('PMC9999999');
    expect(r.isOpenAccess).toBe(true);
    expect(r.abstract).toBe('A trial abstract.');
    expect(r.fullText).toContain('Real methods and results.');
    // DOI query is URL-encoded into the search call.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('DOI%3A%2210.1056%2Fx%22');
  });

  it('skips the full-text fetch when fullText:false', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(coreResult())) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ pmid: '42166701' }, { fetchImpl, fullText: false });
    expect(r.fullText).toBeNull();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // search only
  });

  it('does not fetch full text when the article is not in Europe PMC (inEPMC=N)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(coreResult({ inEPMC: 'N' }))) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ doi: '10.1056/x' }, { fetchImpl });
    expect(r.fullText).toBeNull();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // search only
  });

  it('does not fetch full text for an in-EPMC but non-OA article (isOpenAccess=N)', async () => {
    // Guard against storing copyrighted text: both flags are required.
    const fetchImpl = vi.fn(async () =>
      jsonRes(coreResult({ isOpenAccess: 'N', inEPMC: 'Y' })),
    ) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ doi: '10.1056/x' }, { fetchImpl });
    expect(r.fullText).toBeNull();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('keeps only the JATS <body>, dropping front/back matter', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('fullTextXML')
        ? xmlRes(
            '<article><front><article-title>FRONT TITLE</article-title></front><body><p>BODY METHODS RESULTS</p></body><back><ref-list><ref>BACK REFERENCE</ref></ref-list></back></article>',
          )
        : jsonRes(coreResult()),
    ) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ doi: '10.1056/x' }, { fetchImpl });
    expect(r.fullText).toContain('BODY METHODS RESULTS');
    expect(r.fullText).not.toContain('FRONT TITLE');
    expect(r.fullText).not.toContain('BACK REFERENCE');
  });

  it('returns null full text when the JATS has no <body> (no front/back fallback)', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('fullTextXML')
        ? xmlRes('<article><front><article-title>ONLY FRONT</article-title></front></article>')
        : jsonRes(coreResult()),
    ) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ doi: '10.1056/x' }, { fetchImpl });
    expect(r.fullText).toBeNull();
  });

  it('treats a 404 on full text as "no full text" (not an error)', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('fullTextXML') ? xmlRes('', 404) : jsonRes(coreResult()),
    ) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ doi: '10.1056/x' }, { fetchImpl });
    expect(r.fullText).toBeNull();
    expect(r.abstract).toBe('A trial abstract.');
  });

  it('returns all-null when there is no matching result', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ resultList: { result: [] } })) as unknown as typeof fetch;
    const r = await fetchEuropePmc({ pmid: '1' }, { fetchImpl });
    expect(r).toEqual({ pmid: null, pmcid: null, isOpenAccess: false, abstract: null, fullText: null });
  });

  it('throws on a rate limit', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}, 429)) as unknown as typeof fetch;
    await expect(fetchEuropePmc({ doi: '10.1234/x' }, { fetchImpl })).rejects.toMatchObject({
      name: 'EuropePmcError',
      kind: 'rate_limit',
    });
  });

  it('throws parse error with no identifier', async () => {
    await expect(fetchEuropePmc({})).rejects.toBeInstanceOf(EuropePmcError);
  });
});

describe('stripJats', () => {
  it('strips tags and entities to plain text', () => {
    expect(stripJats('<p>Hello &amp; <b>world</b></p>')).toBe('Hello world');
  });
  it('returns null for empty/tag-only input', () => {
    expect(stripJats('<p></p>')).toBeNull();
    expect(stripJats(null)).toBeNull();
  });
});
