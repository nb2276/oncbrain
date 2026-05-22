// CLI entry point: build one date's digest.
//
// Usage:
//   npm run build:day                            # today
//   npm run build:day -- --date=2026-05-18
//   npm run build:day -- --date=2026-05-18 --dry-run
//   npm run build:day -- --conf=asco2026         # all dates for a conference
//   npm run build:day -- --backfill              # all dates with bookmarks
//
// Flow per date:
//   1. Read bookmarks from SQLite for that date.
//   2. For any bookmark with fetched_via='pending', try oEmbed. Save result back.
//   3. Run the LLM digest pipeline over the resulting tweet set.
//   4. Write the digest to data/digests/<date>.json (committed artifact).
//   5. Write an Obsidian-flavored markdown twin to data/obsidian/<date>[-<conf>].md.
//
// The Astro build then reads these JSON files to produce static digest pages.

import 'dotenv/config';
import {
  openDb,
  listBookmarks,
  listBookmarkDates,
  listAllSourceDates,
  listPapers,
  listSlideUploads,
  updateBookmarkFetched,
  updateBookmarkOcrTexts,
  dominantConferenceForDate,
  getConference,
  todayIso,
  type Bookmark,
  type Paper,
  type SlideUpload,
} from '../src/lib/db.ts';
import { fetchTweet, TweetFetchError } from '../src/lib/twitter-fetch.ts';
import {
  buildDigest,
  type DigestInputItem,
  type DigestInputTweet,
  type DigestInputPaper,
  type DigestInputSlide,
  type DigestOutput,
} from '../src/lib/llm-pipeline.ts';
import { renderObsidian } from '../src/lib/obsidian-export.ts';
import { loadOverrides, applyOverrides, formatOverrideSummary } from '../src/lib/digest-overrides.ts';
import {
  isOcrAvailable,
  ocrImageUrls,
  isOcrEntryFresh,
  type OcrEntry,
} from '../src/lib/vision-ocr.ts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// DIGEST_THINKING → Phase 2 extended-thinking budget (tokens). Accepts a number
// (e.g. 8000) or a truthy flag (→ 8000 default). Clamped to the api minimum of
// 1024. Returns undefined when unset. Warns when set on the claude-cli backend,
// which can't use it.
function parseThinkingBudget(): number | undefined {
  const raw = process.env.DIGEST_THINKING;
  if (!raw) return undefined;
  const n = Number(raw);
  const budget = Number.isFinite(n) && n > 0 ? Math.max(1024, Math.floor(n)) : 8000;
  const backend = process.env.LLM_BACKEND ?? 'api';
  if (backend !== 'api') {
    console.warn(
      `  [build] DIGEST_THINKING=${raw} set but ignored — extended thinking needs LLM_BACKEND=api (current: ${backend}). Phase 2 model still honors DIGEST_STUDY_MODEL.`,
    );
  }
  return budget;
}

type Args = {
  date?: string; // exact date
  conferenceSlug?: string; // build every date for this conference
  backfill: boolean; // build every date with bookmarks
  dryRun: boolean;
  skipFetch: boolean;
  outDir: string;
  obsidianDir: string;
  overridesDir: string;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]!] = m[2] ?? true;
  }
  const date = typeof args.date === 'string' ? args.date.trim() : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${date}`);
  }
  return {
    date,
    conferenceSlug: typeof args.conf === 'string' ? args.conf.trim() : undefined,
    backfill: !!args.backfill,
    dryRun: !!args['dry-run'],
    skipFetch: !!args['skip-fetch'],
    outDir: typeof args.out === 'string' ? args.out : 'data/digests',
    obsidianDir: typeof args.obsidian === 'string' ? args.obsidian : 'data/obsidian',
    overridesDir: typeof args.overrides === 'string' ? args.overrides : 'data/overrides',
  };
}

async function ensureTweetData(
  db: ReturnType<typeof openDb>,
  bookmarks: Bookmark[],
  skipFetch: boolean,
  refetchHtml: boolean,
): Promise<void> {
  if (skipFetch) return;
  // Targets:
  //   - any bookmark still in `pending` state (never fetched)
  //   - if refetchHtml=true: any oembed-fetched bookmark missing either
  //     tweet_html (carry-over from v0.1) or image_urls (carry-over from
  //     v0.2 — added syndication-CDN image extraction in v0.3)
  const needFetch = bookmarks.filter(
    (b) =>
      b.fetched_via === 'pending' ||
      (refetchHtml && b.fetched_via === 'oembed' && (!b.tweet_html || !b.image_urls)),
  );
  if (needFetch.length === 0) return;

  console.log(`  fetching ${needFetch.length} tweet(s) via oEmbed + syndication...`);
  for (const b of needFetch) {
    try {
      const tweet = await fetchTweet(b.url);
      updateBookmarkFetched(db, b.id, {
        author_handle: tweet.author_handle,
        author_name: tweet.author_name,
        tweet_text: tweet.text,
        tweet_html: tweet.html,
        image_urls: tweet.image_urls,
      });
      const imgInfo = tweet.image_urls.length > 0 ? ` (${tweet.image_urls.length} image${tweet.image_urls.length === 1 ? '' : 's'})` : '';
      console.log(`    [fetched] #${b.id}${imgInfo} ${b.url}`);
    } catch (err) {
      if (err instanceof TweetFetchError) {
        console.warn(`    [skip] #${b.id} ${err.kind}: ${b.url}`);
      } else {
        console.warn(`    [skip] #${b.id} unexpected error: ${(err as Error).message}`);
      }
    }
  }
}

function toDigestInput(bookmarks: Bookmark[]): DigestInputTweet[] {
  return bookmarks
    .filter((b) => (b.tweet_text || '').trim().length > 0)
    .map((b) => ({
      source_type: 'tweet' as const,
      id: b.id,
      author: b.author_handle ?? b.author_name ?? null,
      text: b.tweet_text!,
      note: b.notes,
      image_urls: parseImageUrls(b.image_urls),
      // Pipeline consumes just .text aligned to image_urls. Cache metadata
      // (hash, version) stays in the DB layer; the LLM doesn't need it.
      image_ocr_texts: parseOcrEntries(b.image_ocr_texts).map((e) => e.text),
    }));
}

function papersToDigestInput(papers: Paper[]): DigestInputPaper[] {
  return papers.map((p) => ({
    source_type: 'paper' as const,
    id: p.id,
    pmid: p.pmid,
    title: p.title,
    authors: parseJsonStringArray(p.authors_json, 'name'),
    journal: p.journal,
    pub_date: p.pub_date,
    abstract: p.abstract,
    fulltext_excerpt_md: p.fulltext_excerpt_md,
    doi: p.doi,
    mesh_terms: parseJsonStringArray(p.mesh_terms_json),
    note: p.curator_note,
  }));
}

function slidesToDigestInput(slides: SlideUpload[]): DigestInputSlide[] {
  return slides
    .filter((s) => (s.ocr_text || '').trim().length > 0 || (s.source_label || '').trim().length > 0)
    .map((s) => ({
      source_type: 'slide' as const,
      id: s.id,
      file_path: s.file_path,
      source_label: s.source_label,
      ocr_text: s.ocr_text,
      note: s.curator_note,
      width: s.width,
      height: s.height,
    }));
}

// papers.authors_json is stored as [{name, affiliation?}]; mesh_terms_json
// is stored as [string]. Both need tolerant parsing.
function parseJsonStringArray(raw: string | null, field?: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (field) {
      return parsed
        .map((item) =>
          item && typeof item === 'object' && typeof (item as Record<string, unknown>)[field] === 'string'
            ? ((item as Record<string, unknown>)[field] as string)
            : null,
        )
        .filter((x): x is string => Boolean(x));
    }
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function parseImageUrls(raw: string | null): string[] {
  return parseStringArray(raw);
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

// Parse the JSON-encoded OcrEntry[] from bookmarks.image_ocr_texts. Tolerant
// of legacy shapes — if a row was written before the entry struct existed
// (string[] only), each string becomes an entry with empty hash/version so
// the freshness check will reject it and trigger re-OCR.
function parseOcrEntries(raw: string | null): OcrEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      if (typeof item === 'string') return { text: item, hash: '', version: '' };
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        return {
          text: typeof o.text === 'string' ? o.text : '',
          hash: typeof o.hash === 'string' ? o.hash : '',
          version: typeof o.version === 'string' ? o.version : '',
        };
      }
      return { text: '', hash: '', version: '' };
    });
  } catch {
    return [];
  }
}

// OCR every image whose bookmark has missing or stale OcrEntry. Stale =
// version mismatch (per isOcrEntryFresh) or array length mismatch with
// image_urls. Codex amended-plan finding #4 motivates version pinning over
// the old length-equality check.
async function ensureOcrTexts(db: ReturnType<typeof openDb>, bookmarks: Bookmark[]): Promise<void> {
  if (!isOcrAvailable()) return; // graceful skip — wrapper prints warn-once on first call
  const needOcr = bookmarks.filter((b) => {
    const urls = parseImageUrls(b.image_urls);
    if (urls.length === 0) return false;
    const existing = parseOcrEntries(b.image_ocr_texts);
    if (existing.length !== urls.length) return true;
    return !existing.every((e) => isOcrEntryFresh(e));
  });
  if (needOcr.length === 0) return;
  const totalImages = needOcr.reduce((sum, b) => sum + parseImageUrls(b.image_urls).length, 0);
  console.log(`  running on-device OCR on ${totalImages} image(s) from ${needOcr.length} bookmark(s)...`);
  for (const b of needOcr) {
    const urls = parseImageUrls(b.image_urls);
    const entries = await ocrImageUrls(urls);
    updateBookmarkOcrTexts(db, b.id, entries);
    const recognized = entries.filter((e) => e.text.length > 0).length;
    console.log(`    [ocr] #${b.id} ${recognized}/${urls.length} image(s) recognized`);
  }
}

type DigestArtifact = {
  date: string; // YYYY-MM-DD
  conference: { slug: string; name: string } | null;
  generated_at: number;
  digest: DigestOutput;
  bookmarks: Array<{
    id: number;
    url: string;
    bookmark_date: string;
    author_handle: string | null;
    author_name: string | null;
    text: string;
    html: string | null;
    image_urls: string[];
    image_ocr_texts?: string[];
    note: string | null;
    fetched_via: string;
    conference_slug: string | null;
  }>;
  papers?: Array<{
    id: number;
    pmid: string | null;
    doi: string | null;
    pmc_id: string | null;
    title: string;
    authors: string[];
    journal: string | null;
    pub_date: string | null;
    abstract: string | null;
    pdf_path: string | null; // v0.8 PR2: vault location (gitignored, never published)
    note: string | null;
  }>;
  slides?: Array<{
    id: number;
    file_path: string;
    mime_type: string;
    width: number | null;
    height: number | null;
    source_label: string | null;
    ocr_text: string | null;
    note: string | null;
    source_batch_key: string | null;
  }>;
};

function buildArtifact(
  date: string,
  conference: { slug: string; name: string } | null,
  bookmarks: Bookmark[],
  papers: Paper[],
  slides: SlideUpload[],
  digest: DigestOutput,
): DigestArtifact {
  return {
    date,
    conference,
    generated_at: Date.now(),
    digest,
    bookmarks: bookmarks.map((b) => ({
      id: b.id,
      url: b.url,
      bookmark_date: b.bookmark_date,
      author_handle: b.author_handle,
      author_name: b.author_name,
      text: b.tweet_text!,
      html: b.tweet_html,
      image_urls: parseImageUrls(b.image_urls),
      image_ocr_texts: parseOcrEntries(b.image_ocr_texts).map((e) => e.text),
      note: b.notes,
      fetched_via: b.fetched_via,
      conference_slug: b.conference_slug,
    })),
    papers: papers.length > 0
      ? papers.map((p) => ({
          id: p.id,
          pmid: p.pmid,
          doi: p.doi,
          pmc_id: p.pmc_id,
          title: p.title,
          authors: parseJsonStringArray(p.authors_json, 'name'),
          journal: p.journal,
          pub_date: p.pub_date,
          abstract: p.abstract,
          // NOTE: fulltext_excerpt_md is deliberately NOT written to the
          // committed artifact — for PDFs it's copyrighted full text, and the
          // build-time LLM reads it from the DB (not the artifact), so it has
          // no consumer here. Keeping it out of data/digests keeps copyrighted
          // text out of git (v0.8 IP constraint). pdf_path is a vault path
          // string (file itself stays gitignored) used by the Obsidian embed.
          pdf_path: p.pdf_path,
          note: p.curator_note,
        }))
      : undefined,
    slides: slides.length > 0
      ? slides.map((s) => ({
          id: s.id,
          file_path: s.file_path,
          mime_type: s.mime_type,
          width: s.width,
          height: s.height,
          source_label: s.source_label,
          ocr_text: s.ocr_text,
          note: s.curator_note,
          source_batch_key: s.source_batch_key,
        }))
      : undefined,
  };
}

function writeArtifact(args: Args, artifact: DigestArtifact): { json: string; obsidian: string } {
  const jsonPath = resolve(args.outDir, `${artifact.date}.json`);
  if (!existsSync(dirname(jsonPath))) mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + '\n');

  const obsidianName = artifact.conference
    ? `${artifact.date}-${artifact.conference.slug}.md`
    : `${artifact.date}.md`;
  const obsidianPath = resolve(args.obsidianDir, obsidianName);
  if (!existsSync(dirname(obsidianPath))) mkdirSync(dirname(obsidianPath), { recursive: true });
  writeFileSync(obsidianPath, renderObsidian(artifact, { publicSiteUrl: process.env.PUBLIC_SITE_URL }));

  return { json: jsonPath, obsidian: obsidianPath };
}

async function buildOneDate(args: Args, db: ReturnType<typeof openDb>, date: string): Promise<void> {
  const allForDate = listBookmarks(db, { bookmark_date: date });
  const papersForDate = listPapers(db, { bookmark_date: date });
  const slidesForDate = listSlideUploads(db, { bookmark_date: date });

  if (allForDate.length === 0 && papersForDate.length === 0 && slidesForDate.length === 0) {
    console.log(`${date}: no bookmarks/papers/slides, skipping.`);
    return;
  }

  // refetchHtml: pick up bookmarks that were saved with v0.1 and never got
  // the oEmbed HTML stored. One-shot backfill on the next build for that date.
  await ensureTweetData(db, allForDate, args.skipFetch, true);

  // v0.4: OCR newly-fetched images via Apple Vision before the LLM call.
  // Reads from the freshly-updated bookmarks. Idempotent — skips bookmarks
  // whose ocr is already aligned with image_urls length.
  const afterFetch = listBookmarks(db, { bookmark_date: date });
  await ensureOcrTexts(db, afterFetch);

  // Re-read after the fetch step may have updated rows.
  const bookmarks = listBookmarks(db, { bookmark_date: date }).filter(
    (b) => (b.tweet_text || '').trim().length > 0,
  );
  if (bookmarks.length === 0 && papersForDate.length === 0 && slidesForDate.length === 0) {
    console.warn(`${date}: no usable items after fetch; skipping.`);
    return;
  }

  const confSlug = dominantConferenceForDate(db, date);
  const conference = confSlug ? getConference(db, confSlug) : undefined;
  const confMeta = conference ? { slug: conference.slug, name: conference.name } : null;

  console.log(
    `${date}${confMeta ? ` · ${confMeta.name}` : ''}: ${bookmarks.length} tweet(s), ${papersForDate.length} paper(s), ${slidesForDate.length} slide(s) → digest`,
  );

  const tweetInputs = toDigestInput(bookmarks);
  const paperInputs = papersToDigestInput(papersForDate);
  const slideInputs = slidesToDigestInput(slidesForDate);
  const inputs: DigestInputItem[] = [...tweetInputs, ...paperInputs, ...slideInputs];
  let digest: DigestOutput;
  if (args.dryRun) {
    digest = {
      top_line: '[dry-run] LLM not called',
      tldr: '[dry-run] LLM not called',
      sites: [
        {
          disease_site: 'other',
          intro: '[dry-run] no LLM call was made.',
          studies: [
            {
              name: '[dry-run] placeholder study',
              tldr: `${inputs.length} bookmarks would be processed.`,
              details: [],
              figures: [],
              nct: null,
              tweet_ids: inputs.map((t) => t.id),
            },
          ],
          open_questions: null,
        },
      ],
      meta: {
        clusters_total: 0,
        studies_analyzed: 0,
        dropped: [],
        ocr_available: false,
      },
    };
  } else {
    digest = await buildDigest(inputs, {
      conferenceName: confMeta?.name ?? `Day digest — ${date}`,
      conferenceDay: date,
      // Optional model overrides (config, not hardcoded). DIGEST_MODEL sets the
      // default for all phases; DIGEST_STUDY_MODEL overrides Phase 2 only (the
      // deep per-study analysis — e.g. 'opus' on claude-cli for richer output).
      // Unset → pipeline/client defaults (sonnet).
      model: process.env.DIGEST_MODEL || undefined,
      studyModel: process.env.DIGEST_STUDY_MODEL || undefined,
      // DIGEST_THINKING: extended-thinking token budget for Phase 2 (api backend
      // only). Deeper reasoning before each study agent answers.
      studyThinkingBudget: parseThinkingBudget(),
    });
  }

  // Apply durable curator overrides last, so suppressed/edited studies survive
  // every rebuild (the LLM regenerates the digest from scratch each run).
  const overrides = loadOverrides(date, args.overridesDir);
  if (overrides) {
    const applied = applyOverrides(digest, overrides);
    digest = applied.digest;
    console.log(`  applied overrides: ${formatOverrideSummary(applied.summary)}`);
  }

  const artifact = buildArtifact(date, confMeta, bookmarks, papersForDate, slidesForDate, digest);
  const paths = writeArtifact(args, artifact);
  console.log(`  wrote ${paths.json}`);
  console.log(`  wrote ${paths.obsidian}`);
}

function pickDatesToBuild(db: ReturnType<typeof openDb>, args: Args): string[] {
  if (args.backfill) {
    const dates = listAllSourceDates(db);
    if (args.conferenceSlug) {
      return dates.filter((d) => dominantConferenceForDate(db, d) === args.conferenceSlug);
    }
    return dates;
  }
  if (args.conferenceSlug && !args.date) {
    // Build every date for this conference.
    return listBookmarkDates(db).filter(
      (d) => dominantConferenceForDate(db, d) === args.conferenceSlug,
    );
  }
  return [args.date ?? todayIso()];
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();
  const dates = pickDatesToBuild(db, args);
  if (dates.length === 0) {
    console.error('No dates to build. Did you add any bookmarks?');
    process.exit(1);
  }
  console.log(`Building ${dates.length} date(s): ${dates.join(', ')}`);
  for (const date of dates) {
    await buildOneDate(args, db, date);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
