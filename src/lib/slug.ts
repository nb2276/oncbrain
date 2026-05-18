// Stable slug derivation from study names.
//
// Used by the search index (when an artifact predates the persisted slug
// field) and by the [date].astro renderer to generate the per-study anchor
// id. Must be deterministic so /<date>/#<slug> works the same way every
// build.
//
// Output shape matches isSafeSlug() in study-retrieval.ts: kebab-case,
// must start with alphanumeric, max 64 chars.

const MAX_SLUG_LEN = 64;
const FALLBACK_SLUG = 'study';

export function deriveSlug(name: string): string {
  const stripped = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (stripped.length === 0) return FALLBACK_SLUG;
  const truncated = stripped.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');
  if (truncated.length === 0 || !/^[a-z0-9]/.test(truncated)) return FALLBACK_SLUG;
  return truncated;
}
