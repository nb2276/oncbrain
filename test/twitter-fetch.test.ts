import { describe, it, expect, vi } from 'vitest';
import {
  fetchTweet,
  extractTweetText,
  deriveHandleFromUrl,
  TweetFetchError,
} from '../src/lib/twitter-fetch.ts';

function mockFetch(response: Partial<Response> & { jsonBody?: unknown }) {
  return vi.fn(async () => {
    const body = response.jsonBody;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => body,
      ...response,
    } as Response;
  });
}

const validOembed = {
  author_name: 'Joe Jones, MD',
  author_url: 'https://x.com/JoeJonesMD',
  html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Practice-changing data from NCT04567890 — overall survival doubled.<br><br>Full details in NEJM today.</p>&mdash; Joe Jones, MD (@JoeJonesMD) <a href="https://twitter.com/JoeJonesMD/status/123">June 1, 2026</a></blockquote>',
};

describe('fetchTweet', () => {
  it('returns parsed tweet on success', async () => {
    const result = await fetchTweet('https://x.com/JoeJonesMD/status/123', {
      fetchImpl: mockFetch({ ok: true, status: 200, jsonBody: validOembed }),
    });
    expect(result.author_name).toBe('Joe Jones, MD');
    expect(result.author_handle).toBe('@JoeJonesMD');
    expect(result.text).toContain('Practice-changing data');
    expect(result.text).toContain('NCT04567890');
    expect(result.text).toContain('NEJM');
    // html field carries the raw oEmbed blockquote for widgets.js rendering
    expect(result.html).toContain('twitter-tweet');
  });

  it('throws not_found on 404', async () => {
    await expect(
      fetchTweet('https://x.com/deleted/status/1', {
        fetchImpl: mockFetch({ ok: false, status: 404, jsonBody: null }),
      }),
    ).rejects.toMatchObject({ kind: 'not_found', status: 404 });
  });

  it('throws rate_limited on 429', async () => {
    await expect(
      fetchTweet('https://x.com/foo/status/1', {
        fetchImpl: mockFetch({ ok: false, status: 429, jsonBody: null }),
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
  });

  it('throws network on 5xx', async () => {
    await expect(
      fetchTweet('https://x.com/foo/status/1', {
        fetchImpl: mockFetch({ ok: false, status: 503, jsonBody: null }),
      }),
    ).rejects.toMatchObject({ kind: 'network', status: 503 });
  });

  it('throws empty when html is missing', async () => {
    await expect(
      fetchTweet('https://x.com/foo/status/1', {
        fetchImpl: mockFetch({ ok: true, status: 200, jsonBody: { author_name: 'X' } }),
      }),
    ).rejects.toMatchObject({ kind: 'empty' });
  });

  it('throws network on fetch rejection', async () => {
    const broken = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      fetchTweet('https://x.com/foo/status/1', { fetchImpl: broken as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws parse when html lacks a <p> body', async () => {
    await expect(
      fetchTweet('https://x.com/foo/status/1', {
        fetchImpl: mockFetch({
          ok: true,
          status: 200,
          jsonBody: { html: '<blockquote>no paragraph here</blockquote>' },
        }),
      }),
    ).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('extractTweetText', () => {
  it('extracts text from a standard oEmbed blockquote', () => {
    const result = extractTweetText(validOembed.html);
    expect(result).toContain('Practice-changing data from NCT04567890');
    expect(result).toContain('Full details in NEJM today.');
  });

  it('converts <br> tags to newlines', () => {
    const result = extractTweetText('<blockquote><p>line1<br>line2<br/>line3</p></blockquote>');
    expect(result).toBe('line1\nline2\nline3');
  });

  it('decodes HTML entities', () => {
    const html = '<p>&amp; &lt; &gt; &quot; &#39; &mdash; &hellip;</p>';
    expect(extractTweetText(html)).toBe('& < > " \' — …');
  });

  it('decodes numeric entities', () => {
    expect(extractTweetText('<p>&#8217;hello&#8217;</p>')).toBe('’hello’');
  });

  it('strips inner tags like <a>', () => {
    const html = '<p>see <a href="...">this paper</a> for details</p>';
    expect(extractTweetText(html)).toBe('see this paper for details');
  });

  it('returns empty string when no <p> tag exists', () => {
    expect(extractTweetText('<blockquote>no p</blockquote>')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractTweetText('')).toBe('');
  });
});

describe('deriveHandleFromUrl', () => {
  it('extracts handle from twitter.com URL', () => {
    expect(deriveHandleFromUrl('https://twitter.com/JoeJonesMD')).toBe('@JoeJonesMD');
  });

  it('extracts handle from x.com URL', () => {
    expect(deriveHandleFromUrl('https://x.com/JoeJonesMD')).toBe('@JoeJonesMD');
  });

  it('handles trailing path segments', () => {
    expect(deriveHandleFromUrl('https://x.com/JoeJonesMD/status/123')).toBe('@JoeJonesMD');
  });

  it('returns null for empty input', () => {
    expect(deriveHandleFromUrl('')).toBeNull();
  });

  it('returns null when no handle present', () => {
    expect(deriveHandleFromUrl('https://example.com/foo')).toBeNull();
  });

  it('handles handles up to 15 chars (X limit)', () => {
    expect(deriveHandleFromUrl('https://x.com/abcdefghijklmno')).toBe('@abcdefghijklmno');
  });
});

describe('TweetFetchError', () => {
  it('is an instance of Error', () => {
    const err = new TweetFetchError('test', 'not_found', 404);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('not_found');
    expect(err.status).toBe(404);
  });
});
