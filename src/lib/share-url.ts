// Per-study share URL builder.
//
// Returns the canonical disease-site URL with a date-prefixed anchor:
//   /sites/{site}/#{date}-{slug}
//
// This is the canonical "study in its disease-site context" view, used by
// the share button regardless of which page the user is currently viewing.
// Callers absolutize at click time via new URL(shareUrl, origin).href so a
// pasted link works from any origin.
//
// Returns undefined when any input is empty so the caller can suppress
// rendering the share button instead of producing a broken URL.

export interface ShareUrlInput {
  site: string;
  date: string;
  slug: string;
}

export function buildShareUrl({ site, date, slug }: ShareUrlInput): string | undefined {
  if (!site || !date || !slug) return undefined;
  return `/sites/${site}/#${date}-${slug}`;
}
