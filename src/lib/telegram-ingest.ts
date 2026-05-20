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

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

// A file attachment (PDF, etc.) sent as a Telegram document rather than a
// compressed photo. v0.8 PR2 ingests PDFs from this field.
export type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  date: number; // unix seconds
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  // photo[]: same image at different resolutions (smallest → largest).
  // Always pick the LAST entry for OCR (highest resolution).
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument; // file attachment (PDF for v0.8 PR2)
  media_group_id?: string; // present when multi-photo album
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

// Outbound DM to a known chat. Used by notify-curator after a daily build to
// ping the curator with a "✓ built — here's what shipped" summary.
export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  opts: { fetchImpl?: typeof fetch; disableWebPagePreview?: boolean } = {},
): Promise<void> {
  if (!token) throw new TelegramApiError('Missing TELEGRAM_BOT_TOKEN');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${API_BASE}/bot${token}/sendMessage`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: opts.disableWebPagePreview ?? false,
      }),
    });
  } catch (err) {
    throw new TelegramApiError(`Network error: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new TelegramApiError(`sendMessage returned ${response.status}`, response.status);
  }
  let body: { ok: boolean; description?: string };
  try {
    body = (await response.json()) as { ok: boolean; description?: string };
  } catch (err) {
    throw new TelegramApiError(`Failed to parse response: ${(err as Error).message}`);
  }
  if (!body.ok) {
    throw new TelegramApiError(body.description || 'Telegram API returned ok=false');
  }
}

// Matches X / Twitter status URLs: https://x.com/handle/status/12345 (with or
// without query params or trailing path). Group 0 is the full URL — including
// any ?s=20 share tracker — so a global replace cleanly strips it from text.
// extractTweetUrls() normalizes after matching for canonical storage.
export const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+(?:[?#\/][^\s]*)?/gi;

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

// Derive the curator's free-text note from a Telegram message: anything the
// user wrote that isn't ingestable target metadata.
//
// Strips (in order):
//   - Tweet URLs (twitter/x.com status links)
//   - PubMed URLs and inline citation strings ("PMID: 12345")
//   - DOI strings (10.xxxx/yyyy) — citation hangover from PubMed alert emails
//   - Author-list patterns from PubMed citation blocks (Lastname F, Lastname F, ...)
//   - Journal-volume-page strings ("J Clin Oncol. 2026 May 15:...")
//   - The "/note " slash-command prefix
//
// Returns null if there's nothing meaningful left.
export function extractCuratorNote(
  text: string | undefined,
  _entities: TelegramEntity[] = [],
): string | null {
  if (!text) return null;
  let note = text.replace(TWEET_URL_RE, ' ');
  // PubMed URLs (note: \b doesn't work after `/`, so use lookahead for
  // whitespace / end-of-string / punctuation boundary).
  note = note.replace(/https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/?(?=\s|$|[.,;)])/gi, ' ');
  // Then citation residue patterns. These are common in PubMed alert emails.
  note = note.replace(/\bPMID\s*[:.]?\s*\d+\.?/gi, ' ');
  note = note.replace(/\bdoi\s*[:.]?\s*10\.\d+\/[\S]+/gi, ' ');
  note = note.replace(/\bEpub ahead of print\.?/gi, ' ');
  note = note.replace(/^\s*\/note\s+/i, '');
  note = note.replace(/\s+/g, ' ').trim();
  // After stripping, dangling punctuation (.,;) signals there's no real note
  // content — just citation skeleton. Treat as null.
  if (/^[.,;:\s]*$/.test(note)) return null;
  return note.length > 0 ? note : null;
}

// v0.5 Phase B: PubMed paper detection. Two forms accepted:
//   1. URL: https://pubmed.ncbi.nlm.nih.gov/12345/ (or /12345 without trailing slash)
//   2. Citation block containing "PMID: 12345" (case-insensitive, optional space)
// Returns canonical PMIDs (digits only, no prefix). Deduped, message-scoped.
// Skipped: search URLs (?term=...), DOI-only refs, PMC-only refs, ncbi.nlm.nih.gov
// non-pubmed paths.
export const PUBMED_URL_RE = /https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)(?:\/|\b)/gi;
export const PMID_CITATION_RE = /\bPMID\s*[:.]?\s*(\d+)/gi;

export function extractPaperPmids(
  text: string | undefined,
  entities: TelegramEntity[] = [],
): string[] {
  const found = new Set<string>();
  const collect = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(PUBMED_URL_RE)) {
      if (m[1]) found.add(m[1]);
    }
    for (const m of s.matchAll(PMID_CITATION_RE)) {
      if (m[1]) found.add(m[1]);
    }
  };
  collect(text);
  for (const e of entities) {
    if ((e.type === 'text_link' || e.type === 'url') && typeof e.url === 'string') {
      collect(e.url);
    }
  }
  return Array.from(found);
}

// v0.5 Phase C: extract slide photo attachment from a Telegram message.
// Returns the HIGHEST-resolution photo if present, else null. Telegram
// sends `photo[]` ordered smallest → largest, so we want the last entry
// for OCR fidelity.
export function extractSlidePhoto(msg: TelegramMessage): TelegramPhotoSize | null {
  if (!msg.photo || msg.photo.length === 0) return null;
  return msg.photo[msg.photo.length - 1] ?? null;
}

// v0.8 PR2: extract a PDF document attachment from a Telegram message.
// Matches on the application/pdf MIME type or a .pdf filename (Telegram
// occasionally omits or mislabels mime_type for forwarded files). Returns
// null for non-PDF documents (images-as-files, .docx, etc.).
export function extractPdfDocument(msg: TelegramMessage): TelegramDocument | null {
  const doc = msg.document;
  if (!doc || !doc.file_id) return null;
  const isPdfMime = (doc.mime_type ?? '').toLowerCase() === 'application/pdf';
  const isPdfName = /\.pdf$/i.test(doc.file_name ?? '');
  return isPdfMime || isPdfName ? doc : null;
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
