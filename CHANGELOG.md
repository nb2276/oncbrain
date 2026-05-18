# Changelog

All notable changes to oncbrain are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
