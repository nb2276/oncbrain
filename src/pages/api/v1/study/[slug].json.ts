// JSON API: one study, every date it was covered (v0.8 PR3, E1).
// URL: /api/v1/study/<slug>.json
import type { APIRoute, GetStaticPaths } from 'astro';
import { listDigests } from '../../../../lib/digest-data.ts';
import { collectStudyOccurrencesBySlug, buildStudyPayload } from '../../../../lib/api-output.ts';

export const getStaticPaths: GetStaticPaths = () =>
  Array.from(collectStudyOccurrencesBySlug(listDigests()).keys()).map((slug) => ({
    params: { slug },
  }));

export const GET: APIRoute = ({ params }) => {
  const occurrences = params.slug
    ? collectStudyOccurrencesBySlug(listDigests()).get(params.slug)
    : undefined;
  if (!occurrences) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(buildStudyPayload(params.slug!, occurrences)), {
    headers: { 'Content-Type': 'application/json' },
  });
};
