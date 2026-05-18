// Build-time search index for the home-page live search.
//
// One entry per study across all published dates. Loaded lazily by the
// SearchBox component on first keystroke or input focus. Substring filter
// on the client; no external search library.
//
// URL: /search-index.json

import type { APIRoute } from 'astro';
import { listDigests } from '../lib/digest-data.ts';
import { getDiseaseSite } from '../lib/disease-sites.ts';
import { deriveSlug } from '../lib/slug.ts';

export type SearchEntry = {
  date: string;
  site: string;
  site_label: string;
  site_emoji: string;
  name: string;
  slug: string;
  tldr: string;
  nct: string | null;
};

export const GET: APIRoute = () => {
  const entries: SearchEntry[] = [];
  for (const artifact of listDigests()) {
    for (const site of artifact.digest.sites) {
      const meta = getDiseaseSite(site.disease_site);
      for (const study of site.studies) {
        entries.push({
          date: artifact.date,
          site: meta.slug,
          site_label: meta.label,
          site_emoji: meta.emoji,
          name: study.name,
          slug: study.slug ?? deriveSlug(study.name),
          tldr: study.tldr,
          nct: study.nct,
        });
      }
    }
  }
  // listDigests() returns most-recent first, so entries are already date-desc.
  return new Response(JSON.stringify(entries), {
    headers: { 'Content-Type': 'application/json' },
  });
};
