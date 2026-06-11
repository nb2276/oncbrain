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
- **PDF ingestion** (v0.8 PR2): poppler (`brew install poppler`) provides `pdftotext` (text layer) + `pdftoppm` (rasterize scanned pages for Apple Vision OCR). No npm dep. A missing binary yields a clear Telegram reply, not a crash.
- **Deploy**: DigitalOcean App Platform, static-site free tier, GitHub auto-deploy from `main`

## Conventions

- **Never `git add -A`** in this repo. There are publish-on-push data files (`data/digests/*.json`, `data/obsidian/*.md`) that mix code commits with content publishes. Stage explicit paths. (See `~/.claude/projects/.../memory/feedback_staging.md`.)
- **Voice + framing rules live in `VOICE.md`.** Read that before writing UI copy, error messages, button labels, commit messages, or editing the Phase 1/2/3 prompts. VOICE.md covers: audience, register, approved/banned vocabulary, the em-dash ban, effect-size-verbatim rule, bullet emoji vocabulary, source-type pills, framing principles. Build-time analyst LLM reads it too via `{{VOICE}}` substitution in `prompts/digest-v5-*.txt`.
- **Mobile-first.** Newsreader serif body, warm off-white (#f7f5f0) background. Viewport-responsive. Designed for 90-second scanning by a busy subspecialist. Visual design details in `DESIGN.md`.

## Key commands

```bash
# Ingestion
npm run pull:telegram           # drain @oncbrain_bot DMs into the inbox_items queue (offset-safe, no enrichment)
npm run enrich:inbox            # process the queue: tweet→oEmbed, paper→PubMed/Crossref, PDF→text/OCR + vault filing
npm run admin                   # localhost:3001 admin form (date picker, conference tag, manual paste fallback)

# Build
npm run build:day               # rebuild today's digest
npm run build:day -- --date=2026-05-17
npm run build:day -- --backfill # rebuild every date that has bookmarks
npm run build:day -- --dry-run  # no LLM call, see what would happen
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

# Deeper analysis (optional config — see "LLM backend")
DIGEST_STUDY_MODEL=opus npm run build:day -- --date=<date>               # Opus on Phase 2 only (works on claude-cli)
DIGEST_THINKING=8000 LLM_BACKEND=api npm run build:day -- --date=<date>  # + Phase 2 extended thinking (api only)

# Tests + eval
npm test                        # vitest run (1000+ tests)
npm run eval                    # LLM-as-judge eval (score: factual / clinical / citation / clustering / hallucinations / v0.13 query+trial axes)
npm run quality-eval                                # multi-persona quality review of today's digest
npm run quality-eval -- --date=2026-06-05           # specific day
npm run quality-eval -- --date=2026-06-05 --dry-run # print the persona prompts, no LLM calls
# Reports land at ~/.gstack/projects/nb2276-oncbrain/quality-reports/<date>.md

# Autopilot
npm run cron:install            # macOS launchd job at 06:00 local daily
sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00   # wake laptop 5min before 6am cron (sleep guard)

# Local preview
npm run preview                 # Astro preview (after npm run build)
```

## LLM backend

`LLM_BACKEND` env var:

- `api` — Anthropic API via `@anthropic-ai/sdk`. Requires real `ANTHROPIC_API_KEY`. Supports vision (passes pbs.twimg.com image URLs to Claude as content blocks). Fast (~30s per build). Pay-per-token.
- `claude-cli` — shells out to `claude -p`. Uses Claude Code subscription. No image input (CLI doesn't accept `--image` in `-p` mode), so vision falls back to "Images not accessible" in bullets. Slower (2-5 min per build). No per-call cost. **This is the default for builds** (no per-token cost).

The CLI client (`src/lib/llm-client.ts`) scrubs `ANTHROPIC_API_KEY` from the child process env so a stale or placeholder key can't hijack subscription auth.

**Prompt caching (api):** VOICE.md is sent once as a leading cache-flagged content block (`cache: true` on the `LlmTextBlock`), shared across every phase + study-agent call in a build — so a busy day re-uses one cached VOICE block (~10% billing on hits) instead of re-billing it ~20×. No-op on `claude-cli`.

**Per-phase model + thinking (config, not hardcoded):**
- `DIGEST_MODEL` — model for all phases (default sonnet).
- `DIGEST_STUDY_MODEL` — Phase 2 (per-study agents) only, the deep step (e.g. `opus` on cli, `claude-opus-4-7` on api). Falls back to `DIGEST_MODEL`.
- `DIGEST_THINKING` — Phase 2 extended-thinking token budget (e.g. `8000`). **api backend only** (the builder warns + ignores it on cli). Forces temperature=1 and reserves the budget on top of max_tokens.

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
}
```

**Disease-site enum** (`src/lib/disease-sites.ts`): 22 slugs covering solid tumors head-to-toe, liquid tumors, oligomet/supportive/safety cross-cutting. Slugs → labels + emojis. LLM picks the most specific site per cluster; unknown slugs map to `other`.

## File layout

```
src/
  lib/
    db.ts                  SQLite schema + queries + migrations (bookmarks, papers, slide_uploads, inbox_items, conferences, settings)
    telegram-ingest.ts     Telegram Bot API: extractTweetUrls / extractPaperPmids / extractPaperUrls / extractPdfDocument / extractSlidePhoto + sendMessage
    inbox-enrichment.ts    Type-dispatched enrichment loop (tweet→bookmark, paper→papers, slide→slides, PDF→papers); E2/E3 replies; cross-day NCT nudge
    twitter-fetch.ts       oEmbed (text + html) + syndication (images), parallel
    tweet-syndication.ts   Twitter syndication CDN client (token formula derivation)
    pubmed-client.ts       NCBI E-utilities: efetch PubMed metadata + abstract, PMC for Methods/Results
    crossref-client.ts     v0.8 PR1: DOI-keyed metadata via Crossref REST (polite pool)
    paper-url.ts           v0.8 PR1: classify + extract DOI / journal / PMC paper URLs; trade-press host allowlist (isTradePressUrl)
    html-meta.ts           v0.8 PR1: Highwire + OpenGraph meta extraction from journal pages
    doi.ts                 v0.8 PR1: normalizeDoi (single canonicalization) + extractDois
    ssrf-fetch.ts          v0.8 PR1: SSRF-safe HTTPS fetch (private-IP block, per-hop redirect revalidation)
    pdf-text.ts            v0.8 PR2: pdftotext + pdftoppm→Vision OCR fallback (poppler)
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
    digest-data.ts         Astro page data loaders (listDigests, listSiteSummaries, listRecentStudies)
    digest-overrides.ts    durable per-date overrides: suppress/edit studies, applied at build time (applyOverrides + saveOverrides)
    verdict.ts             v0.9: SOC-implication verdict taxonomy (emoji + label), shared by StudyCard + TriageRail
    disease-sites.ts       22-site enum (slug → label + emoji + rationale; see DESIGN.md)
  pages/
    index.astro            home: disease-site nav + hero TL;DR + recent-studies feed + live search
    about.astro            what it is / how it works / curator (linked from the header)
    [date].astro           daily digest, grouped by disease site; per-study verdict pills
    sites/index.astro      browse-by-site grid
    sites/[site].astro     all studies for one site across dates, newest first
    conferences/[slug]/    conference index (all days tagged with a conference)
    search-index.json.ts   v0.6: build-time search index (one entry per study)
    feed.xml.ts            v0.8 PR3: RSS 2.0 feed (latest 30 studies)
    api/index.astro        v0.8 PR3: public RSS + JSON API docs page
    api/v1/digests.json.ts        v0.8 PR3: index of published days + counts
    api/v1/digest/[date].json.ts  v0.8 PR3: one day's artifact (papers sanitized, no full text)
    api/v1/study/[slug].json.ts   v0.8 PR3: one study, cross-date resolved
  components/StudyCard.astro  v0.9: the single dense study card (triage-first — rests at name/TL;DR/verdict/comparator, folds depth); rendered by [date] + sites/[site]
  components/TriageRail.astro v0.9: desktop-only (>=1200px) sticky jump-list (verdict emoji + name) in the left gutter
  components/SearchBox.astro  live search input + results dropdown; lives in the global header (Base.astro), lazy-loads the index
  layouts/Base.astro       shell: Newsreader font, RSS <link>, widgets.js, header (title + search + About/curator on one line), desktop depth-auto-expand script (>=1024px), disclaimer + API/RSS footer
prompts/
  digest-v5-grouping.txt     CURRENT Phase 1: cluster sources into studies
  digest-v5-study-agent.txt  CURRENT Phase 2: per-study deep-analysis (parallel)
  digest-v5-synthesis.txt    CURRENT Phase 3: lede + cross-site TL;DR + open questions
  digest-v1..v4.txt          retained for diff / rollback
  pdf-meta-v1.txt            v0.8 PR2: PDF metadata extraction (treat-text-as-data guard)
  eval-judge-v1.txt          LLM-as-judge rubric
build/
  digest-builder.ts        CLI: pull pending sources → build sites/studies → write JSON + Obsidian
  manage-overrides.ts      CLI (npm run override): edit data/overrides/<date>.json (suppress/edit studies)
  studio.ts                CLI (npm run studio): interactive @clack/prompts TUI over overrides + build:day + pull/enrich
  pull-telegram.ts         CLI: poll Telegram bot, write inbox_items
  enrich-inbox.ts          CLI: drain pending inbox_items into typed source tables (sweeps orphaned OCR temp dirs)
  notify-curator.ts        CLI: Telegram "build done" summary to the curator
  eval.ts                  CLI: run eval, score against rubric
  seed-dev.ts              dev fixture
admin/server.ts            Hono server, localhost only, port 3001
scripts/
  daily-build.sh           6am autopilot: pull → enrich → build:day → build → push
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

- **Working dir is in Dropbox** (`/Users/nboehling/Library/CloudStorage/Dropbox/dev/oncbrain`). `node_modules` and `dist` are `xattr com.dropbox.ignored` to avoid sync churn. Reapply if reinstalling. If this directory is renamed, re-run `npm run cron:install` — the launchd plist bakes the absolute path, so a rename without reinstall silently breaks the 6am cron.
- **Local DB** (`oncbrain.db`) is gitignored. Phone-bookmarking is via Telegram bot, NOT remote DB — admin runs locally only.
- **Cron** at 6am Pacific via launchd. If Mac is asleep, pmset wake at 5:55 is required.
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
