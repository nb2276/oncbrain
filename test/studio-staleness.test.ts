import { describe, it, expect } from 'vitest';
import { classifyBuildDates } from '../build/studio.ts';

// Regression guard for the studio "Daily build" staleness detector.
//
// Bug (pre-fix): the detector multiplied each date's max source created_at by
// 1000, treating it as Unix SECONDS. But created_at is written as Date.now() —
// Unix MILLISECONDS (db.ts). So sourceMs came out ~1000x too large and every
// date with sources was flagged stale on every run. Both created_at and the
// digest's generated_at are milliseconds; the comparison must not rescale.

const ARGS = { todayStr: '2026-06-14', yesterdayStr: '2026-06-13' };

describe('classifyBuildDates', () => {
  it('does NOT flag a date stale when its sources predate the digest (the bug)', () => {
    // Real-shaped 13-digit ms timestamps. Source built into the digest 1ms later.
    const sourceMaxAtMs = new Map([['2026-06-04', 1780584351837]]);
    const generatedAtMs = (d: string) =>
      d === '2026-06-04' ? 1780584351838 : null;

    const { stale } = classifyBuildDates({
      ...ARGS,
      sourceDates: ['2026-06-04'],
      sourceMaxAtMs,
      generatedAtMs,
    });

    // Old code: 1780584351837 * 1000 > 1780584351838 → always true → stale.
    expect(stale).toEqual([]);
  });

  it('flags a date stale when a source arrives after the digest was generated', () => {
    const sourceMaxAtMs = new Map([['2026-06-04', 1780584351838]]);
    const generatedAtMs = (d: string) =>
      d === '2026-06-04' ? 1780584351837 : null;

    const { stale, datesToBuild } = classifyBuildDates({
      ...ARGS,
      sourceDates: ['2026-06-04'],
      sourceMaxAtMs,
      generatedAtMs,
    });

    expect(stale).toEqual(['2026-06-04']);
    expect(datesToBuild).toContain('2026-06-04');
  });

  it('treats an equal timestamp as up-to-date (strictly newer is stale)', () => {
    const ts = 1780584351837;
    const { stale } = classifyBuildDates({
      ...ARGS,
      sourceDates: ['2026-06-04'],
      sourceMaxAtMs: new Map([['2026-06-04', ts]]),
      generatedAtMs: () => ts,
    });
    expect(stale).toEqual([]);
  });

  it('classifies a date with no digest as missing, not stale', () => {
    const { missing, stale, datesToBuild } = classifyBuildDates({
      ...ARGS,
      sourceDates: ['2026-06-04'],
      sourceMaxAtMs: new Map([['2026-06-04', 1780584351837]]),
      generatedAtMs: () => null,
    });
    expect(missing).toEqual(['2026-06-04']);
    expect(stale).toEqual([]);
    expect(datesToBuild).toContain('2026-06-04');
  });

  it('always includes yesterday and today, sorted and de-duplicated', () => {
    const { datesToBuild } = classifyBuildDates({
      ...ARGS,
      // today already a source date — must not appear twice
      sourceDates: ['2026-06-14'],
      sourceMaxAtMs: new Map([['2026-06-14', 1780584351837]]),
      generatedAtMs: () => 1780584351838, // up-to-date, not stale
    });
    expect(datesToBuild).toEqual(['2026-06-13', '2026-06-14']);
  });

  it('unions missing + stale across distinct out-of-order dates, sorted and deduped', () => {
    // 06-02 missing (no digest), 06-10 stale (source newer than digest),
    // 06-07 current (source older than digest). Feed out of order.
    const sourceDates = ['2026-06-10', '2026-06-02', '2026-06-07'];
    const sourceMaxAtMs = new Map([
      ['2026-06-10', 1780584351838],
      ['2026-06-02', 1780000000000],
      ['2026-06-07', 1780300000000],
    ]);
    const generatedAtMs = (d: string) => {
      if (d === '2026-06-02') return null; // missing
      if (d === '2026-06-10') return 1780584351837; // stale (source is +1ms)
      if (d === '2026-06-07') return 1780400000000; // current (source older)
      return null;
    };

    const { missing, stale, datesToBuild } = classifyBuildDates({
      ...ARGS,
      sourceDates,
      sourceMaxAtMs,
      generatedAtMs,
    });

    expect(missing).toEqual(['2026-06-02']);
    expect(stale).toEqual(['2026-06-10']);
    // union of missing + stale + yesterday + today, sorted ascending, no dupes
    expect(datesToBuild).toEqual([
      '2026-06-02',
      '2026-06-10',
      '2026-06-13',
      '2026-06-14',
    ]);
  });

  it('handles a date present in sourceDates but absent from the timestamp map', () => {
    // sourceMaxAtMs.get() → undefined → 0, never newer than a real generated_at.
    const { stale } = classifyBuildDates({
      ...ARGS,
      sourceDates: ['2026-06-04'],
      sourceMaxAtMs: new Map(),
      generatedAtMs: () => 1780584351837,
    });
    expect(stale).toEqual([]);
  });
});
