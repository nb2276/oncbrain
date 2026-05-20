// RSS 2.0 feed — latest study additions across all dates (v0.8 PR3, E1).
// URL: /feed.xml
import type { APIRoute } from 'astro';
import { listRecentStudies } from '../lib/digest-data.ts';
import { studiesToRss } from '../lib/feed.ts';

const FEED_LIMIT = 30;
const FALLBACK_SITE = 'https://oncbrain.oncologytoolkit.com';

export const GET: APIRoute = ({ site }) => {
  const siteUrl = site?.href ?? FALLBACK_SITE;
  const xml = studiesToRss(listRecentStudies(FEED_LIMIT), siteUrl);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
