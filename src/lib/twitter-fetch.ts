// Single-tweet fetcher using X's free oEmbed endpoint.
//
// Why oEmbed and not the official API? Free, no auth, no rate-limit subscription.
// Trade-off: returns embedded HTML, not structured JSON. We parse the HTML to
// extract tweet text + author handle. No image URLs are returned in v1 — the
// digest links back to the original tweet for full content including media.
//
// Reliability strategy: this endpoint has been inconsistent in 2024-2026.
// On any failure (404, rate-limit, empty, parse error), the caller falls back
// to manual-paste mode in the admin form.

export type FetchedTweet = {
  text: string;
  author_name: string | null;
  author_handle: string | null;
  html: string; // raw oEmbed blockquote — fed to widgets.js for image-rich rendering
};

export class TweetFetchError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'rate_limited' | 'network' | 'empty' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TweetFetchError';
  }
}

export type FetchOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injected for tests
};

const OEMBED_BASE = 'https://publish.twitter.com/oembed';

export async function fetchTweet(url: string, opts: FetchOptions = {}): Promise<FetchedTweet> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const oembedUrl = `${OEMBED_BASE}?url=${encodeURIComponent(url)}&omit_script=true`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(oembedUrl, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    throw new TweetFetchError(
      `Network error fetching ${url}: ${(err as Error).message}`,
      'network',
    );
  }
  clearTimeout(timeoutId);

  if (response.status === 404) {
    throw new TweetFetchError(`Tweet not found (404): ${url}`, 'not_found', 404);
  }
  if (response.status === 429) {
    throw new TweetFetchError(`Rate limited by oEmbed: ${url}`, 'rate_limited', 429);
  }
  if (!response.ok) {
    throw new TweetFetchError(
      `oEmbed returned ${response.status}: ${url}`,
      'network',
      response.status,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new TweetFetchError(`Failed to parse oEmbed JSON: ${(err as Error).message}`, 'parse');
  }

  if (!json || typeof json !== 'object') {
    throw new TweetFetchError('oEmbed returned empty or non-object response', 'empty');
  }

  const data = json as Record<string, unknown>;
  const htmlField = typeof data.html === 'string' ? data.html : '';
  const authorName = typeof data.author_name === 'string' ? data.author_name : null;
  const authorUrl = typeof data.author_url === 'string' ? data.author_url : '';

  if (!htmlField) {
    throw new TweetFetchError('oEmbed response missing html field', 'empty');
  }

  const text = extractTweetText(htmlField);
  if (!text) {
    throw new TweetFetchError('Could not extract tweet text from oEmbed html', 'parse');
  }

  return {
    text,
    author_name: authorName,
    author_handle: deriveHandleFromUrl(authorUrl),
    html: htmlField,
  };
}

// X's oEmbed HTML looks like:
//   <blockquote class="twitter-tweet"><p lang="en" dir="ltr">TEXT HERE</p>
//   &mdash; Joe Jones (@joejones) <a href="...">June 1, 2026</a></blockquote>
// We pull the <p> contents, strip tags, decode entities, and return.
export function extractTweetText(html: string): string {
  // The first <p>...</p> after the blockquote opener carries the tweet body.
  const match = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return '';

  let body = match[1]!;

  // Convert <br> to newlines before stripping.
  body = body.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags.
  body = body.replace(/<[^>]+>/g, '');

  // Decode the small set of entities that oEmbed actually emits.
  body = body
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));

  return body.trim();
}

// "https://twitter.com/JoeJones" or "https://x.com/JoeJones" → "@JoeJones"
export function deriveHandleFromUrl(url: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\b/);
  return match ? `@${match[1]}` : null;
}
