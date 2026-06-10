import { describe, it, expect } from 'vitest';
import {
  isValidId,
  dateOfId,
  parseSeen,
  serializeSeen,
  partitionNew,
  capSeen,
  setupWhatsNew,
  type StorageLike,
} from '../src/lib/whats-new.ts';

// These tests drive the pure helpers + setupWhatsNew against stub DOM nodes and
// injected Map-backed storage, so no jsdom is needed (same approach as
// share-script.test.ts). They verify: id validation, date math, seen-set
// parse/serialize round-trips, first-visit-seeds-nothing, returning-visit
// marking, in-session baseline stability, monotonic + pruned persistence, and
// graceful degradation when storage throws.

// ── stubs ──────────────────────────────────────────────────────────────────

interface StubStorage extends StorageLike {
  data: Map<string, string>;
  removeItem(key: string): void;
}
function makeStorage(
  initial: Record<string, string> = {},
  opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {},
): StubStorage {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(k) {
      if (opts.throwOnGet) throw new Error('blocked');
      return data.has(k) ? data.get(k)! : null;
    },
    setItem(k, v) {
      if (opts.throwOnSet) throw new Error('quota');
      data.set(k, v);
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

interface StubRow {
  getAttribute(name: string): string | null;
  classList: { add: (c: string) => void; contains: (c: string) => boolean; remove: (c: string) => void };
  _classes: Set<string>;
}
function makeRow(id: string | null): StubRow {
  const classes = new Set<string>();
  return {
    getAttribute: (name) => (name === 'data-study-id' ? id : null),
    classList: {
      add: (c) => { classes.add(c); },
      contains: (c) => classes.has(c),
      remove: (c) => { classes.delete(c); },
    },
    _classes: classes,
  };
}
function makeTotal() {
  const classes = new Set<string>();
  return {
    textContent: '',
    classList: {
      add: (c: string) => { classes.add(c); },
      contains: (c: string) => classes.has(c),
      remove: (c: string) => { classes.delete(c); },
    },
    _classes: classes,
  };
}

function run(
  rows: StubRow[],
  deps: { local?: StorageLike | null; session?: StorageLike | null },
  total = makeTotal(),
) {
  const count = setupWhatsNew(
    { rows: rows as unknown as ArrayLike<HTMLElement>, totalEl: total as unknown as HTMLElement },
    deps,
  );
  return { count, total };
}

const SEED = 'oncbrain:seenIds';

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('whats-new pure helpers', () => {
  it('isValidId accepts date#slug, rejects junk', () => {
    expect(isValidId('2026-06-09#firestorm')).toBe(true);
    expect(isValidId('2026-06-09#prestige-psma-2')).toBe(true);
    expect(isValidId('firestorm')).toBe(false);
    expect(isValidId('2026-06-09')).toBe(false); // no slug
    expect(isValidId('20260609#x')).toBe(false);
    expect(isValidId('')).toBe(false);
  });

  it('dateOfId extracts the leading date', () => {
    expect(dateOfId('2026-06-09#firestorm')).toBe('2026-06-09');
  });

  it('parseSeen: null/malformed/non-array -> null; filters invalid ids', () => {
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen('not json')).toBeNull();
    expect(parseSeen('null')).toBeNull();
    expect(parseSeen('{"a":1}')).toBeNull(); // not an array
    const set = parseSeen('["2026-06-09#a","junk","2026-06-08#b"]');
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual(['2026-06-08#b', '2026-06-09#a']);
  });

  it('serializeSeen round-trips through parseSeen', () => {
    const s = new Set(['2026-06-09#a', '2026-06-08#b']);
    const back = parseSeen(serializeSeen(s));
    expect(back).toEqual(s);
  });

  it('partitionNew: null baseline -> nothing; else only unseen', () => {
    expect(partitionNew(['2026-06-09#a'], null).size).toBe(0);
    const seen = new Set(['2026-06-08#b']);
    const fresh = partitionNew(['2026-06-09#a', '2026-06-08#b'], seen);
    expect([...fresh]).toEqual(['2026-06-09#a']);
    expect(partitionNew(['2026-06-08#b'], seen).size).toBe(0);
  });

  it('capSeen keeps the most recent `max` by date, drops the oldest; <= max unchanged', () => {
    const ids = ['2026-03-01#old', '2026-06-09#new', '2026-05-01#mid'];
    expect([...capSeen(ids, 2)].sort()).toEqual(['2026-05-01#mid', '2026-06-09#new']);
    expect([...capSeen(ids, 9)].sort()).toEqual([...ids].sort());
    expect(capSeen([], 5).size).toBe(0);
  });
});

// ── setupWhatsNew (DOM core) ─────────────────────────────────────────────────

describe('setupWhatsNew', () => {
  it('first visit (empty storage): marks nothing, total hidden, seeds the set', () => {
    const rows = [makeRow('2026-06-09#a'), makeRow('2026-06-09#b')];
    const local = makeStorage();
    const session = makeStorage();
    const { count, total } = run(rows, { local, session });

    expect(count).toBe(0);
    expect(rows.every((r) => !r._classes.has('is-new'))).toBe(true);
    expect((total as { _classes: Set<string> })._classes.has('is-shown')).toBe(false);
    // seeded
    expect(parseSeen(local.data.get(SEED) ?? null)).toEqual(
      new Set(['2026-06-09#a', '2026-06-09#b']),
    );
  });

  it('returning visit: marks only unseen rows and fills the total', () => {
    const local = makeStorage({ [SEED]: serializeSeen(new Set(['2026-06-08#old'])) });
    const session = makeStorage();
    const rows = [makeRow('2026-06-09#new'), makeRow('2026-06-08#old')];
    const { count, total } = run(rows, { local, session });

    expect(count).toBe(1);
    expect(rows[0]!._classes.has('is-new')).toBe(true);
    expect(rows[1]!._classes.has('is-new')).toBe(false);
    expect((total as { textContent: string }).textContent).toBe('· 1 new overall');
    expect((total as { _classes: Set<string> })._classes.has('is-shown')).toBe(true);
    // persisted union
    expect(parseSeen(local.data.get(SEED) ?? null)).toEqual(
      new Set(['2026-06-08#old', '2026-06-09#new']),
    );
  });

  it('in-session stability: a frozen sessionStorage baseline keeps markers across reloads', () => {
    const local = makeStorage({ [SEED]: serializeSeen(new Set(['2026-06-08#old'])) });
    const session = makeStorage();
    const rows1 = [makeRow('2026-06-09#new'), makeRow('2026-06-08#old')];
    run(rows1, { local, session });
    expect(rows1[0]!._classes.has('is-new')).toBe(true);
    // localStorage has now advanced to include #new; baseline snapshot is frozen.
    const rows2 = [makeRow('2026-06-09#new'), makeRow('2026-06-08#old')];
    run(rows2, { local, session });
    // Second in-session load still marks #new against the frozen baseline.
    expect(rows2[0]!._classes.has('is-new')).toBe(true);
    expect(rows2[1]!._classes.has('is-new')).toBe(false);
  });

  it('without sessionStorage, baseline falls back to localStorage (markers clear on reload)', () => {
    const local = makeStorage({ [SEED]: serializeSeen(new Set(['2026-06-08#old'])) });
    const rows1 = [makeRow('2026-06-09#new')];
    run(rows1, { local, session: null });
    expect(rows1[0]!._classes.has('is-new')).toBe(true);
    const rows2 = [makeRow('2026-06-09#new')];
    run(rows2, { local, session: null });
    // localStorage advanced and there is no frozen baseline -> no longer "new".
    expect(rows2[0]!._classes.has('is-new')).toBe(false);
  });

  it('monotonic: union keeps every prior id (no date-window prune to re-flag old studies)', () => {
    const seen = new Set(['2026-03-01#ancient', '2026-04-10#edge', '2026-06-08#recent']);
    const local = makeStorage({ [SEED]: serializeSeen(seen) });
    const rows = [makeRow('2026-06-09#today')];
    run(rows, { local, session: makeStorage() });
    const stored = parseSeen(local.data.get(SEED) ?? null)!;
    // Every prior id survives (the >60-day-old one is NOT dropped), plus today's.
    expect(stored.has('2026-06-09#today')).toBe(true);
    expect(stored.has('2026-06-08#recent')).toBe(true);
    expect(stored.has('2026-04-10#edge')).toBe(true);
    expect(stored.has('2026-03-01#ancient')).toBe(true);
  });

  it('an old already-seen study still in the feed is NOT re-flagged after a long gap', () => {
    // The cross-model bug: a fixed prune window shorter than the unbounded feed
    // dropped #old, then re-flagged it new. #old is seen AND still rendered.
    const local = makeStorage({ [SEED]: serializeSeen(new Set(['2026-01-01#old', '2026-06-09#new'])) });
    const rows = [makeRow('2026-06-09#new'), makeRow('2026-01-01#old')];
    const { count } = run(rows, { local, session: makeStorage() });
    expect(count).toBe(0);
    expect(rows[1]!._classes.has('is-new')).toBe(false);
  });

  it('malformed stored value is treated as first visit (marks nothing)', () => {
    const local = makeStorage({ [SEED]: 'corrupt{' });
    const rows = [makeRow('2026-06-09#a')];
    const { count } = run(rows, { local, session: makeStorage() });
    expect(count).toBe(0);
    expect(rows[0]!._classes.has('is-new')).toBe(false);
  });

  it('storage.getItem throwing degrades to no markers, no throw', () => {
    const local = makeStorage({}, { throwOnGet: true });
    const rows = [makeRow('2026-06-09#a')];
    expect(() => run(rows, { local, session: null })).not.toThrow();
    expect(rows[0]!._classes.has('is-new')).toBe(false);
  });

  it('storage.setItem throwing (private mode) does not throw and still marks', () => {
    // seen has data so #new would be marked; setItem throws on persist.
    const local = makeStorage(
      { [SEED]: serializeSeen(new Set(['2026-06-08#old'])) },
      { throwOnSet: true },
    );
    const rows = [makeRow('2026-06-09#new')];
    expect(() => run(rows, { local, session: null })).not.toThrow();
    expect(rows[0]!._classes.has('is-new')).toBe(true);
  });

  it('rows without a data-study-id are ignored', () => {
    const local = makeStorage();
    const rows = [makeRow(null), makeRow('2026-06-09#a')];
    const { count } = run(rows, { local, session: makeStorage() });
    // first visit -> count 0, but no crash on the id-less row
    expect(count).toBe(0);
    expect(parseSeen(local.data.get(SEED) ?? null)).toEqual(new Set(['2026-06-09#a']));
  });

  it('deps.local = null disables all persistence but still no-throws', () => {
    const rows = [makeRow('2026-06-09#a')];
    expect(() => run(rows, { local: null, session: null })).not.toThrow();
  });

  it('empty stored set does not flood: baseline falls back to the current feed', () => {
    // A persisted '[]' parses to an empty Set; treating it as a real baseline
    // would mark every row new. It must fall back to "current feed".
    const local = makeStorage({ [SEED]: '[]' });
    const rows = [makeRow('2026-06-09#a'), makeRow('2026-06-09#b')];
    const { count } = run(rows, { local, session: makeStorage() });
    expect(count).toBe(0);
    expect(rows.every((r) => !r._classes.has('is-new'))).toBe(true);
  });

  it('first visit, then a study added mid-session flags only the new one', () => {
    const local = makeStorage();
    const session = makeStorage();
    const rows1 = [makeRow('2026-06-08#a')];
    expect(run(rows1, { local, session }).count).toBe(0); // first paint flags nothing
    const rows2 = [makeRow('2026-06-09#b'), makeRow('2026-06-08#a')];
    const { count } = run(rows2, { local, session });
    expect(count).toBe(1);
    expect(rows2[0]!._classes.has('is-new')).toBe(true); // #b added mid-session
    expect(rows2[1]!._classes.has('is-new')).toBe(false); // #a was in the baseline
  });

  it('tolerates a null totalEl', () => {
    const local = makeStorage({ [SEED]: serializeSeen(new Set(['2026-06-08#old'])) });
    const rows = [makeRow('2026-06-09#new')];
    const count = setupWhatsNew(
      { rows: rows as unknown as ArrayLike<HTMLElement>, totalEl: null },
      { local, session: makeStorage() },
    );
    expect(count).toBe(1);
    expect(rows[0]!._classes.has('is-new')).toBe(true);
  });

  it('re-invocation is idempotent: stale is-new / is-shown are cleared', () => {
    const row = makeRow('2026-06-09#new');
    const { total } = run([row], {
      local: makeStorage({ [SEED]: serializeSeen(new Set(['2026-06-08#old'])) }),
      session: makeStorage(),
    });
    expect(row._classes.has('is-new')).toBe(true);
    expect((total as { _classes: Set<string> })._classes.has('is-shown')).toBe(true);
    // Re-run on the SAME nodes in a fresh session whose baseline already has
    // #new: the stale markers must clear.
    run([row], {
      local: makeStorage({ [SEED]: serializeSeen(new Set(['2026-06-08#old', '2026-06-09#new'])) }),
      session: makeStorage(),
    }, total);
    expect(row._classes.has('is-new')).toBe(false);
    expect((total as { _classes: Set<string> })._classes.has('is-shown')).toBe(false);
    expect((total as { textContent: string }).textContent).toBe('');
  });
});
