// v0.61: local ingestion (build/ingest-local.ts). The drip queue, and a staged
// PDF read from disk through the real enrichment loop. PDF text, metadata,
// figure OCR and vault filing are module-mocked; nothing touches Telegram.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDb,
  enqueueLocalIngest,
  listLocalIngest,
  releaseLocalIngest,
  listInboxItemsForEnrichment,
} from '../src/lib/db.ts';

vi.mock('../src/lib/pdf-text.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/pdf-text.ts')>();
  return {
    ...orig,
    extractPdfText: vi.fn(async () => ({ text: 'Methods. 120 patients were randomized. Results. HR 0.70.', via: 'text' })),
    extractPdfFigureOcr: vi.fn(async () => 'Figure 2 HR 0.70'),
  };
});
vi.mock('../src/lib/figure-extract.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/figure-extract.ts')>();
  return { ...orig, extractPdfFigureStructured: vi.fn(async () => 'structured') };
});
vi.mock('../src/lib/qwen-client.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/qwen-client.ts')>();
  return { ...orig, isQwenAvailable: vi.fn(async () => true) };
});
vi.mock('../src/lib/pdf-meta.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/pdf-meta.ts')>();
  return {
    ...orig,
    extractPaperMetaFromText: vi.fn(async () => ({
      title: 'A Local Trial',
      authors: ['A. Author'],
      journal: 'J Test',
      pub_date: '2020',
      doi: null,
      pmid: null,
      abstract: null,
      disease_site: 'skin',
    })),
  };
});
vi.mock('../src/lib/pdf-storage.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/pdf-storage.ts')>();
  return { ...orig, filePdfToVault: vi.fn(() => ({ absPath: '/x', relPath: 'data/obsidian/papers/skin/a-local-trial.pdf' })) };
});
vi.mock('../src/lib/telegram-ingest.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/telegram-ingest.ts')>();
  return { ...orig, sendMessage: vi.fn(async () => undefined) };
});
vi.mock('../src/lib/slide-photo-storage.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/slide-photo-storage.ts')>();
  return {
    ...orig,
    downloadTelegramFile: vi.fn(async () => {
      throw new Error('Telegram must not be called for a local PDF');
    }),
  };
});

import { runEnrichmentLoop } from '../src/lib/inbox-enrichment.ts';
import { extractPdfFigureOcr } from '../src/lib/pdf-text.ts';
import { extractPdfFigureStructured } from '../src/lib/figure-extract.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';
import { downloadTelegramFile } from '../src/lib/slide-photo-storage.ts';

const DATE = '2026-10-18';

describe('local ingest drip queue', () => {
  const stage = (db: ReturnType<typeof openDb>, n: number) => {
    for (let i = 1; i <= n; i++) enqueueLocalIngest(db, { path: `/p/paper-${i}.pdf`, kind: 'paper' });
  };

  it('staging is idempotent on path', () => {
    const db = openDb(':memory:');
    expect(enqueueLocalIngest(db, { path: '/p/a.pdf', kind: 'paper' }).created).toBe(true);
    expect(enqueueLocalIngest(db, { path: '/p/a.pdf', kind: 'paper' }).created).toBe(false);
    expect(listLocalIngest(db)).toHaveLength(1);
  });

  it('releases at most the nightly limit, in staging order, dated that night', () => {
    const db = openDb(':memory:');
    stage(db, 12);
    const out = releaseLocalIngest(db, { limit: 5, date: DATE, chatId: 1 });
    expect(out.map((r) => r.path)).toEqual([1, 2, 3, 4, 5].map((i) => `/p/paper-${i}.pdf`));
    const inbox = listInboxItemsForEnrichment(db);
    expect(inbox).toHaveLength(5);
    expect(inbox.every((i) => i.bookmark_date === DATE)).toBe(true);
    expect(JSON.parse(inbox[0]!.attachments_json!)).toMatchObject({ kind: 'pdf', quiet: true, figure_structured: false });
  });

  it('a second run the same night tops up to the limit instead of doubling it', () => {
    const db = openDb(':memory:');
    stage(db, 12);
    releaseLocalIngest(db, { limit: 3, date: DATE, chatId: 1 });
    expect(releaseLocalIngest(db, { limit: 5, date: DATE, chatId: 1 })).toHaveLength(2);
    expect(releaseLocalIngest(db, { limit: 5, date: DATE, chatId: 1 })).toHaveLength(0);
    expect(releaseLocalIngest(db, { limit: 5, date: '2026-10-19', chatId: 1 })).toHaveLength(5);
  });

  it('--now releases exactly the named rows, outside the nightly cap', () => {
    const db = openDb(':memory:');
    stage(db, 8);
    const ids = listLocalIngest(db).slice(6).map((r) => r.id);
    const out = releaseLocalIngest(db, { limit: ids.length, date: DATE, chatId: 1, ids });
    expect(out.map((r) => r.path)).toEqual(['/p/paper-7.pdf', '/p/paper-8.pdf']);
  });
});

describe('a staged PDF through enrichment', () => {
  let dir = '';
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
    vi.mocked(extractPdfFigureOcr).mockClear();
    vi.mocked(extractPdfFigureStructured).mockClear();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.SOURCE_FACET = 'off';
    // Inside the project: enrichment refuses any path outside it.
    dir = mkdtempSync(join(process.cwd(), 'test', '.tmp-local-ingest-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the file from disk, skips the Opus figure pass, and stays quiet', async () => {
    const db = openDb(':memory:');
    const pdf = join(dir, 'trial.pdf');
    writeFileSync(pdf, '%PDF-1.4 test');
    enqueueLocalIngest(db, { path: pdf, kind: 'talk', note: 'Slide deck from a talk (presentation), not a study report.' });
    releaseLocalIngest(db, { limit: 5, date: DATE, chatId: 42 });

    const r = await runEnrichmentLoop(db, listInboxItemsForEnrichment(db));
    expect(r.enriched).toBe(1);
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(extractPdfFigureOcr).toHaveBeenCalled(); // free Vision OCR still runs
    expect(extractPdfFigureStructured).not.toHaveBeenCalled(); // no Opus reconcile on the drip
    expect(vi.mocked(sendMessage).mock.calls.filter((c) => String(c[2]).startsWith('Got it'))).toEqual([]);
    const p = db.prepare('SELECT bookmark_date, curator_note, fetched_via FROM papers').get() as Record<string, string>;
    expect(p).toEqual({ bookmark_date: DATE, curator_note: 'Slide deck from a talk (presentation), not a study report.', fetched_via: 'pdf' });
  });

  it('refuses a path outside the project', async () => {
    const db = openDb(':memory:');
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const pdf = join(outside, 'x.pdf');
    writeFileSync(pdf, '%PDF-1.4 test');
    enqueueLocalIngest(db, { path: pdf, kind: 'paper' });
    releaseLocalIngest(db, { limit: 5, date: DATE, chatId: 42 });
    const r = await runEnrichmentLoop(db, listInboxItemsForEnrichment(db));
    rmSync(outside, { recursive: true, force: true });
    expect(r.failed).toBe(1);
    expect((db.prepare('SELECT enrichment_status FROM inbox_items').get() as { enrichment_status: string }).enrichment_status).toBe(
      'failed_permanent',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM papers').get()).toEqual({ n: 0 });
  });
});
