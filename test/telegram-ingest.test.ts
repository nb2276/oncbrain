import { describe, it, expect, vi } from 'vitest';
import {
  fetchUpdates,
  extractTweetUrls,
  extractCuratorNote,
  messageOf,
  unixToLocalDate,
  TelegramApiError,
} from '../src/lib/telegram-ingest.ts';

function mockFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe('fetchUpdates', () => {
  it('returns the result array on ok response', async () => {
    const fetchImpl = mockFetch({ ok: true, result: [{ update_id: 1 }] });
    const updates = await fetchUpdates('faketoken', { fetchImpl });
    expect(updates).toEqual([{ update_id: 1 }]);
  });

  it('returns empty array when result is missing', async () => {
    const fetchImpl = mockFetch({ ok: true });
    const updates = await fetchUpdates('faketoken', { fetchImpl });
    expect(updates).toEqual([]);
  });

  it('throws when Telegram returns ok=false', async () => {
    const fetchImpl = mockFetch({ ok: false, description: 'Unauthorized' });
    await expect(fetchUpdates('badtoken', { fetchImpl })).rejects.toMatchObject({
      name: 'TelegramApiError',
      message: 'Unauthorized',
    });
  });

  it('throws on non-2xx HTTP status', async () => {
    const fetchImpl = mockFetch(null, { ok: false, status: 500 });
    await expect(fetchUpdates('t', { fetchImpl })).rejects.toMatchObject({
      status: 500,
    });
  });

  it('throws when token is empty', async () => {
    await expect(fetchUpdates('')).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('passes offset and timeout to the URL', async () => {
    const fetchImpl = mockFetch({ ok: true, result: [] });
    await fetchUpdates('t', { offset: 42, timeoutSec: 5, fetchImpl });
    // @ts-expect-error inspecting the mock
    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain('offset=42');
    expect(calledUrl).toContain('timeout=5');
    expect(calledUrl).toContain('allowed_updates');
  });

  it('wraps fetch rejection as TelegramApiError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(fetchUpdates('t', { fetchImpl })).rejects.toBeInstanceOf(TelegramApiError);
  });
});

describe('extractTweetUrls', () => {
  it('extracts a plain x.com URL from text', () => {
    expect(extractTweetUrls('check this https://x.com/foo/status/123 cool')).toEqual([
      'https://x.com/foo/status/123',
    ]);
  });

  it('extracts twitter.com URLs', () => {
    expect(extractTweetUrls('https://twitter.com/foo/status/456')).toEqual([
      'https://twitter.com/foo/status/456',
    ]);
  });

  it('strips query strings', () => {
    expect(extractTweetUrls('https://x.com/foo/status/123?s=20&t=abc')).toEqual([
      'https://x.com/foo/status/123',
    ]);
  });

  it('deduplicates the same URL appearing multiple times', () => {
    expect(extractTweetUrls('https://x.com/a/status/1 and https://x.com/a/status/1')).toEqual([
      'https://x.com/a/status/1',
    ]);
  });

  it('extracts multiple distinct URLs in one message', () => {
    const urls = extractTweetUrls('https://x.com/a/status/1 and https://x.com/b/status/2');
    expect(urls.sort()).toEqual(['https://x.com/a/status/1', 'https://x.com/b/status/2']);
  });

  it('extracts URLs from text_link entities', () => {
    const urls = extractTweetUrls('click here', [
      { type: 'text_link', offset: 0, length: 10, url: 'https://x.com/foo/status/999' },
    ]);
    expect(urls).toEqual(['https://x.com/foo/status/999']);
  });

  it('extracts URLs from url entities', () => {
    const urls = extractTweetUrls('see link', [
      { type: 'url', offset: 0, length: 8, url: 'https://x.com/bar/status/555' },
    ]);
    expect(urls).toEqual(['https://x.com/bar/status/555']);
  });

  it('ignores non-tweet URLs', () => {
    expect(extractTweetUrls('https://example.com/foo')).toEqual([]);
    expect(extractTweetUrls('https://x.com/user')).toEqual([]); // profile, not status
  });

  it('returns empty array on empty input', () => {
    expect(extractTweetUrls('')).toEqual([]);
    expect(extractTweetUrls(undefined)).toEqual([]);
  });

  it('case-insensitive on host name', () => {
    expect(extractTweetUrls('https://X.com/foo/status/123')).toEqual([
      'https://X.com/foo/status/123',
    ]);
  });
});

describe('extractCuratorNote', () => {
  it('returns null when text is only a tweet URL', () => {
    expect(extractCuratorNote('https://x.com/foo/status/123')).toBeNull();
  });

  it('returns null when text is a tweet URL with ?s=20 share param', () => {
    expect(extractCuratorNote('https://x.com/foo/status/123?s=20')).toBeNull();
  });

  it('returns null when text is a tweet URL with ?s=2 (trimmed share param)', () => {
    expect(extractCuratorNote('https://x.com/foo/status/123?s=2')).toBeNull();
  });

  it('extracts free text written before a URL', () => {
    expect(
      extractCuratorNote('practice-changing https://x.com/foo/status/123'),
    ).toBe('practice-changing');
  });

  it('extracts free text written after a URL', () => {
    expect(
      extractCuratorNote('https://x.com/foo/status/123 worth a look'),
    ).toBe('worth a look');
  });

  it('strips the share-tracker query when the URL is mid-sentence', () => {
    expect(
      extractCuratorNote(
        'high impact https://x.com/foo/status/123?s=20 — read carefully',
      ),
    ).toBe('high impact — read carefully');
  });

  it('honors a leading /note prefix', () => {
    expect(
      extractCuratorNote('/note practice-changing https://x.com/foo/status/123'),
    ).toBe('practice-changing');
  });

  it('returns null when there is no URL and no commentary', () => {
    expect(extractCuratorNote('')).toBeNull();
  });

  it('handles undefined input', () => {
    expect(extractCuratorNote(undefined)).toBeNull();
  });

  it('handles a message with two URLs surrounded by commentary', () => {
    const note = extractCuratorNote(
      'see https://x.com/a/status/1?s=20 and https://x.com/b/status/2 for context',
    );
    expect(note).toBe('see and for context');
  });
});

describe('messageOf', () => {
  it('returns message for DM-style updates', () => {
    const msg = { message_id: 1, date: 0, text: 'hi' };
    expect(messageOf({ update_id: 1, message: msg })).toBe(msg);
  });

  it('returns channel_post for channel updates', () => {
    const msg = { message_id: 2, date: 0, text: 'hi' };
    expect(messageOf({ update_id: 1, channel_post: msg })).toBe(msg);
  });

  it('returns edited_message when only that present', () => {
    const msg = { message_id: 3, date: 0, text: 'edited' };
    expect(messageOf({ update_id: 1, edited_message: msg })).toBe(msg);
  });

  it('returns undefined for updates with no message fields', () => {
    expect(messageOf({ update_id: 1 })).toBeUndefined();
  });
});

describe('unixToLocalDate', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(unixToLocalDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('respects injected now()', () => {
    const fixed = new Date('2026-05-18T12:00:00Z');
    expect(unixToLocalDate(0, () => fixed)).toBe('2026-05-18');
  });
});
