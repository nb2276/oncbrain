// v0.21: per-study social-preview image (study name + headline number + verdict).
// og:image for /study/<param>/. URL: /og/study/<param>.png
//
// This is the card a SHARED study link unfurls to. The old share target was a
// URL fragment (/sites/{site}/#anchor) that unfurlers strip, so a shared study
// fell back to the generic site card; this gives each study its own card.
import type { APIRoute, GetStaticPaths } from 'astro';
import { renderShareImage, studyCard } from '../../../lib/share-image.ts';
import { listStudyPages, type StudyPageEntry } from '../../../lib/digest-data.ts';

const HANDLE = import.meta.env.PUBLIC_CURATOR_HANDLE || '@nb2276';

export const getStaticPaths: GetStaticPaths = () =>
  listStudyPages().map((entry) => ({ params: { slug: entry.param }, props: { entry } }));

export const GET: APIRoute = async ({ props }) => {
  const e = (props as { entry: StudyPageEntry }).entry;
  // v0.26 (E2): does any bullet carry a figure-sourced number (Thread 1)? Drives
  // the OG-card trust mark on the surface that unfurls in a text thread.
  const figuresSourced = (e.study.details ?? []).some(
    (d) => typeof d === 'object' && d != null && 'source_tier' in d && d.source_tier === 'figure',
  );
  const png = await renderShareImage(
    studyCard({
      name: e.study.name,
      tldr: e.study.tldr,
      date: e.date,
      conference: e.conference?.name ?? null,
      verdict: e.study.verdict ?? null,
      handle: HANDLE,
      figuresSourced,
    }),
  );
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
};
