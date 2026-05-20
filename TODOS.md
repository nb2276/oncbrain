# TODOS

Open work for oncbrain, seeded from CHANGELOG "Not yet shipped" sections and the v0.5 plan's out-of-scope list. Grouped by target milestone. Each item links back to its source so context isn't lost.

Format: `- [scope] description (source)`

## v0.5.1 — hardening hotfix

- **Source-tagged Phase 2 claims.** Per-claim source attribution in per-study deep-analysis so mixed tweet+paper+slide inputs can't silently blend numbers across sources. The downstream numeric validator already cross-checks each table cell against source content; v0.5.1 extends that to tag each `details` bullet with the source it came from. (codex amended-plan P1 #6 — `CHANGELOG.md:36`, `CHANGELOG.md:72`, `docs/plans/v0.5-multi-source-ingestion.md:286`)

## v0.6 — next minor

- **Live search.** Client-side search box on the home page (and possibly `/sites/`) that filters digests + studies as you type. Indexes study `name`, `tldr`, NCT IDs, and disease-site labels. Static-site appropriate: precompute a small JSON index at build time, ship as one file, do the matching in the browser. Tradeoff to settle at implementation time: lightweight substring filter (~5KB JSON, instant, no fuzzy match) vs. a real client-side index like `lunr`/`flexsearch` (~15-30KB, ranked + tolerant of typos, better for "PRESTIGE" → finds "PRESTIGE-PSMA"). Lean toward the lighter option first.
- **PWA + push notifications.** Manifest, installability, offline-cache of the latest digest. Push notifications scoped as optional follow-on. Plan: `docs/plans/v0.6-pwa.md`. (`docs/plans/v0.5-multi-source-ingestion.md:291`)
- **DOI-only paper references** → now planned in v0.8 PR1. (`docs/plans/v0.8-non-pmid-sources.md`)
- **PMC URLs as ingestion targets** → now planned in v0.8 PR1. (`docs/plans/v0.8-non-pmid-sources.md`)
- **Non-photo image attachments.** Detect HEIC `document[]` attachments that iOS Photos sometimes sends instead of `photo[]`. (`CHANGELOG.md:39`, `CHANGELOG.md:100`)
- **PDF attachments** → now planned in v0.8 PR2 (summarize-and-discard). (`docs/plans/v0.8-non-pmid-sources.md`)
- **iCloud shared album watcher.** Curator drops a slide into a shared album, oncbrain pulls it. (`docs/plans/v0.5-multi-source-ingestion.md:285`)
- **Per-paper figure extraction from PMC XML.** Today: figures are linked but not pulled in. (`docs/plans/v0.5-multi-source-ingestion.md:286`)
- **Slide deck grouping.** Use `source_batch_key` (already populated for multi-photo Telegram messages) to render a deck as a unit. (`docs/plans/v0.5-multi-source-ingestion.md:288`)
- **Slide cropping / auto-rotation / EXIF stripping.** Quality pass before slides ship in published digests. (`docs/plans/v0.5-multi-source-ingestion.md:289`)

## v0.8 — non-PMID source ingestion (planned)

Full plan: `docs/plans/v0.8-non-pmid-sources.md` (CEO-reviewed + codex-reviewed 2026-05-19). Phased into 3 PRs: PR1 URL/DOI/PMC ingest + schema rebuild + Telegram replies; PR2 PDF text + scanned-PDF Vision OCR; PR3 RSS/JSON API + cross-day NCT dedup. Hard constraint: summarize and discard, never store PDFs or copyrighted figures.

Deferred sub-items surfaced during CEO review (not in the v0.8 PRs):

- **Preprint detection + badge + verdict cap (E5).** Detect medRxiv/bioRxiv/Research Square + DOI prefix 10.1101; set `is_preprint`; render a "PREPRINT — not peer-reviewed" badge; cap preprint verdicts at `early-signal` in VOICE.md. Clinical-safety: a subspecialist must never mistake a preprint for peer-reviewed. (S effort, P2)
- **Email-forwarding from PubMed alerts.** Curator forwards alert emails; bot polls via Gmail OAuth, extracts paper URLs, runs them through v0.8 ingestion. The 10-star "curator does nothing" version. Supersedes the old "Gmail OAuth polling" v0.6 item. (XL effort, P3)
- **Conference URL auto-detect.** Recognize ASCO/ESMO/ASTRO/AACR URL patterns and auto-apply the conference tag on ingest. (S effort, P3)
- **Per-source rate-limit messaging.** Tell the curator via Telegram when an ingest is stuck on an upstream rate limit (NCBI, Crossref). (S effort, P3)
- **Multi-curator mode.** Reserve `curator_id` on bookmarks/papers so multiple curators can DM the same bot and their sources aggregate. (M effort, P3)

## v0.7+ — entity resolution

- **Cross-day study persistence.** A trial seen on day N should keep its identity on day N+1. (`docs/plans/v0.5-multi-source-ingestion.md:290`)
- **Slug-based retrieval entity resolution.** "PRESTIGE" vs "prestige-psma" should resolve to the same study so prior-context retrieval works across days. (`CHANGELOG.md:297`)

## Known limitations (informational — not on a roadmap)

- **OCR is macOS-only.** Linux/CI builds produce uniformly null captions. (`CHANGELOG.md:298`)
- **Figure caption validator checks numeric tokens only.** Can't catch mis-labeled axes or wrong-arm attribution. (`CHANGELOG.md:296`)
- **Disease-site classification uses MeSH terms, not author affiliations.** Explicit product decision, not a deferred item. (`docs/plans/v0.5-multi-source-ingestion.md:284`)

## Completed

(Completed items are recorded in CHANGELOG.md per version. This section is reserved for items that completed but didn't ship in a tagged release — currently empty.)
