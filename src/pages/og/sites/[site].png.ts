// v0.14 T4: per-disease-site social-preview image. og:image for /sites/<site>/.
// URL: /og/sites/<site>.png
import type { APIRoute, GetStaticPaths } from 'astro';
import { renderShareImage, siteCard } from '../../../lib/share-image.ts';
import { listSiteSummaries, listRecentStudies } from '../../../lib/digest-data.ts';
import { getDiseaseSite } from '../../../lib/disease-sites.ts';

const HANDLE = import.meta.env.PUBLIC_CURATOR_HANDLE || '@nb2276';

export const getStaticPaths: GetStaticPaths = () =>
  listSiteSummaries().map((s) => ({
    params: { site: s.disease_site },
    props: { slug: s.disease_site, count: s.occurrences.length },
  }));

export const GET: APIRoute = async ({ props }) => {
  const { slug, count } = props as { slug: string; count: number };
  const meta = getDiseaseSite(slug);
  // The newest study in this site makes the most compelling headline.
  const latest = listRecentStudies(Number.MAX_SAFE_INTEGER).find((r) => r.disease_site === slug);
  const png = await renderShareImage(
    siteCard({ label: meta.label, headline: latest?.study.name ?? meta.label, count, handle: HANDLE }),
  );
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
};
