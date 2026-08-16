// The stranded-source bug: an enriched source that no build will ever reach.
//
// The nightly cron builds TODAY and YESTERDAY, then drains rebuild_queue with
// --skip=today,yesterday. A source dated outside that window is published ONLY
// if enrichment queues its date. It used to queue only on a MERGE into an
// ALREADY-PUBLISHED date, and the real failure fails both tests: a paper whose
// enrichment finally succeeds days after ingestion keeps its original
// bookmark_date, so it is CREATED fresh on a date that was NEVER PUBLISHED.
//
// That is how the OAR dose-constraints paper survived three submissions while
// staying invisible: sent 2026-08-09 (the URL 403'd), re-sent 08-10 as a PDF
// whose enrichment failed twice and only landed on 08-13 — by which point no
// build would target 2026-08-10 again — and the 08-13 re-send then deduped on
// DOI straight back into the same stranded row.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, savePaper } from '../src/lib/db.ts';
import { queuedAfterBuild } from '../src/lib/rebuild-window.ts';
import { isOutsideBuildWindow, needsRebuildQueue } from '../src/lib/inbox-enrichment.ts';

describe('isOutsideBuildWindow', () => {
  const today = '2026-08-13';

  it('keeps today and yesterday inside the window', () => {
    expect(isOutsideBuildWindow('2026-08-13', today)).toBe(false);
    expect(isOutsideBuildWindow('2026-08-12', today)).toBe(false);
  });

  it('puts anything older outside it', () => {
    expect(isOutsideBuildWindow('2026-08-11', today)).toBe(true);
    expect(isOutsideBuildWindow('2026-08-10', today)).toBe(true);
    expect(isOutsideBuildWindow('2026-05-17', today)).toBe(true);
  });

  it('handles a month boundary', () => {
    expect(isOutsideBuildWindow('2026-07-31', '2026-08-01')).toBe(false);
    expect(isOutsideBuildWindow('2026-07-30', '2026-08-01')).toBe(true);
  });

  it('handles a year boundary', () => {
    expect(isOutsideBuildWindow('2025-12-31', '2026-01-01')).toBe(false);
    expect(isOutsideBuildWindow('2025-12-30', '2026-01-01')).toBe(true);
  });

  it('treats a future date as inside the window', () => {
    expect(isOutsideBuildWindow('2026-09-01', today)).toBe(false);
  });
});

describe('needsRebuildQueue', () => {
  const today = '2026-08-13';

  it('QUEUES a source on an unpublished date outside the window', () => {
    // The regression. Before the fix this returned false and the source was
    // stranded in the DB permanently.
    expect(needsRebuildQueue('2026-08-10', today, false)).toBe(true);
  });

  it('queues a source on an already-published date (the v0.23 upgrade case)', () => {
    expect(needsRebuildQueue('2026-08-01', today, true)).toBe(true);
    expect(needsRebuildQueue('2026-08-13', today, true)).toBe(true);
  });

  it('does NOT queue an unpublished date still inside the window', () => {
    // The cron's own build:day stage covers today and yesterday. Queueing them
    // would buy a wasted second LLM build.
    expect(needsRebuildQueue('2026-08-13', today, false)).toBe(false);
    expect(needsRebuildQueue('2026-08-12', today, false)).toBe(false);
  });
});

// The wiring, not just the predicate. The predicate was already tested and
// correct; the bug was that savePaper returned `bookmarkDate: null` on INSERT,
// so `if (r.bookmarkDate)` short-circuited and a newly created paper never
// reached the queue at all — the exact case the fix was written for.
describe('savePaper reports the date of the row that won', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns bookmarkDate on INSERT, not just on merge', () => {
    const r = savePaper(db, {
      doi: '10.1000/fresh',
      title: 'Organs at risk radiation dose constraints',
      bookmark_date: '2026-08-10',
    });
    expect(r.created).toBe(true);
    expect(r.bookmarkDate).toBe('2026-08-10');
    // and that date is what the queue predicate must judge
    expect(needsRebuildQueue(r.bookmarkDate!, '2026-08-13', false)).toBe(true);
  });

  it('still returns the EXISTING row date on merge', () => {
    savePaper(db, { doi: '10.1000/x', title: 'T', bookmark_date: '2026-08-10' });
    const merged = savePaper(db, {
      doi: '10.1000/x',
      title: 'T',
      abstract: 'now with an abstract',
      bookmark_date: '2026-08-13',
    });
    expect(merged.created).toBe(false);
    expect(merged.bookmarkDate).toBe('2026-08-10');
  });
});

// The cron builds yesterday, then today. Today's lineage pass can suppress a
// card on yesterday and queue it AFTER yesterday was built — at which point
// "already rebuilt this run" is false, and blind-skipping deletes the request
// so the superseded card stays live forever.
describe('queuedAfterBuild', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oncbrain-drain-'));
  writeFileSync(join(dir, '2026-08-13.json'), JSON.stringify({ generated_at: 1000 }));

  it('is false when the queue entry predates the build (safe to skip)', () => {
    expect(queuedAfterBuild('2026-08-13', 900, dir)).toBe(false);
  });

  it('is TRUE when the entry postdates the build (must not skip)', () => {
    expect(queuedAfterBuild('2026-08-13', 1100, dir)).toBe(true);
  });

  it('fails OPEN on a missing or unreadable artifact', () => {
    // A wasted rebuild costs one LLM run; a wrongly skipped one leaves a
    // superseded card published indefinitely.
    expect(queuedAfterBuild('2026-01-01', 500, dir)).toBe(true);
    writeFileSync(join(dir, '2026-08-14.json'), 'not json');
    expect(queuedAfterBuild('2026-08-14', 500, dir)).toBe(true);
    writeFileSync(join(dir, '2026-08-15.json'), JSON.stringify({}));
    expect(queuedAfterBuild('2026-08-15', 500, dir)).toBe(true);
  });
});

// The helper lives in a lib module on purpose: build/rebuild-queued.ts calls
// main() at module scope, so importing IT would open the real database, take the
// drain lock and spawn paid build:day children. v0.39 shipped exactly that bug
// in notify-channel, where the import posted to the public Telegram channel.
describe('rebuild-window is import-safe', () => {
  it('pulls the helper from a module with no side effects', async () => {
    const mod = await import('../src/lib/rebuild-window.ts');
    expect(Object.keys(mod)).toEqual(['queuedAfterBuild']);
  });
});
