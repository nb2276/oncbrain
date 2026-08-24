// Suppression is destructive and the successor publish can fail. The order in
// which those two happen decides what a crash costs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, listRebuildQueue } from '../src/lib/db.ts';
import { commitLineageSuppressions, type PendingSuppression } from '../build/digest-builder.ts';

describe('commitLineageSuppressions', () => {
  let db: ReturnType<typeof openDb>;
  let dir: string;
  let args: { overridesDir: string } & Record<string, unknown>;

  beforeEach(() => {
    db = openDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'oncbrain-commit-'));
    mkdirSync(dir, { recursive: true });
    args = { overridesDir: dir, outDir: dir, obsidianDir: dir, dryRun: false, backfill: false, skipFetch: false };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pending = (o: Partial<PendingSuppression> = {}): PendingSuppression => ({
    priorDate: '2026-07-08',
    entries: [
      { slug: 'nrg-gu005', name: 'NRG-GU005', nct: 'NCT03367702', source_ids: [{ type: 'paper', id: 44 }] },
    ],
    stillPublished: new Set(),
    ...o,
  });

  const overrides = () => JSON.parse(readFileSync(join(dir, '2026-07-08.json'), 'utf8'));

  it('writes the suppress override with the target’s identity', () => {
    commitLineageSuppressions(db, '2026-08-14', [pending()], args as never);
    const ov = overrides();
    expect(ov.suppress).toEqual(['nrg-gu005']);
    // Provenance survives the rename that suppressing itself causes.
    expect(ov.identity['nrg-gu005'].source_ids).toEqual([{ type: 'paper', id: 44 }]);
    expect(listRebuildQueue(db).map((q) => q.bookmark_date)).toEqual(['2026-07-08']);
  });

  it('SELF-HEALS a suppression whose rebuild was never queued', () => {
    // An earlier run wrote the override and then failed to queue the rebuild, so
    // the card is still live with nothing scheduled to remove it. Skipping on
    // "already suppressed" is what made that permanent.
    writeFileSync(join(dir, '2026-07-08.json'), JSON.stringify({ suppress: ['nrg-gu005'] }));
    commitLineageSuppressions(
      db,
      '2026-08-14',
      [pending({ stillPublished: new Set(['nrg-gu005']) })],
      args as never,
    );
    expect(listRebuildQueue(db).map((q) => q.bookmark_date)).toEqual(['2026-07-08']);
  });

  it('does NOT re-queue when the suppression already took effect', () => {
    // Already suppressed AND gone from the published artifact: nothing owed.
    writeFileSync(join(dir, '2026-07-08.json'), JSON.stringify({ suppress: ['nrg-gu005'] }));
    commitLineageSuppressions(db, '2026-08-14', [pending({ stillPublished: new Set() })], args as never);
    expect(listRebuildQueue(db)).toHaveLength(0);
  });

  it('preserves a curator’s existing suppressions on that date', () => {
    writeFileSync(join(dir, '2026-07-08.json'), JSON.stringify({ suppress: ['hand-dropped'] }));
    commitLineageSuppressions(db, '2026-08-14', [pending()], args as never);
    expect(overrides().suppress.sort()).toEqual(['hand-dropped', 'nrg-gu005']);
  });

  it('does nothing at all when nothing was staged', () => {
    commitLineageSuppressions(db, '2026-08-14', [], args as never);
    expect(existsSync(join(dir, '2026-07-08.json'))).toBe(false);
    expect(listRebuildQueue(db)).toHaveLength(0);
  });

  it('never throws — a bookkeeping failure must not fail a publish that succeeded', () => {
    // Unwritable overrides dir: the artifact is already on disk at this point,
    // so throwing here would fail a build whose real work is done.
    const bad = { ...args, overridesDir: '/proc/nonexistent-oncbrain' };
    expect(() => commitLineageSuppressions(db, '2026-08-14', [pending()], bad as never)).not.toThrow();
  });

  it('queues the rebuild even when the override write fails', () => {
    // queueRebuild runs FIRST on purpose: a queued rebuild with no override is a
    // wasted build, an override with no queued rebuild is a card that stays live.
    const bad = { ...args, overridesDir: '/proc/nonexistent-oncbrain' };
    commitLineageSuppressions(db, '2026-08-14', [pending()], bad as never);
    expect(listRebuildQueue(db).map((q) => q.bookmark_date)).toEqual(['2026-07-08']);
  });
});
