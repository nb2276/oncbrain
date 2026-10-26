// v0.62.1: local-drip papers (ingest:local) are announced by curator DM only,
// never in the channel post. A study with any non-drip source still posts.
import { describe, it, expect } from 'vitest';
import { openDb, saveInboxItem, enqueueLocalIngest, releaseLocalIngest, isLocalDripPaper, isDripPaper } from '../src/lib/db.ts';
import { withoutDripStudies, formatChannelPost } from '../src/lib/channel-post.ts';

const artifact = (studies: Array<{ name: string; source_ids: Array<{ type: string; id: number }> }>) => ({
  date: '2026-10-18',
  digest: { sites: [{ disease_site: 'breast', studies }] },
});

describe('withoutDripStudies', () => {
  const drip = new Set([1, 2]);
  const isDrip = (id: number) => drip.has(id);

  it('drops studies built only from drip papers', () => {
    const { artifact: a, dropped } = withoutDripStudies(
      artifact([
        { name: 'Old nomogram', source_ids: [{ type: 'paper', id: 1 }] },
        { name: 'RT CHARM', source_ids: [{ type: 'paper', id: 9 }] },
      ]),
      isDrip,
    );
    expect(dropped).toBe(1);
    expect(a.digest.sites[0]!.studies.map((s) => s.name)).toEqual(['RT CHARM']);
    expect(formatChannelPost(a, 'https://x')).not.toContain('Old nomogram');
  });

  it('keeps a study with any non-drip source (a tweet about the same trial is news)', () => {
    const { dropped } = withoutDripStudies(
      artifact([{ name: 'Mixed', source_ids: [{ type: 'paper', id: 1 }, { type: 'tweet', id: 5 }] }]),
      isDrip,
    );
    expect(dropped).toBe(0);
  });

  it('keeps a study with no recorded sources (cannot prove it is drip)', () => {
    expect(withoutDripStudies(artifact([{ name: 'Legacy', source_ids: [] }]), isDrip).dropped).toBe(0);
  });
});

describe('isLocalDripPaper', () => {
  it('is true only for a paper whose inbox item came from ingest:local', () => {
    const db = openDb(':memory:');
    enqueueLocalIngest(db, { path: '/p/a.pdf', kind: 'paper' });
    const [released] = releaseLocalIngest(db, { limit: 5, date: '2026-10-18', chatId: 1 });
    const tg = saveInboxItem(db, { type: 'paper', raw_target: 'https://doi.org/10.1/x', telegram_msg_id: 7, bookmark_date: '2026-10-18' });
    const ins = db.prepare(
      "INSERT INTO papers (content_hash, title, bookmark_date, inbox_item_id, fetched_via, created_at) VALUES (?, 't', '2026-10-18', ?, 'pdf', 0)",
    );
    const dripPaper = Number(ins.run('h1', released!.inbox_item_id).lastInsertRowid);
    const tgPaper = Number(ins.run('h2', tg.id).lastInsertRowid);
    expect(isLocalDripPaper(db, dripPaper)).toBe(true);
    expect(isLocalDripPaper(db, tgPaper)).toBe(false);
    expect(isLocalDripPaper(db, 999)).toBe(false);
  });
});

describe('isDripPaper (v0.63)', () => {
  it('covers every drip release, URL items included; isLocalDripPaper stays PDF-only', () => {
    const db = openDb(':memory:');
    enqueueLocalIngest(db, { path: '/p/a.pdf', kind: 'paper' });
    enqueueLocalIngest(db, { path: 'https://x/esmo', kind: 'url' });
    const released = releaseLocalIngest(db, { limit: 5, date: '2026-10-26', chatId: 1 });
    const tg = saveInboxItem(db, { type: 'paper', raw_target: 'https://doi.org/10.1/y', telegram_msg_id: 9, bookmark_date: '2026-10-26' });
    const ins = db.prepare("INSERT INTO papers (content_hash, title, bookmark_date, inbox_item_id, fetched_via, created_at) VALUES (?, 't', '2026-10-26', ?, 'pdf', 0)");
    const [pdf, url] = released.map((r) => Number(ins.run(`h${r.id}`, r.inbox_item_id).lastInsertRowid));
    const telegram = Number(ins.run('ht', tg.id).lastInsertRowid);
    expect([isDripPaper(db, pdf!), isDripPaper(db, url!), isDripPaper(db, telegram)]).toEqual([true, true, false]);
    expect([isLocalDripPaper(db, pdf!), isLocalDripPaper(db, url!)]).toEqual([true, false]);
  });
});
