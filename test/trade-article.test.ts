// v0.14: trade-press article ingestion (ASCO Post, OncLive, UroToday, …).
// Network seams (page fetch, Crossref, OA backfill) are module-mocked; the
// rest of the enrichment loop runs for real against an in-memory DB.
//
// Design: trade articles are ALWAYS saved content-hash-keyed. We never key a
// trade row on a DOI found in the body — a "related coverage" link routinely
// carries one foreign DOI, and merging onto it would misattribute the article.
// Clustering with the primary paper happens at build time via NCT/acronym
// association, not via an identity merge here.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, saveInboxItem, listInboxItemsForEnrichment } from '../src/lib/db.ts';

vi.mock('../src/lib/ssrf-fetch.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/ssrf-fetch.ts')>();
  return { ...orig, ssrfSafeFetchText: vi.fn() };
});
vi.mock('../src/lib/crossref-client.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/crossref-client.ts')>();
  return { ...orig, fetchCrossrefPaper: vi.fn() };
});
vi.mock('../src/lib/oa-enrichment.ts', () => ({
  backfillOpenAccess: vi.fn(async (input: { abstract: string | null; fulltext: string | null }) => ({
    abstract: input.abstract,
    fulltext: input.fulltext,
    filled: { abstract: null, fulltext: null },
  })),
}));

import { runEnrichmentLoop } from '../src/lib/inbox-enrichment.ts';
import { ssrfSafeFetchText } from '../src/lib/ssrf-fetch.ts';
import { fetchCrossrefPaper } from '../src/lib/crossref-client.ts';

const mockedFetchText = vi.mocked(ssrfSafeFetchText);
const mockedCrossref = vi.mocked(fetchCrossrefPaper);

function freshDb(): Database.Database {
  return openDb(':memory:');
}

function inboxTradeUrl(db: Database.Database, url: string, msgId = 500) {
  saveInboxItem(db, {
    type: 'paper',
    raw_target: url,
    telegram_msg_id: msgId,
    bookmark_date: '2026-06-09',
  });
  return listInboxItemsForEnrichment(db);
}

// A realistic ASCO Post body: enough text to clear the contentless guard, an
// NCT id for clustering, no DOI of its own.
const PAGE_NO_DOI = `<html><head>
  <meta property="og:title" content="ARANOTE Confirms Darolutamide Benefit">
  <meta property="og:site_name" content="The ASCO Post">
  <meta property="og:description" content="Phase 3 readout in mHSPC.">
  <meta property="article:published_time" content="2026-06-05T09:00:00Z">
</head><body>
  <article><p>Adding darolutamide to androgen-deprivation therapy significantly
  improved radiographic progression-free survival among patients with metastatic
  hormone-sensitive prostate cancer in the phase 3 ARANOTE trial (NCT04736199),
  with a hazard ratio of 0.54. The benefit was consistent across prespecified
  subgroups, and the safety profile was consistent with prior darolutamide
  studies.</p></article>
</body></html>`;

// The misattribution trap: the article's OWN subject prints no DOI, but a
// "related coverage" block links exactly one FOREIGN paper's DOI.
const PAGE_FOREIGN_RELATED_DOI = `<html><head>
  <meta property="og:title" content="Daraxonrasib Doubles PFS in Pancreatic Cancer">
  <meta property="og:site_name" content="OncLive">
  <meta property="og:description" content="RASolute 302 readout at ASCO 2026.">
</head><body>
  <article><p>The multiselective RAS(ON) inhibitor daraxonrasib nearly doubled
  median overall survival versus chemotherapy in previously treated metastatic
  pancreatic cancer in the phase 3 RASolute 302 trial (NCT06625320). Responses
  were durable and the regimen was generally well tolerated.</p></article>
  <aside class="related"><a href="https://doi.org/10.1056/nejmoa.unrelated.999">
  Related: a different trial in a different disease</a></aside>
</body></html>`;

// A JavaScript-rendered shell: no readable body, no usable OG summary.
const PAGE_SPA_SHELL = `<html><head>
  <meta property="og:title" content="Some Coverage">
  <meta property="og:site_name" content="OncLive">
</head><body><div id="root"></div></body></html>`;

describe('trade-press article enrichment', () => {
  beforeEach(() => {
    mockedFetchText.mockReset();
    mockedCrossref.mockReset();
    delete process.env.TELEGRAM_BOT_TOKEN; // replies no-op in tests
  });

  it('always content-hashes a trade article and never calls Crossref', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(PAGE_NO_DOI);

    const url = 'https://www.urotoday.com/conference-highlights/asco-2026/aranote.html?utm_source=x';
    const result = await runEnrichmentLoop(db, inboxTradeUrl(db, url));
    expect(result.enriched).toBe(1);
    expect(mockedCrossref).not.toHaveBeenCalled();

    const paper = db.prepare('SELECT * FROM papers').get() as Record<string, unknown>;
    expect(paper.doi).toBeNull();
    expect(paper.pmid).toBeNull();
    expect(paper.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(paper.fetched_via).toBe('trade_html');
    expect(paper.title).toBe('ARANOTE Confirms Darolutamide Benefit');
    expect(paper.journal).toBe('The ASCO Post');
    expect(paper.abstract).toBe('Phase 3 readout in mHSPC.');
    expect(paper.pub_date).toBe('2026-06-05');
    expect(paper.source_url).toBe(url);
    // NCT in the body survives into the excerpt for clustering/coverage.
    expect(paper.fulltext_excerpt_md).toContain('NCT04736199');
  });

  it('does NOT key the row on a foreign DOI linked in a related-coverage block', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(PAGE_FOREIGN_RELATED_DOI);

    const result = await runEnrichmentLoop(
      db,
      inboxTradeUrl(db, 'https://www.onclive.com/view/daraxonrasib-rasolute-302'),
    );
    expect(result.enriched).toBe(1);
    expect(mockedCrossref).not.toHaveBeenCalled(); // the foreign DOI must not be resolved

    const paper = db.prepare('SELECT * FROM papers').get() as Record<string, unknown>;
    expect(paper.doi).toBeNull(); // identity is the article, not the related paper
    expect(paper.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(paper.fetched_via).toBe('trade_html');
    expect(paper.title).toBe('Daraxonrasib Doubles PFS in Pancreatic Cancer');
    // The article's OWN trial id is preserved for build-time clustering.
    expect(paper.fulltext_excerpt_md).toContain('NCT06625320');
  });

  it('dedups a re-sent URL across utm / trailing-slash / www / scheme variants', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(PAGE_NO_DOI);

    const variants = [
      'https://www.urotoday.com/conference-highlights/asco-2026/aranote.html?utm_source=tw',
      'https://urotoday.com/conference-highlights/asco-2026/aranote.html', // no www, no query
      'http://www.urotoday.com/conference-highlights/asco-2026/aranote.html/', // http + trailing slash
    ];
    let msgId = 600;
    for (const v of variants) {
      await runEnrichmentLoop(db, inboxTradeUrl(db, v, msgId++));
    }

    const count = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(count.n).toBe(1); // canonicalizeTradeUrl collapses all three to one row
  });

  it('derives the outlet name from the host when og:site_name is missing', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(
      `<html><head><meta property="og:title" content="Selpercatinib EFS Benefit"></head><body>
      <article><p>Adjuvant selpercatinib significantly improved event-free survival
      in patients with resected RET fusion-positive early-stage non-small cell lung
      cancer, according to results presented at the meeting. The benefit was seen
      across stage subgroups and the safety profile was manageable.</p></article>
      </body></html>`,
    );

    const result = await runEnrichmentLoop(
      db,
      inboxTradeUrl(db, 'https://ascopost.com/issues/june-10-2026/selpercatinib/'),
    );
    expect(result.enriched).toBe(1);
    const paper = db.prepare('SELECT journal, fetched_via FROM papers').get() as {
      journal: string | null;
      fetched_via: string;
    };
    expect(paper.journal).toBe('The ASCO Post'); // from the host, not og:site_name
    expect(paper.fetched_via).toBe('trade_html');
  });

  it('fails permanently for a JavaScript-rendered shell with no readable text', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(PAGE_SPA_SHELL);

    const result = await runEnrichmentLoop(
      db,
      inboxTradeUrl(db, 'https://www.onclive.com/view/spa-shell'),
    );
    expect(result.failed).toBe(1);
    const item = db.prepare('SELECT enrichment_status FROM inbox_items').get() as {
      enrichment_status: string;
    };
    expect(item.enrichment_status).toBe('failed_permanent'); // no silent contentless save
    const count = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('fails permanently for a registration/paywall stub (no junk saved as trial data)', async () => {
    const db = freshDb();
    // >200 chars of body so the empty-shell guard would pass it — but it's a
    // sign-in wall, not an article. Registration-walled outlets (OncLive,
    // Targeted Oncology, Healio) routinely serve this to a bot fetch.
    mockedFetchText.mockResolvedValue(
      `<html><head><meta property="og:title" content="Pivotal Trial Coverage"></head><body>
      <article><p>Sign in to continue reading. This content is reserved for
      registered members of our oncology community. Create a free account to
      access the full article, including the data tables and expert commentary
      that accompany this conference coverage.</p></article></body></html>`,
    );

    const result = await runEnrichmentLoop(
      db,
      inboxTradeUrl(db, 'https://www.onclive.com/view/paywalled'),
    );
    expect(result.failed).toBe(1);
    const item = db.prepare('SELECT enrichment_status FROM inbox_items').get() as {
      enrichment_status: string;
    };
    expect(item.enrichment_status).toBe('failed_permanent');
    const count = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('saves a thin page when the body is short but og:description carries the finding', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(
      `<html><head>
        <meta property="og:title" content="Off-the-Shelf CAR T Responses">
        <meta property="og:site_name" content="The ASCO Post">
        <meta property="og:description" content="An allogeneic off-the-shelf CAR T-cell therapy produced deep and durable responses in heavily pretreated multiple myeloma, with a manageable safety profile in the phase 1 study.">
      </head><body><article><p>See summary.</p></article></body></html>`,
    );

    const result = await runEnrichmentLoop(
      db,
      inboxTradeUrl(db, 'https://ascopost.com/issues/june-10-2026/car-t/'),
    );
    expect(result.enriched).toBe(1);
    const paper = db.prepare('SELECT abstract, fetched_via FROM papers').get() as {
      abstract: string | null;
      fetched_via: string;
    };
    expect(paper.fetched_via).toBe('trade_html');
    expect(paper.abstract).toContain('off-the-shelf CAR T'); // og:description preserved
  });

  it('a non-trade journal page without identifiers still fails permanently', async () => {
    const db = freshDb();
    mockedFetchText.mockResolvedValue(
      `<html><head><meta property="og:title" content="Splash page"></head><body><article>no ids</article></body></html>`,
    );

    const result = await runEnrichmentLoop(
      db,
      inboxTradeUrl(db, 'https://www.nejm.org/doi-less-page'),
    );
    expect(result.failed).toBe(1);
    const item = db.prepare('SELECT enrichment_status FROM inbox_items').get() as {
      enrichment_status: string;
    };
    expect(item.enrichment_status).toBe('failed_permanent');
  });
});
