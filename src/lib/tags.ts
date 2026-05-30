// v0.10 cross-cutting tag system.
//
// Five tag namespaces surface under /tags/<slug>/: modality, intent,
// methodology (new typed fields on DigestStudy), plus verdict (computed from
// study.verdict.soc_implication) and meeting (computed from digest.conference).
// Disease-site stays under /sites/<slug>/ — NOT surfaced under /tags/ — to
// preserve existing URLs and avoid two surfaces for the same axis.
//
// URL format is SLUG-ONLY: /tags/radiation/ rather than /tags/modality:radiation/.
// This requires every tag value to be globally unique across all 5 namespaces.
// The collision check runs at build time in build/digest-builder.ts; if a future
// value duplicates an existing slug, the build fails before deploy.
//
// Tooltip definitions live here as the single source of truth — the chip render
// reads them, and the LLM prompt (digest-v5-study-agent.txt) gets them as
// constraints so it picks the right namespace value for a study.

// ---------------- Namespace identity ----------------

export const TAG_NAMESPACES = [
  'modality',
  'intent',
  'methodology',
  'verdict', // computed from study.verdict.soc_implication
  'meeting', // computed from digest.conference + date year
] as const;

export type TagNamespace = (typeof TAG_NAMESPACES)[number];

// ---------------- Value enums (typed namespaces) ----------------
//
// Modality, intent, methodology are emitted directly by Phase 2 as typed
// fields on DigestStudy. Verdict + meeting are computed at build time from
// existing fields, so they don't appear here.

export const MODALITY_VALUES = [
  'radiation',
  'surgery',
  'systemic',
  'combined',
] as const;
export type ModalityTag = (typeof MODALITY_VALUES)[number];

export const INTENT_VALUES = ['curative', 'palliative', 'supportive'] as const;
export type IntentTag = (typeof INTENT_VALUES)[number];

export const METHODOLOGY_VALUES = [
  'phase-3-rct',
  'phase-2-trial',
  'phase-1',
  'retrospective',
  'meta-analysis',
  'real-world-evidence',
  'consensus-guideline',
] as const;
export type MethodologyTag = (typeof METHODOLOGY_VALUES)[number];

// ---------------- Tag definitions (tooltip + label) ----------------
//
// Each value gets a short label (display name) and a 1-line tooltip definition.
// The LLM reads these as the canonical assignment rule for each value; readers
// see them on chip hover/tap. Keep tooltips terse, peer-review register — same
// voice as VOICE.md.

type TagDef = { slug: string; label: string; tooltip: string };

export const MODALITY_DEFS: readonly TagDef[] = [
  {
    slug: 'radiation',
    label: 'Radiation',
    tooltip: 'Studies where radiotherapy is a primary intervention or comparator.',
  },
  {
    slug: 'surgery',
    label: 'Surgery',
    tooltip: 'Studies where a surgical procedure is a primary intervention or comparator.',
  },
  {
    slug: 'systemic',
    label: 'Systemic',
    tooltip:
      'Drug therapy as a primary intervention (chemo, IO, targeted, ADC, hormonal).',
  },
  {
    slug: 'combined',
    label: 'Combined',
    tooltip:
      'Multi-modality therapy where two or more modalities are jointly evaluated (e.g. CRT, peri-op systemic + surgery).',
  },
] as const;

export const INTENT_DEFS: readonly TagDef[] = [
  {
    slug: 'curative',
    label: 'Curative',
    tooltip: 'Treatment delivered with curative intent.',
  },
  {
    slug: 'palliative',
    label: 'Palliative',
    tooltip: 'Treatment delivered for symptom control or disease control without curative intent.',
  },
  {
    slug: 'supportive',
    label: 'Supportive',
    tooltip: 'Supportive care, symptom management, or quality-of-life outcomes.',
  },
] as const;

export const METHODOLOGY_DEFS: readonly TagDef[] = [
  {
    slug: 'phase-3-rct',
    label: 'Phase 3 RCT',
    tooltip: 'Phase 3 randomized controlled trial.',
  },
  {
    slug: 'phase-2-trial',
    label: 'Phase 2 trial',
    tooltip: 'Phase 2 trial (randomized or single-arm).',
  },
  {
    slug: 'phase-1',
    label: 'Phase 1',
    tooltip: 'Phase 1 trial.',
  },
  {
    slug: 'retrospective',
    label: 'Retrospective',
    tooltip: 'Retrospective cohort or case-series.',
  },
  {
    slug: 'meta-analysis',
    label: 'Meta-analysis',
    tooltip: 'Meta-analysis or pooled analysis of multiple studies.',
  },
  {
    slug: 'real-world-evidence',
    label: 'Real-world evidence',
    tooltip: 'Registry, claims, or other real-world evidence study.',
  },
  {
    slug: 'consensus-guideline',
    label: 'Consensus / guideline',
    tooltip: 'Consensus statement or clinical practice guideline.',
  },
] as const;

// ---------------- Lookups ----------------

const MODALITY_BY_SLUG = new Map(MODALITY_DEFS.map((d) => [d.slug, d]));
const INTENT_BY_SLUG = new Map(INTENT_DEFS.map((d) => [d.slug, d]));
const METHODOLOGY_BY_SLUG = new Map(METHODOLOGY_DEFS.map((d) => [d.slug, d]));

export function isValidModality(slug: string): slug is ModalityTag {
  return MODALITY_BY_SLUG.has(slug);
}

export function isValidIntent(slug: string): slug is IntentTag {
  return INTENT_BY_SLUG.has(slug);
}

export function isValidMethodology(slug: string): slug is MethodologyTag {
  return METHODOLOGY_BY_SLUG.has(slug);
}

/**
 * Resolve a typed-namespace slug to its display def (label + tooltip).
 * Returns null when the slug isn't in the namespace's enum.
 *
 * The tooltip string is author-controlled prose and trusted as text. Renderers
 * MUST place it in a text-only context (textContent, or Astro's auto-escaped
 * `{def.tooltip}` interpolation) — NEVER as `innerHTML` — so future tooltip
 * extensions can't introduce an XSS vector if a string ever picks up `<`.
 */
export function getTagDefinition(
  namespace: 'modality' | 'intent' | 'methodology',
  slug: string,
): TagDef | null {
  switch (namespace) {
    case 'modality':
      return MODALITY_BY_SLUG.get(slug) ?? null;
    case 'intent':
      return INTENT_BY_SLUG.get(slug) ?? null;
    case 'methodology':
      return METHODOLOGY_BY_SLUG.get(slug) ?? null;
    default:
      // Defensive: a future caller cast outside the union (e.g. once verdict
      // + meeting namespaces also support per-slug defs) gets null instead of
      // undefined slipping through.
      return null;
  }
}

// ---------------- Slug shape ----------------
//
// URL-safe regex: lowercase a-z, 0-9, and hyphens. No dots, colons, slashes,
// underscores. Used by the URL classifier in pages/tags/[...slug].astro and by
// the build-time uniqueness assertion below.
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeTagSlug(slug: string): boolean {
  return SAFE_SLUG.test(slug);
}

// ---------------- Cross-namespace uniqueness assertion ----------------
//
// Slug-only URLs require every value to be globally unique across all
// namespaces that surface under /tags/. This runs at build time over the
// static enums (modality, intent, methodology, verdict) PLUS the dynamic
// meeting slugs collected from digest.conference fields.
//
// Returns the offending pair on collision so the build can fail loudly with a
// useful message; returns null when all slugs are unique.

export type SlugSource = { slug: string; namespace: string };
export type SlugCollisionResult =
  | { kind: 'collision'; a: SlugSource; b: SlugSource }
  | { kind: 'malformed'; slug: string; namespace: string }
  | null;

// Build-time uniqueness assertion across all 5 namespaces that surface under
// /tags/. The dynamic inputs (meeting from digest.conference, verdict from
// VERDICT_META keys) are deduplicated internally — the caller doesn't need to
// pre-dedupe across N digests sharing one conference slug. They're also
// shape-validated: a malformed slug like "ASCO 2026" is reported as
// {kind:'malformed'} so the build fails with a useful error before any broken
// URL ships.
//
// Returns null when every slug is unique AND well-shaped.
export function findSlugCollision(
  meetingSlugs: readonly string[],
  verdictSlugs: readonly string[],
): SlugCollisionResult {
  const meetings = Array.from(new Set(meetingSlugs));
  const verdicts = Array.from(new Set(verdictSlugs));

  for (const slug of meetings) {
    if (!isSafeTagSlug(slug)) return { kind: 'malformed', slug, namespace: 'meeting' };
  }
  for (const slug of verdicts) {
    if (!isSafeTagSlug(slug)) return { kind: 'malformed', slug, namespace: 'verdict' };
  }

  const all: SlugSource[] = [
    ...MODALITY_DEFS.map((d) => ({ slug: d.slug, namespace: 'modality' })),
    ...INTENT_DEFS.map((d) => ({ slug: d.slug, namespace: 'intent' })),
    ...METHODOLOGY_DEFS.map((d) => ({ slug: d.slug, namespace: 'methodology' })),
    ...verdicts.map((slug) => ({ slug, namespace: 'verdict' })),
    ...meetings.map((slug) => ({ slug, namespace: 'meeting' })),
  ];
  const seen = new Map<string, SlugSource>();
  for (const entry of all) {
    const prior = seen.get(entry.slug);
    if (prior) return { kind: 'collision', a: prior, b: entry };
    seen.set(entry.slug, entry);
  }
  return null;
}

// All static tag slugs (modality + intent + methodology). Used by
// pages/tags/[...slug].astro getStaticPaths for the single-tag landing set
// before meeting + verdict are computed from digest data.
export function staticTagSlugs(): readonly string[] {
  return [
    ...MODALITY_DEFS.map((d) => d.slug),
    ...INTENT_DEFS.map((d) => d.slug),
    ...METHODOLOGY_DEFS.map((d) => d.slug),
  ];
}
