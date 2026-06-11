// v0.14 T4 Option B: per-study share-image card, attached by the in-app "Share
// image" button (navigator.share({files})). One PNG per study.
// URL: /og/study/<date>/<slug>.png
import type { APIRoute, GetStaticPaths } from 'astro';
import { renderShareImage, studyShareCard } from '../../../../lib/share-image.ts';
import { listRecentStudies, type RecentStudy } from '../../../../lib/digest-data.ts';
import { getDiseaseSite } from '../../../../lib/disease-sites.ts';

const HANDLE = import.meta.env.PUBLIC_CURATOR_HANDLE || '@nb2276';

export const getStaticPaths: GetStaticPaths = () =>
  listRecentStudies(Number.MAX_SAFE_INTEGER).map((r) => ({
    params: { date: r.date, slug: r.slug },
    props: { study: r },
  }));

export const GET: APIRoute = async ({ props }) => {
  const r = (props as { study: RecentStudy }).study;
  const png = await renderShareImage(
    studyShareCard({
      name: r.study.name,
      tldr: r.study.tldr,
      soc: r.study.verdict?.soc_implication ?? null,
      siteLabel: getDiseaseSite(r.disease_site).label,
      date: r.date,
      conference: r.conference?.name ?? null,
      handle: HANDLE,
    }),
  );
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
};
