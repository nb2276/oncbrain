// Disease site enum: the curator's organizing axis.
//
// Slug is what the LLM emits and what URLs use. Label is the display name.
// Emoji is the per-site visual anchor in the digest. Order matters for the
// /sites/ index page — solid tumors first roughly head-to-toe, then liquid,
// then cross-cutting categories.

export type DiseaseSite = {
  slug: string;
  label: string;
  emoji: string;
};

export const DISEASE_SITES: readonly DiseaseSite[] = [
  { slug: 'cns', label: 'CNS', emoji: '🧠' },
  { slug: 'head-neck', label: 'Head & Neck', emoji: '👄' },
  { slug: 'thoracic', label: 'Thoracic / Lung', emoji: '🫁' },
  { slug: 'breast', label: 'Breast', emoji: '🎀' },
  { slug: 'upper-gi', label: 'Upper GI', emoji: '🍽️' },
  { slug: 'hepatobiliary', label: 'Hepatobiliary', emoji: '🟡' },
  { slug: 'lower-gi', label: 'Lower GI', emoji: '🌀' },
  { slug: 'gyn', label: 'Gynecologic', emoji: '🌷' },
  { slug: 'prostate', label: 'Prostate', emoji: '🌰' },
  { slug: 'bladder', label: 'Bladder', emoji: '💧' },
  { slug: 'kidney', label: 'Kidney', emoji: '🫘' },
  { slug: 'gu-other', label: 'Germ Cell / Other GU', emoji: '♂️' },
  { slug: 'skin', label: 'Skin / Melanoma', emoji: '🌞' },
  { slug: 'sarcoma', label: 'Sarcoma', emoji: '🦴' },
  { slug: 'leukemia', label: 'Leukemia', emoji: '🩸' },
  { slug: 'lymphoma', label: 'Lymphoma', emoji: '🌐' },
  { slug: 'myeloma', label: 'Myeloma / Plasma Cell', emoji: '🩹' },
  { slug: 'oligo-mets', label: 'Oligometastatic / Mets', emoji: '🎯' },
  { slug: 'supportive', label: 'Supportive / QoL', emoji: '🤝' },
  { slug: 'safety', label: 'Safety / Regulatory', emoji: '⚠️' },
  { slug: 'multi-site', label: 'Cross-cutting', emoji: '📊' },
  { slug: 'other', label: 'Other', emoji: '📋' },
] as const;

const SITE_BY_SLUG = new Map(DISEASE_SITES.map((s) => [s.slug, s]));

export function isValidDiseaseSiteSlug(slug: string): boolean {
  return SITE_BY_SLUG.has(slug);
}

// Resolve a slug to its display info. Falls back to "other" for an unknown
// slug so an LLM hallucination of a non-enum value doesn't break rendering.
export function getDiseaseSite(slug: string): DiseaseSite {
  return SITE_BY_SLUG.get(slug) ?? SITE_BY_SLUG.get('other')!;
}

// The list of valid slugs as a comma-separated string — used in the LLM
// prompt template so the model picks from a known enum.
export function diseaseSiteSlugList(): string {
  return DISEASE_SITES.map((s) => s.slug).join(', ');
}
