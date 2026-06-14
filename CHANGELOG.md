# Changelog

All notable changes to oncbrain are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.17.3] - 2026-06-14

### Added

- **Double-click launchers for the studio TUI.** `studio.command` (opens the
  full studio TUI) and `review.command` (jumps straight into the curator
  review/approval queue for review-discussed trials) at the repo root — runnable
  from Finder, no terminal needed. Both local-only dev tooling.
- **Dedicated "Review resolved trials" option in the studio TUI.** The curator
  approve/reject step is now its own top-level menu entry (the recurring
  action), separate from "Resolve review trials" (the PubMed search step). The
  approve sub-option was removed from the resolve submenu to avoid two paths to
  the same action.

## [0.17.2] - 2026-06-14

### Fixed

- **`resolve:review-trials` CLI loads `.env`.** The standalone resolver CLI was
  the only LLM/NCBI build script missing `import 'dotenv/config'`, so run on its
  own (or via the new studio menu) it never loaded `LLM_BACKEND` /
  `ANTHROPIC_API_KEY` / `NCBI_API_KEY` — every rerank failed auth ("Could not
  resolve authentication method") and the run produced only transient errors.
  The v0.17 transient-freeze handling did the right thing (wrote nothing rather
  than poisoning the manifest), so no bad data resulted; the CLI just couldn't
  do useful work. Adding the import (matching every sibling script) fixes it.
  Local-only: the resolve CLI is never part of the deployed static build.

## [0.17.1] - 2026-06-14

Completes the two v0.17 deferred-scope (P3) follow-ups.

### Added

- **Cross-date review-trial surfacing.** A review can now surface a discussed
  trial as a card on its OWN date even when that trial's primary paper is already
  a source on an earlier date. `papers.pmid` is UNIQUE (one row = one date), so
  the row can't be duplicated; instead the manifest is the many-to-many
  review-date↔paper link, and the builder injects a date's approved-resolution
  papers into that date's build inputs (`crossDateResolvedPapers`), de-duped
  against the date's own sources. Such a card carries the "Surfaced from a
  review's discussed trials" provenance pill even though the underlying paper's
  stored `fetched_via` reflects its original date. Replaces the prior
  loud-skip-with-no-card behavior; nothing changes for existing dates (the
  injection only fires for curator-approved cross-date resolutions).
- **Studio entry for review-trial resolution.** `npm run studio` gains a
  "Resolve review trials" menu (resolve a date / review + approve the queue /
  list the manifest), calling the `resolve:review-trials` CLI's run-functions
  directly. The CLI's `main()` is now script-guarded so it can be imported
  without executing.

## [0.17.0] - 2026-06-14

### Added

- **Trials a review names can now be surfaced as their own study cards, curator-gated.**
  When a trade-press review names trials it doesn't carry as primary sources
  (the v0.16 "Trials discussed" list: STOMP, ORIOLE, RADIOSA, ARTO, ...), a new
  resolver searches PubMed for each acronym (esearch/esummary, then an
  advisory rerank-LLM that must pick a candidate from the returned set or NONE),
  and records its pick to a `review_trial_resolutions` manifest as `pending`.
  Nothing publishes automatically: the curator reviews the queue
  (`npm run resolve:review-trials -- --review`), and only `approved` PMIDs are
  ingested into the next build as ordinary same-date paper sources, so the
  existing 3-phase pipeline clusters them into normal study cards. A resolved
  card shows a "Surfaced from a review's discussed trials" provenance pill, and
  the review's discussed-trial acronyms link to the resolved card by PMID join.
  Many trials (ARTO, RADIOSA, ...) are not on ClinicalTrials.gov, so resolution
  is by literature search, not NCT lookup. The manifest freezes each
  `(review, acronym)` resolution (UNIQUE), preserves curator decisions across
  rebuilds, and re-opens only un-decided rows on a resolver-version bump (scoped
  to the date being resolved). PubMed calls share an rps throttle. A
  precision-first eval (`npm run eval:resolver`) gates the rerank: zero
  collision false-positives required, recall above threshold. The curator gate
  means an unapproved or wrongly-matched trial never reaches the published site.

## [0.16.0] - 2026-06-13

### Added

- **Trade-press topic reviews now render as reviews, not bogus single-study cards.**
  A trade-press round-up that surveys multiple trials (e.g. a UroToday
  conference-highlights piece on the oligometastatic-prostate SBRT landscape) is
  classified `content_type: review` at the grouping phase and rendered as a press
  round-up: a "🗞️ Reported via {outlet}" provenance line, a plain-text "Trials
  discussed" list of the acronyms it names (STOMP, ORIOLE, RADIOSA, ARTO,
  WOLVERINE, ...), and NO standard-of-care verdict, because a multi-trial review
  has no single SOC implication to triage. Reviews carry a 🗞️ marker in the
  desktop triage rail in place of a verdict emoji. Single-study trade-press
  write-ups stay study reports and keep their verdict, and also gain the
  provenance line (shown only when the sources are trade-press-only, so a mixed
  cluster is not misattributed). Trade-press trial names are lifted verbatim and
  rendered as plain text, never linked (no NCT is inferred for a bare acronym).
  Classification is conservative: an unrecognized type stays a study report, so
  the existing committed digest corpus is byte-unchanged, and the verdict is
  stripped after curator overrides so a review can never ship one.

## [0.15.3] - 2026-06-13

### Fixed

- **Trade-press papers link to the article, not a broken PMID.** Trade-press papers
  (UroToday, ASCO Post, OncLive) have no PMID/DOI/PMC, yet StudyCard rendered an
  unconditional `PMID null →` link (pointing at `pubmed.ncbi.nlm.nih.gov/null/`) and
  offered no path to the actual article. The PMID link is now conditional, and the
  card/Obsidian export/JSON API surface the article via `source_url`. `source_url`
  is threaded through the published artifact + API, sanitized by `toPublicArticleUrl`
  (http(s)-only, query+fragment dropped) so no tracking tags / session tokens leak
  (codex P1) and no `javascript:` scheme reaches a rendered href (adversarial F1).
  The doi.org dedup regex is anchored and handles `dx.doi.org` (adversarial F2 /
  codex P3); Obsidian percent-encodes `)` in link targets (adversarial F3). Affected
  all 15 papers without a PMID, not just trade press. Existing committed digests are
  backfilled with `source_url` via `build/backfill-source-url.ts` (no LLM rebuild).

## [0.15.2] - 2026-06-13

### Changed

- **PWA now prompts to update instead of silently auto-reloading.** The service
  worker previously called `skipWaiting()` on install, so a new deploy took over
  on the next navigation but open clients never refreshed (no `controllerchange`
  handler) — a reader could sit on a stale version indefinitely. The SW now WAITS;
  when a new version is ready the page shows a non-blocking "New version /
  Refresh" toast (bottom-center, dismissible, safe-area-aware for iOS standalone),
  and only posts `SKIP_WAITING` + reloads when the reader taps. No more
  mid-scroll interruption, and the update is never silently missed.
  (`src/pwa-sw.ts`, `src/layouts/Base.astro`, `astro.config.ts` registerType
  `autoUpdate` → `prompt`.) To force an update before this ships: on iOS fully
  close + reopen the home-screen app (or remove + re-add); on desktop use
  DevTools → Application → Service Workers → Unregister, then reload.

## [0.15.1] - 2026-06-12

### Fixed

- **Related-trials retrieval conflated sibling `-deruxtecan` ADCs.** For an open
  question like "sequencing vs dato-DXd", the Phase 2 query generator searched the
  study's OWN drug (sacituzumab govitecan) instead of the named comparator, and
  the rerank then accepted trastuzumab deruxtecan (T-DXd) / SG trials as answers
  to a datopotamab deruxtecan (dato-DXd) question. Two prompt-precision fixes: the
  query generator now targets the question's named drug by its distinguishing name
  (`datopotamab`, never the shared `deruxtecan` / `DXd` / `ADC` stem that matches a
  different molecule), and the rerank now requires drug IDENTITY (not class),
  abstaining rather than pairing a sibling. Surfaced by the v0.15 quality eval;
  verified by rebuild (the dato-DXd query now retrieves a real Dato-DXd phase 3
  trial; mean eval 8.0 → 8.5, factual accuracy 8.0 → 9.0).

## [0.15.0] - 2026-06-12

### Added

- **Configurable specialty perspective (Phase 2 + Phase 3 lens).** A new
  `DIGEST_PERSPECTIVE` env var selects a subspecialty lens that biases the
  per-study analysis (and the cross-site synthesis) toward one reader's decision
  needs, without changing the output schema. The value names a profile resolved
  to `prompts/perspectives/<name>.md` and injected into the study-agent and
  synthesis prompts' new `{{PERSPECTIVE}}` slot. Shipped profiles: `radonc`
  (foregrounds the role and magnitude of radiotherapy, isolates RT's contribution
  from a systemic backbone, surfaces dose/fractionation/target volume and
  local-regional endpoints) and `medonc` (regimen, biomarker gating, sequencing).
  Unset / blank / unknown name = no bias, byte-identical to the prior
  one-size-fits-all default; the name is sanitized to a single safe path segment.
  The lens never licenses invented numbers — the VOICE no-fabrication rule
  outranks it, and a magnitude the lens wants but the source lacks is flagged as
  missing, not guessed. Add a lens by dropping a file in `prompts/perspectives/`
  (see that dir's README). Wired through `BuildOptions.perspectiveName`.
- **Figure OCR (Path A).** Numbers printed *inside* figures (KM-curve medians,
  forest-plot estimates, n-at-risk, image-rendered tables) are invisible to
  `pdftotext` and often sit on the last pages of an accepted manuscript, past the
  scanned-PDF OCR cap. For a text-layer PDF, enrichment now uses `pdfimages -list`
  to find the pages carrying a real figure (a large raster image) and OCRs just
  those with Apple Vision (`extractPdfFigureOcr` in `pdf-text.ts`). The result is
  stored in a new `papers.figure_ocr_md` column and fed to the Phase 2 study agent
  as labeled, lower-confidence source context, so it can *ground* a figure-locked
  magnitude instead of flagging it missing. Local-only and excluded from the
  published artifact, same IP boundary as `fulltext_excerpt_md`. Backfill the
  existing corpus with `npx tsx build/backfill-figure-ocr.ts`. Together with the
  radonc lens, this lets a day like RTOG-0848 surface the node-negative survival
  benefit (5-yr OS 28.6% → 48.1% with chemoRT) that the text-only pipeline could
  not report.

### Changed

- **Numeric validators now verify multi-token cell values, not just loose
  tokens.** The table (`validateStudyTables`) and figure-caption
  (`validateKeyFigure`) validators previously checked each number in a cell
  independently, so a fabricated confidence interval or range whose two bounds
  each happened to appear *somewhere* in source would pass. They now also verify
  CI/range groups (`0.48-0.79`, `(2.2, 4.0)`, `2 to 5`) as units: the two bounds
  must sit *adjacent* in the source's numeric-token stream. Adjacency (not the
  literal delimiter) is the signal, so a real interval the model rewrites with a
  dash where source spaced or comma-separated the bounds still verifies, while an
  interval glued from two unrelated source numbers is redacted. Cross-arm
  juxtaposition (`28.6 vs 48.1`) stays token-only — pairing two separately-sourced
  values is the table's job. Matters more now that figure OCR feeds number-dense
  forest-plot / KM data into tables.

## [0.14.10] - 2026-06-11

### Changed

- **Conference badge now covers paper/slide-only days.** `dominantConferenceForDate`
  previously keyed off tweet bookmarks only, so a conference day made entirely of
  papers/PDFs/slides got tagged rows (from v0.14.9 auto-detect) but no badge and
  no `/conferences/<slug>` page. It now unions bookmarks + papers + slides,
  keeping the unanimous-single-slug semantics (returns null when the day's tagged
  sources disagree; untagged sources are still ignored). Completes the v0.14.9
  conference auto-detect feature for non-tweet sources.

## [0.14.9] - 2026-06-11

### Added

- **Conference auto-detect on ingest.** Until now the bot ingest path
  (`pull:telegram → enrich:inbox`) never set a `conference_slug` — only the admin
  form did — so the conference badge (`dominantConferenceForDate`) and the
  `/conferences/<slug>` pages were dead for anything DM'd to the bot. A new
  `src/lib/conference-detect.ts` recognizes a major oncology meeting from a
  source's text/URLs across three precision tiers: a year-bearing meeting hashtag
  (`#ASCO26`, `#ESMO2025`, `#GU26`), a meeting-specific URL host (matched on the
  parsed hostname, spoof-proof like the trade-press allowlist), and meeting prose
  with a nearby year ("2026 ASCO Annual Meeting"). It covers ASCO, ESMO, ASTRO,
  AACR, ASH, SABCS, and the ASCO GU/GI symposia. All four enrichment paths
  (tweet, paper, PDF, slide) now stamp the detected slug and insert the
  conference row if absent — never overwriting a row the curator created with real
  dates. Tagging is best-effort and never fails enrichment. Years are taken
  verbatim (no identity-stripping), so distinct years stay distinct conferences.
  The day's conference badge (`dominantConferenceForDate`) keys off tweet
  bookmarks, so tagged tweets light it up immediately; paper/PDF/slide tags are
  stored for cross-source clustering and the conference filter (extending the
  badge query to those source types is a tracked follow-up in TODOS.md).

### Hardened

- **Linear URL-token trimming on ingest.** Capped the matched-URL length before
  the trailing-punctuation trim in both `conference-detect.ts` and
  `paper-url.ts` (`extractPaperUrls`). An unbounded run of trim characters mid
  token could otherwise make the `…+$` trim backtrack quadratically (a latent
  ReDoS). Bounded in practice by Telegram's 4096-char message cap; hardened so it
  stays linear regardless of input source (e.g. unbounded OCR/PDF text).

## [0.14.8] - 2026-06-11

### Added

- **iOS "Add to Home Screen" hint.** The PWA (manifest + offline precache) has
  shipped since v0.6, but iOS Safari has no `beforeinstallprompt`, so the
  iPhone-heavy audience had no way to discover they could install it. A small,
  dismissible, iOS-Safari-only banner now nudges "tap Share → Add to Home
  Screen" (hidden on every other platform, when already installed, and once
  dismissed).

## [0.14.7] - 2026-06-11

### Fixed

- **HEIC / image-as-document slides no longer fall through.** iOS Photos
  sometimes sends a slide photo as a HEIC document attachment rather than a
  compressed photo; the ingestion only recognized `photo[]` (slides) and PDFs
  (papers), so the image was silently dropped. A new `extractImageDocument`
  detects an image sent as a document (by MIME or extension: heic/heif/jpg/png/
  webp/gif/tiff/bmp) and routes it to the slide path. A document carries no
  dimensions, so width/height store null (the slide path already tolerates it).

## [0.14.6] - 2026-06-10

Bundles three independent improvements merged together (#39, #40, #41).

### Added

- **Independently selectable model per pipeline phase.** Each of the three build
  phases can now run a different model: `DIGEST_GROUPING_MODEL` (Phase 1),
  `DIGEST_STUDY_MODEL` (Phase 2, the deep per-study analysis), and
  `DIGEST_SYNTHESIS_MODEL` (Phase 3), each falling back to `DIGEST_MODEL` then the
  client default. The daily cron now runs Phase 2 on Opus.
- **Push distribution to a Telegram channel (T5).** After the daily build, a
  reader-facing announcement of each digest (top-line + verdict-emoji study list
  + a deep link that previews the OG card) is posted to a public Telegram channel
  via `notify:channel`. Dormant until `TELEGRAM_CHANNEL_ID` is set; email
  subscribe remains a later follow-on.

### Changed

- **Desktop two-column home.** The home was one narrow column stranded in empty
  side margin on wide screens; it now reads as a two-column editorial layout
  (hero + studies feed in a wide main column, conferences + tag activity + tag
  chips in a sticky right sidebar). Mobile stays a single stacked column.

## [0.14.5] - 2026-06-10

### Added

- **Preprint detection + "not peer-reviewed" badge + verdict cap (E5).** A study
  sourced from a preprint server (medRxiv, bioRxiv, Research Square — by DOI
  registrant prefix `10.1101`/`10.21203`, host, or source name) now carries a
  "PREPRINT · not peer-reviewed" badge, and its standard-of-care verdict is capped
  at `early-signal` (practice-changing / challenges-soc / confirmatory all
  downgrade), with the rationale rewritten so it can't argue past the cap. The cap
  is **deterministic at build** (not prompt-dependent) and re-asserts after curator
  overrides, so a not-yet-peer-reviewed result can never present as confident
  standard-of-care. The caveat also rides along in the RSS feed. Closes a
  clinical-safety gap opened when v0.8 made preprint ingestion first-class.

## [0.14.4] - 2026-06-10

### Changed

- **`/studies` filters in place.** The full study index no longer auto-redirects
  to the `/tags/<slug>/` landing when you pick a single filter — it narrows the
  feed in place and reflects the selection in the URL (`/studies/?tag=…`,
  shareable + restored on reload). The `/tags/` landing pages still exist as
  direct/RSS destinations (linked from each study's tag chips).
- **Verdict filter ordered by clinical importance** (practice-changing → … →
  unclear) instead of by study count, so the highest-signal verdicts read first.

### Added

- **Brighter filter feedback.** The selected filter option is now clearly
  highlighted (accent label + a left accent bar), and the matched (still-visible)
  study cards get a brighter accent edge while a filter is active.
- **Filter-aware "new" count.** The "N new overall" badge on the feed flips to
  "N new shown" as the filter narrows the list, and reverts when cleared.
- **Per-disease-site new counts.** Each disease-site nav chip shows a "·N" badge
  of how many of its studies are new since your last visit.

## [0.14.3] - 2026-06-10

### Added

- **Disease-site nav on `/studies`.** The disease-site chip row was extracted
  into a shared `SiteNav` component and added to the full study index, which the
  T3 home/browse split had left without that cross-corpus wayfinding axis. Home
  and `/studies` now render the same nav from one source.
- **In-app "Share image" button (T4 Option B).** The per-study share button now
  posts the study's card *as an image* where the platform supports it: a tap
  fetches a build-time 1200×630 PNG (trial name · site · date, the headline
  number, the colored verdict label) and shares `{files, title, url}` via the
  Web Share API (iOS-strong); anywhere that can't share files, it falls back to
  the existing link share. One card per study at `/og/study/<date>/<slug>.png`,
  synthesized text only (stays inside the publish boundary).
- **Google Analytics.** Added the gtag.js tag (property `G-PP2FRCMYS1`, shared
  with the related site oncologytoolkit.com), production-gated alongside the
  existing Cloudflare Web Analytics beacon.

## [0.14.2] - 2026-06-10

### Added

- **Social-preview cards (Open Graph / Twitter).** Every page now carries an
  `og:image` + `twitter:card` so a shared link renders a branded 1200×630
  preview instead of a bare URL (previously there were no preview tags at all).
  The cards are generated at build time (satori → SVG → resvg → PNG) and served
  from `/og/*.png`: a branded default, a per-digest card (the day's curated
  top-line + date), and a per-disease-site card. The card is synthesized **text
  only** (Newsreader serif on warm `#f7f5f0`: wordmark, date · conference, the
  headline, a study-count or verdict label, the curator handle), so it never
  embeds a figure or slide pixel and stays inside the publish boundary by
  construction (a structural test guards every `/og/` endpoint). Verdict colors
  were lifted into a shared `VERDICT_COLOR` token. Fonts: vendored static
  Newsreader instances (satori can't read the variable woff2 the site ships).

## [0.14.1] - 2026-06-10

### Changed

- **Home is a what's-new slice, not a 71-row scroll.** The home page now shows
  the latest 12 studies plus a "Browse all N studies →" link to a new
  **`/studies`** route that holds the full flat index and the filter rail (moved
  off home). The home is the returning reader's front door; the full filterable
  corpus lives one click away. A shared `RecentFeed.astro` renders the feed on
  both pages, so there is one row template. The "N new overall" count and the
  seen-set still cover the whole corpus even on the sliced home, so a study added
  below the slice still counts on the home total and gets its NEW pill on
  `/studies` (the home embeds the full id list; the seen-set logic separates the
  rendered rows from the corpus).

### Fixed

- **`/studies` inherits the home's filter + cache behaviors.** The single-tag
  filter → `/tags/<slug>/` canonical redirect now fires on `/studies` (it was
  keyed to home, which no longer hosts the rail), and `/studies` is classified as
  an archive route (NetworkFirst, not precache-forever, with the existing `?tag=`
  cache-key normalization) so an installed PWA does not serve a stale full index
  offline.

## [0.14.0] - 2026-06-10

### Added

- **Verdict triage at scan distance.** The SOC-implication verdict is now a
  peripheral signal, not just a pill you read after opening a card. The home
  feed leads a row with a 🚀 flag for practice-changing studies (the rarest,
  highest-signal verdict), and the study card's left border is colored for the
  three attention verdicts only (practice-changing, challenges-SOC,
  caveats-dominate), so a long page reads as a heat-map where the few that
  demand action pop. The other verdicts stay neutral; their pill still carries
  the full verdict. A design-review render showed the other five verdict emoji
  fail as bare feed glyphs (🔄/↔️/❔ read as UI controls; ⚠️ collides with the
  safety disease-site anchor), so only 🚀 leads a feed row. `--verdict-color`
  is defined once on `.study.verdict-*` and shared by the pill and the border.
- **"New since your last visit."** Each home-feed study added since the reader
  last visited gets a NEW text pill, with a "N new overall" total beside the
  Studies heading. Client-side only (no backend, no accounts): a localStorage
  set of seen study ids (`date#slug`), a sessionStorage baseline so the markers
  stay stable as you navigate in-session, an immediate monotonic write so a
  stale tab can never move the marker backward, and a first-visit that flags
  nothing. The seen-set is capped to at least the live feed size, so a study
  still in the feed is never dropped and re-flagged. Degrades to no markers if
  storage is blocked (Safari private mode).

## [0.13.2] - 2026-06-09

### Fixed

- **"Trials to watch" titles read as serif links, not heavy code chips.** Each
  trial title reused the citation-chip style (a monospace box meant for
  NCT/PMID/DOI identifiers), so a prose title rendered dense and out of register
  with the Newsreader serif body. Titles now read as plain serif accent links.

## [0.13.1] - 2026-06-09

### Fixed

- **"Trials to watch" now actually finds trials.** The per-study
  ClinicalTrials.gov queries were too specific, stacking trial-design and
  tumor-grade qualifiers ("WHO grade 2", "randomized", "dose escalation"), so
  ct.gov's keyword search (which requires every term to match) returned
  nothing on every digest. Two changes fix it: the query-generation prompt now
  keeps each term to the clinical core (condition plus intervention class), and
  the build retries any query that returns empty once with a broadened term
  (design, grade, and numeric qualifiers stripped) before giving up. The
  broadening keeps at least one specific clinical token, so it never falls back
  to an over-generic search that would swamp the ranker.
- **A study no longer lists its own trial** in its "Trials to watch" set.

## [0.13.0] - 2026-06-09

### Added

- **Trade-press article ingestion.** The Telegram bot now accepts news and
  coverage links from oncology trade outlets (ASCO Post, OncLive, UroToday,
  Targeted Oncology, Cancer Network, Healio, MedPage Today, OncoDaily, ASCO
  Daily News), not just journal pages and PubMed/DOI links. The article's
  title, summary, and body text are pulled from the page and filed as a
  source; trial NCT numbers in the body still cluster the coverage with the
  underlying study at build time. Registration-walled and JavaScript-rendered
  pages that carry no readable text are rejected with a note to forward the
  PDF, rather than saved as empty rows.
- **"Trials to watch" per study.** Each study can surface a short list of
  open, recruiting clinical trials tied to its open questions, pulled from the
  ClinicalTrials.gov v2 API and reranked to the most relevant five. Curators
  can pin, suppress, or override the set per study
  (`npm run override -- --related-trials-*`).
- **Unrecognized-source bot reply.** When a forwarded message carries a link
  the pipeline can't ingest, the bot replies with the source types it accepts
  instead of dropping the message silently. Conversational text and obvious
  non-source links (YouTube, shorteners) stay unanswered.
- **quality-eval skill.** A multi-persona review of a day's build
  (`npm run quality-eval`) that reads the digest as different subspecialist
  readers and reports where it falls short.

### Changed

- **Eval suite now scores the v0.13 query and trial-recommendation axes** and
  snapshots the JSON API output, so a regression in the public feed shape
  surfaces in CI.

### Fixed

- **Trade-press trust and robustness hardening.** Outlet matching uses exact
  hostname parsing so a look-alike host (`ascopost.com.example`) can't
  masquerade as a trusted outlet; article extraction is size-capped to bound
  CPU on malformed pages; the dedup key normalizes scheme, `www.`, trailing
  slash, and tracking query params so a re-sent link collapses to one row
  while distinct query-addressed articles stay separate.
- **Meta-tag values containing an apostrophe no longer truncate.** A
  double-quoted og:description or title with an inner apostrophe (`Patients'
  survival`) is now read in full.
- **Build-output tests made deterministic.** The PWA build test no longer
  rebuilds the site mid-suite, which had let parallel tests read a
  half-written `dist/` directory and report spurious failures.

## [0.11.1] - 2026-06-04

### Changed

- **Filter rail moved to the right gutter.** Studies stay centered;
  filter chips and namespace sections now sit in the right gutter on
  desktop and TriageRail (wide-mode jump-list) mirrors to the left.
  Reads more naturally as "the content, then how to narrow it."
- **Active-filter chips render below the checkboxes, not above.**
  Ticking a filter no longer pushes the namespace sections downward —
  the checkbox you just clicked stays at the same y-coordinate.

### Fixed

- **Daily 6am cron failed silently after the repo directory was
  renamed.** Added a callout in CLAUDE.md noting that the launchd
  plist bakes the absolute path; renaming the working directory
  without re-running `npm run cron:install` produces an `EX_CONFIG`
  exit and no digest publishes that morning. Updated the documented
  Dropbox path to the new `oncbrain/` location.

## [0.11.0] - 2026-05-31

### Added

- **Cross-page tag filter rail.** Every page that lists studies (home,
  `/sites/<site>/`, `/<date>/`, `/tags/<slug>/`) now hosts a checkbox
  filter on the left at ≥1200px (narrow body) and ≥1640px (wide
  body). Tick any combination of modality, intent, methodology,
  verdict, or meeting and the visible cards narrow client-side with
  strict AND semantics. Filter state syncs to the URL as repeated
  `?tag=<slug>` params so a reload or share-link preserves the view.
- **Auto-redirect to canonical landing pages.** On home (`/`) and on
  existing `/tags/<...>/` routes, when the active filter set matches
  a pre-built landing page (`/tags/radiation/`,
  `/tags/phase-3-rct+radiation/`, etc.), the rail redirects to that
  canonical URL via a full navigation. `/sites/` and `/<date>/`
  pages stay on the query-string form to preserve their site/date
  scope.
- **RSS subscribe button per filter combination.** When the active
  filter state matches a canonical `/tags/<...>/` landing, the
  active-chips header shows a 📡 RSS link to that landing's existing
  `feed.xml` endpoint. Turns the filter into a durable
  subscribe-once workflow: filter once, hit the RSS link, your
  feed reader carries the ongoing narrowed updates.
- **Mobile filter drawer.** Below the desktop breakpoint, the rail
  collapses behind a "Filters" trigger button rendered inline above
  the card list. Tapping the trigger slides up a bottom-sheet drawer
  containing the same checkbox tree. Full WAI-ARIA dialog pattern
  (`role="dialog"`, `aria-modal="true"`, `aria-haspopup="dialog"`,
  focus trap, Escape dismiss, tap-outside dismiss, body scroll lock).
  iOS-safe sizing via `100dvh` + `env(safe-area-inset-bottom)`.
- **Smart empty-state with "Drop X → N would show." suggestions.**
  When a filter combination yields zero matching studies AND there
  are unlocked filters active, a status card under the active-chips
  header lists up to two single-removal suggestions sorted by
  would-show count. Click a suggestion → unticks that filter and the
  reader is back in a non-empty view in one tap. On
  `/tags/<rare-slug>/` pages where every removal still yields zero,
  the suggestion falls back to a `Browse all tags →` escape link to
  `/tags/` index.
- **TriageRail stale-link dimming.** On `/<date>/` and `/tags/<...>/`
  pages the jump-list now dims items whose target study is hidden by
  the filter and removes them from the keyboard tab order
  (`tabindex="-1"` + `pointer-events: none`) so dead clicks are
  impossible.
- **Mobile-only inline empty banner.** A page-level "No studies
  match this filter. Open filters" banner renders inline above the
  card list at mobile breakpoints so phone readers see the recovery
  affordance without having to open the drawer first.

### Changed

- **PWA service worker normalizes `?tag=` cache keys.** Both the
  archive (`NetworkFirst`) and home (`StaleWhileRevalidate`) routes
  now route `/sites/breast/?tag=radiation`,
  `/sites/breast/?tag=phase-3-rct`, and the bare `/sites/breast/`
  through the same cache entry via a `cacheKeyWillBeUsed` plugin.
  Non-filter query params (utm_*, gclid, fbclid) still fall through
  to the network on archive routes so they don't evict useful
  entries; on the home route every variant collapses to a single
  fixed cache key.
- **Cloudflare Web Analytics beacon `spa: false`.** Disables CF's
  automatic SPA pageview tracking on `pushState` + `popstate` so
  the filter rail's URL-sync mutations don't fire one analytics
  hit per chip click.
- **Canonical `<link rel="canonical">` on every page.** Strips
  `?tag=` and `?tags=` filter params so search engines index one
  URL per content page rather than one per filter combination.
- **Build-time slug-uniqueness assertion runs in `astro:build:start`.**
  Previously only `npm run build:day` validated; now `npm run build`
  fails pre-SSG if any tag slug collides across the five `/tags/`
  namespaces (modality / intent / methodology / verdict / meeting).
- **TriageRail wide-mode anchors to the right edge.** At ≥1640px on
  date and tag-landing pages, the TriageRail mirrors to the right
  gutter so the TagFilterRail can occupy the left.
- **Home page left rail switches from disease-site nav to filter.**
  The disease-site chip row at the top of content remains the
  navigation surface at every viewport; the left rail at ≥1200px is
  now the filter.

### Fixed

- **Repo open-source preparation.** Added MIT LICENSE, a GitHub
  link in the /about page, and a README version bump. Audit
  confirmed no secrets in any committed file.

## [0.10.0] - 2026-05-30

### Added

- **Cross-cutting tags on top of disease site.** Studies now carry three
  typed tag fields that the Phase 2 LLM emits and the curator can
  override: **modality** (radiation, surgery, systemic, combined),
  **intent** (curative, palliative, supportive), and **methodology**
  (phase-3-rct, phase-2-trial, phase-1, retrospective, meta-analysis,
  real-world-evidence, consensus-guideline). Verdict (SOC implication)
  and meeting are also exposed as tag namespaces. Every existing digest
  has been backfilled, so 41 studies across 9 dates are tagged at
  launch.
- **Tag landing pages.** Slug-only URLs at `/tags/<slug>/` (e.g.
  `/tags/radiation/`, `/tags/practice-changing/`, `/tags/asco-2026/`).
  Two- and three-way intersections render at
  `/tags/<a>+<b>/` and `/tags/<a>+<b>+<c>/`, alphabetical canonical.
  A `/tags/` index page lists every populated namespace at a glance.
- **Per-tag RSS feeds and JSON API.** Every tag landing has a
  `/tags/<slug>/feed.xml` companion. New `/api/v1/tag/<slug>.json`
  endpoint joins the existing per-date and per-study API surface.
- **Tag chips on StudyCard + sibling footer.** Each study now renders a
  chip row showing its tags (each linking to the landing page) plus a
  footer linking to up to three peer studies that share the same
  modality+disease-site (the "you might also want to read..." surface).
- **Home page tag activity histogram.** Inline 80×10px sparklines show
  the last-30-published-day count per top tag, with up/down/flat trend
  arrows. Recency-weighted ranking surfaces emerging themes over
  historical volume. Section sits below the recent-studies feed.
- **Curator override flags for tag fields.** `npm run override -- --edit
  --modality=<slug>` (and `--intent`, `--methodology`) lets the curator
  correct hard semantic LLM calls (palliative vs curative borderline
  cases, phase 2 vs phase 3 misclassification) without re-running the
  LLM. Empty value clears the LLM emission; tags are case-normalized
  and enum-validated, with sidecar JSON edits validated at apply time
  so a hand-edit can't silently land an out-of-enum slug.
- **Build-time tag emission observability.** `build:day` now prints
  `tag emissions: tagged X/Y; modality=...; intent=...; methodology=...`
  per date so the curator sees Phase 2's tag distribution at a glance.
- **Backfill smoke test.** `test/backfill-smoke.test.ts` seeds an in-
  memory SQLite fixture, drives `buildOneDate` end-to-end with a
  content-addressed mock `LlmClient`, and asserts per-date study
  identity, source-ref preservation across bookmarks/papers/slides,
  and tag fields populated on every study.

### Changed

- **PWA cache hygiene extended to /tags/.** Tag landing pages route
  through the existing NetworkFirst `oncbrain-archive` strategy (3s
  timeout, 30-entry cap). Intersection pages are deliberately excluded
  from precache so the SW doesn't cache 1000 combinatoric URLs.
- **Build-time slug uniqueness assertion.** Build fails if a slug
  collides across modality + intent + methodology + verdict + meeting
  namespaces — catches a future tag value or freshly-imported
  conference that would silently route the wrong studies to a tag
  landing page.

### Fixed

- **`buildOneDate` no longer auto-runs on import.** Added a realpath-
  aware `import.meta.url` guard so importing the module from a test
  doesn't trigger `openDb('./oncbrain.db')` against the curator's
  local DB. Realpath both sides to handle the Dropbox/Library/
  CloudStorage symlink alias on macOS.

## [0.9.15] - 2026-05-30

### Fixed

- **Paper dedup missed journal-URL variants.** `normalizeDoi` only
  recognized bare DOIs, `doi:` prefixes, and `doi.org` resolver URLs.
  A paper forwarded once as a DOI and again as a publisher article URL
  (`onlinelibrary.wiley.com/doi/10.1002/cncr.34567/pdf`,
  `nejm.org/doi/full/10.1056/NEJMoa2024001`) or as a `%2F`-encoded link
  (`/doi/10.1002%2Fcncr.34567`) produced different normalized keys, so
  the `papers(lower(doi))` UNIQUE index didn't catch the duplicate and
  `savePaper()` wrote a second row instead of merging metadata onto the
  first. `normalizeDoi` now (1) pre-decodes `%2F` to a slash so the
  bare-DOI regex matches URL-encoded paths, and (2) strips trailing
  publisher view-mode tokens (`/pdf`, `/full`, `/epdf`, `/abstract`,
  `/html`, `/meta`, `/references`, `/citations`, `/fulltext`),
  including stacked forms like `/full/abstract`. Five surface forms of
  the same paper now collapse to one canonical key. Regression test
  asserts the dedup invariant directly.

## [0.9.14] - 2026-05-30

### Fixed

- **Stale-precache white flash when opening the latest digest.** Opening
  a study on the precached latest digest (e.g. SENOMAC on `/2026-05-27/`)
  rendered with the browser's default white background instead of the
  warm off-white `#f7f5f0`; hard reload fixed it. Root cause: the PWA
  service worker keyed the precache revision for `/<latest>/` on the
  digest JSON's md5, but the precached HTML carries content-hashed
  `<link rel="stylesheet">` URLs to `Base.<hash>.css` (which sets
  `--bg`). When a UI commit changed the CSS bundle hash but the digest
  JSON was unchanged, Workbox saw the same `(url, revision)` tuple and
  KEPT the stale HTML; `cleanupOutdatedCaches` then evicted the old CSS
  bundle, and `astro build` had already deleted it from `dist/`, so the
  stylesheet 404'd and the `--bg` cascade never applied. Replaced the
  JSON-keyed `additionalManifestEntries` with a single
  `manifestTransforms` callback that rewrites `.html` URLs to clean URLs
  (replacing the `@vite-pwa/astro` auto-injection that gets disabled
  whenever a user provides their own transforms array) AND appends
  `/<latest>/` with `revision = md5(dist/<latest>/index.html)`. The
  revision now tracks the actual cached bytes, so any CSS-bundle hash
  change invalidates the precached digest entry. Bonus: also collapses
  5× duplicate `manifest.webmanifest` precache entries down to one.
  Regression test in `test/pwa-build.test.ts` asserts the revision
  hashes the built HTML.

## [0.9.13] - 2026-05-29

### Fixed

- **Search results dropdown text rendered all-accent-blue at 18px.** The
  result rows are injected via `list.innerHTML` at runtime, so they don't
  carry Astro's `data-astro-cid-*` scope attribute. The component-scoped
  `.search-list a` / `.result-name` / `.result-tldr` rules in
  `SearchBox.astro` never matched, leaving every line to inherit the
  global `a { color: var(--accent) }` and body 18px serif. Wrapped the
  affected descendant selectors with `:global()` so the rules un-scope
  the dynamic children while keeping `.search-list` itself scoped:
  meta line is now sans 0.78rem `--fg-muted`, trial name serif 18px
  weight 600 `--fg`, TL;DR serif 0.92rem `--fg-muted`. CSS-only.

## [0.9.12] - 2026-05-29

### Changed

- **StudyCard share button is an icon, not text.** The square-with-up-arrow
  icon at the top-right of each study card replaces the "Share" label.
  On copy success the icon flips to a checkmark for 1.5s; on clipboard
  rejection it flips to a triangle alert and the inline URL-recovery
  input still appears. Screen-reader "Copied" / "Couldn't copy"
  announcements continue through the existing aria-live span. Applies
  to both StudyCard and the home-page recent-feed share affordance.
- **StudyCard TL;DR paragraph is now labeled `TL;DR`.** The headline
  result was reading as orphaned prose. The inline label matches the
  existing `FOR` / `vs leading data` uppercase-sans rhythm so the
  triage layer (name → audience → TL;DR → verdict → comparator) reads
  as a labeled hierarchy.

### Added

- **Cloudflare Web Analytics on the live site** (production-gated via
  `import.meta.env.PROD`, so localhost dev and `astro preview` runs
  don't pollute the dashboard with non-production hits).

## [0.9.11] - 2026-05-28

### Fixed

- **StudyCard content no longer compressed by 72px of unused padding on
  mobile.** v0.9.10 added `padding-right: 4.5rem` to `.study-head` so the
  trial name wouldn't run under the absolutely-positioned share button.
  But that padding applied to the WHOLE head, not just the title row —
  the TL;DR box, verdict pill, comparator callout, depth fold, and
  CONSORT all got squeezed by 72px on every screen, leaving mobile
  cards with only 235px of usable width (out of 307px available). The
  share button only occupies the top ~44px of the card, so only the
  title row needs to clear it. Moved the padding from `.study-head` to
  `.study-name`. All blocks below now render full-width as designed;
  the title row still clears the share button. Found by /qa on mobile
  latest digest immediately after v0.9.10 shipped.

## [0.9.10] - 2026-05-28

### Changed

- **StudyCard share button moved from the bottom utility row to the top-right
  of the card head.** Anchored inside `.study-head` (not the outer `.study`)
  so on wide-desktop figures-present cards (grid: head | figs at ≥1200px)
  the button stays in the narrative left column instead of overlaying the
  figures right column. `.study-head` gets `padding-right: 4.5rem` to
  reserve a slot — trial name, audience, TL;DR, verdict, and comparator
  never run under the absolutely-positioned button. The `.study-utility-row`
  wrapper introduced in v0.9.6 is removed; the depth `<details>` is back
  as a direct child of `.study-rest` as it was before.
- Home recent-feed card share overlay is unchanged (still bottom-right of
  the `<li>`) — different card grammar, same affordance.

## [0.9.9] - 2026-05-28

### Fixed

- **Share button on StudyCard is now actually inline with the `▸ N details`
  summary, not orphaned below the open depth fold.** v0.9.6 made the
  utility row a `display: flex` parent with the `<details>` and the share
  button as flex siblings. On desktop (≥1024px) where the depth fold
  auto-expands, the open `<details>` claims the full row width as a flex
  child, and `flex-wrap: wrap` pushed the share button to a new line
  ~750px below the summary (after the entire IMRD body). Reworked to
  `position: relative` on the utility row and `position: absolute; top:0;
  right:0` on the button so it stays pinned to the top-right of the row
  regardless of the depth fold's open/closed state. The recovery `<input>`
  is also absolutely positioned now (below the share button) so it sits
  in the row's reserved space without pushing other content. Found by
  the second /qa pass after v0.9.8 shipped.

## [0.9.8] - 2026-05-28

### Fixed

- **Clipboard-failure recovery input now actually appears.** Same root cause
  as v0.9.7: `input.style.display = ''` clears the inline style, then the
  CSS `display: none` re-applies, so the recovery input stayed invisible
  on rare clipboard-rejection paths (privacy mode, denied permission).
  Now sets `display: block` explicitly. Found via the same `/qa` pass that
  caught the v0.9.7 bug, by forcing `clipboard.writeText` to reject and
  observing computed style.

## [0.9.7] - 2026-05-28

### Fixed

- **Share button now actually appears.** v0.9.6 set the SSG default to
  `display: none` and tried to reveal via `button.style.display = ''`,
  which cleared the inline style and let the CSS `display: none` re-apply,
  leaving the button invisible on every card despite the feature-detect
  having succeeded (label correctly flipped to `Copy link`). Now sets
  `display: inline-block` explicitly so the inline style wins over the CSS
  rule. Found by `/qa` against the live site within minutes of v0.9.6
  shipping. The Vitest unit test asserted the inline-style value in
  isolation rather than against actual CSS context, so it missed the
  regression — updated to assert the explicit `inline-block` value.

## [0.9.6] - 2026-05-28

### Added — share affordance on every study card

Each study card now carries a small **Share** button. On iPhone (and any
browser with the Web Share API — macOS Safari and some Chrome variants),
tapping it opens the native share sheet pre-filled with the trial name and
a canonical URL. Elsewhere it copies the link to the clipboard with an
inline "Copied" confirmation. Insecure contexts and very old browsers hide
the button entirely instead of showing one that wouldn't work.

- **StudyCard** (per-date `/[date]/` and per-site `/sites/[site]/`) — share
  sits in the bottom utility row, inline with the existing `▸ N details`
  summary. Same muted-sans treatment as the other affordances.
- **Home recent feed** (`/`) — share is a small bottom-right overlay on each
  card. Clicking share doesn't navigate; clicking elsewhere on the card
  still opens the per-date page as before. The card border stays accent
  whenever the cursor or keyboard focus is anywhere on the li, so the
  hover state doesn't flicker when moving between card body and button.
- **Canonical URL:** `/sites/{site}/#{date}-{slug}` regardless of which page
  the share was triggered from. Absolutized at click time via
  `new URL(rel, origin).href` so pasted links work from any origin.
- **Recovery path** when the clipboard write fails (privacy mode, denied
  permission): a small read-only `<input>` appears with the absolute URL
  pre-selected for manual `Cmd+C`, then auto-hides after 10 seconds.
- **Web Share rejection chain:** AbortError (user dismissed the sheet) is
  silent; any other rejection falls through to the clipboard path so the
  user still gets the URL.
- Accessibility: 44px tap target, native focus ring, per-card
  `aria-label="Share link to {trial}"`, separate visually-hidden
  `aria-live="polite"` region for state announcements so screen readers
  hear "Copied" even when the button's own text mutation doesn't fire.
- Plan + reviews: `docs/plans/share-study-link.md` captures the 11
  design + eng + Codex-outside-voice decisions that shaped this.

## [0.9.5] - 2026-05-27

### Changed

- Open questions now render on every study card, including in the by-disease-site
  aggregation (`/sites/<site>/`) where they were previously suppressed. The
  `showOpenQuestions` prop on `StudyCard` is removed — the open-questions block
  is gated only on whether the study has any.

## [0.9.4] - 2026-05-27

### Changed

- Card left-bars revert from `--fg-muted` back to `--border` (the darker gray
  in dark mode that v0.9 was using before the v0.9.3 visibility tweak).

## [0.9.3] - 2026-05-27

### Changed — study card depth dropdown flows like a paper

The expanded details on each study card are now grouped into labeled sections
that read like a scientific paper, instead of one flat emoji-prefixed list.

- **Methods · Results · Critique** dividers inside the dropdown. Bullets are
  routed by their leading emoji from `VOICE.md` (🔍/💊 → Methods, 📊/📐 →
  Results, ⚠️ → Critique). A small "Notes" bucket at the bottom catches any
  bullet without a recognized emoji prefix, so nothing is silently dropped.
- **CONSORT participant flow nested inside Methods.** Previously the
  randomization diagram sat as a sibling above the dropdown; it now lives in
  the Methods section where readers expect it, behind the same expandable
  affordance as before.
- **No schema or LLM change.** Bucketing reads the emoji vocabulary that the
  build-time prompts already emit, so every existing digest renders with the
  new structure without a rebuild.

## [0.9.2] - 2026-05-22

### Changed

- The "← all dates · browse by site" nav now stays pinned to the top of the
  screen while scrolling a digest or a by-site list, so navigation stays reachable
  without scrolling back up.

## [0.9.1] - 2026-05-22

### Changed — study card layout + typography

- **Bigger figures on desktop**, and click any figure to open it full-screen
  (lightbox; click outside or press Esc to close).
- **Wider two-column cards at ≥1200px** (narrative + figure side by side); below
  that they fall to a single comfortable reading column with figures stacked, so
  the text never gets cramped beside a figure.
- The **eligible-population ("For …") line and the headline TL;DR moved up** under
  the trial name; the TL;DR is now the card's lead callout instead of plain text
  lost between the boxed sections.
- **Calmer, more consistent typography** — one shared label style, serif content
  throughout, and prominence from size/weight rather than tinted bands and color
  swaps. Clearer visual separation between stacked cards.
- **Caption tables wrap** to fit the figure column instead of clipping on the right.
- **"+N more figures"** stays collapsed by default and only auto-expands (on wide
  screens) when doing so won't make the card taller; a manual toggle always wins.

## [0.9.0] - 2026-05-22

### Added — Progressive Web App (installable + offline)

oncbrain is now an installable PWA with offline support, built on
`@vite-pwa/astro` (Workbox, `injectManifest`).

- **Install to home screen** with a dedicated brain-mark icon set (192/512 +
  maskable on the warm `#f7f5f0` background) and a web app manifest
  (`display: standalone`, theme/background color `#f7f5f0`).
- **Offline-first for the latest digest.** The single most-recent dated digest is
  precached at build time, so it opens offline even for a reader who installed
  from the home screen and never tapped today's page. The app shell (home, about,
  sites index, search, CSS, icons, self-hosted font) is precached too.
- **Bounded archive caching.** Older dated digests + per-site/per-conference pages
  are `NetworkFirst` (3s timeout for hostile conference wifi), capped at 30 cached
  entries so the offline footprint can't grow without limit.
- **Branded offline page** (`/offline/`) with recovery links to the precached
  latest digest + home, instead of the browser's default error screen.
- **Self-hosted Newsreader** (`@fontsource-variable/newsreader`, latin subset)
  replaces the Google Fonts CDN: offline font fidelity, faster first paint, no
  third-party dependency.
- **Silent auto-update** (`registerType: autoUpdate`): a new deploy reaches
  readers on next load, no update prompt.
- New `src/lib/pwa-routes.ts` (cache-route classification, unit-tested) and
  `test/pwa-build.test.ts` (build-output assertions: precache scope, routes,
  offline fallback, page injection). `astro.config.mjs` → `astro.config.ts`.

The SW registration is wired manually in `Base.astro` because `@vite-pwa/astro`'s
auto-injection does not fire under Astro 6.

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
