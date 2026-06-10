// Client-side "new since your last visit" marker for the home recent-studies
// feed. Marks each study the reader has not seen before with a NEW pill and
// shows a "N new overall" total.
//
// Identity is per-study, not per-date: a study id is `${date}#${slug}` (the
// same id used for the feed deep-link anchor). A date alone is not an identity,
// so a study added or corrected on an already-seen date still surfaces as new.
//
// Persistence model (no backend, static multi-page site):
//   - localStorage holds the SET of seen study ids (date-pruned to a window).
//   - On load we read it, then write back union(seen, current) IMMEDIATELY.
//     The write is monotonic by construction (we only ever ADD current ids;
//     pruning drops only stale ones), so a stale tab or PWA stale-while-
//     revalidate page can never move the checkpoint backward.
//   - sessionStorage holds a per-tab BASELINE snapshot of the seen-set taken on
//     the first load of the session. Marking is computed against that frozen
//     baseline, so NEW pills stay stable as the reader navigates in-session
//     (home -> study -> back) even though localStorage advanced on the first
//     load.
//   - First visit (no stored set) marks nothing (no flooding 71 NEW pills) and
//     just seeds the set.
//   - All storage access is wrapped: a throw (Safari private mode, quota,
//     disabled storage) degrades to "no markers", never a crash.
//
// Pure helpers + the DOM `setupWhatsNew` core are exported so the logic can be
// unit-tested against stub nodes + injected storage with no jsdom, mirroring
// src/lib/share-script.ts.

const LS_KEY = 'oncbrain:seenIds';
const SS_KEY = 'oncbrain:baseline';
// Upper bound on the stored seen-set. At write time the cap is raised to the
// live feed size, so an id that is STILL IN THE FEED is never dropped (dropping
// one would re-flag an already-seen study as new on a later visit, the bug both
// reviewers caught). The cap only trims ids that have aged off the feed
// entirely; today the feed is uncapped, so it is a pure safety net for a future
// capped feed (T3).
const MAX_SEEN = 5000;

// A study id is `${YYYY-MM-DD}#${slug}`. The leading 10 chars are the date.
const ID_RE = /^\d{4}-\d{2}-\d{2}#.+$/;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WhatsNewDeps {
  local?: StorageLike | null;
  session?: StorageLike | null;
}

export interface WhatsNewRefs {
  // Feed <li> elements, each carrying data-study-id and (in markup) a hidden
  // .recent-new-pill child revealed by the .is-new class this function adds.
  // These are only the RENDERED rows; a page may render a slice of the corpus.
  rows: ArrayLike<HTMLElement>;
  // The "N new overall" total element, hidden until .is-shown is added.
  totalEl?: HTMLElement | null;
  // The FULL current corpus of study ids (T3: the home renders a ~12-row slice
  // but must count, snapshot the baseline against, and persist the whole feed,
  // or visiting home would mark the unrendered studies seen and /studies would
  // never flag them). When omitted, the corpus is the rendered rows' ids (the
  // /studies and legacy single-page case where every study renders).
  allIds?: string[];
}

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

// 'YYYY-MM-DD#slug' -> 'YYYY-MM-DD'.
export function dateOfId(id: string): string {
  return id.slice(0, 10);
}

// Parse the stored seen-set. Returns null for missing OR malformed input (both
// mean "treat as first visit"); only well-formed ids survive. The literal
// stored string 'null' (used for the first-visit session baseline) also parses
// to null, which round-trips first-visit state correctly.
export function parseSeen(raw: string | null): Set<string> | null {
  if (raw == null) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const set = new Set<string>();
  for (const v of arr) {
    if (typeof v === 'string' && isValidId(v)) set.add(v);
  }
  return set;
}

export function serializeSeen(set: Set<string>): string {
  return JSON.stringify(Array.from(set));
}

// Which of currentIds are NOT in the baseline -> "new". baseline === null is
// first visit, so nothing is new.
export function partitionNew(currentIds: string[], baseline: Set<string> | null): Set<string> {
  const fresh = new Set<string>();
  if (baseline === null) return fresh;
  for (const id of currentIds) {
    if (!baseline.has(id)) fresh.add(id);
  }
  return fresh;
}

// Cap the stored set to `max` ids, keeping the most recent. Ids are date-
// prefixed (`YYYY-MM-DD#slug`), so a lexical sort orders them by date. Callers
// raise `max` to the live feed size so an id still in the feed is never
// dropped. <= max returns the set unchanged.
export function capSeen(ids: Iterable<string>, max: number): Set<string> {
  const arr = Array.from(new Set(ids));
  if (arr.length <= max) return new Set(arr);
  arr.sort(); // ascending: oldest (lowest date prefix) first
  return new Set(arr.slice(arr.length - max)); // keep the newest `max`
}

// Wrap a Storage getter so a throw on access OR on the write-probe (Safari
// private mode) degrades to null rather than throwing.
function safeStorage(get: () => StorageLike | undefined | null): StorageLike | null {
  try {
    const s = get();
    if (!s) return null;
    const probe = '__oncbrain_probe__';
    s.setItem(probe, '1');
    // removeItem may not exist on a stub; guard it.
    (s as unknown as { removeItem?: (k: string) => void }).removeItem?.(probe);
    return s;
  } catch {
    return null;
  }
}

// DOM core. Marks new rows, fills the total, and advances the stored set.
// Returns the count of new studies (for tests / callers). Exported for unit
// tests driven against stub elements + injected storage.
export function setupWhatsNew(refs: WhatsNewRefs, deps: WhatsNewDeps = {}): number {
  const local = deps.local !== undefined ? deps.local : safeStorage(() => (globalThis as { localStorage?: StorageLike }).localStorage);
  const session = deps.session !== undefined ? deps.session : safeStorage(() => (globalThis as { sessionStorage?: StorageLike }).sessionStorage);

  const rows = Array.from(refs.rows);
  const renderedIds: string[] = [];
  for (const row of rows) {
    const id = row.getAttribute?.('data-study-id') ?? '';
    if (id) renderedIds.push(id);
  }

  // The CORPUS is the full current feed (T3: home renders a slice). It drives
  // the count, the baseline, and the persisted seen-set. The rendered rows only
  // drive which visible row gets a NEW pill. When allIds is omitted, empty, or
  // entirely invalid, the corpus falls back to the rendered rows (the /studies
  // and legacy single-page case, and a defensive guard against a junk island).
  const validAllIds = refs.allIds ? refs.allIds.filter(isValidId) : [];
  const corpus = validAllIds.length > 0 ? validAllIds : renderedIds;

  // Nothing to count or persist if the corpus is empty. Bailing here means we
  // never write an empty set, which on a later visit would have an empty
  // baseline and flood every row as new.
  if (corpus.length === 0) return 0;
  const corpusSet = new Set<string>(corpus);

  // 1. Persisted seen-set (localStorage). Absent/malformed -> null (first visit).
  let stored: string | null = null;
  try {
    stored = local?.getItem(LS_KEY) ?? null;
  } catch {
    stored = null;
  }
  const seen = parseSeen(stored);

  // 2. Per-session baseline, frozen on the first load of the tab session so
  //    markers stay stable across in-session navigation. It is ALWAYS a real,
  //    non-empty set: a first visit (or an absent / empty / malformed seen-set)
  //    treats everything currently shown as already-seen, so the first paint
  //    flags nothing and only studies added LATER flag. This both avoids
  //    flooding 71 NEW pills and never persists the string 'null'.
  let baseline: Set<string>;
  try {
    const ssRaw = session ? session.getItem(SS_KEY) : null;
    if (ssRaw !== null && ssRaw !== undefined) {
      const parsed = parseSeen(ssRaw);
      baseline = parsed && parsed.size > 0 ? parsed : corpusSet;
    } else {
      baseline = seen && seen.size > 0 ? seen : corpusSet;
      session?.setItem(SS_KEY, serializeSeen(baseline));
    }
  } catch {
    baseline = seen && seen.size > 0 ? seen : corpusSet;
  }

  // 3. The new set is computed over the whole CORPUS (so the count is correct
  //    even on a sliced page). Mark only the RENDERED rows whose id is new;
  //    clear stale state first so a re-invocation on the same DOM is idempotent.
  const fresh = partitionNew(corpus, baseline);
  for (const row of rows) {
    const id = row.getAttribute?.('data-study-id') ?? '';
    if (!id) continue;
    if (fresh.has(id)) row.classList.add('is-new');
    else row.classList.remove('is-new');
  }

  // 4. Total. "N new overall" (filter-agnostic; per-row pills hide with their
  //    rows under the filter rail, so the count is labeled "overall").
  if (refs.totalEl) {
    if (fresh.size > 0) {
      refs.totalEl.textContent = `· ${fresh.size} new overall`;
      refs.totalEl.classList.add('is-shown');
    } else {
      refs.totalEl.textContent = '';
      refs.totalEl.classList.remove('is-shown');
    }
  }

  // 5. Advance the stored set immediately. Monotonic union of the prior set and
  //    the current feed, capped to >= the live feed size so no id still in the
  //    feed is ever dropped (the cross-model finding: a fixed date window
  //    shorter than the unbounded feed re-flagged old studies).
  try {
    const merged = new Set<string>(seen ?? []);
    for (const id of corpus) {
      if (isValidId(id)) merged.add(id);
    }
    const cap = Math.max(MAX_SEEN, corpus.length);
    local?.setItem(LS_KEY, serializeSeen(capSeen(merged, cap)));
  } catch {
    // Storage full / blocked: markers already applied, skip persistence.
  }

  return fresh.size;
}

// Page-level entry point. Idempotent. Reads the optional full-corpus id list
// from a <script type="application/json" id="all-study-ids"> tag (T3: the home
// renders a slice but must count + persist the whole feed). Absent -> the
// rendered rows are the corpus (/studies and legacy pages).
export function initWhatsNew(): void {
  if (typeof document === 'undefined') return;
  const rows = document.querySelectorAll<HTMLElement>('.recent-li[data-study-id]');
  if (rows.length === 0) return;
  const totalEl = document.querySelector<HTMLElement>('.recent-new-total');
  let allIds: string[] | undefined;
  const idsTag = document.getElementById('all-study-ids');
  if (idsTag?.textContent) {
    try {
      const parsed = JSON.parse(idsTag.textContent);
      if (Array.isArray(parsed)) allIds = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // Malformed corpus JSON -> fall back to the rendered rows.
    }
  }
  setupWhatsNew({ rows, totalEl, allIds });
}
