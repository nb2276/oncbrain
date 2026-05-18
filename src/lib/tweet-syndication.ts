// Twitter / X syndication-CDN fetcher.
//
// oEmbed gives us the tweet text and the widget-renderable HTML, but it does
// NOT give us direct image URLs — only `pic.twitter.com/...` shortlinks that
// require auth to resolve. The syndication endpoint at
// `cdn.syndication.twimg.com/tweet-result` is the same endpoint Twitter's own
// embed widget calls; it's public, unauthenticated, and returns:
//   - tweet text (including notes-tweet long-form bodies)
//   - author info
//   - mediaDetails[] / photos[] with direct pbs.twimg.com URLs
//
// The catch: the endpoint requires a `token` derived from the tweet id. The
// formula was reverse-engineered from Twitter's embed JS years ago and has
// remained stable since ~2023:
//   token = string((tweet_id / 1e15) * π).split('.')[1].rstrip('0')
//
// If this endpoint stops working, fall back to image-less rendering — the
// Twitter widget itself still renders images via its own auth path.

export type SyndicationPhoto = {
  url: string; // pbs.twimg.com direct URL
  width: number;
  height: number;
};

export type SyndicationTweet = {
  id: string;
  text: string;
  author: { name: string; handle: string } | null;
  photos: SyndicationPhoto[];
  created_at: string | null;
};

export class TweetSyndicationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TweetSyndicationError';
  }
}

const BASE = 'https://cdn.syndication.twimg.com/tweet-result';

// Token formula. Math.PI gives enough precision; toFixed(18) matches the
// reference implementation. Trailing zeros are stripped because the
// endpoint expects exactly the chars Twitter's embed widget sends.
export function syndicationToken(tweetId: string): string {
  // Use string math to avoid precision loss on big ints. Convert via Number
  // (53-bit precision is fine for the magnitudes we get from snowflake ids).
  const n = Number(tweetId) / 1e15;
  const raw = (n * Math.PI).toFixed(18);
  const decimal = raw.split('.')[1] ?? '';
  return decimal.replace(/0+$/, '');
}

// Extract the numeric tweet id from a full X URL.
// e.g. https://x.com/handle/status/123456789012345 → "123456789012345"
export function tweetIdFromUrl(url: string): string | null {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1]! : null;
}

export type FetchSyndicationOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function fetchTweetSyndication(
  url: string,
  opts: FetchSyndicationOptions = {},
): Promise<SyndicationTweet> {
  const id = tweetIdFromUrl(url);
  if (!id) throw new TweetSyndicationError(`Could not extract tweet id from URL: ${url}`);

  const token = syndicationToken(id);
  const requestUrl = `${BASE}?id=${id}&token=${token}&lang=en`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 6000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      signal: controller.signal,
      headers: {
        // The syndication CDN refuses requests without a UA that looks like a
        // browser. Any plausible UA works; we use a generic one.
        'User-Agent': 'Mozilla/5.0 (compatible; oncbrain/0.3; +https://oncbrain.oncologytoolkit.com)',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    throw new TweetSyndicationError(`Network error: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (response.status === 404) {
    throw new TweetSyndicationError(`Tweet not found: ${url}`, 404);
  }
  if (!response.ok) {
    throw new TweetSyndicationError(`Syndication returned ${response.status}`, response.status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new TweetSyndicationError(`Failed to parse JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object') {
    throw new TweetSyndicationError('Empty or non-object response');
  }
  const data = json as Record<string, unknown>;

  // text can be in `text` (short tweets) or `note_tweet.note_tweet_results.result.text` (long-form)
  const text = extractText(data);

  const userRaw = data.user as Record<string, unknown> | undefined;
  const author = userRaw
    ? {
        name: typeof userRaw.name === 'string' ? userRaw.name : '',
        handle:
          typeof userRaw.screen_name === 'string' && userRaw.screen_name
            ? `@${userRaw.screen_name}`
            : '',
      }
    : null;

  const photos = extractPhotos(data);
  const created_at = typeof data.created_at === 'string' ? data.created_at : null;

  return { id, text, author, photos, created_at };
}

function extractText(data: Record<string, unknown>): string {
  // Long tweets put the full body under note_tweet.note_tweet_results.result.text
  const note = data.note_tweet as Record<string, unknown> | undefined;
  if (note) {
    const results = note.note_tweet_results as Record<string, unknown> | undefined;
    const result = results?.result as Record<string, unknown> | undefined;
    if (result && typeof result.text === 'string' && result.text) return result.text;
  }
  return typeof data.text === 'string' ? data.text : '';
}

function extractPhotos(data: Record<string, unknown>): SyndicationPhoto[] {
  // Prefer mediaDetails (newer shape) over photos (older shape). mediaDetails
  // includes videos too — filter to type='photo'.
  const media = Array.isArray(data.mediaDetails) ? (data.mediaDetails as Record<string, unknown>[]) : null;
  if (media) {
    const out: SyndicationPhoto[] = [];
    for (const m of media) {
      if (m.type !== 'photo') continue;
      const url = typeof m.media_url_https === 'string' ? m.media_url_https : null;
      const sizes = (m.sizes as Record<string, { w: number; h: number }> | undefined) ?? {};
      const large = sizes.large ?? sizes.medium ?? null;
      if (!url) continue;
      out.push({
        url,
        width: large?.w ?? 0,
        height: large?.h ?? 0,
      });
    }
    if (out.length > 0) return out;
  }

  // Older fallback shape.
  const photos = Array.isArray(data.photos) ? (data.photos as Record<string, unknown>[]) : null;
  if (photos) {
    const out: SyndicationPhoto[] = [];
    for (const p of photos) {
      const url = typeof p.url === 'string' ? p.url : null;
      if (!url) continue;
      out.push({
        url,
        width: typeof p.width === 'number' ? p.width : 0,
        height: typeof p.height === 'number' ? p.height : 0,
      });
    }
    return out;
  }

  return [];
}
