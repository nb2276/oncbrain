import { describe, it, expect, vi } from 'vitest';
import { fetchOpenAlex, abstractFromInvertedIndex, OpenAlexError } from '../src/lib/openalex-client.ts';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('abstractFromInvertedIndex', () => {
  it('reconstructs prose in position order', () => {
    const inv = { Trial: [0], showed: [1], no: [2, 5], benefit: [3], with: [4], harm: [6] };
    expect(abstractFromInvertedIndex(inv)).toBe('Trial showed no benefit with no harm');
  });
  it('returns null for empty/missing index', () => {
    expect(abstractFromInvertedIndex({})).toBeNull();
    expect(abstractFromInvertedIndex(null)).toBeNull();
    expect(abstractFromInvertedIndex(undefined)).toBeNull();
  });
  it('ignores malformed position arrays', () => {
    expect(abstractFromInvertedIndex({ word: 'nope' as unknown as number[] })).toBeNull();
  });
});

describe('fetchOpenAlex', () => {
  it('returns the reconstructed abstract for a DOI', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ abstract_inverted_index: { Hello: [0], world: [1] } }),
    ) as unknown as typeof fetch;
    const r = await fetchOpenAlex('10.1234/x', { fetchImpl });
    expect(r.abstract).toBe('Hello world');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('mailto=');
  });

  it('returns null abstract when OpenAlex has no inverted index', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({})) as unknown as typeof fetch;
    const r = await fetchOpenAlex('10.1234/x', { fetchImpl });
    expect(r.abstract).toBeNull();
  });

  it('throws not_found on 404', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}, 404)) as unknown as typeof fetch;
    await expect(fetchOpenAlex('10.1234/x', { fetchImpl })).rejects.toMatchObject({
      name: 'OpenAlexError',
      kind: 'not_found',
    });
  });

  it('throws network error on a thrown fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(fetchOpenAlex('10.1234/x', { fetchImpl })).rejects.toBeInstanceOf(OpenAlexError);
  });

  it('rejects a malformed DOI at the boundary without fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchOpenAlex('not-a-doi', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({
      name: 'OpenAlexError',
      kind: 'parse',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
