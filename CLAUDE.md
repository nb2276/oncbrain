# CLAUDE.md — oncbrain project guide

Project-level context for AI agents (Claude Code and others) working on this codebase. Read this before making changes.

## What this is

**oncbrain** is a curated AI-summarized digest of oncology meeting research. A single oncologist sends sources from major meetings (ASCO, ESMO, ASTRO, AACR, plus subspecialty meets): conference tweets, paper links (DOI/PubMed/journal pages), trade-press articles (ASCO Post, OncLive, UroToday, …), full-text PDFs, and slide photos. An AI pipeline analyzes them with comparative literature context and a standard-of-care verdict, and the output ships as a static site (plus an RSS feed + JSON API) at **https://oncbrain.oncologytoolkit.com**.

The site is organized by disease site (`/sites/breast/`, `/sites/prostate/`, etc.) and by date (`/2026-05-17/`). Each study gets a per-study TL;DR with effect sizes verbatim, then bullets that include comparisons to recent / historic literature and methodological critique when warranted.

Audience: oncology subspecialists. Tone: subspecialist-to-subspecialist, peer-review register, terse.

## Pipeline at a glance

```
Telegram bot ─┐  pull:telegram        enrich:inbox
 tweets,      ├─▶ inbox_items queue ─▶  oEmbed · PubMed · Crossref ·  ─▶ SQLite (oncbrain.db)
 papers,      │                         PDF text + Apple Vision OCR      bookmarks / papers / slides
 PDFs, slides │
admin form ───┘                               │
                                              ▼
                              build:day ─▶ 3-phase LLM (group → study agent →
                                synthesis) + SOC verdict + literature comparison
                                              │
                              data/digests/<date>.json    (committed)   ─┐
                              data/obsidian/<date>.md      (committed)    ├─▶ git push ─▶ DO (~40s)
                              data/obsidian/papers/...     (gitignored)   ┘
                                              │
                              astro build ─▶ HTML + /feed.xml + /api/v1/*.json
                                              → oncbrain.oncologytoolkit.com
```

Admin + Telegram poller + build run locally only. The deployed site is pure static HTML.

## Stack

- **Runtime**: Node 22+ (homebrew at `/opt/homebrew/bin/node`). Bun also installed at `~/.bun/bin/bun` (used by gstack browse binary).
- **Static SSG**: Astro 6.3 (TypeScript strict)
- **Admin server**: Hono 4 (localhost only, on port 3001)
- **DB**: better-sqlite3 (synchronous), file at `./oncbrain.db`
- **LLM**: Anthropic Claude Sonnet via `@anthropic-ai/sdk` OR via `claude -p` (subscription path). v0.8 PR2: also called at *enrichment* time (not just build) to extract metadata from PDF text.
- **Tests**: Vitest (469 tests as of v0.8)
- **PDF ingestion** (v0.8 PR2): poppler (`brew install poppler`) provides `pdftotext` (text layer) + `pdftoppm` (rasterize scanned pages for Apple Vision OCR) + `pdfimages` (v0.15: locate figure pages). No npm dep. A missing binary yields a clear Telegram reply, not a crash.
- **Figure OCR** (v0.15, Path A): for a text-layer PDF, `pdfimages -list` finds the pages carrying a real figure (large raster image) and `pdftoppm`→Vision OCRs just those, capturing numbers printed *inside* figures (subgroup medians, forest-plot estimates, n-at-risk, image-rendered tables) that `pdftotext` can't see. Stored in `papers.figure_ocr_md` (local-only, never published — same IP boundary as `fulltext_excerpt_md`) and fed to the Phase 2 study agent as labeled lower-confidence source so it can *ground* a figure-locked magnitude instead of flagging it missing. Backfill the back catalog with `npx tsx build/backfill-figure-ocr.ts`.
- **Grounded figure extraction** (v0.20, Vision + Qwen → Opus): a structured layer on top of the raw figure OCR. The figure page goes to *both* Apple Vision (high recall) and a local Qwen2.5-VL (`qwen2.5vl:7b` via an Ollama HTTP server — clean per-panel structure + honest "not legible"), and Opus reconciles the two into per-panel markdown (KM / cumulative-incidence / forest plots / image-rendered tables). A deterministic **grounding gate** then audits the *whole* merged output: if any number isn't in the figure's own Vision OCR token stream it **withholds the entire merge and falls back to raw OCR**, so a fabricated magnitude can't reach the digest. Grounding is role-aware for percentage/CI labels (a "95% CI" claim must match a printed "95%"). Stored in `papers.figure_structured_md` (local-only, same IP boundary as `figure_ocr_md`; guarded out of the published artifact + JSON API by `test/publish-boundary.test.ts`) and fed to the Phase 2 study agent as the *preferred* figure-number source over `figure_ocr_md`. Runs in PDF enrichment only when the paper has figure pages **and** a local Qwen/Ollama is reachable (`isQwenAvailable()`); a machine without Ollama just keeps `figure_ocr_md` and loses nothing. Kill switch `FIGURE_STRUCTURED=off`; reconcile model is Opus by default, override with `FIGURE_RECONCILE_MODEL`; `QWEN_MODEL` / `OLLAMA_HOST` configurable. Run one manually with `npm run figure-extract`.
- **Deploy**: DigitalOcean App Platform, static-site free tier, GitHub auto-deploy from `main`

## Conventions

- **Never `git add -A`** in this repo. There are publish-on-push data files (`data/digests/*.json`, `data/obsidian/*.md`) that mix code commits with content publishes. Stage explicit paths. (See `~/.claude/projects/.../memory/feedback_staging.md`.)
- **Voice + framing rules live in `VOICE.md`.** Read that before writing UI copy, error messages, button labels, commit messages, or editing the Phase 1/2/3 prompts. VOICE.md covers: audience, register, approved/banned vocabulary, the em-dash ban, effect-size-verbatim rule, bullet emoji vocabulary, source-type pills, framing principles. Build-time analyst LLM reads it too via `{{VOICE}}` substitution in `prompts/digest-v5-*.txt`.
- **Mobile-first.** Newsreader serif body, warm off-white (#f7f5f0) background. Viewport-responsive. Designed for 90-second scanning by a busy subspecialist. Visual design details in `DESIGN.md`.

## Key commands

```bash
# Ingestion
npm run pull:telegram           # drain @oncbrain_bot DMs into the inbox_items queue (offset-safe, no enrichment)
npm run enrich:inbox            # process the queue: tweet→oEmbed, paper→PubMed/Crossref, PDF→text/OCR + figure-structure + vault filing
npm run figure-extract -- --image=<png> [--json] [--model=...]            # v0.20: grounded figure extraction (Vision+Qwen→Opus) on one image
npm run figure-extract -- --pdf=<pdf> --page=<n> [--dpi=300] [--json]     # or one PDF page (poppler renders it); Ollama is optional — Vision-only without it
npm run backfill:pmc-oa-figures                                          # v0.24: OCR PMC open-access figure images for papers ingested via PMID/DOI/PMC (no PDF). --id / --date / --force. Non-OA papers skipped.
npm run admin                   # localhost:3001 admin form (date picker, conference tag, manual paste fallback)

# Build
npm run build:day               # rebuild today's digest
npm run build:day -- --date=2026-05-17
npm run build:day -- --backfill # rebuild every date that has bookmarks
npm run build:day -- --dry-run  # no LLM call, see what would happen
npm run rebuild:queued          # v0.23: rebuild PAST dates the enrichment layer flagged after a richer re-send (full-paper PDF merged figures onto an abstract-only study, late slide); drains rebuild_queue. --skip=d1,d2 drops already-rebuilt dates. Run by the daily cron.
npm run build                   # Astro static build

# Durable digest overrides (survive build:day regeneration)
npm run override -- --date=2026-05-20 --list                 # show studies + slugs
npm run override -- --date=2026-05-20 --suppress=<slug>      # drop a study
npm run override -- --date=2026-05-20 --edit=<slug> --tldr="..."  # override text
# v0.13: per-study "Trials to watch" overrides
npm run override -- --date=2026-05-20 --related-trials-suppress=<slug>                   # hide all
npm run override -- --date=2026-05-20 --related-trials-suppress=<slug> --question="..."  # per question
npm run override -- --date=2026-05-20 --related-trials-set=<slug> --json='[...]'         # pin set
npm run override -- --date=2026-05-20 --related-trials-clear=<slug>                       # clear
npm run studio                  # interactive TUI (suppress/edit studies, trials-to-watch, build, ingest) wraps the above via @clack/prompts

# Cross-day duplicate detection (v0.26)
npm run find:dups               # scan published digests for the same trial covered on >1 date (shared NCT + discriminating acronym key); prints suggested --suppress commands. READ-ONLY. --json for tooling
# Also: the enrich-time nudge (notifyPriorCoverage) DMs the curator when a submission matches an earlier study
# (by NCT or acronym) and both cards will publish; reply "drop <date>/<slug>" in Telegram to suppress the earlier
# one (writes a suppress override + queues a rebuild). Never auto-suppresses; default keeps both.

# Deeper analysis (optional config — see "LLM backend")
DIGEST_STUDY_MODEL=opus npm run build:day -- --date=<date>               # Opus on Phase 2 only (works on claude-cli)
DIGEST_THINKING=8000 LLM_BACKEND=api npm run build:day -- --date=<date>  # + Phase 2 extended thinking (api only)
DIGEST_PERSPECTIVE=radonc npm run build:day -- --date=<date>            # specialty lens for Phase 2 (radonc | medonc | your own); see prompts/perspectives/

# Tests + eval
npm test                        # vitest run (1000+ tests)
npm run eval                    # LLM-as-judge eval (score: factual / clinical / citation / clustering / hallucinations / v0.13 query+trial axes)
npm run quality-eval                                # multi-persona quality review of today's digest
npm run quality-eval -- --date=2026-06-05           # specific day
npm run quality-eval -- --date=2026-06-05 --dry-run # print the persona prompts, no LLM calls
# Reports land at ~/.gstack/projects/nb2276-oncbrain/quality-reports/<date>.md

# Autopilot
npm run cron:install            # macOS launchd job at 01:00 local daily
sudo pmset repeat wakeorpoweron MTWRFSU 00:55:00   # wake laptop 5min before 1am cron (sleep guard)

# Local preview
npm run preview                 # Astro preview (after npm run build)
```

## LLM backend

`LLM_BACKEND` env var:

- `api` — Anthropic API via `@anthropic-ai/sdk`. Requires real `ANTHROPIC_API_KEY`. Supports vision (passes pbs.twimg.com image URLs to Claude as content blocks). Fast (~30s per build). Pay-per-token.
- `claude-cli` — shells out to `claude -p`. Uses Claude Code subscription. No image input (CLI doesn't accept `--image` in `-p` mode), so vision falls back to "Images not accessible" in bullets. Slower (2-5 min per build). No per-call cost. **This is the default for builds** (no per-token cost).

The CLI client (`src/lib/llm-client.ts`) scrubs `ANTHROPIC_API_KEY` from the child process env so a stale or placeholder key can't hijack subscription auth.

**Prompt caching (api):** VOICE.md is sent once as a leading cache-flagged content block (`cache: true` on the `LlmTextBlock`), shared across every phase + study-agent call in a build — so a busy day re-uses one cached VOICE block (~10% billing on hits) instead of re-billing it ~20×. No-op on `claude-cli`.

**Per-phase model + thinking (config, not hardcoded):** each of the three phases
is independently selectable; every per-phase var falls back to `DIGEST_MODEL`,
then the client default (sonnet).
- `DIGEST_MODEL` — model for all phases (default sonnet).
- `DIGEST_GROUPING_MODEL` — Phase 1 (clustering) only. Falls back to `DIGEST_MODEL`.
- `DIGEST_STUDY_MODEL` — Phase 2 (per-study agents) only, the deep step (e.g. `opus` on cli, `claude-opus-4-7` on api). Falls back to `DIGEST_MODEL`.
- `DIGEST_SYNTHESIS_MODEL` — Phase 3 (lede + cross-site TL;DR + open questions) only. Falls back to `DIGEST_MODEL`.
- `DIGEST_THINKING` — Phase 2 extended-thinking token budget (e.g. `8000`). **api backend only** (the builder warns + ignores it on cli). Forces temperature=1 and reserves the budget on top of max_tokens.

**Specialty perspective (Phase 2 lens, config not hardcoded):** `DIGEST_PERSPECTIVE`
selects a subspecialty lens that biases the per-study analysis toward one
reader's decision needs without changing the schema. The value is a profile name
resolved to `prompts/perspectives/<name>.md` and injected into the study-agent
prompt's `{{PERSPECTIVE}}` slot (Phase 2 only; Phases 1 + 3 stay specialty-neutral).
Shipped profiles: `radonc` (foregrounds RT role + magnitude, isolates RT's
contribution from a systemic backbone, surfaces dose/fractionation/target volume
and local-regional endpoints), `medonc` (foregrounds regimen, biomarker gating,
sequencing). Unset / blank / unknown name = no bias (byte-identical to the prior
one-size-fits-all default). The name is sanitized to a single safe path segment.
Set it per-build (`DIGEST_PERSPECTIVE=radonc npm run build:day -- --date=…`) or
make it permanent for manual + cron builds via `.env`. Add a new lens by dropping
a `prompts/perspectives/<name>.md` file (see that dir's README). The lens never
licenses invented numbers: the VOICE no-fabrication rule outranks it, and a
magnitude the lens wants but the source text lacks (e.g. a subgroup HR locked in a
figure) is flagged as missing, not guessed.

## Schema (digest output, v0.7+ study shape)

```ts
DigestOutput {
  top_line: string         // one sentence, headline number
  tldr: string             // 2-3 sentences cross-site
  sites: DigestSite[]      // grouped by disease site enum
}

DigestSite {
  disease_site: string     // slug from disease-sites.ts enum
  intro: string | null
  studies: DigestStudy[]
  open_questions: string[] | null
}

DigestStudy {
  name: string             // specific trial name (PRESTIGE-PSMA, ARANOTE)
  tldr: string             // ONE sentence with headline number
  details: DigestDetail[]  // bullets: string | {text, subdetails} | {text, table}
  nct: string | null
  slug?: string            // v0.6: stable per-study anchor + search id (deriveSlug fallback)
  tweet_ids: number[]      // back-compat synthetic ids
  source_ids?: SourceRef[] // v0.5: typed refs → bookmarks / papers / slide_uploads
  verdict?: StudyVerdict   // v0.7: {soc_implication, rationale, audience} SOC-triage pill
  significance?: string | null  // v0.22: perspective-framed "Why it matters" prose (2-4 sentences). The ONE long-form surface on the card, an always-visible callout under the verdict. Generated by Phase 2 under the active DIGEST_PERSPECTIVE lens; surfaces the subtle additive figure/table/results detail the terse bullets drop and names the decision it moves. Grounded (no-fabrication outranks the lens); abstains (null) when nothing additive. Heading carries significance_perspective
  significance_perspective?: string | null  // v0.22: lens display label ("Radiation oncology") stamped at build from DIGEST_PERSPECTIVE; drives the "WHY IT MATTERS · {label}" heading. Null when no perspective set (generic heading) or no significance
  content_type?: ContentType  // v0.16: 'study_report' (default, absent) | 'review'; decided at Phase 1. A review carries NO verdict (stripped at build) and renders discussed_trials instead of a numbers-first card
  discussed_trials?: string[] // v0.16: trial acronyms a review names, lifted verbatim. Hard rule: NO NCT is ever inferred/linked for a bare acronym, and a review study itself carries no nct (forced null at parse, v0.audit). v0.17 (T6) DOES deep-link an acronym to a same-date study card the curator approved-resolved from it, via an in-page #slug anchor (discussed_trial_links) — never a clinicaltrials.gov URL. Empty/absent for study reports
}
```

**Disease-site enum** (`src/lib/disease-sites.ts`): 22 slugs covering solid tumors head-to-toe, liquid tumors, oligomet/supportive/safety cross-cutting. Slugs → labels + emojis. LLM picks the most specific site per cluster; unknown slugs map to `other`.

## File layout

```
src/
  lib/
    db.ts                  SQLite schema + queries + migrations (bookmarks, papers, slide_uploads, inbox_items, conferences, settings)
    telegram-ingest.ts     Telegram Bot API: extractTweetUrls / extractPaperPmids / extractPaperUrls / extractPdfDocument / extractSlidePhoto + sendMessage
    inbox-enrichment.ts    Type-dispatched enrichment loop (tweet→bookmark, paper→papers, slide→slides, PDF→papers + v0.15 figure OCR + v0.20 grounded figure structuring when a local Qwen/Ollama is up); E2/E3 replies; cross-day NCT nudge; conference auto-stamp via detectAndEnsureConference
    conference-detect.ts   v0.14.9: detect a major oncology meeting (ASCO/ESMO/ASTRO/AACR/ASH/SABCS + ASCO GU/GI) from a source's hashtags / URL-hosts / prose so bot-ingested sources get a conference_slug
    twitter-fetch.ts       oEmbed (text + html) + syndication (images), parallel
    tweet-syndication.ts   Twitter syndication CDN client (token formula derivation)
    pubmed-client.ts       NCBI E-utilities: efetch PubMed metadata + abstract, PMC for Methods/Results
    crossref-client.ts     v0.8 PR1: DOI-keyed metadata via Crossref REST (polite pool)
    paper-url.ts           v0.8 PR1: classify + extract DOI / journal / PMC paper URLs; trade-press host allowlist (isTradePressUrl)
    html-meta.ts           v0.8 PR1: Highwire + OpenGraph meta extraction from journal pages
    doi.ts                 v0.8 PR1: normalizeDoi (single canonicalization) + extractDois
    ssrf-fetch.ts          v0.8 PR1: SSRF-safe HTTPS fetch (private-IP block, per-hop redirect revalidation)
    pdf-text.ts            v0.8 PR2: pdftotext + pdftoppm→Vision OCR fallback (poppler). v0.15: extractPdfFigureOcr — pdfimages-targeted OCR of figure pages (numbers printed inside KM curves / forest plots / image-rendered tables that the text layer can't see). v0.20: rasterizePageToPngs (caller-cleaned page images for the structured pipeline)
    qwen-client.ts         v0.20: local Qwen2.5-VL via an Ollama HTTP server (base64 image, raised num_ctx). isQwenAvailable() probe + FIGURE_STRUCTURED=off kill switch + placeholder/oversize guards. Graceful-degrade, never throws
    figure-extract.ts      v0.20: grounded figure extraction — Vision (recall) + Qwen (structure) → Opus reconcile, with a deterministic role-aware grounding gate that withholds the whole merge to raw OCR if any number isn't in the OCR. extractFigure (image) + extractPdfFigureStructured (PDF page). Output → papers.figure_structured_md (local-only)
    pmc-oa.ts              v0.24: figures for PMC papers ingested WITHOUT a PDF. Tier A (pubmed-client extractFigureCaptions): figure/table captions from the already-fetched nxml → study-agent input. Tier B (this file): for the PMC OPEN-ACCESS subset, query oa.fcgi → download+untar the OA package (host-pinned, tar-slip/bomb-validated) → pick figure images from the nxml → reuse ocrFile + extractFigure (same v0.20 grounding gate) → local-only figure_ocr_md/figure_structured_md. Best-effort, gated (OA subset + macOS Vision + PMC_OA_FIGURES=off kill switch). Non-OA (JCO/Lancet/NEJM) skipped. Backfill: npm run backfill:pmc-oa-figures. v0.25: resolvePmcIdForDoi (NCBI idconv, DOI-verified) so DOI-only OA papers also reach this path.
    html-figures.ts        v0.25: OPT-IN (HTML_FIGURE_OCR=on, default OFF) figure OCR for TRADE-PRESS article pages (UroToday/ASCO Post/OncLive). Extracts figure-candidate <img> URLs from the fetched HTML (same registrable domain, figure-heuristic, positive-signal), fetches each pinned to the article's own domain (SSRF-safe), and emits ONLY the grounded structured extract (Qwen+Opus, never raw OCR) into local-only figure_structured_md. Copyrighted source → grounded-numbers-only by design; trade-press-only to keep the domain-pin safe.
    pdf-meta.ts            v0.8 PR2: LLM metadata extraction from PDF text (+ DOI/PMID regex backstop)
    pdf-storage.ts         v0.8 PR2: file PDFs to the gitignored Obsidian vault (papers/<site>/<slug>.pdf)
    slide-photo-storage.ts Telegram getFile download + magic-byte sniff + disk save
    vision-ocr.ts          Apple Vision OCR (macOS-only); image fetch + caption validator
    nct-coverage.ts        v0.8 PR3: cross-day NCT coverage index + prior-coverage lookup
    source-association.ts  NCT + trial-acronym weighted graph; soft Phase 1 clustering hints
    extract.ts             NCT / PMID / DOI regex + auto-link
    slug.ts / slug-resolve.ts  deriveSlug + per-date slug disambiguation (anchors, search, API)
    llm-client.ts          AnthropicLlmClient + ClaudeCliLlmClient + multimodal blocks
    llm-pipeline.ts        Three-phase pipeline (group → per-study agent → synthesis); DigestInputItem union; verdict parse
    obsidian-export.ts     Markdown export: YAML frontmatter + wikilinks + source-type pills + filed-PDF embed
    feed.ts                v0.8 PR3: RSS 2.0 builder
    api-output.ts          v0.8 PR3: JSON API shapers (digests index, per-study, sanitized per-date)
    digest-data.ts         Astro page data loaders (listDigests, listSiteSummaries, listRecentStudies; v0.21: listStudyPages + StudyPageEntry — one entry per study behind the standalone /study/ page + its OG card)
    digest-overrides.ts    durable per-date overrides: suppress/edit studies, applied at build time (applyOverrides + saveOverrides)
    verdict.ts             v0.9: SOC-implication verdict taxonomy (emoji + label), shared by StudyCard + TriageRail. v0.16: REVIEW_GLYPH (🗞️) + railEmojiForStudy (verdict emoji, else 🗞️ for a review, else neutral dot)
    content-type.ts        v0.16: study content_type (study_report | review) — first-class, orthogonal to methodology + verdict; parseContentType + stripReviewVerdicts (a review carries no verdict). Classified at Phase 1; NOT a /tags/ namespace
    disease-sites.ts       22-site enum (slug → label + emoji + rationale; see DESIGN.md)
  pages/
    index.astro            home: disease-site nav + hero TL;DR + recent-studies feed + live search
    about.astro            what it is / how it works / curator (linked from the header)
    [date].astro           daily digest, grouped by disease site; per-study verdict pills
    sites/index.astro      browse-by-site grid
    sites/[site].astro     all studies for one site across dates, newest first
    study/[slug].astro     v0.21: standalone per-study page at /study/<date>-<slug>/ — the share-button target; og:title is the study name (+ " — oncbrain") and og:image is the per-study card, so a shared link unfurls with the study, not the site card. Renders the same StudyCard the date/site pages use
    conferences/[slug]/    conference index (all days tagged with a conference)
    og/study/[slug].png.ts v0.21: per-study OG card at /og/study/<date>-<slug>.png (share-image.ts studyCard: study name + headline number + verdict pill); og:image for the standalone study page
    search-index.json.ts   v0.6: build-time search index (one entry per study)
    feed.xml.ts            v0.8 PR3: RSS 2.0 feed (latest 30 studies)
    api/index.astro        v0.8 PR3: public RSS + JSON API docs page
    api/v1/digests.json.ts        v0.8 PR3: index of published days + counts
    api/v1/digest/[date].json.ts  v0.8 PR3: one day's artifact (papers sanitized, no full text)
    api/v1/study/[slug].json.ts   v0.8 PR3: one study, cross-date resolved
  components/StudyCard.astro  v0.9: the single dense study card (triage-first — rests at name/TL;DR/verdict/comparator, folds depth); rendered by [date] + sites/[site] + tags/[...slug] + (v0.21) study/[slug]
  components/TriageRail.astro v0.9: desktop-only (>=1200px) sticky jump-list (verdict emoji + name) in the left gutter
  components/SearchBox.astro  live search input + results dropdown; lives in the global header (Base.astro), lazy-loads the index
  layouts/Base.astro       shell: Newsreader font, RSS <link>, widgets.js, header (title + search + About/curator on one line), desktop depth-auto-expand script (>=1024px), disclaimer + API/RSS footer
prompts/
  digest-v5-grouping.txt     CURRENT Phase 1: cluster sources into studies
  digest-v5-study-agent.txt  CURRENT Phase 2: per-study deep-analysis (parallel)
  digest-v5-synthesis.txt    CURRENT Phase 3: lede + cross-site TL;DR + open questions
  digest-v1..v4.txt          retained for diff / rollback
  pdf-meta-v1.txt            v0.8 PR2: PDF metadata extraction (treat-text-as-data guard)
  figure-reconcile-v1.txt    v0.20: Opus merge prompt — reconcile Vision + Qwen figure reads (treat-input-as-data + the grounding rule: omit any number not in the OCR)
  eval-judge-v1.txt          LLM-as-judge rubric
build/
  digest-builder.ts        CLI: pull pending sources → build sites/studies → write JSON + Obsidian
  manage-overrides.ts      CLI (npm run override): edit data/overrides/<date>.json (suppress/edit studies)
  studio.ts                CLI (npm run studio): interactive @clack/prompts TUI over overrides + build:day + pull/enrich
  pull-telegram.ts         CLI: poll Telegram bot, write inbox_items
  enrich-inbox.ts          CLI: drain pending inbox_items into typed source tables (sweeps orphaned OCR temp dirs)
  figure-extract.ts        CLI (npm run figure-extract): grounded figure extraction on one image or PDF page (Vision+Qwen→Opus); manual runs / spikes
  notify-curator.ts        CLI: Telegram "build done" summary to the curator
  eval.ts                  CLI: run eval, score against rubric
  seed-dev.ts              dev fixture
admin/server.ts            Hono server, localhost only, port 3001
scripts/
  daily-build.sh           1am autopilot: pull → enrich → build:day → build → push
  link-slides.sh           pre-build hook: ensures public/slides symlink → data/slide-photos
  cron-doctor.sh           diagnose a missed overnight run
  launchd/                 plist template + install/uninstall
test/                      vitest unit tests
docs/
  plans/                   per-release planning artifacts (e.g. v0.5-multi-source-ingestion.md, v0.6-pwa.md)
data/
  digests/<date>.json           committed digest artifacts (consumed by Astro getStaticPaths)
  overrides/<date>.json         committed curator overrides applied at build (suppress/edit studies)
  obsidian/<date>[-<conf>].md   committed Obsidian markdown twin
  obsidian/papers/<site>/<slug>.pdf  v0.8 PR2: filed full-text PDFs (gitignored, never published)
  slide-photos/<date>/<uuid>.<ext>  curator slide uploads (gitignored by default — see CHANGELOG v0.5)
public/
  favicon.svg / favicon.ico
  slides -> ../data/slide-photos  symlink for Astro static asset serving
DESIGN.md                  design system source-of-truth (type, color, voice, emoji vocab)
TODOS.md                   deferred work tracker (seeded from CHANGELOG "Not yet shipped" sections)
.do/app.yaml               DigitalOcean App Platform spec
```

## Deploy mechanics

- GitHub repo: `nb2276/oncbrain` (public — repo and all PR/commit contents are world-readable; keep secrets out of code, commits, and PR bodies)
- DO app: `6ce55877-da68-4a8d-aacd-1b1f244733dd`, region SFO, static site free tier
- Domain: `oncbrain.oncologytoolkit.com` (PRIMARY, Let's Encrypt cert)
- Fallback URL: `oncbrain-k4i4q.ondigitalocean.app`
- Auto-deploy: every push to `main` triggers DO build. ~40s commit → live.
- Twitter widget: `platform.twitter.com/widgets.js` loaded once in `Base.astro`. Replaces source-card blockquotes with native X cards (images served from Twitter CDN, no IP risk for us).

## Operational notes

- **Working dir is in Dropbox** (`/Users/nboehling/Library/CloudStorage/Dropbox/dev/oncbrain`). `node_modules` and `dist` are `xattr com.dropbox.ignored` to avoid sync churn. Reapply if reinstalling. If this directory is renamed, re-run `npm run cron:install` — the launchd plist bakes the absolute path, so a rename without reinstall silently breaks the 1am cron.
- **Local DB** (`oncbrain.db`) is gitignored. Phone-bookmarking is via Telegram bot, NOT remote DB — admin runs locally only.
- **Cron** at 1am Pacific via launchd (early enough that its claude-cli usage clears the rolling 5-hour subscription window before the morning). If Mac is asleep, pmset wake at 00:55 is required.
- **Channel distribution (v0.14.7 T5).** After the build + push, the cron runs `npm run notify:channel` per changed date, posting a reader-facing announcement (top-line + verdict-emoji study list + deep link, which Telegram previews with the T4 OG card) to a public Telegram channel. Config: `TELEGRAM_CHANNEL_ID` (`.env`) = the channel `@username` or numeric id, with `@oncbrain_bot` added as a channel ADMIN. Unset → the step self-skips (ships dormant). Distinct from `notify:curator` (the curator's private "build done" DM). `npm run notify:channel -- --dry-run` previews the post without sending.
- **Curator name** (`PUBLIC_CURATOR_NAME`, `PUBLIC_CURATOR_HANDLE`) is local-only — DO's build doesn't see `.env`. Set these as DO app env vars to attribute on the live site.
- **Filed PDFs are local-only** (v0.8 PR2). Full-text PDFs forwarded to the bot are filed under `data/obsidian/papers/<site>/<slug>.pdf` (gitignored, no `public/` symlink, never in the Astro build) and embedded in the Obsidian daily note. The public site carries only the summary. This is a hard IP constraint — never publish the PDFs (a test in `test/publish-boundary.test.ts` guards it).

## Skill routing

When a user request matches a gstack skill, invoke via the Skill tool:

- Product ideas / brainstorming → `/office-hours`
- Strategy / scope expansion → `/plan-ceo-review`
- Architecture lock-in → `/plan-eng-review`
- Visual polish → `/design-review` (live site) or `/plan-design-review` (pre-build)
- Pre-landing PR review → `/review`
- Bugs / errors → `/investigate`
- QA the live site → `/qa` or `/qa-only`
- Ship / deploy → `/ship` or `/land-and-deploy`

## Testing

```
npm test                   # 469 tests, all should pass
npm run test:watch         # vitest watch mode
npx astro check            # type check (0 errors expected)
```

Tests live in `test/`. Each lib module has a corresponding test file. Naming convention: `test/<module>.test.ts`.

## Versioning

Single source of truth: `package.json` `"version"` field. CHANGELOG.md gets a new section per release. Currently v0.8.0 (non-PMID + PDF source ingestion: DOI/journal/PMC URLs and full-text PDFs filed to a private Obsidian vault, plus an RSS feed and versioned JSON API; bundles the v0.6 live search and the v0.7 standard-of-care verdict).

## Planning artifacts

- **`DESIGN.md`** — design system source-of-truth (type, color, voice, emoji vocabulary, layout principles). Read before any visual change.
- **`TODOS.md`** — deferred work tracker. Seeded from CHANGELOG "Not yet shipped" sections; grouped by target milestone (v0.5.1, v0.6, v0.7+).
- **`docs/plans/<version>-*.md`** — per-release implementation plans. Phased breakdowns, file touchpoints, test plans, codex review history.

## Don't

- Don't use `git add -A` (see Conventions).
- Don't add a number to a digest that isn't in a source tweet/image. Comparative claims must be grounded — if uncertain a comparator trial is real, omit rather than hallucinate.
- Don't refactor the IMRD/sites schema casually — Astro pages, Obsidian export, and the LLM prompt all depend on it.
- Don't write to `dist/` or `node_modules/` paths from scripts — they're generated.
- Don't push without running `npm test` + `npx astro check` first.
- Don't merge tweet text into LLM analysis without preserving citations (NCT, PMID, DOI). The auto-link layer assumes these survive.

## Anything ambiguous?

Default behavior:
- Pick a real typeface over `system-ui`.
- Pick a serif body over sans for clinical content (Newsreader is current).
- Cards earn their existence — don't decorate without a function.
- Brevity beats completeness in output. Depth shows in WHAT bullets get included.
