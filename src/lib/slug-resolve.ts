// Per-date slug resolution.
//
// Phase 1 emits a unique slug per cluster, but existing v0.5 artifacts don't
// carry that field, so renderers fall back to deriveSlug(name). The derivation
// is lossy by design (strips punctuation, collapses unicode, truncates to 64)
// which can collide for distinct study names:
//   "研究" + "🧪" → "study"          (both fall to FALLBACK_SLUG)
//   "Trial — α" + "Trial" → "trial"   (drops the suffix entirely)
//   ("a".repeat(64)) + ("a".repeat(65)) → 64 'a's (truncation collision)
//
// Within a single date the slug is the anchor id on [date].astro and the
// deep-link target from search results. Same-day collisions = duplicate HTML
// ids + ambiguous deep links. Cross-date is safe because the date is part of
// the URL.
//
// This module resolves a list of studies (one date's worth) by suffixing -2,
// -3, ... to collisions. Persisted slugs (study.slug) win uncontested over
// derived fallbacks for that name; only the fallback gets suffixed.

import { deriveSlug } from './slug.ts';

const MAX_SLUG_LEN = 64;

type WithName = { name: string; slug?: string | null };

export function assignSlugsForDate<T extends WithName>(studies: readonly T[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const s of studies) {
    const base = (s.slug && s.slug.length > 0 ? s.slug : deriveSlug(s.name));
    const count = seen.get(base) ?? 0;
    if (count === 0) {
      out.push(base);
      seen.set(base, 1);
    } else {
      // Suffix -2, -3, ... Truncate the base if the suffix would push past
      // MAX_SLUG_LEN so the resulting id stays inside the safe-slug regex.
      // LOOP until the candidate is actually unused: the old code reserved the
      // resolved slug AFTER pushing it, which only guarded a FUTURE base — an
      // explicit slug like "x-2" appearing before two "x" studies still
      // collided ("x","x" → "x-2" duplicating the explicit "x-2"), producing
      // duplicate DOM ids + ambiguous anchors/API/search links. Increment the
      // suffix past any already-emitted candidate.
      let n = count + 1;
      let resolved: string;
      do {
        const suffix = `-${n}`;
        const trimmedBase = base.length + suffix.length > MAX_SLUG_LEN
          ? base.slice(0, MAX_SLUG_LEN - suffix.length).replace(/-+$/, '')
          : base;
        resolved = `${trimmedBase}${suffix}`;
        n++;
      } while (seen.has(resolved));
      out.push(resolved);
      seen.set(base, count + 1);
      // Reserve the resolved slug so a later base that derives directly to it
      // won't collide.
      seen.set(resolved, 1);
    }
  }
  return out;
}
