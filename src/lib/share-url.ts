// Per-study share URL builder.
//
// Returns the standalone per-study page:
//   /study/{date}-{slug}/
//
// This URL exists so a shared link unfurls with the STUDY's own preview (its
// name as og:title + a study-specific og:image), instead of the site-level card
// the previous target produced. The old target was the disease-site page with a
// `#{date}-{slug}` fragment — but URL fragments never reach a server and every
// link-unfurling client strips them, so a shared study fell back to the site
// page's OG metadata (site label + generic site card). A real page fixes that.
//
// `site` is retained in the input (callers pass it) and guarded as a
// well-formedness check, even though the standalone URL no longer needs it.
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
  return `/study/${date}-${slug}/`;
}
