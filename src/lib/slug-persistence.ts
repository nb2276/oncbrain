// A rebuild must not rename a study's URL.
//
// THE BUG. `study.slug` comes from Phase 1's clustering, derived from the study
// NAME the LLM writes. Rebuild a date and the LLM writes a slightly different
// name, so the slug moves: `stellar-tnt-larc` → `stellar`,
// `larc-sib-crt` → `nct02195141`, `irock` → `irock-rcc-sabr-contouring`.
// Rebuilding five dates on 2026-08-10 kept 5 per-study URLs and broke 7.
//
// WHY IT IS WORSE THAN IT LOOKS. Two silent failures, no error on either path:
//   1. The slug IS the permalink (`/study/<date>-<slug>/`). `.do/app.yaml` sets
//      `catchall_document: index.html`, so a dead per-study link returns HTTP
//      200 with the HOME PAGE — never a 404. A shared link decays into "the
//      site" and nothing anywhere reports it.
//   2. The slug is also the curator OVERRIDE target. A sidecar keyed to the old
//      slug becomes a no-op, reported only as `WARN edit slug(s) not found`.
//      This happened live: an `irock` override stopped applying the moment the
//      next build renamed the study.
//
// THE FIX. Stop deriving identity from the name, which the LLM rewrites, and
// take it from PROVENANCE, which it cannot: the same study is assembled from
// the same source rows. If a new study cites paper 42 and last build's study
// cited paper 42, they are the same card and it keeps the published slug.
//
// This runs at build time against the PREVIOUSLY PUBLISHED artifact for that
// same date, so a slug is minted once and then held. It fixes the cause, so no
// redirect is needed for anything published after it ships; retired slugs are
// still recorded for the links already broken before it existed.

export type PersistableStudy = {
  slug?: string;
  name?: string;
  nct?: string | null;
  source_ids?: ReadonlyArray<{ type?: string; id?: number | string }> | null;
};

export type SlugPersistenceResult = {
  // One slug per NEW study, positionally aligned with the input.
  slugs: string[];
  // Previously published slugs no longer carried by any study, so a caller can
  // record them as aliases. Empty in the steady state.
  retired: string[];
};

function sourceKeys(s: PersistableStudy): Set<string> {
  const out = new Set<string>();
  for (const r of s.source_ids ?? []) {
    if (!r || r.id === undefined || r.id === null) continue;
    out.add(`${r.type ?? 'unknown'}:${r.id}`);
  }
  return out;
}

function normNct(s: PersistableStudy): string | null {
  const n = typeof s.nct === 'string' ? s.nct.trim().toUpperCase() : '';
  return /^NCT\d{8}$/.test(n) ? n : null;
}

// How strongly do these two describe the same card? Higher wins; 0 = no match.
//
// The NCT disagreement veto mirrors `prior-estimate.ts`: when both sides state a
// registration and they differ, that is positive evidence of two DIFFERENT
// trials and it outranks any provenance overlap (a single source can legitimately
// cover two trials, so shared sources alone must not fuse them).
export function matchScore(a: PersistableStudy, b: PersistableStudy): number {
  const na = normNct(a);
  const nb = normNct(b);
  if (na && nb && na !== nb) return 0;

  const ka = sourceKeys(a);
  const kb = sourceKeys(b);
  let shared = 0;
  for (const k of ka) if (kb.has(k)) shared++;
  const union = ka.size + kb.size - shared;
  const overlap = union > 0 ? shared / union : 0;

  // An unchanged slug is already stable — rank it first so a steady-state
  // rebuild is a no-op and can never be perturbed by a rival's overlap.
  if (a.slug && b.slug && a.slug === b.slug) return 1000 + overlap;
  if (na && nb && na === nb) return 100 + overlap;
  return overlap > 0 ? overlap : 0;
}

// Reuse each previously published slug for whichever new study is the same card.
//
// Greedy, highest score first, strictly one-to-one: a cluster SPLIT (one old
// study becoming two) hands the published slug to the better-matching half and
// mints a fresh one for the other, and a MERGE takes only one old slug. Ties
// break on input order, so the result is deterministic.
export function persistSlugs(
  previous: readonly PersistableStudy[],
  next: readonly PersistableStudy[],
): SlugPersistenceResult {
  const slugs = next.map((s) => (typeof s.slug === 'string' ? s.slug : ''));
  if (previous.length === 0) return { slugs, retired: [] };

  const pairs: Array<{ score: number; ni: number; pi: number }> = [];
  next.forEach((n, ni) =>
    previous.forEach((p, pi) => {
      if (!p.slug) return;
      const score = matchScore(n, p);
      if (score > 0) pairs.push({ score, ni, pi });
    }),
  );
  pairs.sort((x, y) => y.score - x.score || x.ni - y.ni || x.pi - y.pi);

  const takenNew = new Set<number>();
  const usedPrev = new Set<number>();
  // Slugs already spoken for, so a reused slug can never collide with a new
  // study that happens to derive the same one.
  const claimed = new Set<string>();
  for (const { ni, pi } of pairs) {
    if (takenNew.has(ni) || usedPrev.has(pi)) continue;
    const slug = previous[pi].slug!;
    if (claimed.has(slug)) continue;
    slugs[ni] = slug;
    claimed.add(slug);
    takenNew.add(ni);
    usedPrev.add(pi);
  }

  // Unmatched studies keep their own slug, unless a reused one already took it.
  const seen = new Set(claimed);
  slugs.forEach((s, i) => {
    if (takenNew.has(i)) return;
    let candidate = s || 'study';
    let n = 2;
    while (seen.has(candidate)) candidate = `${s || 'study'}-${n++}`;
    slugs[i] = candidate;
    seen.add(candidate);
  });

  const carried = new Set(slugs);
  const retired = previous
    .map((p) => p.slug)
    .filter((s): s is string => !!s && !carried.has(s));

  return { slugs, retired };
}
