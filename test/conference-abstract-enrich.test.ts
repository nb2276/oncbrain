// v0.60: a meeting-portal abstract through the real enrichment loop. Only the
// page fetch is mocked; the rest runs against an in-memory DB.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDb, saveInboxItem, listInboxItemsForEnrichment, addDoiWatch, listDoiWatch } from '../src/lib/db.ts';

vi.mock('../src/lib/ssrf-fetch.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/ssrf-fetch.ts')>();
  return { ...orig, ssrfSafeFetchText: vi.fn() };
});

import { runEnrichmentLoop } from '../src/lib/inbox-enrichment.ts';
import { ssrfSafeFetchText, SsrfError } from '../src/lib/ssrf-fetch.ts';

const mockedFetchText = vi.mocked(ssrfSafeFetchText);
const GI003_HTML = readFileSync('test/fixtures/conference-abstracts/astro-gi003.html', 'utf8');
const GI003 =
  'https://amportal.astro.org/sessions/pl-01-22946/initial-results-of-nrg-oncology-nrg-gi003-a-phase-iii-randomized-trial-of-protons-vs-photons-113309';
const DOI = '10.1016/j.ijrobp.2026.06.004';

let msgId = 900;
function send(db: Database.Database, text: string, bookmark_date = '2026-10-04') {
  saveInboxItem(db, {
    type: 'paper',
    raw_target: GI003,
    raw_message_text: text,
    telegram_msg_id: msgId++,
    bookmark_date,
  });
  return listInboxItemsForEnrichment(db);
}

type Row = Record<string, unknown>;
const papers = (db: Database.Database) => db.prepare('SELECT * FROM papers').all() as Row[];
const status = (db: Database.Database) =>
  (db.prepare('SELECT enrichment_status FROM inbox_items ORDER BY id DESC').get() as { enrichment_status: string })
    .enrichment_status;

describe('conference abstract enrichment', () => {
  beforeEach(() => {
    mockedFetchText.mockReset();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('a confirm reply ingests the abstract with its DOI, files it on the presented date and retires the watch', async () => {
    const db = openDb(':memory:');
    addDoiWatch(db, { doi: DOI, title: 'NRG-GI003 protons vs photons' });
    mockedFetchText.mockResolvedValue(GI003_HTML);

    const r = await runEnrichmentLoop(db, send(db, `${GI003} ${DOI}`));
    expect(r.enriched).toBe(1);
    expect(mockedFetchText).toHaveBeenCalledWith(GI003, { allowedHostSuffixes: ['amportal.astro.org'] });

    const [p] = papers(db);
    expect(p!.doi).toBe(DOI);
    expect(p!.fetched_via).toBe('conference_abstract');
    expect(p!.journal).toBe('ASTRO 2026 Annual Meeting');
    expect(p!.bookmark_date).toBe('2026-09-28'); // presented date, not the reply date
    expect(p!.curator_note).toBeNull(); // the confirm line is a command, not a note
    expect(String(p!.abstract)).toMatch(/^ASTRO 2026 abstract 2 · PL 01 - Plenary Session · 2026-09-28/);
    expect(String(p!.conference_slug ?? '')).toMatch(/astro-2026/);
    expect(listDoiWatch(db)).toHaveLength(0);
  });

  it('a bare link (no DOI) ingests without a DOI and leaves the watch open', async () => {
    const db = openDb(':memory:');
    addDoiWatch(db, { doi: DOI, title: 'NRG-GI003' });
    mockedFetchText.mockResolvedValue(GI003_HTML);
    await runEnrichmentLoop(db, send(db, GI003));
    expect(papers(db)[0]!.doi).toBeNull();
    expect(listDoiWatch(db)).toHaveLength(1);
  });

  it('two DOIs in the message pair neither', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockResolvedValue(GI003_HTML);
    await runEnrichmentLoop(db, send(db, `${GI003} ${DOI} 10.1016/j.ijrobp.2026.06.005`));
    expect(papers(db)[0]!.doi).toBeNull();
  });

  it('a re-send with the DOI attaches it to the existing row and retires the watch', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockResolvedValue(GI003_HTML);
    await runEnrichmentLoop(db, send(db, GI003));
    addDoiWatch(db, { doi: DOI, title: 'NRG-GI003' });
    await runEnrichmentLoop(db, send(db, `${GI003} ${DOI}`));
    const rows = papers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doi).toBe(DOI);
    expect(listDoiWatch(db)).toHaveLength(0);
  });

  it('a DOI confirmed onto an already-published abstract queues its date for rebuild', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockResolvedValue(GI003_HTML);
    // Filed 2026-09-28: outside the nightly build window by the reply date, so
    // nothing else would ever rebuild the card with its DOI.
    await runEnrichmentLoop(db, send(db, GI003));
    db.prepare('DELETE FROM rebuild_queue').run();
    await runEnrichmentLoop(db, send(db, `${GI003} ${DOI}`));
    const q = db.prepare('SELECT bookmark_date, reason FROM rebuild_queue').all() as Array<{ bookmark_date: string; reason: string }>;
    expect(q.map((x) => x.bookmark_date)).toEqual(['2026-09-28']);
    expect(q[0]!.reason).toMatch(/doi/);
  });

  it('a page with no abstract body fails permanently with a specific reason', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockResolvedValue('<html><h1>Discussant</h1></html>');
    const r = await runEnrichmentLoop(db, send(db, GI003));
    expect(r.failed).toBe(1);
    expect(status(db)).toBe('failed_permanent');
    expect(papers(db)).toHaveLength(0);
  });

  it('a portal 503 stays retryable', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockRejectedValue(new SsrfError('HTTP 503', GI003));
    await runEnrichmentLoop(db, send(db, GI003));
    expect(status(db)).toBe('failed');
  });

  it('a DNS failure on the pinned portal host stays retryable', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockRejectedValue(new SsrfError('DNS resolution failed', GI003));
    await runEnrichmentLoop(db, send(db, GI003));
    expect(status(db)).toBe('failed');
  });

  it('a confirm with a different DOI than the row holds is refused, not swapped', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockResolvedValue(GI003_HTML);
    await runEnrichmentLoop(db, send(db, `${GI003} ${DOI}`));
    addDoiWatch(db, { doi: '10.1016/j.ijrobp.2026.06.009', title: 'x' });
    await runEnrichmentLoop(db, send(db, `${GI003} 10.1016/j.ijrobp.2026.06.009`));
    expect(papers(db).map((p) => p.doi)).toEqual([DOI]);
    expect(listDoiWatch(db).map((w) => w.doi)).toEqual(['10.1016/j.ijrobp.2026.06.009']);
  });

  it('a portal 404 is permanent', async () => {
    const db = openDb(':memory:');
    mockedFetchText.mockRejectedValue(new SsrfError('HTTP 404', GI003));
    await runEnrichmentLoop(db, send(db, GI003));
    expect(status(db)).toBe('failed_permanent');
  });
});
