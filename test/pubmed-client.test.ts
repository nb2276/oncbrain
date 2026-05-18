import { describe, it, expect, vi } from 'vitest';
import {
  fetchPubMedPaper,
  parsePubMedArticleXml,
  parseAbstractFromXml,
  extractMethodsAndResults,
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
