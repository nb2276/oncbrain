// Telegram Bot API ingestion.
//
// You DM the bot (or post in a private channel where it's admin) with tweet URLs.
// `npm run pull:telegram` calls getUpdates, parses tweet URLs out of message
// text + entities, and saves them as bookmarks for the message's local date.
//
// Auth: TELEGRAM_BOT_TOKEN env var, issued by @BotFather.
// State: offset (highest update_id + 1) is stored in the settings table so
// re-runs only fetch new messages.

const API_BASE = 'https://api.telegram.org';

export type TelegramEntity = {
  type: string; // 'url' | 'text_link' | 'mention' | ...
  offset: number;
  length: number;
  url?: string; // present on text_link
};

export type TelegramMessage = {
  message_id: number;
  date: number; // unix seconds
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  chat?: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_message?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

export type FetchUpdatesOptions = {
  offset?: number;
  timeoutSec?: number; // long-poll timeout; 0 = short poll
  fetchImpl?: typeof fetch;
};

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly response?: unknown,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

// Calls getUpdates and returns the raw update list. Caller persists the next offset.
export async function fetchUpdates(
  token: string,
  opts: FetchUpdatesOptions = {},
): Promise<TelegramUpdate[]> {
  if (!token) throw new TelegramApiError('Missing TELEGRAM_BOT_TOKEN');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  params.set('timeout', String(opts.timeoutSec ?? 0));
  // We want both DMs and channel posts. allowed_updates filters to those kinds.
  params.set('allowed_updates', JSON.stringify(['message', 'channel_post']));

  const url = `${API_BASE}/bot${token}/getUpdates?${params}`;

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new TelegramApiError(`Network error: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new TelegramApiError(`getUpdates returned ${response.status}`, response.status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new TelegramApiError(`Failed to parse response: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object') throw new TelegramApiError('Empty response');
  const body = json as { ok: boolean; description?: string; result?: TelegramUpdate[] };
  if (!body.ok) {
    throw new TelegramApiError(body.description || 'Telegram API returned ok=false', undefined, body);
  }
  return body.result ?? [];
}

// Matches X / Twitter status URLs: https://x.com/handle/status/12345 (with or
// without query params). Group 0 is the full URL. We strip the query and
// fragment to normalize for dedup.
const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+(?:\/\S*)?/gi;

export function extractTweetUrls(text: string | undefined, entities: TelegramEntity[] = []): string[] {
  const found = new Set<string>();
  if (text) {
    for (const m of text.matchAll(TWEET_URL_RE)) {
      found.add(normalizeTweetUrl(m[0]!));
    }
  }
  // text_link entities carry the URL even when the displayed text is something else
  // (e.g., Telegram clients may render shortened previews). Inspect both fields.
  for (const e of entities) {
    if ((e.type === 'text_link' || e.type === 'url') && typeof e.url === 'string') {
      const url = e.url.match(TWEET_URL_RE);
      if (url && url[0]) found.add(normalizeTweetUrl(url[0]));
    }
  }
  return Array.from(found);
}

function normalizeTweetUrl(raw: string): string {
  // Strip query string and fragment; keep canonical /<handle>/status/<id>.
  const url = raw.split('?')[0]!.split('#')[0]!;
  // Trim trailing slash if present and no path remains beyond status/id.
  return url.replace(/\/+$/, '');
}

export function messageOf(update: TelegramUpdate): TelegramMessage | undefined {
  // Channels POST as channel_post; DMs as message. Both feed the same pipeline.
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post;
}

// Converts a Unix timestamp (seconds) to YYYY-MM-DD in the local timezone.
// Local time matches "the day the curator was reading," which is usually what
// users expect when they bookmark something at 11pm.
export function unixToLocalDate(unixSec: number, now: () => Date = () => new Date(unixSec * 1000)): string {
  return now().toLocaleDateString('en-CA'); // en-CA happens to format as YYYY-MM-DD
}
