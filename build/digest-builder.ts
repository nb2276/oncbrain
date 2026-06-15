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
  createRelatedTrialsRunCache,
  type DigestInputItem,
  type DigestInputTweet,
  type DigestInputPaper,
  type DigestInputSlide,
  type DigestOutput,
  type RelatedTrialsRunCache,
  type EnrichRelatedTrialsDeps,
} from '../src/lib/llm-pipeline.ts';
import { renderObsidian } from '../src/lib/obsidian-export.ts';
import { loadOverrides, applyOverrides, formatOverrideSummary } from '../src/lib/digest-overrides.ts';
import { clampPreprintVerdict } from '../src/lib/preprint.ts';
import { stripReviewVerdicts } from '../src/lib/content-type.ts';
import { ingestApprovedResolutions, crossDateResolvedPapers } from '../src/lib/review-trial-ingest.ts';
import { fetchPubMedPaper, type PubMedPaper } from '../src/lib/pubmed-client.ts';
import { listResolutions } from '../src/lib/db.ts';

// v0.17 (T6): on each review study, attach discussed_trial_links — a map from a
// discussed-trial acronym (normalized) to the slug of the same-date study that
// was auto-resolved from it. The join is by PMID (robust), not name: the
// manifest gives (review paper, acronym) → chosen_pmid; we map chosen_pmid →
// the study whose paper source is that PMID. No-op when nothing was resolved.
export function linkResolvedTrials(
  db: ReturnType<typeof openDb>,
  date: string,
  digest: DigestOutput,
  papers: Paper[],
): void {
  const approved = listResolutions(db, { date, status: 'approved' }).filter((r) => r.chosen_pmid);
  if (approved.length === 0) return;

  const pmidByPaperId = new Map(papers.map((p) => [p.id, p.pmid] as const));
  // chosen PMID → the resolved study's slug.
  const slugByPmid = new Map<string, string>();
  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (!study.slug) continue;
      for (const ref of study.source_ids ?? []) {
        if (ref.type !== 'paper') continue;
        const pmid = pmidByPaperId.get(ref.id);
        if (pmid) slugByPmid.set(pmid, study.slug);
      }
    }
  }

  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (study.content_type !== 'review') continue;
      const reviewPaperId = study.source_ids?.find((s) => s.type === 'paper')?.id;
      if (reviewPaperId == null) continue;
      const links: Record<string, string> = {};
      for (const r of approved) {
        if (r.review_source_paper_id !== reviewPaperId || !r.chosen_pmid) continue;
        const slug = slugByPmid.get(r.chosen_pmid);
        if (slug) links[r.acronym_norm] = slug;
      }
      if (Object.keys(links).length > 0) study.discussed_trial_links = links;
    }
  }
}
import {
  listDigestsStrict,
  assertSlugUniqueness,
  summarizeTagEmissions,
  formatTagEmissionStats,
} from '../src/lib/tag-index.ts';
import { VERDICT_META } from '../src/lib/verdict.ts';
import { toPublicArticleUrl } from '../src/lib/paper-url.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';
import {
  isOcrAvailable,
  ocrImageUrls,
  isOcrEntryFresh,
  type OcrEntry,
} from '../src/lib/vision-ocr.ts';
import { writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    figure_ocr_md: p.figure_ocr_md,
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
    source_url: string | null; // v0.15.3: curator-submitted article URL — the link for trade-press (no PMID/DOI). A public citation link, not content; safe to publish.
    pdf_path: string | null; // v0.8 PR2: vault location (gitignored, never published)
    note: string | null;
    resolved_from_review: boolean; // v0.17 (T6): auto-resolved from a review's discussed trials
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
  // v0.17 P3: paper ids surfaced cross-date from a review's approved manifest.
  // Their stored fetched_via reflects their ORIGINAL date's ingestion (which may
  // not be 'review-resolved'), so force the provenance-pill flag for them.
  forceResolvedFromReview: Set<number> = new Set(),
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
          // papers.abstract is publishable: the PDF enrichment path nulls the
          // LLM-from-PDF abstract at the source (inbox-enrichment) so only
          // authoritative provider abstracts (Crossref/PubMed/page meta) are
          // ever stored here. See that IP-boundary comment for why the gate is
          // at ingestion, not here (fetched_via can't tell a Crossref abstract
          // from a leaked one on a pdf-with-DOI row).
          abstract: p.abstract,
          // NOTE: fulltext_excerpt_md AND figure_ocr_md are deliberately NOT
          // written to the committed artifact — both are copyrighted full-text /
          // figure content, and the build-time LLM reads them from the DB (not
          // the artifact), so they have no consumer here. Keeping them out of
          // data/digests keeps copyrighted material out of git (v0.8 IP
          // constraint). pdf_path is a vault path string (file itself stays
          // gitignored) used by the Obsidian embed.
          pdf_path: p.pdf_path,
          // v0.15.3: the curator-submitted article URL, the ONLY link for
          // trade-press papers (UroToday/ASCO Post/OncLive — no PMID/DOI/PMC).
          // toPublicArticleUrl drops the query + fragment (no tracking tags /
          // session tokens leak into the public artifact, codex P1) and rejects
          // non-http(s) schemes (no javascript: in a rendered href). The raw URL
          // stays in the DB as the local audit trail.
          source_url: toPublicArticleUrl(p.source_url),
          note: p.curator_note,
          // v0.17 (T6): true when this paper was auto-resolved from a review's
          // discussed-trials manifest (curator-approved). Drives the StudyCard
          // "surfaced from a review" provenance pill. A boolean, not the raw
          // fetched_via, so internal fetch methods stay out of the public artifact.
          // v0.17 P3: also true for papers surfaced cross-date (forceResolvedFromReview),
          // whose own fetched_via reflects their original date.
          resolved_from_review: p.fetched_via === 'review-resolved' || forceResolvedFromReview.has(p.id),
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

// Exported so the v0.10 backfill smoke test can drive one date end-to-end
// without spawning the CLI: it seeds an in-memory SQLite DB, passes a mock
// LlmClient via `deps.client`, and asserts the written artifact preserves
// study identity, source refs, and tag emissions. CLI callers omit `deps`
// and get the default LlmClient via createLlmClient().
export async function buildOneDate(
  args: Args,
  db: ReturnType<typeof openDb>,
  date: string,
  deps?: {
    client?: LlmClient;
    // v0.13: optional injectable seams for the related-trials orchestrator.
    // `relatedTrialsRunCache` lets `main()` allocate ONE cache and share it
    // across every `buildOneDate` invocation in a backfill so overlapping
    // drug+condition queries dedup across dates (codex round-2 #20). When
    // omitted, buildDigest allocates a per-call cache (single-date semantic).
    // `relatedTrialsDeps` is injectable for tests (ctgovFetch, rerankClient,
    // etc.); production callers omit it.
    relatedTrialsRunCache?: RelatedTrialsRunCache;
    relatedTrialsDeps?: EnrichRelatedTrialsDeps;
    // v0.17 (T5): injectable PubMed fetch for ingesting curator-approved
    // review-trial resolutions. Tests pass a mock; production omits it (defaults
    // to fetchPubMedPaper). The ingest is a no-op when there are no approved
    // resolutions for the date.
    ingestPaper?: (pmid: string) => Promise<PubMedPaper>;
  },
): Promise<void> {
  // v0.17 (T5): pull any curator-APPROVED review-trial resolutions into the DB
  // as ordinary same-date paper sources BEFORE papersForDate is read, so they
  // cluster as normal study cards through the existing pipeline. No-op when none.
  const ingest = await ingestApprovedResolutions(db, date, {
    fetchPaper: deps?.ingestPaper ?? fetchPubMedPaper,
    log: (m) => console.log(m),
  });
  if (ingest.ingested > 0) {
    console.log(`  ${ingest.ingested} approved review-trial(s) ingested as sources`);
  }
  if (ingest.failed > 0) {
    // review fix #5: never let a transient NCBI failure silently publish a
    // digest WITHOUT a curator-approved trial. The approved rows are not
    // consumed, so the next build retries — but surface it loudly now.
    console.warn(
      `  ⚠ ${ingest.failed} approved review-trial(s) FAILED to ingest (transient NCBI error); they will retry on the next build`,
    );
  }

  const allForDate = listBookmarks(db, { bookmark_date: date });
  const papersForDate = listPapers(db, { bookmark_date: date });
  const slidesForDate = listSlideUploads(db, { bookmark_date: date });

  // v0.17 P3 (cross-date surfacing): a review on this date may discuss a trial
  // whose primary paper is already a source on an EARLIER date. papers.pmid is
  // UNIQUE so the row lives on its first date; inject those approved-resolution
  // papers into THIS date's build inputs so the trial gets a card here too (the
  // manifest is the many-to-many review-date↔paper link). De-duped against the
  // date's own paper PMIDs. crossDateIds drives the provenance pill: these
  // papers' stored fetched_via reflects their ORIGINAL date, so resolved_from_review
  // can't key on it for them.
  const sameDatePmids = new Set(
    papersForDate.filter((p) => p.pmid).map((p) => p.pmid as string),
  );
  const crossDatePapers = crossDateResolvedPapers(db, date, sameDatePmids);
  const allPapers = [...papersForDate, ...crossDatePapers];
  const crossDateIds = new Set(crossDatePapers.map((p) => p.id));

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
    `${date}${confMeta ? ` · ${confMeta.name}` : ''}: ${bookmarks.length} tweet(s), ${papersForDate.length} paper(s), ${slidesForDate.length} slide(s)` +
      (crossDatePapers.length > 0 ? ` + ${crossDatePapers.length} cross-date review-trial(s)` : '') +
      ` → digest`,
  );

  const tweetInputs = toDigestInput(bookmarks);
  const paperInputs = papersToDigestInput(allPapers);
  const slideInputs = slidesToDigestInput(slidesForDate);
  const inputs: DigestInputItem[] = [...tweetInputs, ...paperInputs, ...slideInputs];
  // Dry-run must NOT write: the committed data/digests/<date>.json and the
  // Obsidian note are publish-on-push artifacts, and the old placeholder-digest
  // path fell through to writeArtifact below, clobbering the real committed
  // digest with a hollow one (a documented footgun). Log what would happen and
  // return before any LLM call, override application, or disk write.
  if (args.dryRun) {
    console.log(
      `  [dry-run] LLM not called; would process ${inputs.length} input(s) ` +
        `(${tweetInputs.length} tweet, ${paperInputs.length} paper, ${slideInputs.length} slide) ` +
        `→ would write data/digests/${date}.json (committed artifact left untouched)`,
    );
    return;
  }
  let digest: DigestOutput = await buildDigest(inputs, {
      conferenceName: confMeta?.name ?? `Day digest — ${date}`,
      conferenceDay: date,
      client: deps?.client,
      // Optional model overrides (config, not hardcoded). DIGEST_MODEL sets the
      // default for all phases; each phase can also be selected independently —
      // DIGEST_GROUPING_MODEL (Phase 1), DIGEST_STUDY_MODEL (Phase 2, the deep
      // per-study analysis — e.g. 'opus' on claude-cli), DIGEST_SYNTHESIS_MODEL
      // (Phase 3) — each falling back to DIGEST_MODEL, then the client default
      // (sonnet) when unset.
      model: process.env.DIGEST_MODEL || undefined,
      groupingModel: process.env.DIGEST_GROUPING_MODEL || undefined,
      studyModel: process.env.DIGEST_STUDY_MODEL || undefined,
      synthesisModel: process.env.DIGEST_SYNTHESIS_MODEL || undefined,
      // DIGEST_THINKING: extended-thinking token budget for Phase 2 (api backend
      // only). Deeper reasoning before each study agent answers.
      studyThinkingBudget: parseThinkingBudget(),
      // DIGEST_PERSPECTIVE: specialty lens for Phase 2 (e.g. 'radonc', 'medonc').
      // Resolved to prompts/perspectives/<name>.md. Unset = no bias.
      perspectiveName: process.env.DIGEST_PERSPECTIVE || undefined,
      // v0.13: thread the shared cache + injectable seams.
      relatedTrialsRunCache: deps?.relatedTrialsRunCache,
      relatedTrialsDeps: deps?.relatedTrialsDeps,
    });

  // T18: build-time tag emission summary so the curator can see at a glance
  // whether Phase 2 produced the expected distribution. Logged before override
  // application — these are the raw LLM emissions, separate from curator-
  // applied corrections (override summary logs immediately after).
  console.log(`  tag emissions: ${formatTagEmissionStats(summarizeTagEmissions(digest))}`);

  // Apply durable curator overrides last, so suppressed/edited studies survive
  // every rebuild (the LLM regenerates the digest from scratch each run).
  const overrides = loadOverrides(date, args.overridesDir);
  if (overrides) {
    const applied = applyOverrides(digest, overrides, { digestDate: date });
    digest = applied.digest;
    console.log(`  applied overrides: ${formatOverrideSummary(applied.summary)}`);
  }

  // v0.14.5 (E5): re-assert the preprint verdict cap AFTER overrides. A curator
  // verdict edit runs after the Phase-2 clamp and could otherwise restore an
  // over-confident verdict on a flagged preprint — the clinical-safety floor
  // must hold regardless of override. Idempotent on already-capped verdicts.
  //
  for (const site of digest.sites) {
    for (const study of site.studies) {
      if (study.is_preprint) study.verdict = clampPreprintVerdict(study.verdict) ?? undefined;
    }
  }
  // v0.16: force every `review` study verdict-less in the same post-override
  // phase (Codex #9). A multi-trial review has no single SOC implication to
  // triage; it surfaces discussed_trials instead. Runs AFTER overrides so a
  // curator verdict edit can't reintroduce one. See stripReviewVerdicts.
  const strippedReviewVerdicts = stripReviewVerdicts(digest);
  if (strippedReviewVerdicts > 0) {
    console.log(`  stripped ${strippedReviewVerdicts} verdict(s) from review studies`);
  }

  // v0.17 (T6): link each review's discussed-trial acronyms to the same-date
  // study auto-resolved from it (via the approved manifest), so the rendered
  // "Trials discussed" list can deep-link to the resolved card.
  linkResolvedTrials(db, date, digest, allPapers);

  const artifact = buildArtifact(date, confMeta, bookmarks, allPapers, slidesForDate, digest, crossDateIds);
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
  // v0.13: allocate ONE related-trials run cache for the entire backfill so
  // overlapping drug+condition queries dedup across dates. For single-date
  // builds this is functionally identical to per-call allocation.
  // Codex round-2 #20.
  const relatedTrialsRunCache = createRelatedTrialsRunCache();
  for (const date of dates) {
    await buildOneDate(args, db, date, { relatedTrialsRunCache });
  }

  // v0.10: cross-namespace slug uniqueness assertion. Reads the freshly
  // written data/digests/*.json corpus + the verdict enum, fails the build
  // on collision or malformed slug. Slug-only /tags/<slug>/ URLs require
  // every value to be globally unique across modality + intent + methodology
  // + verdict + meeting; this assertion is what catches a future tag value
  // (or a freshly imported conference) that would silently route the wrong
  // studies to a tag landing page.
  const corpus = listDigestsStrict();
  const verdictSlugs = Object.keys(VERDICT_META);
  assertSlugUniqueness(corpus, verdictSlugs);
}

// Only run as a CLI when invoked directly. Guard added in v0.10 so the
// smoke test can import `buildOneDate` without triggering the full builder
// loop (which would otherwise call openDb('./oncbrain.db') against the
// curator's local DB at module load time).
//
// Symlink hazard: the curator's working dir is in Dropbox, which exposes
// BOTH `/Users/<u>/Library/CloudStorage/Dropbox/...` (real path) and
// `/Users/<u>/Dropbox/...` (symlink). Node ESM resolves `import.meta.url`
// to the realpath while `process.argv[1]` is preserved literally — so a
// naive `===` compare would skip `main()` when the cron starts under the
// symlinked path and the build silently no-ops. Realpath both sides so
// the cron + manual invocations both fire `main()` regardless of which
// alias was used to launch tsx.
function isInvokedAsScript(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isInvokedAsScript()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
