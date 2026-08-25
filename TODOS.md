# TODOS

Open work for oncbrain, seeded from CHANGELOG "Not yet shipped" sections and per-release plans. Grouped by priority/milestone. Each item links back to its source so context isn't lost.

Format: `- [scope] description (source)`

## Full-text excerpting (v0.41 follow-ups — all closed in v0.42)

- **Row-association REPAIR (the withhold half shipped in v0.41).** **Priority:
  P2.** Detection and refusal are live; the fold was removed after review showed
  it corrupted rows. A trustworthy repair needs a positive row-label test (not
  "any leftmost line without a value cell"), a real value grammar, and document
  order rather than indent order. Worth doing: 31 of 69 corpus table blocks are
  currently refused, and some are guideline grids worth rendering.
  (v0.41 pre-merge review)
- **Extend self-consistency beyond the headline.** **Priority: P3.** v0.43 checks
  the TL;DR against the card body when a table is present, which is where the
  eval found the failures. It does NOT catch a contradiction between two body
  surfaces (a bullet vs an analysis section), nor a card without a table, nor the
  "5,026 vs 6,057 pts for the same HR" shape, which needs quantity identity
  rather than value traceability. Label matching was tried and does not work;
  a synonym map for endpoint names is the plausible next step. (v0.43)
- **Broaden the quality-eval evidence base.** **Priority: P2.** The 50,000
  default rests on one date, three personas, one run (6.7 → 7.4). Run it across
  several dates before treating the number as settled. (v0.41)

## v0.12 — tag filter rail extensions (deferred from v0.11 via /autoplan)

- **Tag-filter observability.** Pick a CF-compatible backend first (Plausible / Umami / Cloudflare Worker → KV / self-hosted). CF Web Analytics docs confirm custom events are NOT supported. Once a backend is picked, fire custom events on filter activation with `{tagCount, tagNames, pageType, source}` to drive v0.13 prioritization. (v0.11 autoplan eng pass — CF Analytics infeasibility / `docs/plans/v0.11-tag-filter-rail.md`)
- **Reader-prefs cookie / saved-default filters.** localStorage-backed; precedence URL > saved > none. Defer until v0.11 ships and reader behavior data exists (or until curator feedback validates the workflow). Implementation must use `requestIdleCallback` defer + post-paint application + "applying saved filter…" transition to avoid blocking critical render path on iOS Safari. (v0.11 autoplan design + eng — perf risk + design-thin / `docs/plans/v0.11-tag-filter-rail.md`)
- **Tag-filter keyboard shortcuts.** Resolve the `f`-vs-global-search-focus collision first (try `\` or `/` instead). Spec the editable-control guard list explicitly including `<select>` and `[role="textbox"]`. Numerals 1-9 map to top visible filters with `<kbd>` hints inline. (v0.11 autoplan eng — Base.astro search-focus collision / `docs/plans/v0.11-tag-filter-rail.md`)

## Notifications (from the v0.32 deploy-readiness work)

- **Announce a stranded date older than yesterday.** **Priority: P3.** The
  stranded-publish-commit bug is fixed in v0.39: `scripts/daily-build.sh` now unions the
  dates of commits ahead of `origin/main` into `CHANGED_DATES`, so a date a failed push
  stranded is announced by the run that finally pushes it. But `ANNOUNCE_DATES` still
  filters to today/yesterday, so a **multi-day** outage (push failing three nights running)
  deploys the older dates silently. The filter cannot simply be relaxed for backlog dates:
  a `rebuild:queued` rebuild of a past date is *also* unpushed, and re-posting a weeks-old
  day to the public channel as if new is the known-wrong behaviour adversarial-review #A1
  forbade. Distinguishing "never announced" from "announced before, rebuilt since" needs a
  persisted announced-ledger, which is the real fix. **Found by:** codex review during
  /ship v0.39.
- **Observe one fresh Telegram round-trip (E2 reply).** **Priority: P4.** v0.8 ingestion is
  confirmed live: 137 real bot DMs between 2026-05-18 and 2026-08-01, 65 papers enriched
  (23 PMID / 54 DOI / 10 PMC), 27 PDFs filed to the vault and all 27 present on disk, 48
  full-text excerpts, and 7 permanent failures that are all TYPED and graceful (5x HTTP 403,
  1x magic-byte, 1x no DOI/PMID). A live `pull:telegram` polls the Bot API cleanly. The only
  untested step is watching the bot's E2 confirmation reply arrive for a NEWLY sent message,
  which needs the curator to DM the bot. Do it opportunistically the next time you send one.

## v0.14 — verdict triage + what's-new (deferred from 2026-06-09 office-hours design + eng review)

Design doc: `~/.gstack/projects/nb2276-oncbrain/2026-06-09-design-triage-and-distribution.md`. T1-T5 shipped (verdict triage, what's-new feed, home/browse split, OG + share-image cards, Telegram channel distribution). Remaining:

- **Email subscribe distribution (T5 scale play).** The Telegram channel cheap-proof shipped in v0.14.6 (`notify:channel`). Email is the scale play but needs a third-party list service (Buttondown / Listmonk / SES) + unsubscribe/compliance (the static site has no backend). Daily or a 🚀/↔️ weekly roundup; per-site follow rides on the disease-site enum. (office-hours design T5)

## v0.5.1 — hardening hotfix

- **Source-tagged Phase 2 claims.** Per-claim source attribution in per-study deep-analysis so mixed tweet + paper + slide + PDF inputs can't silently blend numbers across sources. The numeric validator already cross-checks each table cell against source content; v0.5.1 extends that to tag each `details` bullet with its source. **Prompt-dependent → needs a real `build:day` to verify (don't ship blind); design + verification gate in `docs/plans/v0.16-entity-resolution-and-source-tagging.md`.** (codex amended-plan P1 #6 — `docs/plans/v0.5-multi-source-ingestion.md:286`)

## v0.6 — next minor (partially shipped)

- **Web Push notifications — BLOCKED on architecture (decision needed).** The PWA itself shipped (v0.6: `@vite-pwa/astro`/Workbox manifest + offline precache of the latest digest; v0.14.8 added the iOS Add-to-Home-Screen hint). Web Push, however, can't be built as `docs/plans/v0.6-pwa.md` Phase B specs it: it routes subscriptions to `admin/server.ts` and sends from `daily-build.sh`, both **localhost-only** on the curator's Mac — a public PWA user's browser can't reach them, and the static site has no public backend to accept subscriptions or send pushes. A proper implementation needs a public backend (serverless function + VAPID keys). The plan itself notes email/subscription is usually the better fit, and the **T5 Telegram channel distribution (v0.14.6) already delivers the push-to-readers value**. Revisit only if a public backend is added; otherwise prefer the T5/email path.
- **search-index.json size budget + split.** `search-index.json` is regenerated daily and grows forever; once it's the largest frequently-refreshed asset it silently degrades mobile load + the SWR runtime cache. Cap or split (e.g. shard by site, lazy-load) when it crosses a size budget (~150KB). Start at `src/pages/search-index.json.ts` + `SearchBox.astro` lazy-load. Small today; not a v0.6 blocker. (v0.6 eng review — Codex outside voice)
- **iCloud shared album watcher.** Curator drops a slide into a shared album, oncbrain pulls it. (`docs/plans/v0.5-multi-source-ingestion.md:285`)
- **Per-paper figure extraction from PMC XML.** Figures are linked but not pulled in. (`docs/plans/v0.5-multi-source-ingestion.md:286`)
- **Slide deck grouping.** Use `source_batch_key` (already populated for multi-photo messages) to render a deck as a unit. (`docs/plans/v0.5-multi-source-ingestion.md:288`)
- **Slide cropping / auto-rotation / EXIF stripping.** Quality pass before slides ship. (`docs/plans/v0.5-multi-source-ingestion.md:289`)

## v0.8 deferred (surfaced in CEO review; not in PR1-3)

- **Email-forwarding from PubMed alerts.** Curator forwards alert emails; bot polls via Gmail OAuth, extracts paper URLs, runs them through v0.8 ingestion. The "curator does nothing" version. (XL, P3 — `docs/plans/v0.8-non-pmid-sources.md`)
- **Per-source rate-limit messaging.** Tell the curator via Telegram when an ingest is stuck on an upstream rate limit (NCBI, Crossref). (S, P3)
- **Multi-curator mode.** Reserve `curator_id` on bookmarks/papers so multiple curators can DM the same bot and aggregate. (M, P3)
- **CORS on the JSON API.** `/api/v1/*` + `/feed.xml` send no `Access-Control-Allow-Origin`. Server-side fetches + feed readers work; browser cross-origin `fetch()` is blocked. Add a DO header rule if a browser app needs it. (v0.8 PR3)
- **Live-site curator attribution.** Set `PUBLIC_SITE_NAME` + `PUBLIC_CURATOR_*` as DO app env vars (or `.do/app.yaml`) so the live header shows "curated by ...". The /about page already attributes via a hardcoded fallback. (this session)

## v0.7+ — entity resolution

- **Cross-day study persistence + slug-based entity resolution.** A trial seen on day N keeps its identity on day N+1; "PRESTIGE" vs "prestige-psma" resolve to the same study so prior-context dossier retrieval works across days. (NCT coverage index is a partial step.) **WARNING (found 2026-06-11): do NOT auto-strip a trailing `-\d+` suffix to normalize slugs — it cross-links distinct trials whose numbers are identity (`rtog-0539`, `rtog-0848` → `rtog`). The safe path is curator-declared `aliases:` frontmatter on the dossier. Design in `docs/plans/v0.15-entity-resolution-and-source-tagging.md`.** (`docs/plans/v0.5-multi-source-ingestion.md:290`)

## Trade-press format (deferred from 2026-06-13 office-hours + eng review)

- **Approach B — separate the trade pub's commentary into a labeled secondary layer.** **Priority: P3.** After Approach A (classify single-study vs review + provenance + conservative link) proves out in real digests, split the trade pub's distinctive interpretation (KOL take, "what this means for practice") from the reported facts, rendered as a subordinate "🗞️ {outlet}'s take:" block. **Why:** facts-first-then-framing is how a subspecialist reads; the v1 (Approach A) blends commentary into the bullets. **Depends on:** Approach A shipping first. **Context:** design doc `~/.gstack/projects/nb2276-oncbrain/nboehling-fix-trade-press-article-link-design-20260613-135111.md`; eng plan `docs/plans/trade-press-format.md` (note that plan's foundation was reworked per Codex — content_type is a first-class Phase-1 field, not a methodology value).
- **Review consistency on secondary surfaces (v0.16 ship review — red-team + adversarial).** **Priority: P3.** A `content_type:review` reads as a 🗞️ press round-up on the date / site / tag pages (shared `railEmojiForStudy`) but four other study surfaces don't yet distinguish it: (1) the home `RecentFeed` shows the disease-site emoji (it deliberately flags only practice-changing with 🚀 — decide whether a review warrants its own marker there); (2) the Telegram channel post (`channel-post.ts`) renders a neutral bullet; (3) the OG / share-image (`share-image.ts`, `og/study/[date]/[slug].png.ts`) shows no review marker; (4) the Obsidian vault twin (`renderObsidian`) omits the `discussed_trials` list + review framing, so a review note is a bare verdict-less study. All are **design/scope judgments, not bugs** — the web milestone is intentionally first. Decide per-surface whether to mirror the review treatment (consider exporting `REVIEW_GLYPH` everywhere) or document it as web-only.
- **Harden v0.16 trade-press classification + extraction (ship adversarial + codex structured review).** **Priority: P3.** Three non-blocking robustness items surfaced at ship: (a) **Ground `discussed_trials` against the source text** (codex review P2 #2) — currently the cap/length/charset filter accepts any 2–40-char alphanumeric token, so a hallucinated acronym renders verbatim; add a word-boundary case-insensitive check that each retained acronym appears in the cluster's source text + image OCR before persisting (must include OCR-only sources + handle `STOMP/ORIOLE` slash-joined spellings so it doesn't drop legit names — needs its own real-build verify). (b) **Make `content_type` curator-overridable** (codex adversarial) — `content_type`/`discussed_trials` are not in `EDITABLE_STUDY_KEYS` (`digest-overrides.ts`), so a Phase-1 misclassification can't be durably corrected and `stripReviewVerdicts` re-strips the verdict every rebuild; add a durable override path (and skip the strip when a curator pins `content_type:study_report`). (c) **Warn on an invalid (non-empty) `content_type`** from a live Phase-1 response so a model typo that silently falls open to `study_report` is observable rather than silent. **Context:** eng plan `docs/plans/trade-press-format.md`; the conservative `study_report` default is deliberate (back-compat), so (a)/(c) tighten without changing the default.

## Digest quality (eval now PASSES at 8.5 — v0.55)

- **The eval is ONE fixture and the hallucination cap makes it bimodal.**
  **Priority: P3.** Observed 5.0 / 6.5 / 7.5 / 5.0 / 5.0 / 8.5 across runs while
  fixing genuinely different defects each time — any single unsupported claim
  caps the score at 5.0 regardless of the other axes. A second and third fixture
  would separate "we regressed" from "the model rolled badly". (v0.55)

## Trial lineage (v0.53 follow-ups)

- **A SECOND gate round (v0.56.0) again answered both questions "yes".** Its own
  four findings are fixed in v0.56.0 — three of them could remove a published card
  with the flag OFF (partial-rebuild deletion, unauthenticated `drop`, legacy
  identity migrating onto a sibling), and the fourth was a hole left in v0.55.6's
  own fix (a lone comparator NCT satisfying registered identity). The lesson worth
  keeping: two of the four were regressions introduced by the previous round's
  fixes, so each round needs its own round.
- **Third gate round — ALL NINE FIXED** (two in v0.56.1, seven in v0.57.0). Kept
  as history; see the CHANGELOG. A FOURTH round has not been run against v0.57.0,
  and each of the three so far found regressions introduced by the previous one.
  **Priority: run round four before enabling the flag.**
- Round three detail, for reference. **Priority: none.** It again
  answered both gate questions "yes". Two of its nine were defects in v0.56.0's own
  new guards and are fixed in v0.56.1; the rest, by its numbering:
  #1 a cron running on a FEATURE BRANCH compares the rebuild against that branch's
  stale artifact, not live main, then copies the result over main and pushes — a
  card published on main but absent from the branch checkout disappears with no
  alias and no notification (P0);
  #2 Phase 1 can MERGE two published cards into one cluster; partition validation
  accepts it, `meta.dropped` stays empty, and the regression guard has nothing to
  inspect (P0);
  #3 a Phase 1 rename plus a Phase 2 failure where BOTH names yield a null dedup
  key evades the regression guard entirely — it matches neither slug nor key (P0);
  #4 destructive Telegram authorization checks the CHAT, not the sender, so any
  member of an allowed group can issue `drop` (P0);
  #5 `study.nct` from Phase 2 is format-checked but not proven to belong to the
  reported study, and `toTrialReport` unions it with the source-derived NCT, so a
  comparator's registration can defeat the NCT-conflict check; a cue attached to a
  comparator ("the comparator was registered at ClinicalTrials.gov as NCT…") also
  still passes `ownRegistrations` (P1);
  #6 `TrialReport` carries no cohort/arm/population field, so one basket trial's
  lung cohort can supersede its own breast cohort under the shared NCT (P1);
  #7 with autosuppress ON and the ingest allowlist unset, ordinary open ingestion
  becomes a destructive endpoint: a forged source claiming the victim NCT reaches
  lineage with no human review between inboxing and suppression (P1).
  (v0.56.1 gate round)
- **Six findings from the FIRST gate round — NOW FIXED in v0.56.1.** Kept here only
  as history; see the CHANGELOG entry. **Priority: none.** The
  pre-enable adversarial round returned 11 findings over the destructive path and
  answered both gate questions "yes": with the flag ON cards can still be wrongly
  unpublished, and system-wide a partial rebuild can remove a published card with
  no human reply. Two were fixed in v0.55.6 (source-type aliasing in the grounding
  map, registration-cue bleed). Still open, by the reviewer's numbering:
  #4 the empty-date guard is stale by commit time (concurrent builds or an
  intervening curator drop can each approve one of two cards and suppress both);
  #5 the enrich-time human drop path is not successor-transactional;
  #7 `conflictingState` is bypassed by every degraded rerank fallback path;
  #8 prior-coverage notifications still use `extractCitations`, not
  `ownRegistrations`, so a comparator NCT can produce `droppable:true`;
  #9 the DM header's `anyDroppable` counts priors that dedup later removes, so it
  can say "unless you drop one" with no authorized token visible;
  #11 artifact and override writes are neither atomic nor fsynced, and a torn
  sidecar can poison `rebuild:queued` for three nightly drains.
  Findings #1 and #2 were lost to a capture error and were NOT recovered: the
  v0.56.0 re-run derived its own set against the newer HEAD rather than
  reproducing the old numbering, so those two remain unknown. (v0.55.6 gate round)
- **Re-run the destructive path through review before enabling the flag.**
  **Priority: P1 (gate).** Both blocking items are now closed — transactional
  suppression (v0.55.4) and own-registration corroboration (v0.55.5). What remains
  before `TRIAL_LINEAGE_AUTOSUPPRESS=on` is a clean adversarial round over the
  destructive path AS IT NOW STANDS. Five rounds were run against earlier
  versions; none has seen the staged-commit ordering or the identity narrowing.
  (v0.53, updated v0.55.5)

  Closed in v0.53.2: gating the enrich-time prior-coverage DM. The offer is now
  opt-in per prior and cleared only on facet compatibility — the full evidence
  gate cannot run at enrich time, because a source has no `primary_endpoint`
  until Phase 2.

## Known limitations (informational — not on a roadmap)

- **Three traps when auditing the corpus by hand against the DB.** (1) `source_ids[].type` is `tweet`, NOT `bookmark`, so keying on the wrong string silently yields EMPTY source text and every number reads as ungrounded. (2) The bookmarks OCR column is `image_ocr_texts` (plural). (3) Stored abstracts encode the middle dot as `&#xb7;`, which `normalizeNumericText` does not decode. All three produced false "ungrounded" verdicts while verifying v0.48 arm outcomes.

- **The middle dot appears HTML-entity-encoded in stored abstracts.** `15&#xb7;1` rather than `15·1`, which `normalizeNumericText` (figure-extract.ts) does not decode. Harmless today — no production grounding path compares against entity-encoded text — but it produced two false "ungrounded number" verdicts in a manual audit of v0.48 arm outcomes, so any future grounding check that reads `papers.abstract` must decode entities first.

- **OCR is macOS-only.** Linux/CI builds produce uniformly null captions; scanned-PDF OCR (v0.8 PR2) needs the Mac Vision binary + poppler.
- **Figure caption validator checks numeric tokens only.** Can't catch mislabeled axes or wrong-arm attribution.
- **Disease-site classification uses MeSH terms / keywords, not author affiliations.** Explicit product decision, not a deferred item.

## Completed (v0.41.0, 2026-08-09)

- **Run `npm run quality-eval` at 24,000 vs 50,000.** Done on 2026-08-08 with the
  artifact floor and grid rule in place: overall 6.7 → 7.4, accuracy 6.0 → 7.7,
  oncologist persona 5.0 → 7.8. 50,000 kept. The 24,000 arm is what surfaced the
  P0 above — it rendered the panel-agreement table with percentages pinned to the
  wrong classes. **Completed:** v0.41.0 (2026-08-09)

## Completed (v0.20.1, 2026-06-17)

- **Back-catalog backfill for grounded figure extraction + persistent Ollama.**
  `npm run backfill:figure-structured` (`build/backfill-figure-structured.ts`)
  re-runs the v0.20 Vision + Qwen → Opus pipeline over filed PDFs whose
  `figure_structured_md` is NULL (gated on `isQwenAvailable()`, idempotent,
  `--date`/`--id`/`--force`/`--dry-run`). Ollama is now a persistent `brew
  services` login item so new-ingest enrichment + the backfill always find it.
  **Completed:** v0.20.1 (2026-06-17). Closes the v0.20 ship follow-up.

## Completed (v0.14.10, 2026-06-11)

- **Conference badge for paper/slide-only days.** `dominantConferenceForDate` (src/lib/db.ts:605) now unions bookmarks + papers + slides (unanimous-single-slug semantics preserved), so a paper/PDF/slide-only conference day gets a badge + `/conferences/<slug>` page. Untagged sources still ignored. Tests in `test/db.test.ts`. **Completed:** v0.14.10 (2026-06-11). Completes the v0.14.9 conference auto-detect feature for non-tweet sources.

## Completed (v0.14.9, 2026-06-11)

- **Conference auto-detect on ingest.** `src/lib/conference-detect.ts` recognizes ASCO/ESMO/ASTRO/AACR/ASH/SABCS + ASCO GU/GI from meeting hashtags (`#ASCO26`), meeting-specific URL hosts, and year-bearing prose; all four enrichment paths (tweet/paper/PDF/slide) stamp `conference_slug` + insert-if-absent the conference row. Closes the gap where bot-ingested sources were never conference-tagged (only the admin form was). Tests in `test/conference-detect.test.ts` + `test/inbox.test.ts`. **Completed:** v0.14.9 (2026-06-11). Follow-up tracked above (badge for paper/slide-only days).
- **Daily-build quality-eval skill (multi-persona, longitudinal, prescriptive).** Shipped as `build/quality-eval.ts` / `npm run quality-eval` — multi-persona review of a day's digest, dated reports under `~/.gstack/projects/nb2276-oncbrain/quality-reports/<date>.md`. **Completed:** prior release (verified shipped 2026-06-11 during TODOS cleanup).

## Completed (released in v0.8.0, 2026-05-19)

- **Release v0.8.0:** package.json bump, CHANGELOG consolidated into a dated `[0.8.0]`, git tag `v0.8.0`.
- **Docs modernization:** README (architecture diagram, multi-source pipeline, digest-format, Obsidian PDF vault, RSS/API), CLAUDE (pipeline diagram, schema, lib file-map, key commands), DESIGN (verdict-pill + home-page sections) refreshed for v0.8.
- **Live search** (v0.6) — `SearchBox.astro` + `search-index.json.ts`.
- **SOC-implication verdict + comparator promotion** (v0.7).
- **DOI-only paper references + PMC URLs as ingestion targets** (v0.8 PR1).
- **PDF attachments** (v0.8 PR2). The original "summarize-and-discard, never store PDFs" constraint was **revised** to store-local-not-publish: PDFs are filed to the gitignored Obsidian vault (`data/obsidian/papers/<site>/<slug>.pdf`), summary-only on the public site.
- **RSS feed + versioned JSON API + cross-day NCT dedup** (v0.8 PR3).
- **/api docs page + RSS auto-discovery link + About-page rewrite** (this session).
