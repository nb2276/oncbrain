// v0.10 tag system uses slug-only URLs (/tags/<slug>/, not /tags/<ns>:<slug>/).
// Every tag value must be globally unique across the 5 namespaces that surface
// under /tags/: modality, intent, methodology, verdict, meeting. This test
// guards the assertion that build/digest-builder.ts runs at every build —
// without it, a future tag value could silently collide with another namespace's
// slug and the wrong studies would land on a single tag page.

import { describe, it, expect } from 'vitest';
import {
  MODALITY_DEFS,
  INTENT_DEFS,
  METHODOLOGY_DEFS,
  findSlugCollision,
  isSafeTagSlug,
  staticTagSlugs,
} from '../src/lib/tags.ts';
import { VERDICT_META } from '../src/lib/verdict.ts';

const VERDICT_SLUGS = Object.keys(VERDICT_META);

describe('tag namespace slug uniqueness', () => {
  it('every static tag slug passes the URL-safe regex', () => {
    for (const slug of staticTagSlugs()) {
      expect(isSafeTagSlug(slug), `slug "${slug}" is not URL-safe`).toBe(true);
    }
  });

  it('static enums have no internal collisions (modality / intent / methodology)', () => {
    // No verdict, no meeting — just the typed enums against themselves.
    const result = findSlugCollision([], []);
    expect(result, result ? `collision: ${result.a.namespace}/${result.a.slug} vs ${result.b.namespace}/${result.b.slug}` : '').toBeNull();
  });

  it('static enums do not collide with the verdict slug set', () => {
    const result = findSlugCollision([], VERDICT_SLUGS);
    expect(result, result ? `collision: ${result.a.namespace}/${result.a.slug} vs ${result.b.namespace}/${result.b.slug}` : '').toBeNull();
  });

  it('static enums do not collide with a representative meeting slug set', () => {
    // Conferences observed in data/digests/. Year-suffixed slugs are
    // unique-by-construction; this guards against future flat-named meetings.
    const meetings = ['asco-2026', 'esmo-2026', 'astro-2026', 'aacr-2026', 'asco-gi-2026', 'asco-gu-2026'];
    const result = findSlugCollision(meetings, VERDICT_SLUGS);
    expect(result, result ? `collision: ${result.a.namespace}/${result.a.slug} vs ${result.b.namespace}/${result.b.slug}` : '').toBeNull();
  });

  it('detects a synthetic collision (regression guard)', () => {
    // If 'retrospective' (methodology) were added to verdict, this is what
    // the build-time assertion would catch.
    const result = findSlugCollision([], ['retrospective']);
    expect(result).not.toBeNull();
    expect(result!.a.namespace).toBe('methodology');
    expect(result!.b.namespace).toBe('verdict');
    expect(result!.a.slug).toBe('retrospective');
  });

  it('detects a meeting/methodology collision', () => {
    const result = findSlugCollision(['phase-3-rct'], []);
    expect(result).not.toBeNull();
    expect(result!.b.namespace).toBe('meeting');
  });

  it('every static def has slug + label + non-empty tooltip', () => {
    for (const def of [...MODALITY_DEFS, ...INTENT_DEFS, ...METHODOLOGY_DEFS]) {
      expect(def.slug.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.tooltip.length).toBeGreaterThan(0);
    }
  });
});
