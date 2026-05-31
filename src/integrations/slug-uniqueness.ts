// v0.11 PR-1a foundations: Astro integration that runs
// assertSlugUniqueness BEFORE the static site generation begins.
//
// Why an integration: v0.10 already calls assertSlugUniqueness at the
// end of `build:day` (build/digest-builder.ts), but `astro build` runs
// independently and never validates the slug-uniqueness invariant. If
// a curator hand-edits an override JSON to introduce a colliding slug,
// `build:day` skips (no source changes), `astro build` produces a
// silently-malformed reverse index, and the colliding `/tags/<slug>/`
// landing routes the wrong studies. The v0.11 filter rail will read
// the namespace JSON and built-intersections allowlist for slug
// resolution; an ambiguous lookup would route ?tag=<slug> filters to
// the wrong namespace and silently mis-narrow the study list.
//
// Why `astro:build:start` (not `astro:build:done`): the latter fires
// AFTER dist/ is written, so a collision would already be on disk by
// the time we throw. The integration runs `astro:build:start` so a
// collision halts the build before any HTML is emitted — leaves the
// previous dist/ intact for a safe re-deploy, and CI sees a non-zero
// exit on the failing build.
//
// Lifecycle: dev mode (`astro dev`) is intentionally NOT validated —
// the hook is build-only. Local edits can iterate on overrides without
// the validator firing on every save; the failure surfaces at the next
// `npm run build`, which is the gate that matters.

import type { AstroIntegration } from 'astro';
import { listDigestsStrict, assertSlugUniqueness } from '../lib/tag-index.ts';
import { VERDICT_META } from '../lib/verdict.ts';

export type SlugUniquenessOptions = {
  // Optional digests dir override for tests / non-default layouts.
  // Production callers leave this undefined → reads from data/digests/.
  digestsDir?: string;
};

export default function slugUniquenessIntegration(
  opts: SlugUniquenessOptions = {},
): AstroIntegration {
  return {
    name: 'oncbrain:slug-uniqueness',
    hooks: {
      'astro:build:start': async ({ logger }) => {
        const verdictSlugs = Object.keys(VERDICT_META);
        const digests = listDigestsStrict(opts.digestsDir);
        // assertSlugUniqueness throws on collision or malformed slug —
        // the throw propagates out of the hook and aborts the build
        // before page generation begins. The logger prefix makes it
        // obvious in CI which integration halted the build.
        try {
          assertSlugUniqueness(digests, verdictSlugs);
          logger.info(
            `slug uniqueness: ${digests.length} digest(s) validated`,
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          logger.error(`slug uniqueness violation: ${message}`);
          throw err;
        }
      },
    },
  };
}
