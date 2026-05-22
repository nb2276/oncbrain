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
  // Short one-liner explaining the why of the emoji choice. Surfaced as a
  // hover tooltip on the emoji wherever it renders. See DESIGN.md for the
  // full selection principles.
  rationale: string;
};

export const DISEASE_SITES: readonly DiseaseSite[] = [
  { slug: 'cns', label: 'CNS', emoji: '🧠', rationale: 'brain — direct anatomical anchor' },
  { slug: 'head-neck', label: 'Head & Neck', emoji: '👄', rationale: 'mouth — captures oral, pharyngeal, laryngeal scope' },
  { slug: 'thoracic', label: 'Thoracic / Lung', emoji: '🫁', rationale: 'lungs — direct anatomical anchor' },
  { slug: 'breast', label: 'Breast', emoji: '🎀', rationale: 'pink ribbon — canonical breast-cancer awareness symbol' },
  { slug: 'upper-gi', label: 'GI Upper', emoji: '🍽️', rationale: 'plate — entry to the GI tract (no stomach/esophagus emoji exists)' },
  { slug: 'hepatobiliary', label: 'Hepatobiliary', emoji: '🟡', rationale: 'yellow — jaundice/bilirubin, the clinical signal not the etiology' },
  { slug: 'lower-gi', label: 'GI Lower', emoji: '🌀', rationale: 'spiral — intestinal coil' },
  { slug: 'gyn', label: 'Gynecologic', emoji: '🌷', rationale: 'tulip — distinct from breast pink ribbon' },
  { slug: 'prostate', label: 'Prostate', emoji: '🌰', rationale: 'chestnut ≈ walnut, the classic prostate-size analogy' },
  { slug: 'bladder', label: 'Bladder', emoji: '💧', rationale: 'water drop — urology anchor' },
  { slug: 'kidney', label: 'Kidney', emoji: '🫘', rationale: 'kidney bean — literally named for the shape' },
  { slug: 'gu-other', label: 'Germ Cell / Other GU', emoji: '♂️', rationale: 'male symbol — testicular / germ-cell GU' },
  { slug: 'skin', label: 'Skin / Melanoma', emoji: '🌞', rationale: 'sun — UV exposure is the dominant etiology' },
  { slug: 'sarcoma', label: 'Sarcoma', emoji: '🦴', rationale: 'bone — established sarcoma anchor (imperfect for soft tissue)' },
  { slug: 'leukemia', label: 'Leukemia', emoji: '🩸', rationale: 'blood drop — hematologic malignancy' },
  { slug: 'lymphoma', label: 'Lymphoma', emoji: '🌐', rationale: 'network — lymphatic system spread across the body' },
  { slug: 'myeloma', label: 'Myeloma / Plasma Cell', emoji: '🩹', rationale: 'bandage — lytic lesions on bone' },
  { slug: 'oligo-mets', label: 'Oligometastatic / Mets', emoji: '🎯', rationale: 'target — SBRT / metastasis-directed therapy' },
  { slug: 'supportive', label: 'Supportive / QoL', emoji: '🤝', rationale: 'handshake — patient-centered care' },
  { slug: 'safety', label: 'Safety / Regulatory', emoji: '⚠️', rationale: 'warning — safety / regulatory signal' },
  { slug: 'multi-site', label: 'Cross-cutting', emoji: '📊', rationale: 'chart — cross-cutting analyses across multiple sites' },
  { slug: 'other', label: 'Other', emoji: '📋', rationale: 'clipboard — catch-all for unclassified topics' },
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
