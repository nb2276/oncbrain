// v0.60.1: the one coherence rule a CONSORT flow must pass to be drawn, shared
// by the Phase 2 parser (parseConsort) and the renderer (ConsortFlow), so an
// artifact built before the rule still can't draw an impossible flow.
//
// Arms that allocate MORE patients than were randomized are not a randomization:
// STAR-TREC (2026-08-24) drew "Primary TME (40 randomised + 42 by preference)"
// as a third arm, 426 allocated out of 384 randomized. Which arm is wrong can't
// be known here, so the whole diagram is withheld. Fewer is normal (post-
// randomization exclusions: PIVOTALboost 1314 of 1465, MAVERICK 303 of 304).
//
// The randomized total is optional: a source that prints only the arm
// allocations ("PCI + MRI n=152 vs MRI alone n=151") still gets its flow, with
// no total, because summing the arms would be a back-calculated number.
export type ConsortShape = {
  randomized?: number | null;
  arms: Array<{ allocated: number }>;
};

export function consortIsCoherent(c: ConsortShape | null | undefined): boolean {
  if (!c || !Array.isArray(c.arms) || c.arms.length < 2) return false;
  if (c.randomized == null) return true;
  const allocated = c.arms.reduce((n, a) => n + a.allocated, 0);
  return allocated <= c.randomized;
}

/** The randomized node's count, or null to draw the bare label (never the arms' sum). */
export function randomizedCount(c: ConsortShape): number | null {
  return typeof c.randomized === 'number' && c.randomized > 0 ? c.randomized : null;
}
