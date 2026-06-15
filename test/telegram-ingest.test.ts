import { describe, it, expect, vi } from 'vitest';
import {
  fetchUpdates,
  fetchWebhookInfo,
  extractTweetUrls,
  extractCuratorNote,
  extractPaperPmids,
  extractPdfDocument,
  extractImageDocument,
  looksLikeAttemptedShare,
  messageOf,
  unixToLocalDate,
  TelegramApiError,
  parseAllowedChatIds,
  isChatAuthorized,
  computeNextTelegramOffset,
  type TelegramMessage,
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

describe('fetchWebhookInfo', () => {
  it('returns the result object on ok response', async () => {
    const fetchImpl = mockFetch({
      ok: true,
      result: { url: '', pending_update_count: 3, allowed_updates: ['message'] },
    });
    const info = await fetchWebhookInfo('t', { fetchImpl });
    expect(info.pending_update_count).toBe(3);
    expect(info.url).toBe('');
  });

  it('throws when token is empty', async () => {
    await expect(fetchWebhookInfo('')).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('throws when result is missing', async () => {
    const fetchImpl = mockFetch({ ok: true });
    await expect(fetchWebhookInfo('t', { fetchImpl })).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('throws when Telegram returns ok=false', async () => {
    const fetchImpl = mockFetch({ ok: false, description: 'Unauthorized' });
    await expect(fetchWebhookInfo('badtoken', { fetchImpl })).rejects.toMatchObject({
      name: 'TelegramApiError',
      message: 'Unauthorized',
    });
  });

  it('hits the getWebhookInfo endpoint', async () => {
    const fetchImpl = mockFetch({ ok: true, result: { url: '', pending_update_count: 0 } });
    await fetchWebhookInfo('t', { fetchImpl });
    // @ts-expect-error inspecting the mock
    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/getWebhookInfo');
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

describe('extractPaperPmids', () => {
  it('extracts a PMID from a pubmed.ncbi URL', () => {
    expect(extractPaperPmids('see https://pubmed.ncbi.nlm.nih.gov/42139645/')).toEqual([
      '42139645',
    ]);
  });

  it('extracts a PMID from inline citation "PMID: N"', () => {
    expect(
      extractPaperPmids(
        'Moon AM, et al. J Clin Oncol. 2026 May 15. doi: 10.1200/JCO-25-02399. PMID: 42139645.',
      ),
    ).toEqual(['42139645']);
  });

  it('extracts a PMID from a citation with no space after colon', () => {
    expect(extractPaperPmids('PMID:42139645')).toEqual(['42139645']);
  });

  it('dedupes when same PMID appears as URL AND citation', () => {
    expect(
      extractPaperPmids(
        'see https://pubmed.ncbi.nlm.nih.gov/42139645/ — PMID: 42139645',
      ),
    ).toEqual(['42139645']);
  });

  it('extracts multiple distinct PMIDs from one message', () => {
    const out = extractPaperPmids('PMID: 11111111 and PMID: 22222222');
    expect(out.sort()).toEqual(['11111111', '22222222']);
  });

  it('extracts from text_link entities', () => {
    const out = extractPaperPmids('click', [
      { type: 'text_link', offset: 0, length: 5, url: 'https://pubmed.ncbi.nlm.nih.gov/42139645/' },
    ]);
    expect(out).toEqual(['42139645']);
  });

  it('returns empty for non-PubMed content', () => {
    expect(extractPaperPmids('just some text and a https://x.com/foo/status/1')).toEqual([]);
  });

  it('returns empty for empty/undefined input', () => {
    expect(extractPaperPmids('')).toEqual([]);
    expect(extractPaperPmids(undefined)).toEqual([]);
  });

  it('ignores PubMed search URLs (no numeric path)', () => {
    expect(
      extractPaperPmids('https://pubmed.ncbi.nlm.nih.gov/?term=hepatocellular'),
    ).toEqual([]);
  });
});

describe('extractPdfDocument', () => {
  const msg = (document?: TelegramMessage['document']): TelegramMessage => ({
    message_id: 1,
    date: 0,
    document,
  });

  it('detects a PDF by application/pdf MIME type', () => {
    const doc = extractPdfDocument(
      msg({ file_id: 'F1', file_unique_id: 'U1', mime_type: 'application/pdf', file_name: 'paper.pdf' }),
    );
    expect(doc?.file_id).toBe('F1');
  });

  it('detects a PDF by .pdf filename when MIME is missing', () => {
    const doc = extractPdfDocument(msg({ file_id: 'F2', file_unique_id: 'U2', file_name: 'scan.PDF' }));
    expect(doc?.file_id).toBe('F2');
  });

  it('returns null for a non-PDF document (image-as-file)', () => {
    expect(
      extractPdfDocument(msg({ file_id: 'F3', file_unique_id: 'U3', mime_type: 'image/png', file_name: 'fig.png' })),
    ).toBeNull();
  });

  it('returns null when there is no document', () => {
    expect(extractPdfDocument({ message_id: 1, date: 0, text: 'hi' })).toBeNull();
  });
});

describe('extractImageDocument', () => {
  const msg = (document?: TelegramMessage['document']): TelegramMessage => ({
    message_id: 1,
    date: 0,
    document,
  });

  it('detects a HEIC image-as-document by MIME (iOS Photos)', () => {
    const doc = extractImageDocument(
      msg({ file_id: 'I1', file_unique_id: 'U1', mime_type: 'image/heic', file_name: 'IMG_4821.HEIC' }),
    );
    expect(doc?.file_id).toBe('I1');
  });

  it('detects a HEIC/HEIF image by filename when MIME is missing', () => {
    expect(extractImageDocument(msg({ file_id: 'I2', file_unique_id: 'U2', file_name: 'slide.heif' }))?.file_id).toBe('I2');
    expect(extractImageDocument(msg({ file_id: 'I3', file_unique_id: 'U3', file_name: 'fig.JPEG' }))?.file_id).toBe('I3');
    expect(extractImageDocument(msg({ file_id: 'I4', file_unique_id: 'U4', file_name: 'chart.png' }))?.file_id).toBe('I4');
  });

  it('returns null for a PDF document (extractPdfDocument owns those)', () => {
    expect(
      extractImageDocument(msg({ file_id: 'P1', file_unique_id: 'U1', mime_type: 'application/pdf', file_name: 'paper.pdf' })),
    ).toBeNull();
  });

  it('returns null for a non-image document and when there is no document', () => {
    expect(extractImageDocument(msg({ file_id: 'D1', file_unique_id: 'U1', file_name: 'notes.docx' }))).toBeNull();
    expect(extractImageDocument({ message_id: 1, date: 0, text: 'hi' })).toBeNull();
  });
});

describe('extractCuratorNote (paper citations)', () => {
  it('strips a PubMed URL', () => {
    expect(extractCuratorNote('great paper https://pubmed.ncbi.nlm.nih.gov/42139645/ worth reading')).toBe(
      'great paper worth reading',
    );
  });

  it('strips "PMID: N" residue', () => {
    expect(extractCuratorNote('practice-changing PMID: 42139645')).toBe('practice-changing');
  });

  it('strips DOI residue', () => {
    expect(extractCuratorNote('see this: doi: 10.1200/JCO-25-02399')).toBe('see this:');
  });

  it('strips "Epub ahead of print" hangover including the trailing period', () => {
    expect(extractCuratorNote('notable. Epub ahead of print.')).toBe('notable.');
  });

  it('returns null when only citation residue remains', () => {
    expect(
      extractCuratorNote('PMID: 42139645. doi: 10.1200/JCO-25-02399. Epub ahead of print.'),
    ).toBeNull();
  });
});

describe('looksLikeAttemptedShare', () => {
  const msg = (overrides: Partial<TelegramMessage>): TelegramMessage => ({
    message_id: 1,
    date: 0,
    ...overrides,
  });

  it('true for an unrecognized URL in text (the dropped ASCO Post case)', () => {
    expect(
      looksLikeAttemptedShare(msg({ text: 'https://www.some-news-site.com/article/123' })),
    ).toBe(true);
  });

  it('true for a URL in the caption', () => {
    expect(looksLikeAttemptedShare(msg({ caption: 'see http://example.org/x' }))).toBe(true);
  });

  it('true for a url entity even when the text itself hides it', () => {
    expect(
      looksLikeAttemptedShare(
        msg({
          text: 'this trial',
          entities: [{ type: 'text_link', offset: 0, length: 10, url: 'https://e.com/a' }],
        }),
      ),
    ).toBe(true);
  });

  it("true for a plain 'url' entity type (auto-detected link)", () => {
    expect(
      looksLikeAttemptedShare(
        msg({
          text: 'see ascopost.com/x for the readout',
          entities: [{ type: 'url', offset: 4, length: 14 }],
        }),
      ),
    ).toBe(true);
  });

  it('false for a text_link entity missing its url (the !!e.url guard)', () => {
    expect(
      looksLikeAttemptedShare(
        msg({
          text: 'a trial',
          entities: [{ type: 'text_link', offset: 0, length: 7 }],
        }),
      ),
    ).toBe(false);
  });

  it('true for a url entity carried in caption_entities (no text/entities)', () => {
    expect(
      looksLikeAttemptedShare(
        msg({
          caption: 'photo with a link',
          caption_entities: [{ type: 'url', offset: 0, length: 5 }],
        }),
      ),
    ).toBe(true);
  });

  it('true for a non-PDF document attachment (.docx)', () => {
    expect(
      looksLikeAttemptedShare(
        msg({
          document: { file_id: 'F1', file_unique_id: 'U1', mime_type: 'application/msword', file_name: 'notes.docx' },
        }),
      ),
    ).toBe(true);
  });

  it('false for conversational text and bot commands', () => {
    expect(looksLikeAttemptedShare(msg({ text: 'thanks!' }))).toBe(false);
    expect(looksLikeAttemptedShare(msg({ text: '/start' }))).toBe(false);
    expect(looksLikeAttemptedShare(msg({}))).toBe(false);
  });

  it('false when the only links are obvious non-source hosts (no nudge for a talk/shortener)', () => {
    expect(
      looksLikeAttemptedShare(msg({ text: 'great talk https://www.youtube.com/watch?v=abc' })),
    ).toBe(false);
    expect(looksLikeAttemptedShare(msg({ text: 'https://bit.ly/xyz' }))).toBe(false);
    expect(looksLikeAttemptedShare(msg({ text: 'https://t.co/abc123' }))).toBe(false);
  });

  it('true when a real source link sits alongside a noise link', () => {
    expect(
      looksLikeAttemptedShare(
        msg({ text: 'https://youtu.be/x and https://some-journal.org/article/5' }),
      ),
    ).toBe(true);
  });
});

describe('parseAllowedChatIds', () => {
  it('returns null when unset / blank (no policy = accept all + warn)', () => {
    expect(parseAllowedChatIds(undefined)).toBeNull();
    expect(parseAllowedChatIds(null)).toBeNull();
    expect(parseAllowedChatIds('')).toBeNull();
    expect(parseAllowedChatIds('   ')).toBeNull();
  });

  it('parses a comma-separated numeric list (with whitespace + negatives)', () => {
    const s = parseAllowedChatIds(' 123 , -456,789 ');
    expect(s).toEqual(new Set([123, -456, 789]));
  });

  it('drops non-integer tokens (keeps the valid ones)', () => {
    expect(parseAllowedChatIds('abc, 12')).toEqual(new Set([12]));
  });

  it('a configured-but-all-invalid value fails CLOSED (empty set = deny-all, not null)', () => {
    // Regression (codex /ship review): "abc" used to return null → accept-all.
    // A non-blank value is a configured policy; if it has no valid ids it must
    // deny all, not silently open the bot to everyone.
    const s = parseAllowedChatIds('abc, , xyz');
    expect(s).toEqual(new Set());
    expect(s).not.toBeNull();
    expect(isChatAuthorized(123, s)).toBe(false); // denies everyone
  });
});

describe('isChatAuthorized', () => {
  it('accepts everything when no allowlist is configured', () => {
    expect(isChatAuthorized(123, null)).toBe(true);
    expect(isChatAuthorized(null, null)).toBe(true);
  });

  it('accepts only listed chat ids when an allowlist is set', () => {
    const allow = new Set([111, 222]);
    expect(isChatAuthorized(111, allow)).toBe(true);
    expect(isChatAuthorized(333, allow)).toBe(false);
    expect(isChatAuthorized(null, allow)).toBe(false);
  });
});

describe('computeNextTelegramOffset', () => {
  it('advances to the high-water mark when nothing failed', () => {
    expect(computeNextTelegramOffset([10, 11, 12], new Set(), 10)).toBe(13);
  });

  it('holds at the first (lowest) failed update so it re-fetches next run', () => {
    // 11 failed → offset 11 (re-fetches 11 and the idempotent 12 next run),
    // never advancing past the lost message.
    expect(computeNextTelegramOffset([10, 11, 12], new Set([11]), 10)).toBe(11);
  });

  it('uses the lowest failed id even if a later one also failed', () => {
    expect(computeNextTelegramOffset([10, 11, 12], new Set([12, 11]), 10)).toBe(11);
  });

  it('does not advance below the current offset (re-fetch on first-update failure)', () => {
    // First update itself failed: offset stays put so getUpdates re-returns it.
    expect(computeNextTelegramOffset([10, 11], new Set([10]), 10)).toBe(10);
  });

  it('returns the current offset for an empty update batch', () => {
    expect(computeNextTelegramOffset([], new Set(), 42)).toBe(42);
  });
});
