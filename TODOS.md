# TODOS

Open work for oncbrain, seeded from CHANGELOG "Not yet shipped" sections and per-release plans. Grouped by priority/milestone. Each item links back to its source so context isn't lost.

Format: `- [scope] description (source)`

## v0.12 — tag filter rail extensions (deferred from v0.11 via /autoplan)

- **Tag-filter observability.** Pick a CF-compatible backend first (Plausible / Umami / Cloudflare Worker → KV / self-hosted). CF Web Analytics docs confirm custom events are NOT supported. Once a backend is picked, fire custom events on filter activation with `{tagCount, tagNames, pageType, source}` to drive v0.13 prioritization. (v0.11 autoplan eng pass — CF Analytics infeasibility / `docs/plans/v0.11-tag-filter-rail.md`)
- **Reader-prefs cookie / saved-default filters.** localStorage-backed; precedence URL > saved > none. Defer until v0.11 ships and reader behavior data exists (or until curator feedback validates the workflow). Implementation must use `requestIdleCallback` defer + post-paint application + "applying saved filter…" transition to avoid blocking critical render path on iOS Safari. (v0.11 autoplan design + eng — perf risk + design-thin / `docs/plans/v0.11-tag-filter-rail.md`)
- **Tag-filter keyboard shortcuts.** Resolve the `f`-vs-global-search-focus collision first (try `\` or `/` instead). Spec the editable-control guard list explicitly including `<select>` and `[role="textbox"]`. Numerals 1-9 map to top visible filters with `<kbd>` hints inline. (v0.11 autoplan eng — Base.astro search-focus collision / `docs/plans/v0.11-tag-filter-rail.md`)

## Now — highest priority

- **Daily-build quality-eval skill (multi-persona, longitudinal, prescriptive).** New in-session skill that runs on each day's `build:day` output and scores it across four axes: (1) accuracy / zero-hallucination (numbers verbatim from source, NCT correctness, comparator claims grounded in tweet/OCR/paper text), (2) voice + readability (VOICE.md compliance, banned-vocab audit, em-dash audit, sentence length, subspecialist register), (3) UI/UX of the rendered card (hierarchy, density, mobile fold, scannability at 375px), (4) clinical relevance + completeness (subspecialist would consider it useful for a 90-second triage). Three personas per run, each scoring + commenting from their own lens: senior product designer (DESIGN.md anchored), expert oncologist (site-matched, e.g. GU subspecialist when prostate dominates the day), early trainee (PGY-2 reading to learn — what's confusing, what's missing context, what an attending would expect them to know). Each persona's prompt assembled from a small persona file + the live DESIGN.md + VOICE.md. Output: dated report (`~/.gstack/projects/$SLUG/quality-reports/YYYY-MM-DD.md`) with per-axis 0-10 scores, the top 3 issues across personas (consensus surfaces first), and 1-3 prescriptive recommendations for tuning the next build's prompts. Each run reads the most recent N reports (default 7) and includes them as longitudinal context; issues that recur across days get escalated to "prompt-change suggested." Bonus: emit a "guidance for next LLM pull" block (concrete prompt-template diffs) that the build pipeline can optionally consume. Pair with existing `test/eval.test.ts` rig (LLM-as-judge primitives) but a separate skill so daily-run cadence is separate from CI regression gate. (this session — user request 2026-06-08)

- **Live end-to-end test of v0.8 ingestion.** PR1/2/3 pass unit + build tests but have never run against real Telegram traffic. DM the bot a journal URL + a PDF, run `pull:telegram → enrich:inbox → build:day`, confirm vault filing + E2/E3 replies + digest output. (this session)

## v0.14 — verdict triage + what's-new (deferred from 2026-06-09 office-hours design + eng review)

Design doc: `~/.gstack/projects/nb2276-oncbrain/2026-06-09-design-triage-and-distribution.md`. T1-T5 shipped (verdict triage, what's-new feed, home/browse split, OG + share-image cards, Telegram channel distribution). Remaining:

- **Email subscribe distribution (T5 scale play).** The Telegram channel cheap-proof shipped in v0.14.6 (`notify:channel`). Email is the scale play but needs a third-party list service (Buttondown / Listmonk / SES) + unsubscribe/compliance (the static site has no backend). Daily or a 🚀/↔️ weekly roundup; per-site follow rides on the disease-site enum. (office-hours design T5)

## v0.5.1 — hardening hotfix

- **Source-tagged Phase 2 claims.** Per-claim source attribution in per-study deep-analysis so mixed tweet + paper + slide + PDF inputs can't silently blend numbers across sources. The numeric validator already cross-checks each table cell against source content; v0.5.1 extends that to tag each `details` bullet with its source. **Prompt-dependent → needs a real `build:day` to verify (don't ship blind); design + verification gate in `docs/plans/v0.15-entity-resolution-and-source-tagging.md`.** (codex amended-plan P1 #6 — `docs/plans/v0.5-multi-source-ingestion.md:286`)

## v0.6 — next minor (partially shipped)

- **Web Push notifications — BLOCKED on architecture (decision needed).** The PWA itself shipped (v0.6: `@vite-pwa/astro`/Workbox manifest + offline precache of the latest digest; v0.14.8 added the iOS Add-to-Home-Screen hint). Web Push, however, can't be built as `docs/plans/v0.6-pwa.md` Phase B specs it: it routes subscriptions to `admin/server.ts` and sends from `daily-build.sh`, both **localhost-only** on the curator's Mac — a public PWA user's browser can't reach them, and the static site has no public backend to accept subscriptions or send pushes. A proper implementation needs a public backend (serverless function + VAPID keys). The plan itself notes email/subscription is usually the better fit, and the **T5 Telegram channel distribution (v0.14.6) already delivers the push-to-readers value**. Revisit only if a public backend is added; otherwise prefer the T5/email path.
- **search-index.json size budget + split.** `search-index.json` is regenerated daily and grows forever; once it's the largest frequently-refreshed asset it silently degrades mobile load + the SWR runtime cache. Cap or split (e.g. shard by site, lazy-load) when it crosses a size budget (~150KB). Start at `src/pages/search-index.json.ts` + `SearchBox.astro` lazy-load. Small today; not a v0.6 blocker. (v0.6 eng review — Codex outside voice)
- **iCloud shared album watcher.** Curator drops a slide into a shared album, oncbrain pulls it. (`docs/plans/v0.5-multi-source-ingestion.md:285`)
- **Per-paper figure extraction from PMC XML.** Figures are linked but not pulled in. (`docs/plans/v0.5-multi-source-ingestion.md:286`)
- **Slide deck grouping.** Use `source_batch_key` (already populated for multi-photo messages) to render a deck as a unit. (`docs/plans/v0.5-multi-source-ingestion.md:288`)
- **Slide cropping / auto-rotation / EXIF stripping.** Quality pass before slides ship. (`docs/plans/v0.5-multi-source-ingestion.md:289`)

## v0.8 deferred (surfaced in CEO review; not in PR1-3)

- **Email-forwarding from PubMed alerts.** Curator forwards alert emails; bot polls via Gmail OAuth, extracts paper URLs, runs them through v0.8 ingestion. The "curator does nothing" version. (XL, P3 — `docs/plans/v0.8-non-pmid-sources.md`)
- **Conference URL auto-detect.** Recognize ASCO/ESMO/ASTRO/AACR URL patterns and auto-apply the conference tag on ingest. (S, P3)
- **Per-source rate-limit messaging.** Tell the curator via Telegram when an ingest is stuck on an upstream rate limit (NCBI, Crossref). (S, P3)
- **Multi-curator mode.** Reserve `curator_id` on bookmarks/papers so multiple curators can DM the same bot and aggregate. (M, P3)
- **CORS on the JSON API.** `/api/v1/*` + `/feed.xml` send no `Access-Control-Allow-Origin`. Server-side fetches + feed readers work; browser cross-origin `fetch()` is blocked. Add a DO header rule if a browser app needs it. (v0.8 PR3)
- **Live-site curator attribution.** Set `PUBLIC_SITE_NAME` + `PUBLIC_CURATOR_*` as DO app env vars (or `.do/app.yaml`) so the live header shows "curated by ...". The /about page already attributes via a hardcoded fallback. (this session)

## v0.7+ — entity resolution

- **Cross-day study persistence + slug-based entity resolution.** A trial seen on day N keeps its identity on day N+1; "PRESTIGE" vs "prestige-psma" resolve to the same study so prior-context dossier retrieval works across days. (NCT coverage index is a partial step.) **WARNING (found 2026-06-11): do NOT auto-strip a trailing `-\d+` suffix to normalize slugs — it cross-links distinct trials whose numbers are identity (`rtog-0539`, `rtog-0848` → `rtog`). The safe path is curator-declared `aliases:` frontmatter on the dossier. Design in `docs/plans/v0.15-entity-resolution-and-source-tagging.md`.** (`docs/plans/v0.5-multi-source-ingestion.md:290`)

## Known limitations (informational — not on a roadmap)

- **OCR is macOS-only.** Linux/CI builds produce uniformly null captions; scanned-PDF OCR (v0.8 PR2) needs the Mac Vision binary + poppler.
- **Figure caption validator checks numeric tokens only.** Can't catch mislabeled axes or wrong-arm attribution.
- **Disease-site classification uses MeSH terms / keywords, not author affiliations.** Explicit product decision, not a deferred item.

## Completed (released in v0.8.0, 2026-05-19)

- **Release v0.8.0:** package.json bump, CHANGELOG consolidated into a dated `[0.8.0]`, git tag `v0.8.0`.
- **Docs modernization:** README (architecture diagram, multi-source pipeline, digest-format, Obsidian PDF vault, RSS/API), CLAUDE (pipeline diagram, schema, lib file-map, key commands), DESIGN (verdict-pill + home-page sections) refreshed for v0.8.
- **Live search** (v0.6) — `SearchBox.astro` + `search-index.json.ts`.
- **SOC-implication verdict + comparator promotion** (v0.7).
- **DOI-only paper references + PMC URLs as ingestion targets** (v0.8 PR1).
- **PDF attachments** (v0.8 PR2). The original "summarize-and-discard, never store PDFs" constraint was **revised** to store-local-not-publish: PDFs are filed to the gitignored Obsidian vault (`data/obsidian/papers/<site>/<slug>.pdf`), summary-only on the public site.
- **RSS feed + versioned JSON API + cross-day NCT dedup** (v0.8 PR3).
- **/api docs page + RSS auto-discovery link + About-page rewrite** (this session).
