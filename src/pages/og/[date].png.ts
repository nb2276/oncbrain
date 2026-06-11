// v0.14 T4: per-digest social-preview image (the day's curated top-line + date).
// og:image for /[date]/. URL: /og/<date>.png
import type { APIRoute, GetStaticPaths } from 'astro';
import { renderShareImage, digestCard } from '../../lib/share-image.ts';
import { listDigests, type DigestArtifact } from '../../lib/digest-data.ts';

const HANDLE = import.meta.env.PUBLIC_CURATOR_HANDLE || '@nb2276';

export const getStaticPaths: GetStaticPaths = () =>
  listDigests().map((a) => ({ params: { date: a.date }, props: { artifact: a } }));

export const GET: APIRoute = async ({ props }) => {
  const a = (props as { artifact: DigestArtifact }).artifact;
  const studyCount = a.digest.sites.reduce((n, s) => n + s.studies.length, 0);
  const png = await renderShareImage(
    digestCard({
      date: a.date,
      topLine: a.digest.top_line,
      conference: a.conference?.name ?? null,
      studyCount,
      siteCount: a.digest.sites.length,
      handle: HANDLE,
    }),
  );
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
};
