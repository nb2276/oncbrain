// v0.10 per-tag RSS 2.0 feed.
//
// URL: /tags/<slug>/feed.xml          single-tag feed
//      /tags/<a>+<b>/feed.xml         2-way intersection feed
//      /tags/<a>+<b>+<c>/feed.xml     3-way intersection feed
//
// One <item> per study under this tag (or intersection), newest first.
// Subspecialists subscribe via their RSS reader to a slice they care about
// (e.g. /tags/radiation/feed.xml) without consuming the firehose at /feed.xml.
//
// Per the eng-review cap-unit decision: feed.xml routes are NOT counted
// against the 1000 HTML-page intersection cap. They're trivially cheap
// static endpoint emissions and the marginal cost of an extra entry is
// effectively zero.

import type { APIRoute, GetStaticPaths } from 'astro';
import type { RecentStudy } from '../../../lib/digest-data.ts';
import {
  buildReverseIndex,
  computeIntersections,
  intersectTagOccurrences,
  listDigestsStrict,
  listTagSummaries,
  parseTagPageSlug,
  type TagOccurrence,
} from '../../../lib/tag-index.ts';
import { studiesToRss } from '../../../lib/feed.ts';

const FALLBACK_SITE = 'https://oncbrain.oncologytoolkit.com';

// One feed per single-tag landing + one per intersection landing. Matches
// the URL set emitted by pages/tags/[...slug].astro getStaticPaths so
// readers can subscribe to any landing they can navigate to.
export const getStaticPaths: GetStaticPaths = () => {
  // Astro runs getStaticPaths in an isolated scope — module-top constants
  // are NOT accessible here. Define inline.
  const INTERSECTION_THRESHOLD = 3;
  const INTERSECTION_PAGE_CAP = 1000;

  // Fail-closed for the tag surface (Codex review).
  const digests = listDigestsStrict();
  const summaries = listTagSummaries(digests);
  const reverseIndex = buildReverseIndex(digests);

  const paths: Array<{ params: { slug: string } }> = [];
  for (const slug of summaries.keys()) {
    paths.push({ params: { slug } });
  }
  const intersections = computeIntersections(reverseIndex, {
    maxArity: 3,
    threshold: INTERSECTION_THRESHOLD,
    cap: INTERSECTION_PAGE_CAP,
  });
  for (const inter of intersections) {
    paths.push({ params: { slug: inter.tags.join('+') } });
  }
  return paths;
};

// Convert a TagOccurrence into the RecentStudy shape that studiesToRss expects.
function toRecentStudy(occ: TagOccurrence): RecentStudy {
  return {
    date: occ.date,
    conference: occ.conference,
    disease_site: occ.diseaseSite,
    study: occ.study,
    slug: occ.resolvedSlug,
  };
}

export const GET: APIRoute = ({ params, site }) => {
  const parsed = parseTagPageSlug(params.slug);
  if (!parsed.ok) {
    return new Response('Not found', { status: 404 });
  }
  // Fail-closed for the tag surface (Codex review).
  const digests = listDigestsStrict();
  const summaries = listTagSummaries(digests);
  const occurrences =
    parsed.tags.length === 1
      ? summaries.get(parsed.tags[0]!) ?? []
      : intersectTagOccurrences(summaries, parsed.tags);

  const recent = occurrences.map(toRecentStudy);
  const siteUrl = site?.href ?? FALLBACK_SITE;
  const xml = studiesToRss(recent, siteUrl);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
