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

  function describeResult(result: ReturnType<typeof findSlugCollision>): string {
    if (!result) return '';
    if (result.kind === 'collision') {
      return `collision: ${result.a.namespace}/${result.a.slug} vs ${result.b.namespace}/${result.b.slug}`;
    }
    return `malformed: ${result.namespace}/${result.slug}`;
  }

  it('static enums have no internal collisions (modality / intent / methodology)', () => {
    // No verdict, no meeting — just the typed enums against themselves.
    const result = findSlugCollision([], []);
    expect(result, describeResult(result)).toBeNull();
  });

  it('static enums do not collide with the verdict slug set', () => {
    const result = findSlugCollision([], VERDICT_SLUGS);
    expect(result, describeResult(result)).toBeNull();
  });

  it('static enums do not collide with a representative meeting slug set', () => {
    // Conferences observed in data/digests/. Year-suffixed slugs are
    // unique-by-construction; this guards against future flat-named meetings.
    const meetings = ['asco-2026', 'esmo-2026', 'astro-2026', 'aacr-2026', 'asco-gi-2026', 'asco-gu-2026'];
    const result = findSlugCollision(meetings, VERDICT_SLUGS);
    expect(result, describeResult(result)).toBeNull();
  });

  it('detects a synthetic collision (regression guard)', () => {
    // If 'retrospective' (methodology) were added to verdict, this is what
    // the build-time assertion would catch.
    const raw = findSlugCollision([], ['retrospective']);
    expect(raw).not.toBeNull();
    const result = raw!;
    expect(result.kind).toBe('collision');
    if (result.kind === 'collision') {
      expect(result.a.namespace).toBe('methodology');
      expect(result.b.namespace).toBe('verdict');
      expect(result.a.slug).toBe('retrospective');
    }
  });

  it('detects a meeting/methodology collision', () => {
    const raw = findSlugCollision(['phase-3-rct'], []);
    expect(raw).not.toBeNull();
    const result = raw!;
    expect(result.kind).toBe('collision');
    if (result.kind === 'collision') {
      expect(result.b.namespace).toBe('meeting');
    }
  });

  it('every static def has slug + label + non-empty tooltip', () => {
    for (const def of [...MODALITY_DEFS, ...INTENT_DEFS, ...METHODOLOGY_DEFS]) {
      expect(def.slug.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.tooltip.length).toBeGreaterThan(0);
    }
  });

  it('deduplicates meeting input internally (build callers do not pre-dedupe)', () => {
    // Every day of ASCO 2026 shares the same conference slug. The build
    // passes the raw list across all digests; a naive impl would report a
    // confusing self-collision.
    const result = findSlugCollision(['asco-2026', 'asco-2026', 'asco-2026'], []);
    expect(result).toBeNull();
  });

  it('rejects a malformed meeting slug (build fails BEFORE broken URLs ship)', () => {
    const raw = findSlugCollision(['ASCO 2026'], []);
    expect(raw).not.toBeNull();
    const result = raw!;
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.namespace).toBe('meeting');
      expect(result.slug).toBe('ASCO 2026');
    }
  });

  it('rejects a %2F-encoded meeting slug', () => {
    const raw = findSlugCollision(['asco%2Fgi-2026'], []);
    expect(raw).not.toBeNull();
    const result = raw!;
    expect(result.kind).toBe('malformed');
  });
});
