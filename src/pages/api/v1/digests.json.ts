// JSON API: index of published digests (v0.8 PR3, E1).
// URL: /api/v1/digests.json
import type { APIRoute } from 'astro';
import { listDigests } from '../../../lib/digest-data.ts';
import { buildDigestsIndex } from '../../../lib/api-output.ts';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildDigestsIndex(listDigests())), {
    headers: { 'Content-Type': 'application/json' },
  });
