// v0.10 per-tag JSON API.
//
// URL: /api/v1/tag/<slug>.json
//
// One endpoint per single-tag landing — readers (and downstream consumers
// like subspecialty Mastodon bots, hospital intranets, EMR widgets) get a
// machine-readable list of every study under a tag, newest first. Intersection
// JSON APIs are NOT emitted at this URL pattern — they're trivial to compose
// client-side from the single-tag endpoints if needed, and keeping the API
// surface single-slug keeps the contract simple.
//
// Per the eng-review cap-unit decision: per-tag JSON endpoints are NOT
// counted against the 1000 HTML-page intersection cap.

import type { APIRoute, GetStaticPaths } from 'astro';
import { listDigests } from '../../../../lib/digest-data.ts';
import { API_VERSION } from '../../../../lib/api-output.ts';
import {
  listTagSummaries,
  resolveTagDisplay,
  type TagOccurrence,
} from '../../../../lib/tag-index.ts';
import { isSafeTagSlug } from '../../../../lib/tags.ts';

type TagApiOccurrence = {
  date: string; // YYYY-MM-DD
  slug: string; // resolved per-date slug (anchor on /<date>/ page)
  disease_site: string;
  conference: { slug: string; name: string } | null;
  name: string;
  tldr: string;
  nct: string | null;
  verdict: {
    soc_implication: string;
    rationale: string;
    audience: string | null;
  } | null;
};

type TagApiPayload = {
  api_version: string;
  slug: string;
  namespace: string;
  label: string;
  occurrence_count: number;
  occurrences: TagApiOccurrence[];
};

export const getStaticPaths: GetStaticPaths = () => {
  const summaries = listTagSummaries(listDigests());
  return Array.from(summaries.keys()).map((slug) => ({ params: { slug } }));
};

function toApiOccurrence(occ: TagOccurrence): TagApiOccurrence {
  return {
    date: occ.date,
    slug: occ.resolvedSlug,
    disease_site: occ.diseaseSite,
    conference: occ.conference,
    name: occ.study.name,
    tldr: occ.study.tldr,
    nct: occ.study.nct ?? null,
    verdict: occ.study.verdict
      ? {
          soc_implication: occ.study.verdict.soc_implication,
          rationale: occ.study.verdict.rationale,
          audience: occ.study.verdict.audience,
        }
      : null,
  };
}

export const GET: APIRoute = ({ params }) => {
  const slug = params.slug;
  // Defense in depth: getStaticPaths emits only safe slugs, but reject
  // anything malformed in case a future caller hits this with an arbitrary
  // string (e.g. dev-server probe, hand-crafted URL).
  if (typeof slug !== 'string' || !isSafeTagSlug(slug)) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const summaries = listTagSummaries(listDigests());
  const occurrences = summaries.get(slug);
  if (!occurrences) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const display = resolveTagDisplay(slug, occurrences);
  const payload: TagApiPayload = {
    api_version: API_VERSION,
    slug,
    namespace: display?.namespace ?? 'unknown',
    label: display?.label ?? slug,
    occurrence_count: occurrences.length,
    occurrences: occurrences.map(toApiOccurrence),
  };
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
};
