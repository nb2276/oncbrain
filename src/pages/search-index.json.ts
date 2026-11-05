// Build-time search index for the home-page live search.
//
// One entry per study across all published dates. Loaded lazily by the
// SearchBox component on first keystroke or input focus. Each entry carries
// the card's full text (`body`) so a search reaches past the title and TL;DR;
// matching + ranking live in src/lib/search.ts. No external search library.
//
// URL: /search-index.json

import type { APIRoute } from 'astro';
import { listDigests, stripStudyNamePrefix } from '../lib/digest-data.ts';
import { getDiseaseSite } from '../lib/disease-sites.ts';
import { assignSlugsForDate } from '../lib/slug-resolve.ts';
import { studySearchBody, type SearchEntry } from '../lib/search.ts';
import { studyMeeting } from '../lib/study-meeting.ts';

export type { SearchEntry };

// Cap tldr in the index to bound per-keystroke filter cost and DOM render
// size. The full tldr remains on the [date] page; this is search-only.
const TLDR_MAX_LEN = 240;
function trimTldr(s: string): string {
  if (s.length <= TLDR_MAX_LEN) return s;
  return s.slice(0, TLDR_MAX_LEN - 1).trimEnd() + '…';
}

export const GET: APIRoute = () => {
  const entries: SearchEntry[] = [];
  for (const artifact of listDigests()) {
    // Disambiguate same-day slug collisions the same way [date].astro does,
    // so deep links into /<date>/#<slug> resolve to the right card.
    const allStudiesOnDate = artifact.digest.sites.flatMap((s) => s.studies);
    const resolvedSlugs = assignSlugsForDate(allStudiesOnDate);
    let i = 0;
    for (const site of artifact.digest.sites) {
      const meta = getDiseaseSite(site.disease_site);
      for (const study of site.studies) {
        entries.push({
          date: artifact.date,
          site: meta.slug,
          site_label: meta.label,
          site_emoji: meta.emoji,
          site_rationale: meta.rationale,
          name: study.name,
          slug: resolvedSlugs[i++]!,
          tldr: trimTldr(stripStudyNamePrefix(study.tldr, study.name)),
          nct: study.nct,
          body: studySearchBody(study, studyMeeting(study, artifact.conference)?.name),
        });
      }
    }
  }
  // listDigests() returns most-recent first, so entries are already date-desc.
  return new Response(JSON.stringify(entries), {
    headers: { 'Content-Type': 'application/json' },
  });
};
