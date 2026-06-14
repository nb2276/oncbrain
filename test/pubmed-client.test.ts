import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchPubMedPaper,
  parsePubMedArticleXml,
  parseAbstractFromXml,
  extractMethodsAndResults,
  searchPubMed,
  summarizePmids,
  _resetNcbiThrottleForTests,
  PubMedClientError,
} from '../src/lib/pubmed-client.ts';

const SAMPLE_PUBMED_XML = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation>
    <PMID Version="1">42139645</PMID>
    <Article>
      <Journal>
        <Title>Journal of Clinical Oncology</Title>
      </Journal>
      <ArticleTitle>Overall Survival Among Patients With Hepatocellular Carcinoma Treated With External Beam Radiation Therapy</ArticleTitle>
      <Abstract>
        <AbstractText Label="PURPOSE">To evaluate OS in HCC pts treated with EBRT.</AbstractText>
        <AbstractText Label="METHODS">Individual patient data pooled from N=27 cohorts.</AbstractText>
        <AbstractText Label="RESULTS">Median OS 14.2 mo (95% CI 12.4-16.0).</AbstractText>
      </Abstract>
      <AuthorList>
        <Author><LastName>Moon</LastName><Initials>AM</Initials></Author>
        <Author><LastName>Yanagihara</LastName><Initials>TK</Initials></Author>
        <CollectiveName>EBRT Collaboration Group</CollectiveName>
      </AuthorList>
      <PubDate>
        <Year>2026</Year>
        <Month>May</Month>
        <Day>15</Day>
      </PubDate>
    </Article>
    <MeshHeadingList>
      <MeshHeading><DescriptorName>Carcinoma, Hepatocellular</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName>Radiotherapy</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList>
      <ArticleId IdType="pubmed">42139645</ArticleId>
      <ArticleId IdType="doi">10.1200/JCO-25-02399</ArticleId>
      <ArticleId IdType="pmc">PMC9999999</ArticleId>
    </ArticleIdList>
  </PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

const SAMPLE_PMC_XML = `<?xml version="1.0" ?>
<pmc-articleset>
<article>
  <body>
    <sec sec-type="methods">
      <title>Methods</title>
      <p>Individual patient data from 27 multinational cohorts spanning 2001-2023 were collated and analyzed.</p>
      <p>EBRT regimens included SBRT (35-50 Gy in 5 fractions), conventional (45-60 Gy in 25-30 fractions), and hypofractionated.</p>
    </sec>
    <sec sec-type="results">
      <title>Results</title>
      <p>Median OS was 14.2 months (95% CI 12.4-16.0).</p>
      <p>SBRT cohort showed mOS 16.8 months <xref ref-type="bibr">[12]</xref> vs conventional 12.1 months.</p>
      <table-wrap><table><tr><td>x</td></tr></table></table-wrap>
    </sec>
    <sec sec-type="discussion">
      <title>Discussion</title>
      <p>Should not appear in extracted excerpt.</p>
    </sec>
  </body>
</article>
</pmc-articleset>`;

describe('parsePubMedArticleXml', () => {
  it('extracts metadata from a well-formed PubMed XML response', () => {
    const meta = parsePubMedArticleXml(SAMPLE_PUBMED_XML, '42139645');
    expect(meta.pmid).toBe('42139645');
    expect(meta.title).toContain('Hepatocellular Carcinoma');
    expect(meta.journal).toBe('Journal of Clinical Oncology');
    expect(meta.doi).toBe('10.1200/JCO-25-02399');
    expect(meta.pmc_id).toBe('PMC9999999');
    expect(meta.pub_date).toBe('2026-05-15');
    expect(meta.authors).toContainEqual({ name: 'Moon AM' });
    expect(meta.authors).toContainEqual({ name: 'EBRT Collaboration Group' });
    expect(meta.mesh_terms).toContain('Carcinoma, Hepatocellular');
  });

  it('handles PMC ID without the PMC prefix', () => {
    const xml = SAMPLE_PUBMED_XML.replace('PMC9999999', '9999999');
    const meta = parsePubMedArticleXml(xml, '42139645');
    expect(meta.pmc_id).toBe('PMC9999999');
  });

  it('throws on missing PubmedArticle root', () => {
    expect(() => parsePubMedArticleXml('<garbage/>', '12345')).toThrow(PubMedClientError);
  });
});

describe('parseAbstractFromXml', () => {
  it('joins labeled AbstractText nodes with labels prepended', () => {
    const abstract = parseAbstractFromXml(SAMPLE_PUBMED_XML);
    expect(abstract).toContain('PURPOSE:');
    expect(abstract).toContain('METHODS: Individual patient data');
    expect(abstract).toContain('RESULTS: Median OS 14.2');
  });

  it('returns null when no AbstractText nodes exist', () => {
    expect(parseAbstractFromXml('<PubmedArticle><Article></Article></PubmedArticle>')).toBeNull();
  });
});

describe('extractMethodsAndResults', () => {
  it('extracts Methods and Results sections; skips Discussion', () => {
    const md = extractMethodsAndResults(SAMPLE_PMC_XML);
    expect(md).not.toBeNull();
    expect(md).toContain('## Methods');
    expect(md).toContain('## Results');
    expect(md).toContain('Median OS was 14.2 months');
    expect(md).not.toContain('Should not appear');
  });

  it('strips xref/table tags from body text', () => {
    const md = extractMethodsAndResults(SAMPLE_PMC_XML);
    expect(md).not.toContain('[12]');
    expect(md).not.toContain('<table>');
  });

  it('caps output at the requested char limit', () => {
    const md = extractMethodsAndResults(SAMPLE_PMC_XML, 200);
    expect(md!.length).toBeLessThanOrEqual(220); // headroom for header padding
  });

  it('falls back to title-based section detection', () => {
    const xml = `<article><body>
      <sec><title>Methods</title><p>Method body.</p></sec>
      <sec><title>Results</title><p>Result body.</p></sec>
    </body></article>`;
    const md = extractMethodsAndResults(xml);
    expect(md).toContain('Method body');
    expect(md).toContain('Result body');
  });

  it('returns null when no Methods/Results sections exist', () => {
    const xml = `<article><body><sec><title>Other</title><p>x</p></sec></body></article>`;
    expect(extractMethodsAndResults(xml)).toBeNull();
  });
});

describe('fetchPubMedPaper', () => {
  it('rejects non-numeric PMIDs', async () => {
    await expect(fetchPubMedPaper('abc' as string)).rejects.toThrow(/invalid PMID/);
  });

  it('fetches metadata + abstract; skips PMC fetch when no PMC ID', async () => {
    const noPmcXml = SAMPLE_PUBMED_XML.replace(
      /<ArticleId IdType="pmc">[^<]+<\/ArticleId>/,
      '',
    );
    const fetchImpl = vi.fn(async () => new Response(noPmcXml));
    const paper = await fetchPubMedPaper('42139645', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no PMC fetch
    expect(paper.metadata.pmc_id).toBeNull();
    expect(paper.fulltext_excerpt_md).toBeNull();
    expect(paper.abstract).toContain('Median OS');
  });

  it('fetches PMC body when PMC ID present', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('db=pmc')) return new Response(SAMPLE_PMC_XML);
      return new Response(SAMPLE_PUBMED_XML);
    });
    const paper = await fetchPubMedPaper('42139645', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(paper.fulltext_excerpt_md).toContain('Median OS was 14.2');
  });

  it('treats PMC fetch failure as non-fatal (still returns abstract)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('db=pmc')) return new Response('error', { status: 500 });
      return new Response(SAMPLE_PUBMED_XML);
    });
    const paper = await fetchPubMedPaper('42139645', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(paper.abstract).toContain('Median OS');
    expect(paper.fulltext_excerpt_md).toBeNull();
  });

  it('throws not_found on 404', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      fetchPubMedPaper('99999999', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

// v0.17 (T2): esearch + esummary + the rps throttle.
describe('searchPubMed (esearch)', () => {
  // No-op throttle so tests never actually wait.
  const fast = { sleep: async () => {}, minIntervalMs: 0 };
  beforeEach(() => _resetNcbiThrottleForTests());

  // Recorded esearch JSON (the real STOMP[Title] AND oligometastatic prostate shape).
  const ESEARCH_JSON = JSON.stringify({
    header: { type: 'esearch' },
    esearchresult: { count: '4', retmax: '10', idlist: ['36001857', '36526472', '39820657'] },
  });

  it('parses idlist + total count', async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response(ESEARCH_JSON));
    const res = await searchPubMed('STOMP[Title] AND oligometastatic prostate', {
      ...fast,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.pmids).toEqual(['36001857', '36526472', '39820657']);
    expect(res.total).toBe(4);
    expect(fetchImpl.mock.calls[0]![0]).toContain('esearch.fcgi');
    expect(fetchImpl.mock.calls[0]![0]).toContain('retmode=json');
  });

  it('returns empty (not an error) when nothing matches', async () => {
    const empty = JSON.stringify({ esearchresult: { count: '0', idlist: [] } });
    const fetchImpl = vi.fn(async () => new Response(empty));
    const res = await searchPubMed('NOSUCHTRIAL[Title]', { ...fast, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ pmids: [], total: 0 });
  });

  it('drops non-numeric ids defensively', async () => {
    const dirty = JSON.stringify({ esearchresult: { count: '2', idlist: ['123', 'abc', 456] } });
    const fetchImpl = vi.fn(async () => new Response(dirty));
    const res = await searchPubMed('x', { ...fast, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.pmids).toEqual(['123']);
  });

  it('throws parse on non-JSON, network on HTTP error', async () => {
    const bad = vi.fn(async () => new Response('<html>oops</html>'));
    await expect(searchPubMed('x', { ...fast, fetchImpl: bad as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'parse' });
    const err500 = vi.fn(async () => new Response('err', { status: 500 }));
    await expect(searchPubMed('x', { ...fast, fetchImpl: err500 as unknown as typeof fetch })).rejects.toBeInstanceOf(PubMedClientError);
  });

  it('throttles: the 2nd call waits ~minIntervalMs (codex #19 rps gate)', async () => {
    // Fake clock that does not advance; sleep records its argument.
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => new Response(ESEARCH_JSON));
    const opts = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: () => 1000,
      sleep: async (ms: number) => { waits.push(ms); },
      minIntervalMs: 334,
    };
    await searchPubMed('a', opts);
    await searchPubMed('b', opts);
    // 1st reserves slot at t=1000 (no wait); 2nd is pushed to t=1334 → waits 334.
    expect(waits).toEqual([334]);
  });
});

describe('summarizePmids (esummary)', () => {
  const fast = { sleep: async () => {}, minIntervalMs: 0 };
  beforeEach(() => _resetNcbiThrottleForTests());

  const ESUMMARY_JSON = JSON.stringify({
    result: {
      uids: ['32215577', '36001857'],
      '32215577': {
        uid: '32215577',
        title: 'Outcomes of Observation vs SABR for Oligometastatic Prostate Cancer: The ORIOLE Trial',
        fulljournalname: 'JAMA Oncology',
        source: 'JAMA Oncol',
        pubdate: '2020 Apr 1',
      },
      '36001857': {
        uid: '36001857',
        title: 'Pooled STOMP/ORIOLE analysis',
        source: 'J Clin Oncol',
        pubdate: '2022 Sep',
      },
    },
  });

  it('parses title / journal / year for each pmid in one batched call', async () => {
    const fetchImpl = vi.fn(async () => new Response(ESUMMARY_JSON));
    const out = await summarizePmids(['32215577', '36001857'], { ...fast, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // batched, not per-id
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ pmid: '32215577', journal: 'JAMA Oncology', year: '2020' });
    expect(out[0]!.title).toContain('ORIOLE');
    expect(out[1]).toMatchObject({ pmid: '36001857', journal: 'J Clin Oncol', year: '2022' });
  });

  it('no-ops on empty / all-non-numeric input (no request)', async () => {
    const fetchImpl = vi.fn(async () => new Response(ESUMMARY_JSON));
    expect(await summarizePmids([], { ...fast, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
    expect(await summarizePmids(['abc', 'NCT123'], { ...fast, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
