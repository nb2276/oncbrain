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

export type TelegramWebhookInfo = {
  url: string;
  has_custom_certificate?: boolean;
  pending_update_count: number;
  last_error_date?: number; // unix seconds
  last_error_message?: string;
  allowed_updates?: string[];
};

// Snapshot of the bot's server-side state. We call this immediately after an
// empty getUpdates to catch the "Telegram returned result:[] but the queue
// actually had updates" Bot API stale-read failure mode. If pending_update_count
// is > 0 right after fetchUpdates returned 0, that proves provider inconsistency,
// not curator silence.
export async function fetchWebhookInfo(
  token: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TelegramWebhookInfo> {
  if (!token) throw new TelegramApiError('Missing TELEGRAM_BOT_TOKEN');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${API_BASE}/bot${token}/getWebhookInfo`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new TelegramApiError(`Network error: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new TelegramApiError(`getWebhookInfo returned ${response.status}`, response.status);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new TelegramApiError(`Failed to parse response: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object') throw new TelegramApiError('Empty response');
  const body = json as { ok: boolean; description?: string; result?: TelegramWebhookInfo };
  if (!body.ok) {
    throw new TelegramApiError(body.description || 'Telegram API returned ok=false', undefined, body);
  }
  if (!body.result) throw new TelegramApiError('Missing result in getWebhookInfo response');
  return body.result;
}

// Outbound DM to a known chat. Used by notify-curator after a daily build to
// ping the curator with a "✓ built — here's what shipped" summary.
export async function sendMessage(
  // chatId is a numeric chat id OR a channel "@username" (Telegram accepts
  // both; T5 channel posts use the latter).
  token: string,
  chatId: number | string,
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

// Hosts the curator plainly didn't intend as a paper source — sharing a
// conference talk or a shortened link shouldn't draw a "couldn't find a source"
// nudge. Scheme is optional because Telegram auto-links bare hosts (a `url`
// entity's text can be schemeless). This is a small reply-GATING denylist; the
// ingestion-side denylist lives in paper-url.ts (kept separate to avoid a
// telegram-ingest↔paper-url import cycle — paper-url already imports from here).
const NOISE_HOST_RE =
  /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be|google\.[a-z.]+|bit\.ly|t\.co)\b/i;

// True when a message that matched NO extractor still looks like an attempted
// source share: a document attachment, OR at least one link the curator might
// have meant as a source (i.e. NOT an obvious talk/shortener/social host).
// Gates the "couldn't recognize that" reply so conversational text ("thanks",
// bot commands) and shared non-source links stay unanswered, while a genuinely
// dropped paper link gets surfaced instead of vanishing silently.
export function looksLikeAttemptedShare(msg: TelegramMessage): boolean {
  if (msg.document) return true; // e.g. a .docx the PDF extractor rejected
  const text = msg.text ?? msg.caption ?? '';
  const candidates: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>")]+/gi)) candidates.push(m[0]);
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const e of entities) {
    if (e.type === 'text_link' && typeof e.url === 'string') {
      candidates.push(e.url); // text_link carries the target out-of-band
    } else if (e.type === 'url' && typeof e.offset === 'number' && typeof e.length === 'number') {
      // A `url` entity's link IS the visible text slice (often schemeless).
      const slice = text.slice(e.offset, e.offset + e.length).trim();
      if (slice) candidates.push(slice);
    }
  }
  return candidates.some((u) => !NOISE_HOST_RE.test(u));
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

// Extract an IMAGE sent as a document rather than a compressed photo. iOS Photos
// sometimes delivers HEIC/HEIF (and occasionally PNG/JPEG) as a document
// attachment, which extractSlidePhoto (photo[] only) and extractPdfDocument
// (PDF only) both miss — the slide would silently fall through and be lost.
// Matches an image/* MIME type or a known image filename extension. Returns null
// for PDFs (extractPdfDocument owns those) and non-image documents, so a document
// resolves to at most one of {paper(pdf), slide(image)}.
const IMAGE_DOC_EXT_RE = /\.(?:heic|heif|jpe?g|png|webp|gif|tiff?|bmp)$/i;
export function extractImageDocument(msg: TelegramMessage): TelegramDocument | null {
  const doc = msg.document;
  if (!doc || !doc.file_id) return null;
  const mime = (doc.mime_type ?? '').toLowerCase();
  if (mime === 'application/pdf') return null;
  const isImageMime = mime.startsWith('image/');
  const isImageName = IMAGE_DOC_EXT_RE.test(doc.file_name ?? '');
  return isImageMime || isImageName ? doc : null;
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

// --- Curator allowlist + offset safety (pull:telegram) ---------------------
// The bot has no other authentication: anyone who finds @<bot> can DM it, and
// pull:telegram would inbox their content, which the 6am cron then enriches and
// auto-publishes. TELEGRAM_ALLOWED_CHAT_IDS (comma-separated numeric chat ids)
// restricts ingestion to the curator. Pure + exported so the gate logic is
// unit-tested (the CLI main() itself isn't testable — it auto-runs on import).

// Parse the comma-separated allowlist. Returns null when unset/empty (=accept
// all, with a loud runtime warning) so the caller can distinguish "no policy"
// from "empty policy".
export function parseAllowedChatIds(raw: string | undefined | null): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));
  return ids.length > 0 ? new Set(ids) : null;
}

// True when an update's chat is allowed to ingest. No allowlist configured =>
// accept all (the unset-policy case, warned at the call site).
export function isChatAuthorized(
  chatId: number | null | undefined,
  allowed: Set<number> | null,
): boolean {
  if (!allowed) return true;
  return chatId != null && allowed.has(chatId);
}

// The next Telegram getUpdates offset given which update ids failed to inbox.
// The offset must NOT advance past the FIRST (lowest) failed update, so a
// transient write failure (SQLITE_BUSY, disk full) re-fetches next run instead
// of silently dropping the message; the UNIQUE(telegram_msg_id,type,raw_target)
// index makes re-processing the already-saved later updates idempotent. With no
// failures, advance to the high-water mark (max update_id + 1).
export function computeNextTelegramOffset(
  updateIds: readonly number[],
  failedUpdateIds: ReadonlySet<number>,
  currentOffset: number,
): number {
  let highWater = currentOffset;
  let firstFailed: number | null = null;
  for (const id of updateIds) {
    if (id + 1 > highWater) highWater = id + 1;
    if (failedUpdateIds.has(id)) firstFailed = firstFailed === null ? id : Math.min(firstFailed, id);
  }
  return firstFailed ?? highWater;
}
