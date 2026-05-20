# Changelog

All notable changes to oncbrain are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added — durable digest overrides

The 3-phase LLM regenerates the whole digest on every `build:day`, so hand-edits
to `data/digests/<date>.json` don't survive a rebuild. A per-date sidecar fixes
that.

- **`data/overrides/<date>.json`** — committed override file applied as the last
  build step (`src/lib/digest-overrides.ts`, pure `applyOverrides`). Suppress a
  study, override study text (tldr / name / bullets / verdict / open_questions),
  or override the cross-site top_line/tldr. Studies are matched by their stable
  per-study slug; identity/citation fields (slug, source refs) can't be clobbered.
- **`npm run override`** CLI to manage the sidecar without hand-writing JSON:
  `--list` (current studies + slugs), `--suppress`/`--unsuppress`,
  `--edit=<slug> --tldr=.. --name=.. --nct=..`, `--top-line`/`--digest-tldr`,
  `--clear`. Complex edits (bullets, tables) are hand-edited in the JSON file.

### Changed — study bullet density (less wall-of-text)

- VOICE.md + the Phase 2 study-agent prompt now favor several short bullets over
  dense ones: one idea per bullet, typically 4-9 bullets, flat strings ≤20 words,
  related facts grouped under `{text, subdetails}`. This decomposes the facts the
  source already gives; it does not pad or fabricate (the no-fabrication rule
  still wins). All committed digests reprocessed.

### Fixed — paper ingestion

- Bot-blocked publisher pages (Elsevier/ScienceDirect 403, surfaced as
  `SsrfError`) now retry via a DOI or PMID embedded in the URL or curator
  message (Crossref/PubMed don't bot-block) before giving up.
- Unrecoverable failures (paywall/403 with no usable identifier, non-PDF file,
  unrecognized target) are parked as `failed_permanent`: excluded from the
  enrichment queue so they aren't retried, and the curator stops getting
  re-pinged the same error on every enrich run.

### Fixed — backfill skipped paper/slide-only days

- `build:day --backfill` now unions dates across bookmarks, papers, and slides
  (`listAllSourceDates`), so a paper-only or slide-only day (v0.5+ multi-source)
  is reprocessed instead of silently skipped.

## [0.8.0] — 2026-05-19

First release cut since 0.5.0. Everything below shipped to `main` and went live
incrementally; this stamps the version. Three feature lines: live search
(v0.6), the standard-of-care verdict (v0.7), and non-PMID + PDF source
ingestion with an RSS/JSON API (v0.8, built as PR1-3). Grouped by feature,
newest first.

### Discoverability + docs (post-v0.8)

- RSS auto-discovery `<link>` in every page `<head>`, so a reader finds
  `/feed.xml` from the site URL. New public `/api` docs page covering the feed +
  JSON endpoints.
- About page rewritten for the current multi-source app, with curator
  attribution (Nick Boehling, MD, @nb2276) moved up to the header by the title.

### RSS feed + JSON API + cross-day NCT dedup (v0.8 PR3)

The digest becomes a content backbone other apps can consume, and the bot
nudges you when you re-bookmark an already-covered trial. Completes the v0.8
plan (`docs/plans/v0.8-non-pmid-sources.md`). All output is static, generated
at Astro build time.

### Added — output (E1)

- **`/feed.xml`** — RSS 2.0, latest 30 study additions newest-first. Each item
  is one study: name, analyst verdict + eligibility audience + TL;DR, deep-
  linked to `/<date>/#<slug>`. Hand-rolled (`src/lib/feed.ts`), no new dep.
- **`/api/v1/digests.json`** — index of published days with study/site counts.
- **`/api/v1/digest/<date>.json`** — one day's full artifact.
- **`/api/v1/study/<slug>.json`** — one study, every date it was covered
  (cross-date resolved by the same slug the page anchors + search index use).
- `/api/v1/` is a versioned namespace from day one so the contract can evolve
  additively. `site` is now set in `astro.config.mjs` for absolute links.

### Added — cross-day NCT dedup (E6)

- **"Previously covered" nudge.** `src/lib/nct-coverage.ts` indexes which NCT
  appeared in which prior digest; at enrich time, if a newly-ingested source
  (tweet / paper / PDF) references a trial covered in a *strictly earlier*
  digest, the bot replies "previously covered <date> (<study>)". Low-noise:
  silent unless there's a match. Reuses the existing NCT extractor + reply path.

### Fixed (IP) — PR2 follow-up

- **Copyrighted PDF full text no longer reaches git or the API.**
  `fulltext_excerpt_md` was being written into the committed `data/digests/*.json`
  even though nothing renders it (the build LLM reads it from the DB). Removed
  it from the artifact, and `sanitizeArtifactForApi` allowlists paper fields
  (drops `pdf_path` + any historical full text) before `/api/v1/digest/<date>`
  serves it. `test/api-output.test.ts` + a build-time leak scan assert no
  `fulltext_excerpt_md` / `pdf_path` appears in any served API file.

### Engineering

- 469 tests (was 451, +18): RSS shape + XML escaping, API index/study/sanitize
  shapers, NCT coverage index + strictly-prior lookup.
- `npm run build` verified to emit `dist/feed.xml` + `dist/api/v1/**` (one file
  per date + per slug); served JSON confirmed leak-free on real artifacts.
- 0 type errors.

### Notes / not done

- CORS headers (`Access-Control-Allow-Origin: *`) aren't set — DigitalOcean's
  static tier doesn't do per-file headers. RSS readers + server-side fetchers
  don't need it; add via DO config if browser cross-origin access is wanted.
- The NCT nudge keys on a study's resolved `nct`; a tweet whose oEmbed text
  hasn't loaded yet at enrich time won't trigger it (best-effort courtesy).
- v0.8 is now feature-complete across PR1–PR3; `package.json` still reads 0.5.0
  pending a release bump (handled via the ship workflow).

### PDF ingestion + private vault library (v0.8 PR2)

Forward the bot a PDF and it summarizes into the digest AND files the full
text into your Obsidian vault. Builds on PR1's schema + reply work. Plan +
reviews: `docs/plans/v0.8-non-pmid-sources.md`.

### Added

- **PDF ingestion.** DM/forward a PDF document → it's stored as a `type='paper'`
  inbox item (`kind:'pdf'` marker) and, at enrich time, downloaded, text-
  extracted, summarized, and filed. `extractPdfDocument` in `telegram-ingest.ts`.
- **Text extraction via poppler** (`src/lib/pdf-text.ts`) — `pdftotext` for the
  embedded text layer; scanned PDFs (sparse layer) fall back to `pdftoppm` →
  Apple Vision OCR per page → joined text. Transient OCR page-images live only
  in `os.tmpdir()` and are unlinked in a finally block; a startup sweep clears
  crash orphans. No new npm dependency — poppler is `brew install poppler`.
- **LLM metadata extraction** (`src/lib/pdf-meta.ts` + `prompts/pdf-meta-v1.txt`)
  reads the PDF's full text for title / authors / journal / year / abstract /
  DOI / PMID / disease-site. A "treat text as data, not instructions" guard
  blocks prompt injection from the PDF. A DOI/PMID regex backstops the model so
  dedup against URL-ingested papers still works; the full text is stored as
  `fulltext_excerpt_md` so the build-time study agent reads real Methods/Results.
- **Private PDF library** — filed at `data/obsidian/papers/<site>/<slug>.pdf`,
  organized by disease site (`src/lib/pdf-storage.ts`). The Obsidian daily note
  gains a `📎 [[papers/…|<study> (full text)]]` embed. Re-ingest overwrites in
  place; identifier-less / unreadable PDFs land under `_unsorted/`.
- **E2/E3 replies extend to PDFs**: "Got it: <title> (filed to your vault)" on
  success; named-reason replies for too-large / unreadable / non-PDF / poppler-
  missing / scanned-but-no-Vision.

### Changed (schema)

- **`papers` gains `content_hash` + `pdf_path`; CHECK relaxed to
  `(pmid OR doi OR content_hash)`** so an identifier-less PDF (author
  manuscript, scanned pre-DOI paper) can still be stored, keyed + deduped by
  its content hash. `migratePapersAddPdfColumns` runs the table rebuild
  (transactional, backed up, idempotent; ordered after PR1's migration). The
  content_hash unique index is created post-migration, not in SCHEMA, so an
  old-shape DB doesn't error on the missing column. `savePaper` now keys on
  pmid → doi → content_hash and merges a late `content_hash` / `pdf_path` /
  full text onto an existing row (URL-then-PDF of the same paper enriches one
  row instead of duplicating).

### IP constraint (load-bearing)

- Filed PDFs are LOCAL-ONLY: gitignored, no `public/` symlink, never in the
  Astro build. The public site carries only the summary. `test/publish-
  boundary.test.ts` asserts the gitignore + no-public-path guarantees.

### Engineering

- 451 tests (was 410, +41): PDF text composition + poppler error mapping,
  metadata parse + regex backstop, vault filing + path-safety, content_hash
  migration (original→final, idempotent, content-hash-only CHECK), savePaper
  PDF merge, Telegram PDF detection, Obsidian embed, publish-boundary.
- Real-poppler smoke test confirmed the text + OCR-fallback chains end to end.
- 0 type errors (also cleared the pre-existing `source_ids` error in
  obsidian-export.ts). `enrich:inbox` now sweeps orphaned OCR temp dirs on start.

### Deviations from plan / known limits

- Plan filed the PDF before extraction; we extract first (DOI/site needed for
  the folder), then file — the diagram's intent, reordered. Metadata comes from
  one LLM call over the full text (richer than Crossref, which often lacks
  abstracts) rather than a Crossref/PubMed round-trip on the PDF path.
- Not yet exercised against real Telegram PDF traffic (needs a live DM).
- PR3 (RSS/API + cross-day NCT dedup) still pending.

### Non-PMID URL ingestion (v0.8 PR1)

DM the bot a DOI, journal-page, or PMC URL and it ingests as a paper. No
more PubMed-detour to find a PMID first. Plan + reviews:
`docs/plans/v0.8-non-pmid-sources.md` (CEO + codex + eng reviewed).

### Added

- **URL ingestion.** `pull-telegram` now detects DOI/journal/PMC URLs
  (`extractPaperUrls` in `src/lib/paper-url.ts`) alongside tweet URLs and
  PMIDs, storing them raw as `type='paper'` inbox items. Resolution runs
  at enrichment, not ingest, so a journal-page timeout retries instead of
  dropping the message (eng-review decision 1).
- **Enrichment-time resolution.** `enrichPaperItem` classifies each
  target and resolves: PMID → PubMed efetch; DOI → Crossref; journal/PMC
  URL → SSRF-safe fetch → Highwire/OpenGraph meta → PMID (PubMed) or DOI
  (Crossref) or page-meta fallback.
- **`src/lib/ssrf-fetch.ts`** — SSRF-safe fetch: https-only, DNS-resolve +
  reject private/loopback/link-local IPs (v4+v6, IPv4-mapped, numeric
  encodings), per-hop redirect revalidation, 10s timeout, 5MB cap.
- **`src/lib/crossref-client.ts`** — DOI-keyed metadata via Crossref REST,
  polite-pool User-Agent. Abstracts are frequently absent (publishers
  rarely deposit them) — ingest proceeds with title/authors and the digest
  notes "no abstract available" rather than fabricating analysis.
- **`src/lib/html-meta.ts`** — Highwire (`citation_*`) + OpenGraph meta
  extraction from journal article pages.
- **`src/lib/doi.ts`** — `normalizeDoi` (the single canonicalization used
  by both the unique index and the dedup lookup), `extractDois`, `isBareDoi`.
- **Telegram replies (E2/E3).** Confirmation on success ("Got it: <title>")
  and named-reason rejection on permanent failure (paywall, no metadata,
  unrecognized). Best-effort — a failed reply never fails the ingest.

### Changed (schema)

- **`papers` table rebuilt.** `pmid` is now nullable; uniqueness moved from
  the inline `pmid UNIQUE` to two partial unique indexes (`pmid`,
  `lower(doi)`) plus `CHECK (pmid IS NOT NULL OR doi IS NOT NULL)`. New
  `source_url` column. `migratePapersAllowDoiOnly` runs the SQLite
  table-rebuild for existing DBs (transactional, backs up to
  `oncbrain.db.bak-<date>` first; no SQL FKs reference papers so no cascade
  dance). `savePaper` keys on PMID-or-DOI and merges a late-arriving PMID
  onto a DOI-only row instead of duplicating.

### Engineering

- 410 tests (was 339, +71): 3 CRITICAL suites (papers migration row-
  preservation + idempotency, SSRF private-range rejection) plus doi /
  paper-url / html-meta / crossref / savePaper-merge.
- 0 new type errors (one pre-existing `source_ids` in obsidian-export.ts).

### Not yet shipped (this PR)

- PDF ingestion + scanned-PDF OCR (PR2); RSS/API + cross-day dedup (PR3).
- Conference URL auto-detect, preprint badge, email-forwarding — TODOS.

### Analyst verdict + comparator promotion (v0.7)

- Per-study standard-of-care verdict pill at the top of each study card
  (practice-changing / challenges-soc / confirmatory / early-signal /
  methodologically-limited / unclear) with a one-line rationale and the
  eligibility audience, for 60-second triage. Comparator (🔗) bullets promoted
  into a dedicated "vs leading data" callout. Author name/handle surfaced on
  source cards. Verdict calibration hardened with VOICE.md maturity gates
  (single-arm / interim / post-hoc caps) after codex review.

### Live search (v0.6)

Client-side live search on the home page. The curator scans across days; as the archive grows past ~10 dates, "browse by date" stops scaling.

### Added

- **`src/components/SearchBox.astro`** — single search input mounted above the recent-dates strip on `/`. Lazy-loads the index on first focus, filters as you type. Substring match (case-insensitive) across study `name`, `tldr`, `nct`, and disease-site label. Up to 20 results, sorted newest date first; if more match, shows "+N more — narrow your search". Keyboard: `/` focuses, `Esc` clears.
- **`src/pages/search-index.json.ts`** — Astro endpoint emitting one `SearchEntry` per study across all published dates. ~250 bytes/entry; deferred to v0.6.x to switch to a real search engine (lunr/flexsearch) if typo tolerance becomes a real complaint.
- **`src/lib/slug.ts`** — `deriveSlug(name)` helper, single source for slug derivation. Strips punctuation, normalizes diacritics, collapses separators, truncates to 64 chars, falls back to `study` for empty-after-strip input. Matches the `isSafeSlug()` shape used elsewhere.
- **Per-study slug on `DigestStudy`.** Schema additive: new optional `slug` field carried from Phase 1 clustering through to the final artifact. Older v0.5 artifacts fall back to `deriveSlug(name)` at render time, so existing pages keep working.
- **Anchor IDs on study cards in `[date].astro`.** Each `.study` div gets `id={study.slug ?? deriveSlug(study.name)}` + `scroll-margin-top: 1rem` so search-result clicks deep-link cleanly. Format: `/<date>/#<slug>`.

### Engineering

- 308 tests (was 298, +10 for slug derivation edge cases).
- 0 new type errors. One pre-existing `source_ids` error in `obsidian-export.ts` carries over from v0.5.

### Hardenings folded from codex review/challenge (pre-merge)

- **All interpolated fields HTML-escaped, not just name/tldr.** Codex challenge #1 caught that `date`, `slug`, and `site_emoji` were injected raw into `innerHTML`. Even though those sources are tightly controlled today (date is YYYY-MM-DD; slug is safe-slug-shaped from the resolver; emoji from `disease-sites.ts` constants), the uniform escape protects against future drift.
- **Search-index payload shape validation.** `loadIndex()` now rejects non-array payloads and filters out entries that don't match the `SearchEntry` shape. A malformed `/search-index.json` no longer bricks the component on first keystroke.
- **Anchor-fragment encoding.** URL fragments built from `date` + `slug` go through `anchorEscape()` (URI-encode if not safe-slug-shaped) before being put into the `href`. Defense-in-depth — should be a no-op for current well-formed entries.
- **Per-date slug collision resolver.** New `src/lib/slug-resolve.ts` walks each date's studies in render order and suffixes `-2`, `-3` to fallback-slug collisions. Used by both `[date].astro` (anchor `id`) and `search-index.json.ts` (deep-link target) so the two paths stay in sync. Codex challenge #2 surfaced real-world collisions: distinct names like "研究" + "🧪" both derive to `"study"`, "Trial — α" + "Trial" both derive to `"trial"`, and 64-char names truncate to the same prefix. 11 new tests in `test/slug-resolve.test.ts`.
- **Cache-on-error no longer permanent.** Codex review's only P2 + challenge #3: previously, a transient `/search-index.json` failure cached `[]` and resolved `inflight`, making search silently broken until reload. Now the catch path resets `inflight = null` so the next call retries.
- **Stale-query guard via debounce.** 80ms debounce on input + the awaited render reads `input.value` after the await (not the captured-at-event-time value), so a fast typer who clears the box mid-fetch no longer sees stale results painted.
- **`tldr` capped at 240 chars in the search index.** Bounds per-keystroke filter cost and DOM render size. Full `tldr` still rendered on the per-date page; this is search-only. Codex challenge #4.
- **Accessibility:** explicit visually-hidden `<label>` on the search input, `aria-controls` on the input pointing to the results region. Codex challenge #5.

### Not yet shipped (deferred)

- **Source-type filter** in search results (tweet/paper/slide). v0.6.x.
- **Fuzzy / typo-tolerant match.** Defer until a real reader complaint. Substring covers known-name lookups.
- **Keyboard navigation through results.** Arrow keys + Enter. Stretch.
- **URL state** (`?q=foo`). Stretch — results live in JS state only for the MVP.
- **Publication filter on `listDigests()`.** `/search-index.json` and the build pipeline read every JSON file under `data/digests/`. Codex challenge residual note — not a v0.6 ship blocker (no draft artifacts live there in practice), but worth a `published: boolean` field if drafts ever land beside published ones.

## [0.5.0] — 2026-05-18

Multi-source ingestion. The digest pipeline now accepts three input types:

- **Tweets** (existing) — bookmarked via Telegram bot
- **Papers** — PMID URLs or `PMID: N` citation blocks DM'd to the bot. Metadata + abstract + section-filtered PMC body via NCBI E-utilities.
- **Slide photos** — image attachments DM'd to the bot. Downloaded via Telegram getFile, saved under `data/slide-photos/`, Apple Vision OCR'd, magic-byte sniffed.

All three flow through an inbox queue that decouples message receipt from enrichment, so transient NCBI/Telegram/OCR failures don't lose source messages (codex amended-plan P0 #1). A weighted source-association layer (NCT strong, trial acronym medium with a blacklist filter) gives Phase 1 soft clustering hints so cross-source items about the same trial cluster together — without forcing the model to preserve bad merges (codex P0 #2/#3).

### Phase E rendering (this release)

- **Source-attribution badges** in each study's Sources summary: `📚 Sources · 🐦 3 tweets · 📄 1 paper · 🩻 2 slides`. Expands to show each source rendered in a type-specific card.
- **Paper card**: PMID/DOI/PMC links, journal + date, author list, expandable Abstract section.
- **Slide card**: image rendered with onerror fallback; source_label and curator note.
- **`/slides/[date]/[uuid].<ext>`** static asset path served via `public/slides` symlink to `data/slide-photos`. Pre-build hook (`scripts/link-slides.sh`) creates the symlink idempotently.
- **Obsidian export** writes source-type pills (🐦/📄/🩻) inline with markdown source list. Papers include linked PMID + DOI + truncated abstract; slides include image embed + OCR snippet.
- **Site aggregation pages** (`/sites/<slug>/`) also resolve paper + slide refs per study occurrence, same rendering pattern.

### Engineering

- 298 tests across 13 files. 0 type errors across 45+ files.
- 5 commits land in this release (one per phase): A → B → C → D → E.

### Privacy / publishing

- `data/slide-photos/` is **gitignored by default** — slides stay curator-private. Astro renders them locally via the symlink, but DO prod builds see no slides unless explicitly committed (`git add -f data/slide-photos/<date>/<uuid>.jpg`).
- Papers always render publicly — their content is PubMed-sourced and already public.

### Not yet shipped (deferred)

- **Source-tagged Phase 2 claims** (codex amended-plan P1 #6 mixed-source hallucination guard) — will land as v0.5.1 hardening.
- **DOI-only paper references** (PMID required for v0.5 ingestion).
- **PMC URLs as ingestion targets** (must include PMID).
- **Non-photo image attachments** (HEIC documents from iOS Photos sometimes).
- **Gmail OAuth polling** for PubMed alerts (manual forward-to-bot is the v0.5 workflow).

[0.5.0]: https://github.com/nb2276/oncbrain/releases/tag/v0.5.0

## [Unreleased] — v0.5 Phase D — 2026-05-18

Papers and slides reach the LLM pipeline. `buildDigest` now accepts a `DigestInputItem` union (tweet | paper | slide); `digest-builder` gathers all three source types for the date and assembles them. A new source-association layer builds NCT + trial-acronym weighted hints that Phase 1 receives as a soft addendum (codex P0 #2, #3 — soft hints only; model can override on content contradiction).

### Added

- **`DigestInputItem` union** in `src/lib/llm-pipeline.ts`: discriminated by `source_type` ('tweet' | 'paper' | 'slide'). Tweets stay shape-compatible with v0.4 callers (source_type optional). Papers carry pmid + title + authors + abstract + Methods/Results excerpt + MeSH. Slides carry file_path + ocr_text + source_label.
- **`src/lib/source-association.ts`** with `buildAssociationGraph()`: NCT match = strength 10, multi-occurrence trial acronym = strength 3, single-occurrence acronym ignored. Acronym blacklist filters genes (TP53, BRCA, HER2, EGFR), endpoints (OS, PFS, HR, CI), and disease shorthand (mCRPC, NSCLC, etc.) so over-merge is bounded. Hints render into the Phase 1 prompt as `STRONG`/`medium` labeled lines.
- **`{{ASSOCIATION_HINTS}}` placeholder** in `prompts/digest-v5-grouping.txt`. Soft hints only — the model has final say on clustering.
- **`DigestStudy.source_ids`**: typed source references `Array<{type, id}>` alongside the back-compat `tweet_ids`. Renderers prefer `source_ids` when present.
- **Artifact JSON gains `papers[]` and `slides[]`** alongside existing `bookmarks[]`. Optional — only emitted when papers/slides exist for the date.
- **Synthetic id namespacing**: papers occupy `1_000_000_000+`, slides `2_000_000_000+` inside the pipeline's tweet-shape plumbing. Reverse-mapped to typed refs on output via `syntheticIdToSourceRef`.

### Changed

- **`buildDigest(items, opts)`** signature now `DigestInputItem[]`. v0.4 callers passing `DigestInputTweet[]` continue to work — the union accepts tweet shapes.
- **Phase 1 prompt** acknowledges the three source types and instructs the model to read `[PAPER ...]` / `[SLIDE ...]` markers at the start of each item's text payload.
- **`buildArtifact`** signature: now accepts bookmarks + papers + slides (was bookmarks only).

### Engineering

- 298 tests (was 290, +8 for source-association weighted edges and acronym blacklist).
- 0 type errors across 45 files.
- Existing 2026-05-17 artifact (v0.4.4) continues to render unchanged via the back-compat fallback paths.

### Not yet shipped

- Astro doesn't render the new paper/slide sources yet — Phase E adds source-attribution badges, abstract toggles, and the `/slides/[uuid]` static route.
- Source-tagged Phase 2 claims (codex P1 #6 mixed-source hallucination guard) deferred to a v0.5.1 hardening hotfix.

## [Unreleased] — v0.5 Phase C — 2026-05-18

Slide photos join the ingestion pipeline. Send a photo to @oncbrain_bot and it gets downloaded via the Telegram getFile API, saved to `data/slide-photos/<date>/<uuid>.<ext>`, OCR'd via Apple Vision, and stored in a new `slide_uploads` table. Photos are curator-private by default (gitignored); committing them to make them public is a per-deployment choice that Phase E will surface in the rendering layer.

### Added

- **`slide_uploads` table**: file_path (UNIQUE), file_hash (sha256 of bytes), mime_type, width, height, source_label, ocr_text, ocr_version, bookmark_date, conference_slug, curator_note, source_batch_key (for multi-photo Telegram messages), inbox_item_id (FK).
- **`src/lib/slide-photo-storage.ts`**: Telegram `getFile` two-call flow (`getFile?file_id=X` → `file_path` → bytes), magic-byte sniffing (JPEG/PNG/GIF/WebP), path-traversal guarded write under `data/slide-photos/`. 25 MB hard cap rejects oversize documents masquerading as photos.
- **`extractSlidePhoto()`** in telegram-ingest.ts: picks the highest-resolution variant from Telegram's `photo[]` array. Multi-photo album messages carry `media_group_id` which is stored on the inbox item as `source_batch_key` for later grouping.
- **Slide enrichment handler** in inbox-enrichment.ts: download → save to disk → OCR via `ocrFile()` → insert slide_uploads row. OCR failure is non-fatal (slide ships uncaptioned; operator can re-OCR manually). Missing TELEGRAM_BOT_TOKEN or vision-ocr binary fail/defer cleanly.
- **`ocrFile()`** in vision-ocr.ts: OCR a local path (no download). Sibling to `ocrImageUrl()`; used by Phase C for slides already on disk.

### Changed

- **`pull:telegram`** now detects photo attachments on incoming messages. One Telegram message can produce inbox items across tweet, paper, AND slide types (e.g., a curator text containing a PubMed URL with an attached slide photo).
- **`.gitignore`** adds `data/slide-photos/` by default. Curator can comment out and commit explicitly to publish slides on the live site.

### Engineering

- 290 tests (was 279, +11 for Telegram getFile flow, magic-byte sniffing, path safety, and the slide-enrichment failure path).
- 0 type errors across 42 files.
- Vision OCR available on macOS only (existing v0.4 constraint). On Linux/CI, slide ingestion defers with a clear reason.

### Not yet shipped

- Slide photos don't render in the digest yet — Phase E adds the `/slides/[uuid]` static route + Astro source-attribution badges.
- Documents (non-`photo[]` attachments like `image/heic` from iOS Photos sometimes) are not yet detected. v0.6+.

## [Unreleased] — v0.5 Phase B — 2026-05-18

PubMed papers join the ingestion pipeline. Telegram bot now detects PMID URLs and inline "PMID: N" citations alongside tweet URLs; enrichment fetches metadata + abstract from NCBI E-utilities and, when the paper has a PMC ID, extracts Methods + Results sections capped at ~2000 tokens. Papers accumulate in a new `papers` table and will join the digest pipeline in Phase D.

### Added

- **`papers` table**: PMID-keyed metadata storage. Columns: doi, pmc_id, title, authors_json, journal, pub_date, abstract, fulltext_excerpt_md (section-filtered Methods + Results), mesh_terms_json, bookmark_date, conference_slug, curator_note, inbox_item_id (FK), fetched_via.
- **`src/lib/pubmed-client.ts`**: NCBI E-utilities client. `fetchPubMedPaper(pmid)` calls efetch on db=pubmed for metadata + abstract, then efetch on db=pmc for Methods + Results when PMC ID present. Section filter pulls `sec[sec-type="methods|results"]` or falls back to title-based detection. PMC fetch failure is non-fatal (paper still ships with abstract). Char-cap 8000 (~2000 tokens) per codex P0 revision down from 8000 tokens.
- **`extractPaperPmids()`** in telegram-ingest.ts: detects PMID URLs (`pubmed.ncbi.nlm.nih.gov/N`) and inline citation strings (`PMID: N`). Deduped per-message.
- **Paper enrichment handler** in inbox-enrichment.ts: dispatches paper inbox items to PubMed client, inserts into papers table. Network errors return retry-eligible failure; not_found and parse errors fail permanently.

### Changed

- **`pull:telegram`** detects paper targets alongside tweet URLs. One message can produce multiple inbox items across types.
- **`extractCuratorNote()`** strips PubMed URLs, PMID citations, DOIs, and "Epub ahead of print" residue so a curator's note is only the actual free-form commentary (not the forwarded citation block).

### Engineering

- 279 tests (was 251, +28 for PubMed XML parsing, section filtering, paper detection, citation-residue stripping).
- 0 type errors across 41 files.
- Rate limit safe: 3 req/sec NCBI cap; solo-curator volume well within. Add `NCBI_API_KEY` to `.env` to bump to 10/sec when needed.

### Not yet shipped

- Papers don't appear in digests yet — that's Phase D (pipeline becomes type-aware and renders source-attribution badges).
- DOI-only references and PMC URLs are not detected (PMID required). v0.6+.

## [Unreleased] — v0.5 Phase A — 2026-05-18

Inbox-first ingestion. Telegram puller no longer writes directly to bookmarks; it writes to a new `inbox_items` queue. A separate `enrich:inbox` CLI processes pending items into typed tables (bookmarks now; papers and slides in v0.5 Phases B + C). Decoupling guarantees the Telegram offset advances on inbox write — not on enrichment success — so transient enrichment failures don't lose source messages (codex amended-plan P0 #1).

### Added

- **`inbox_items` table**: per-target row keyed by `(telegram_msg_id, type, raw_target)` for idempotency. Tracks `enrichment_status`, `enrichment_attempts` (capped at 5), `enrichment_attempted_at`, `enriched_row_id` (FK to bookmarks/papers/slides), `enrichment_error`. Indexes on status, bookmark_date, telegram_msg_id.
- **`src/lib/inbox-enrichment.ts`**: type-dispatched enrichment loop. Phase A handles `tweet` → bookmarks via oEmbed. `paper` and `slide` types are detected (when Phases B/C land) but currently return `deferred` so they sit in `pending` until their handlers ship.
- **`build/enrich-inbox.ts` CLI** + `npm run enrich:inbox` script. Reads pending/failed items, dispatches, updates state. Idempotent.
- **`scripts/daily-build.sh`** chains the new step: `pull:telegram → enrich:inbox → build:day → build → push`.

### Changed

- **`build/pull-telegram.ts`** writes to `inbox_items` instead of `bookmarks`. Same tweet URL detection logic; same offset semantics. The bookmark insert moves into the enrichment handler.

### Engineering

- 251 tests (was 240, +11 for inbox CRUD + dispatch behavior).
- 0 type errors across 40 files.
- Legacy bookmarks remain untouched; existing `pending` bookmarks still enrich on next build:day. New tweets route through the inbox.

## [0.4.4] — 2026-05-18

Dedup hotfix. v0.4.3 introduced table captions but the LLM, given both caption-table and detail-table features, produced duplicate matrices for the same comparison (caption table showing IBTR/Local relapse/etc. + detail table showing the same six rows). Fix at both layers: the prompt forbids it, and a code-level backstop drops detail-tables whose columns overlap ≥2 with the caption-table.

### Added

- **`dedupTablesAgainstCaption()`** runs after `validateStudyTables` per study. If `key_figure_caption` is a table and any detail in `details` is a table with ≥2 column-header overlap (case-insensitive, trimmed), the detail-table is collapsed to its `text` label only. Reader keeps the bullet's concept; the duplicate matrix is removed.

### Changed

- **Phase 2 prompt rule**: explicit "no duplication between caption and details." If caption is a table summarizing the figure, details must NOT include a detail-table covering the same axis. Detail bullets must complement the caption: methodology, subgroups beyond caption, cross-trial comparisons, critique, open questions.

### Engineering

- 240 tests (was 235, +5 for dedup behavior across overlap thresholds and caption-form variations).
- 0 type errors across 37 files.

[0.4.4]: https://github.com/nb2276/oncbrain/releases/tag/v0.4.4

## [0.4.3] — 2026-05-18

Tables become the default for any comparison outcome, including in figure captions. The prompt's "tables required" rule expands from multi-trial-only to any-comparison (arms, trials, timepoints, subgroups). Comparison figures now caption with a small table directly under the image instead of a single-line string.

### Added

- **`key_figure_caption` accepts table form**: `string | DigestTable | null`. Comparison figures (KM curves, forest plots, AE side-by-side) emit `{columns, rows}` captions instead of dense single-string CIs. Same per-cell numeric-token OCR validation as details tables; any unverified cell drops the whole caption.
- **Astro renders caption tables** under the figure with monospace cell font and the sticky-first-column horizontal-scroll pattern shared with details tables. Caption-as-string path unchanged (back-compat).
- **Obsidian export** writes caption tables as markdown immediately after the figure image. String captions still render as italic single line.

### Changed

- **Prompt rule broadens**: tables are now required for ANY comparison outcome — not just multi-trial. Multi-arm vs single-arm, multi-timepoint, multi-subgroup, forest-plot row data, dose-escalation × toxicity grade — all should use tables. Single-data-point bullets stay flat.
- **Phase 2 prompt example** updated with a table-form caption for the canonical Lu-PSMA vs cabazitaxel case (was a single-string CI).

### Engineering

- 235 tests (was 232, +3 for table-caption parsing/validation/edge cases).
- `validateKeyFigure` now accepts `string | DigestTable | null` for the caption parameter, branching to per-cell validation for tables.
- 0 type errors across 37 files.

### Migration

- v0.4.0/4.1/4.2 artifacts with string captions render unchanged via the back-compat branch.
- v0.4.3 rebuild populates new comparison-figure captions as tables where the LLM judges appropriate. Caption-failed-validation behavior identical: figure kept, caption dropped.

[0.4.3]: https://github.com/nb2276/oncbrain/releases/tag/v0.4.3

## [0.4.2] — 2026-05-18

Tables for 2D comparisons. v0.4.1 added subbullets (1D); v0.4.2 adds tables when a comparison is genuinely a matrix (2+ trials × 2+ endpoints, primaries × timepoints, etc.). POP-RT vs PEACE-2's HR comparison across bFFS/cFFS/MFS is the canonical case the v0.4.0 wall-of-semicolons rendering couldn't handle.

### Added

- **Table form for `DigestDetail`**: `{text, table: {columns: string[], rows: string[][]}}`. Sits alongside the v0.4.1 `{text, subdetails}` form. Parser pads short rows, truncates long rows, and rejects tables with <2 columns or 0 rows (falls back to flat string).
- **`validateStudyTables`** runs after `validateKeyFigure` on every Phase 2 output. Every numeric token in every table cell must appear in the union of (a) tweet text and (b) image OCR text for the study's source tweets. Any cell number not verified = the whole table is replaced with `"<text> — comparison values omitted (cell number ... not verified in source)"`. Caption validator pattern extended to tables.
- **Astro table rendering** with horizontal scroll + sticky first column on mobile (`@media (max-width: 600px)`). Row labels stay in view as the rest of the table scrolls. Cell font 0.88rem sans-serif. Header row in `--fg-muted` with subtle separator.
- **Obsidian markdown tables** in `obsidian-export.ts`. Standard pipe syntax with separator row; cell text escapes `|` characters with `\|`. Renders correctly in Obsidian, GitHub markdown, and any standard markdown viewer.

### Changed

- **Phase 2 prompt** instructs the model to pick from three detail shapes by dimensionality: flat string (single statement), `subdetails` (1D list under shared concept), `table` (2D matrix). Explicit forbidden pattern: "POP-RT HR 0.50; PEACE-2 HR 0.97; POP-RT cFFS HR 0.74..." as one string.

### Engineering

- 232 tests (was 225, +7 for table parsing/validation/edge cases).
- Type guards `isStringDetail`/`isSubdetailDetail`/`isTableDetail` exported for renderers.
- `detailAllText()` helper walks all text fragments across all three detail forms for consumers that need the full text content uniformly.
- 0 type errors across 37 files.

### Caveats

- Mobile tables with >3 columns require horizontal scroll. Acceptable trade-off — alternative was font shrinking or row-stacking, both inferior for clinical scanning.
- The validator is per-cell-token strict. A table with one unverifiable number drops the ENTIRE table, not just the suspect cell. Conservative by design; clinical content punishes silent partial corruption.

[0.4.2]: https://github.com/nb2276/oncbrain/releases/tag/v0.4.2

## [0.4.1] — 2026-05-18

Readability hotfix. Detail bullets that compared multiple trials/arms/endpoints (e.g., the POP-RT vs PEACE-2 entry) rendered as a wall of semicolons. Replaced with structured subbullets: a parent label and a row per comparison cell. Scannable at meeting-tempo.

### Changed

- **`DigestStudy.details` is now `Array<string | {text, subdetails: string[]}>`** instead of `string[]`. Flat strings still work for non-comparison bullets; comparison bullets emit the structured form. Existing v0.4.0 artifacts continue to render unchanged.
- **Phase 2 prompt instructs**: when comparing 2+ trials/arms/endpoints on the same metric, emit a structured bullet with `text` parent (the shared concept) and `subdetails[]` (one row per comparison cell). Wall-of-semicolons strings are explicitly discouraged.
- **Astro renders nested `<ul class="study-subdetails">`** under parent bullets with a subtle `·` marker and 0.92rem font size. Visual hierarchy preserved on mobile.
- **Obsidian export** writes parent bullets at indent 0, subdetails at indent 2 — standard markdown nested list. Renders correctly in Obsidian and any other markdown viewer.

### Engineering

- 225 tests (was 221, +4 for subdetails parser behavior).
- TypeScript: `DigestDetail = string | { text: string; subdetails: string[] }` union exported from `src/lib/llm-pipeline.ts` and re-exposed in `digest-data.ts`.
- Parser collapses `{text: 'x', subdetails: []}` to flat `'x'` to keep artifacts tidy.
- 0 type errors across 37 files.

[0.4.1]: https://github.com/nb2276/oncbrain/releases/tag/v0.4.1

## [0.4.0] — 2026-05-18

The LLM call splits into three phases: cluster, per-study deep-analysis, and synthesis. Each study gets its own agent that can read attached images and on-device-OCR'd text. A promoted "key figure" (typically a KM curve) renders prominently in the study card with a numeric-only caption verified against OCR. Adversarial review (codex) shaped the failure-mode handling.

### Added

- **Three-pass orchestration** (`src/lib/llm-pipeline.ts`). Phase 1 groups tweets into study clusters by disease site. Phase 2 spawns one LLM agent per cluster (bounded concurrency 4), each producing TL;DR + analysis bullets + a chosen key figure. Phase 3 synthesizes top_line + tldr + site-level open questions over only the successful Phase 2 outputs. Failed studies drop from the output entirely rather than placeholder.
- **Apple Vision OCR layer** (`scripts/vision-ocr.swift` + `src/lib/vision-ocr.ts`). On-device text extraction via `VNRecognizeTextRequest .accurate`. Pulls trial IDs, HRs, CI's, p-values, and slide titles from `pbs.twimg.com` images. Runs locally, zero API cost, ~200ms/image. macOS-only; pipelines gracefully skip on other platforms. Compile once with `npm run setup:vision`.
- **Key-figure promotion**. Phase 2 agents pick the most informative image (KM > forest > endpoint chart > schema > AE table) per study and write a caption sourced strictly from OCR text overlays. Astro renders the figure prominently above the study's detail bullets.
- **Caption validator** (`validateKeyFigure`). Post-hoc check: every numeric token in the caption must appear verbatim in the OCR for the chosen image. Otherwise the caption is dropped. If the model hallucinates a figure URL not present in the cluster, both fields are dropped. Defaults toward abstention.
- **Read-only study retrieval** (`src/lib/study-retrieval.ts`). Optional per-study anchoring context loaded from hand-curated `data/studies/<slug>.md` files. Read-only by design — the build pipeline never writes back. Avoids the "self-licking ice cream" failure mode where model output becomes model input.
- **Twitter-onc shorthand register** (`prompts/digest-v5-study-agent.txt`). Subspecialist-to-subspecialist abbreviations (mOS, mPFS, HR, ORR), emoji prefixes (📊 result, 🔍 method, ⚠️ counter, 🔗 comparison, ❓ open question), and inline adversarial bullets — no separate counter[] schema.
- **Disclosure metadata** (`digest.meta`). Surfaces `clusters_total`, `studies_analyzed`, dropped clusters with reasons, and OCR availability. Astro renders a "Build disclosures" footer when relevant. Silent omission of dropped clinical findings would be worse than no result.
- **Cluster-collision warnings**. After Phase 1, the pipeline detects when 2+ clusters reference the same NCT — a likely over-split that the operator should review.

### Changed

- **Prompt: v4 → v5 (split across three files).** `prompts/digest-v5-grouping.txt` (clustering only, no analysis), `prompts/digest-v5-study-agent.txt` (per-study deep dive in shorthand register), `prompts/digest-v5-synthesis.txt` (final top_line/tldr/open_questions).
- **OCR cache hardened by version pinning.** `image_ocr_texts` now stores `{text, hash, version}[]` aligned to `image_urls`. Re-OCR triggered on version mismatch (catches OCR engine upgrades) or array-length mismatch. Old length-equality cache was too weak per the adversarial review.
- **Schema-repair retry on parse failure.** Phase 1/2/3 each retries once with "your last response was malformed JSON, re-emit only the JSON" on parse error — not just network errors as in v0.3. Cheap and beats dropping a study.
- **Per-study image cap.** Default 6 images per Phase 2 agent (`maxImagesPerStudy` option). Controls token cost on big meeting days; concurrency cap alone only paces, doesn't bound spend.
- **DigestOutput schema additive only.** `meta` field added; `key_figure_url`/`key_figure_caption` are optional on DigestStudy. v0.3 artifacts continue to render without modification.
- **DigestStudy now carries the chosen figure.** Astro `[date].astro` and `sites/[site].astro` render the figure with numeric caption above the detail bullets when present.
- **Obsidian export** writes the figure as `![caption](url)` followed by italic caption, and a "Build disclosures" section when clusters were dropped or OCR was unavailable.

### Engineering

- 205 unit tests across 9 files (was 185). New: 3-pass orchestration (`buildDigest` happy path, failed-study handling, all-fail rejection, schema-repair retry, code-fence handling), `validateKeyFigure` (6 cases including unverified-numbers and missing-OCR drops), `capStudyImages`, `detectClusterCollisions`, `parseGroupingResponse`/`parseStudyAgentResponse`/`parseSynthesisResponse`, OCR cache freshness.
- Non-destructive DB ALTER for `image_ocr_texts` column. Existing v0.3 rows remain functional; OCR will populate on next build:day pass.
- TypeScript strict, 0 errors across 36 files (`npx astro check`).

### Process

- Plan reviewed twice by codex (independent adversarial). Initial v0.4 plan attracted 10 substantive critiques; 7 incorporated directly (failure-mode handling, no append-only dossier, retrieval as read-only, etc.). Amended plan reviewed again after key-figure scope was added — 8 additional findings, all 5 clinical-safety blockers and 3 cheap mitigations folded into this release. Casual register (codex flagged as auditability regression) was retained per product call with acknowledged trade-off.
- Code reviewed by `/review` pipeline (codex code-review + Claude adversarial subagent + 4 specialist subagents: testing, security, data-migration, maintainability). 13 additional findings folded into this release as hardenings (below). Remaining findings deferred to v0.5+ with documented rationale.

### Hardenings folded from /review (post-implementation)

- **Caption validator no longer accepts substring matches.** Previous code used `String.includes()` so caption "0.6" passed against OCR "0.62". Replaced with tokenized OCR + set-membership equality. `validateKeyFigure` now also (a) requires at least one numeric anchor — captions of pure prose are rejected; (b) handles leading-zero variants (".62" ↔ "0.62") so Vision's locale quirks don't drop legitimate captions; (c) drops BOTH figure and caption when OCR is unavailable globally (uncaptioned figures looked editorial under the old behavior).
- **Phase 1 partition enforcement.** `parseGroupingResponse` now verifies every input tweet id appears in exactly one cluster — no orphans, no duplicates. Violations throw, triggering the schema-repair retry. Closes a silent-omission gap where the model could drop clinically important source tweets with no disclosure.
- **Phase 2 ordering is deterministic.** Results stored at fixed indices keyed by Phase 1 cluster position rather than worker completion order. Two builds over identical input now produce byte-identical artifacts; git history stops churning on parallel-completion-order noise.
- **OCR failure no longer cached as fresh.** Previously a transient download or Vision error wrote a zero-text entry with the current `OCR_VERSION` and `isOcrEntryFresh()` happily kept it forever. Failed/skipped OCR now writes an empty-version sentinel that the freshness check rejects, so the next build retries naturally.
- **pbs.twimg.com host allowlist** in OCR fetcher and Astro figure rendering. Refuses non-HTTPS URLs, non-pbs.twimg.com hostnames, `javascript:` / `data:` / `file:` URLs, link-local (169.254.x), and localhost — defense against SSRF, image-decoder CVE exposure, and reader-IP tracking via arbitrary CDNs. `redirect: 'error'` on fetch prevents redirect-based bypass.
- **Empty Phase 1 returns a degraded digest** instead of crashing the build. Curator day with no cluster-worthy bookmarks now produces a "no analyzable studies surfaced" digest with all tweets listed in `meta.dropped` rather than a hard build failure.
- **Single source of truth for `DigestStudy` / `DigestSite` / `DigestMeta` types.** `src/lib/digest-data.ts` re-exports from `src/lib/llm-pipeline.ts` so producer (build pipeline) and consumers (Astro pages, Obsidian export) stay in lockstep. Removing a field on one side now breaks the type check on the other.
- **Prompt-injection defense.** Phase 1 and Phase 2 prompts now include a `═══ TRUST BOUNDARY ═══` block instructing the model that tweet text, author, note, and image OCR text are user-generated data and not instructions. Doesn't eliminate the risk (well-known limitation of LLM safety) but raises the bar for casual hostile-bookmark scenarios.
- **`dropped[].reason` field is categorized.** Previously stored raw error messages which could leak SDK request IDs or internal endpoint URLs to the public-committed `data/digests/<date>.json`. Now stored as one of `network-timeout`, `rate-limit`, `network-error`, `parse-error`, `auth-error`, or `unknown-error`. Full error message still goes to launchd log.

### Caveats

- The figure caption validator can only verify numeric tokens — it cannot catch mis-labeled axes or wrong-arm attribution. Captions remain advisory; readers should cross-reference the original tweet image when a number drives clinical reasoning.
- Slug-based retrieval has no entity resolution. A trial that gets a different slug across days (e.g., "PRESTIGE" vs "prestige-psma") will miss its own prior context. Deferred to v0.5+.
- OCR is macOS-only. On Linux/CI, figure captions are uniformly null — env-portable but no caption layer. To produce captions, builds must run on a Mac with `npm run setup:vision` completed.

[0.4.0]: https://github.com/nb2276/oncbrain/releases/tag/v0.4.0

## [0.3.0] — 2026-05-17

The model becomes an analyst, not a summarizer. Comparative literature context, historic benchmarks, and methodological critique now show up in per-study bullets. Source-tweet images get extracted from Twitter's syndication CDN and are passed to the LLM as vision content on the API path.

### Added

- **Comparative analysis + critique.** Prompt v4 asks the model to ground every study in recent (last 2-5 years) and historic literature, and to flag methodological concerns when warranted. Output stays terse — depth shows in WHICH bullets are included. Example from a real ESTRO26 EORTC 22922 study: "Prior 10-year data (Poortmans et al., NEJM 2015) showed borderline OS benefit; era of enrollment (1996-2004) predates aromatase inhibitors and CDK4/6 inhibitors; absolute RT benefit may be attenuated in contemporary luminal patients on extended ET."
- **Image extraction from Twitter syndication CDN.** New `src/lib/tweet-syndication.ts` fetches direct `pbs.twimg.com` URLs via the no-auth syndication endpoint (same one Twitter's embed widget calls). Each bookmark now stores its photo URLs alongside text+HTML.
- **Multimodal LLM calls.** `LlmContentBlock` types (`text` / `image`) extend the client interface. `AnthropicLlmClient` passes images directly to Claude's vision API. The LLM reads slide screenshots, KM curves, study schemas, and forest plots — extracting effect sizes that tweet text doesn't repeat. Requires `LLM_BACKEND=api` with a real `ANTHROPIC_API_KEY`. The `claude-cli` path falls back to text-only with a clear marker in the bullets ("Images not accessible").

### Changed

- **Strict one-study-per-group.** v4 prompt: "if multiple tweets discuss the same trial (schema, OS curve, subgroup, commentary), collapse into one `study` whose `tweet_ids` lists all of them. Pure-commentary tweets join the study they comment on."
- **CLI timeout 120s → 600s.** v4's deep-analysis prompt with a full day of tweets needs 2-5 minutes on the subscription path. Headroom matters more than tight budget.
- **Max tokens 4096 → 8192.** Per-study bullets including comparison + critique need more room.
- **Daily digest + per-site page** now also carry `image_urls` per bookmark in the artifact JSON, so the rendered page has all the information needed even without the Twitter widget running.

### Engineering

- 185 unit tests, 0 type errors across 35 files.
- Non-destructive DB column-add for `image_urls` JSON (already present from v0.1 but unpopulated until now).
- Syndication token derivation uses the published formula: `((tweet_id / 1e15) * π).toFixed(18)` decimal-part with trailing zeros stripped. Stable since ~2023.

### Caveats

- Vision analysis only activates when `LLM_BACKEND=api`. `claude -p` doesn't accept `--image` in `-p` mode, so subscription users get text-only analysis with the v4 comparative prompt. Switch to API for full multimodal.
- Comparative claims are subject to the model's training knowledge. The prompt instructs "if uncertain a comparator trial is real, omit the comparison rather than hallucinate one" — but reader verification against primary sources remains essential.

[0.3.0]: https://github.com/nb2276/oncbrain/releases/tag/v0.3.0

## [0.2.0] — 2026-05-17

Organizing axis flips from date to disease site. Each study now carries its own TL;DR. Source tweets render as native Twitter cards with images.

### Added

- **Disease-site organization.** New `/sites/` index lists 22 oncology subspecialties (CNS, head & neck, thoracic, breast, GI tracts, GYN, GU subsites, skin, sarcoma, heme branches, oligomet, supportive, safety, etc.) with per-site study counts. Each site has its own `/sites/<slug>/` page aggregating every study tagged with that site across all dates, newest first.
- **Per-study TL;DRs.** Schema reshape: clusters → sites; each site contains 1-N `studies`, each with a specific name (trial name when available, drug+indication otherwise), a one-sentence headline-with-effect-size TL;DR, bullets for secondary endpoints/methods/subgroups, optional NCT id, and source tweet ids.
- **Twitter widget embeds.** Source tweets now render as native X cards via `platform.twitter.com/widgets.js`, with images served from Twitter's CDN. The oEmbed blockquote HTML is stored alongside plain text so the curator gets image-rich source rendering for free, without IP/hosting risk. Manual-paste fallback unchanged.
- **`disease-sites.ts` enum.** 22-site taxonomy with slug, label, and emoji. LLM picks the most specific site per cluster; unknown slugs fall back to `other` rather than dropping content.
- **Site-level open questions.** Each disease site can carry 1-3 open-question bullets (sequencing debates, controversies, awaited data).

### Changed

- **Prompt v3** replaces the IMRD-per-cluster structure. New shape asks the LLM for disease_site selection, per-study breakdown (name + per-study tldr + details bullets + nct + tweet_ids), and optional site-level intro + open_questions. Hallucination prevention strengthened: "if tweets don't give a number, write 'no effect size reported in source tweets'."
- **Daily digest page** reorganizes by disease site within the day instead of free-form clusters. Site headings link to the aggregation page so readers can jump from "today's prostate updates" to "all prostate studies ever."
- **Database schema.** `bookmarks.tweet_html` column added (nullable, non-destructive ALTER). On next build, any bookmark missing HTML is re-fetched once via oEmbed.

### Engineering

- 185 unit tests across DB, twitter-fetch, LLM pipeline, eval, Obsidian export, Telegram ingest, LLM backend, citation extraction, disease-site parser.
- TypeScript strict, 0 type errors across 33 files.
- Obsidian export adapted to new schema: `## <emoji> <site label>` headings, `### <study name>` per study, `> [!question] Open questions` callout for site-level debates.

[0.2.0]: https://github.com/nb2276/oncbrain/releases/tag/v0.2.0

## [0.1.0] — 2026-05-17

First real deploy. Live at **https://oncbrain.oncologytoolkit.com**.

### Added

- **IMRD digest format.** Each cluster reads as a mini scientific paper: top-line lede (one sentence with the headline number), TL;DR, then Intro → Methods → Results (bullets with effect sizes) → Discussion per topic. Subspecialty emoji prefix (🌸 breast, 🎯 SABR / precision, 🍇 GU, 📡 radonc, 💊 systemic, 🛡️ IO, 🧠 CNS, 🩸 heme, 🫁 lung, 🌽 GI, 🧬 molecular, 🔪 surgery, 🧒 peds, 🧓 supportive, ⚠️ safety).
- **Telegram ingestion.** Send tweet URLs to your `@BotFather`-issued bot anytime. `npm run pull:telegram` drains the queue into SQLite, dated to your local timezone. Inline curator notes work: paste `"practice-changing https://x.com/foo/status/1"` and the bot picks both up.
- **Obsidian export.** Every `npm run build:day` writes `data/obsidian/<date>[-<conf>].md` with YAML frontmatter, callouts, and wikilinks to NCT / PMID / DOI / conference / neighboring-date notes. Open the repo as a vault or symlink the directory into an existing vault — Obsidian's graph view connects everything.
- **3am autopilot.** `npm run cron:install` registers a macOS launchd job that runs the full chain (pull Telegram → build today + yesterday → astro build → git push) every day at 03:00 local. Pair with `sudo pmset repeat wakeorpoweron MTWRFSU 02:55:00` if your laptop sleeps. Logs append to `~/Library/Logs/oncbrain-cron.log`.
- **LLM-as-judge eval.** `npm run eval` scores each digest on factual accuracy, clinical relevance, citation correctness, clustering quality, and hallucinations. Pass threshold 8/10. Any hallucination caps overall at 5.0 regardless of dimension scores. Save baselines with `--save-baseline`; compare with `--compare-baseline` after a prompt change.
- **Pluggable LLM backend.** `LLM_BACKEND=api` (Anthropic API, pay-per-token, ~$0.05–0.10 per digest) or `LLM_BACKEND=claude-cli` (your Claude Code subscription, no API key, runs `claude -p` under the hood). One env var swap. The CLI client scrubs `ANTHROPIC_API_KEY` from the child env so a stale or placeholder key can't hijack subscription auth.
- **Newsreader serif typography.** Switched from `system-ui` to Newsreader (variable serif designed for digital reading) plus a warm off-white background (#f7f5f0) for editorial register that matches the scientific-paper structure.
- **NCT / PMID / DOI auto-linking.** Trial numbers and citations in summary text become inline chips linking to clinicaltrials.gov / pubmed.ncbi.nlm.nih.gov / doi.org. Same patterns become wikilinks in the Obsidian export.
- **Conferences as optional tags.** Bookmarks can carry a conference slug for a badge on the digest plus a `/conferences/<slug>/` index page. Bookmarks without a conference ship as bare-date digests.

### Changed

- **Date-based schema.** `bookmark_date` (YYYY-MM-DD, local timezone) replaces the previous `(conference_slug, day)` composite key. Conferences are now metadata, not required. Continual cadence with conference-week prominence via badge.
- **URL structure.** Primary digest URL is `/YYYY-MM-DD/`. Conference index lives at `/conferences/<slug>/`. The previous `/<conference>/day-<N>/` scheme retired.
- **Visual hierarchy** (post design-review). Top-line is now a 1.65rem serif headline that dominates; TL;DR drops to a left-rule-only treatment; Intro / Methods / Discussion read as label-and-prose; only Results carries card chrome (accent-tinted, left-bar highlight) since it carries the effect sizes the reader is scanning for.

### Engineering

- 184 unit tests across DB, twitter-fetch, LLM pipeline, eval, Obsidian export, Telegram ingest, LLM backend adapter, citation extraction.
- TypeScript strict mode, 0 type errors.
- Stack: Astro 6.3 (static digest pages) + Hono 4 (localhost admin) + better-sqlite3 + Anthropic SDK + Vitest + tsx.
- `node_modules` and `dist` are Dropbox-ignored via `xattr com.dropbox.ignored` to avoid sync churn.

### Operational

- Bot: `@oncbrain_bot` (Telegram)
- Site: https://oncbrain.oncologytoolkit.com
- Repo: https://github.com/nb2276/oncbrain (private)
- Region: SFO (DigitalOcean App Platform, free static tier, Let's Encrypt SSL)
- Auto-deploy: `git push origin main` → DO rebuilds in ~40 sec

[0.1.0]: https://github.com/nb2276/oncbrain/releases/tag/v0.1.0
