// JSON API: one day's full digest artifact (v0.8 PR3, E1).
// URL: /api/v1/digest/<date>.json
// Papers are sanitized (no copyrighted full text / local vault paths) before
// serving — see sanitizeArtifactForApi.
import type { APIRoute, GetStaticPaths } from 'astro';
import { listDigests, getDigest } from '../../../../lib/digest-data.ts';
import { sanitizeArtifactForApi } from '../../../../lib/api-output.ts';

export const getStaticPaths: GetStaticPaths = () =>
  listDigests().map((a) => ({ params: { date: a.date } }));

export const GET: APIRoute = ({ params }) => {
  const artifact = params.date ? getDigest(params.date) : null;
  if (!artifact) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(sanitizeArtifactForApi(artifact)), {
    headers: { 'Content-Type': 'application/json' },
  });
};
