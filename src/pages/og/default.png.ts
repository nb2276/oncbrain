// v0.14 T4: the branded default social-preview image. Used as the og:image for
// the home, /studies, /about, /tags, and any page without a more specific card.
// URL: /og/default.png
import type { APIRoute } from 'astro';
import { renderShareImage, defaultCard } from '../../lib/share-image.ts';

const HANDLE = import.meta.env.PUBLIC_CURATOR_HANDLE || '@nb2276';

export const GET: APIRoute = async () => {
  const png = await renderShareImage(defaultCard(HANDLE));
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
};
