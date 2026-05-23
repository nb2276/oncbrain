import { describe, it, expect, vi } from 'vitest';
import { backfillOpenAccess } from '../src/lib/oa-enrichment.ts';
import type { EuropePmcResult } from '../src/lib/europepmc-client.ts';

const epmc = (over: Partial<EuropePmcResult> = {}): EuropePmcResult => ({
  pmid: null,
  pmcid: null,
  isOpenAccess: false,
  abstract: null,
  fullText: null,
  ...over,
});

describe('backfillOpenAccess', () => {
  it('makes no calls when abstract and full text are already present', async () => {
    const europePmc = vi.fn();
    const openAlex = vi.fn();
    const r = await backfillOpenAccess(
      { doi: '10.1/x', pmid: null, abstract: 'have it', fulltext: 'have it too' },
      { europePmc, openAlex },
    );
    expect(europePmc).not.toHaveBeenCalled();
    expect(openAlex).not.toHaveBeenCalled();
    expect(r.abstract).toBe('have it');
  });

  it('makes no calls when there is no DOI or PMID to query', async () => {
    const europePmc = vi.fn();
    const openAlex = vi.fn();
    const r = await backfillOpenAccess(
      { doi: null, pmid: null, abstract: null, fulltext: null },
      { europePmc, openAlex },
    );
    expect(europePmc).not.toHaveBeenCalled();
    expect(r.abstract).toBeNull();
  });

  it('fills abstract + full text from Europe PMC', async () => {
    const europePmc = vi.fn(async () => epmc({ abstract: 'epmc abstract', fullText: 'epmc body' }));
    const openAlex = vi.fn();
    const r = await backfillOpenAccess(
      { doi: '10.1/x', pmid: null, abstract: null, fulltext: null },
      { europePmc, openAlex },
    );
    expect(r.abstract).toBe('epmc abstract');
    expect(r.fulltext).toBe('epmc body');
    expect(r.filled).toEqual({ abstract: 'europepmc', fulltext: 'europepmc' });
    expect(openAlex).not.toHaveBeenCalled(); // abstract already filled
  });

  it('falls back to OpenAlex for the abstract when Europe PMC has none', async () => {
    const europePmc = vi.fn(async () => epmc({ abstract: null, fullText: null }));
    const openAlex = vi.fn(async () => ({ abstract: 'openalex abstract' }));
    const r = await backfillOpenAccess(
      { doi: '10.1/x', pmid: null, abstract: null, fulltext: null },
      { europePmc, openAlex },
    );
    expect(r.abstract).toBe('openalex abstract');
    expect(r.filled.abstract).toBe('openalex');
  });

  it('does not call OpenAlex when there is no DOI (PMID-only)', async () => {
    const europePmc = vi.fn(async () => epmc());
    const openAlex = vi.fn();
    const r = await backfillOpenAccess(
      { doi: null, pmid: '123', abstract: null, fulltext: null },
      { europePmc, openAlex },
    );
    expect(openAlex).not.toHaveBeenCalled();
    expect(r.abstract).toBeNull();
  });

  it('is best-effort: a thrown Europe PMC error degrades to no backfill', async () => {
    const europePmc = vi.fn(async () => {
      throw new Error('network down');
    });
    const openAlex = vi.fn(async () => ({ abstract: 'openalex saved us' }));
    const r = await backfillOpenAccess(
      { doi: '10.1/x', pmid: null, abstract: null, fulltext: null },
      { europePmc, openAlex },
    );
    expect(r.abstract).toBe('openalex saved us');
  });

  it('keeps an existing abstract and only fills the missing full text', async () => {
    const europePmc = vi.fn(async () => epmc({ abstract: 'should be ignored', fullText: 'new body' }));
    const r = await backfillOpenAccess(
      { doi: '10.1/x', pmid: null, abstract: 'original abstract', fulltext: null },
      { europePmc, openAlex: vi.fn() },
    );
    expect(r.abstract).toBe('original abstract');
    expect(r.fulltext).toBe('new body');
    expect(r.filled.abstract).toBeNull();
  });
});
