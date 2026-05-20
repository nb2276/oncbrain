# CLAUDE.md — oncbrain project guide

Project-level context for AI agents (Claude Code and others) working on this codebase. Read this before making changes.

## What this is

**oncbrain** is a curated AI-summarized digest of oncology meeting tweets. A single oncologist bookmarks tweets from major meetings (ASCO, ESMO, ASTRO, AACR, plus subspecialty meets), an AI pipeline analyzes them with comparative literature context, and the output ships as a static site at **https://oncbrain.oncologytoolkit.com**.

The site is organized by disease site (`/sites/breast/`, `/sites/prostate/`, etc.) and by date (`/2026-05-17/`). Each study gets a per-study TL;DR with effect sizes verbatim, then bullets that include comparisons to recent / historic literature and methodological critique when warranted.

Audience: oncology subspecialists. Tone: subspecialist-to-subspecialist, peer-review register, terse.

## Pipeline at a glance

```
Telegram bot  ─┐
               ├─▶ SQLite (oncbrain.db) ─▶ digest-builder
admin form  ───┘                              │
                                              ├─▶ oEmbed fetch (text + html)
                                              ├─▶ syndication CDN (image URLs)
                                              ├─▶ LLM (claude-sonnet-4-6) with vision
                                              ▼
                              data/digests/<date>.json    ─┐
                              data/obsidian/<date>.md      ├─▶ git push ─▶ DO deploy
                              data/digests/<date>.json     ┘    (~40s)
                                              │
                                              ▼
                              Astro static site → oncbrain.oncologytoolkit.com
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
npm run pull:telegram           # drain @oncbrain_bot DMs into SQLite
npm run admin                   # localhost:3001 admin form (date picker, conference tag, manual paste fallback)

# Build
npm run build:day               # rebuild today's digest
npm run build:day -- --date=2026-05-17
npm run build:day -- --backfill # rebuild every date that has bookmarks
npm run build:day -- --dry-run  # no LLM call, see what would happen
npm run build                   # Astro static build

# Tests + eval
npm test                        # vitest run (469 tests)
npm run eval                    # LLM-as-judge eval (score: factual / clinical / citation / clustering / hallucinations)

# Autopilot
npm run cron:install            # macOS launchd job at 03:00 local daily
sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00   # wake laptop 5min before 6am cron (sleep guard)

# Local preview
npm run preview                 # Astro preview (after npm run build)
```

## LLM backend

`LLM_BACKEND` env var:

- `api` — Anthropic API via `@anthropic-ai/sdk`. Requires real `ANTHROPIC_API_KEY`. Supports vision (passes pbs.twimg.com image URLs to Claude as content blocks). Fast (~30s per build). Pay-per-token (~$0.10/build).
- `claude-cli` — shells out to `claude -p`. Uses Claude Code subscription. No image input (CLI doesn't accept `--image` in `-p` mode), so vision falls back to "Images not accessible" in bullets. Slower (2-5 min per build). No per-call cost.

The CLI client (`src/lib/llm-client.ts`) scrubs `ANTHROPIC_API_KEY` from the child process env so a stale or placeholder key can't hijack subscription auth.

## Schema (v0.3)

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
  details: string[]        // bullets: endpoints, comparisons, critique
  nct: string | null
  tweet_ids: number[]      // multiple tweets per study = collapsed group
}
```

**Disease-site enum** (`src/lib/disease-sites.ts`): 22 slugs covering solid tumors head-to-toe, liquid tumors, oligomet/supportive/safety cross-cutting. Slugs → labels + emojis. LLM picks the most specific site per cluster; unknown slugs map to `other`.

## File layout

```
src/
  lib/
    db.ts                  SQLite schema + queries (bookmarks, papers, slide_uploads, inbox_items, conferences, settings)
    twitter-fetch.ts       oEmbed (text + html) + syndication (images), parallel
    tweet-syndication.ts   Twitter syndication CDN client (token formula derivation)
    pubmed-client.ts       NCBI E-utilities client: efetch pubmed metadata + abstract, efetch PMC for Methods/Results
    source-association.ts  NCT + trial-acronym weighted graph; soft Phase 1 clustering hints
    inbox-enrichment.ts    Type-dispatched enrichment loop (tweet → bookmark, paper → papers, slide → slide_uploads)
    extract.ts             NCT / PMID / DOI regex + auto-link
    llm-client.ts          AnthropicLlmClient + ClaudeCliLlmClient + multimodal blocks
    llm-pipeline.ts        Three-phase pipeline (group → per-study agent → synthesis); DigestInputItem union
    image-ocr.ts           Apple Vision OCR (macOS-only); pbs.twimg.com fetch + caption validator
    obsidian-export.ts     Markdown export with YAML frontmatter + wikilinks + source-type pills
    digest-data.ts         Astro page data loaders (listDigests, listSiteSummaries)
    disease-sites.ts       22-site enum (slug → label + emoji; see DESIGN.md)
    telegram-ingest.ts     Telegram Bot API client + extractTweetUrls + extractPaperPmids + slide download
  pages/
    index.astro            recent dates + browse strip
    about.astro            disclaimer + curator info
    [date].astro           daily digest, grouped by disease site
    sites/index.astro      browse-by-site grid
    sites/[site].astro     all studies for one site across dates, newest first
    conferences/[slug]/    conference index (all days tagged with a conference)
  layouts/Base.astro       shell: Newsreader font, widgets.js, disclaimer footer
prompts/
  digest-v5-grouping.txt     CURRENT Phase 1: cluster sources into studies
  digest-v5-study-agent.txt  CURRENT Phase 2: per-study deep-analysis (parallel)
  digest-v5-synthesis.txt    CURRENT Phase 3: lede + cross-site TL;DR + open questions
  digest-v1..v4.txt          retained for diff / rollback
  eval-judge-v1.txt          LLM-as-judge rubric
build/
  digest-builder.ts        CLI: pull pending sources → build sites/studies → write JSON + Obsidian
  pull-telegram.ts         CLI: poll Telegram bot, write inbox_items
  enrich-inbox.ts          CLI: drain pending inbox_items into typed source tables
  eval.ts                  CLI: run eval, score against rubric
  seed-dev.ts              dev fixture
admin/server.ts            Hono server, localhost only, port 3001
scripts/
  daily-build.sh           6am autopilot: pull → enrich → build:day → build → push
  link-slides.sh           pre-build hook: ensures public/slides symlink → data/slide-photos
  launchd/                 plist template + install/uninstall
test/                      vitest unit tests
docs/
  plans/                   per-release planning artifacts (e.g. v0.5-multi-source-ingestion.md, v0.6-pwa.md)
data/
  digests/<date>.json           committed digest artifacts (consumed by Astro getStaticPaths)
  obsidian/<date>[-<conf>].md   committed Obsidian markdown twin
  slide-photos/<date>/<uuid>.<ext>  curator slide uploads (gitignored by default — see CHANGELOG v0.5)
public/
  favicon.svg / favicon.ico
  slides -> ../data/slide-photos  symlink for Astro static asset serving
DESIGN.md                  design system source-of-truth (type, color, voice, emoji vocab)
TODOS.md                   deferred work tracker (seeded from CHANGELOG "Not yet shipped" sections)
.do/app.yaml               DigitalOcean App Platform spec
```

## Deploy mechanics

- GitHub repo: `nb2276/oncbrain` (private)
- DO app: `6ce55877-da68-4a8d-aacd-1b1f244733dd`, region SFO, static site free tier
- Domain: `oncbrain.oncologytoolkit.com` (PRIMARY, Let's Encrypt cert)
- Fallback URL: `oncbrain-k4i4q.ondigitalocean.app`
- Auto-deploy: every push to `main` triggers DO build. ~40s commit → live.
- Twitter widget: `platform.twitter.com/widgets.js` loaded once in `Base.astro`. Replaces source-card blockquotes with native X cards (images served from Twitter CDN, no IP risk for us).

## Operational notes

- **Working dir is in Dropbox** (`/Users/nboehling/Library/CloudStorage/Dropbox/dev/MeetingSummary`). `node_modules` and `dist` are `xattr com.dropbox.ignored` to avoid sync churn. Reapply if reinstalling.
- **Local DB** (`oncbrain.db`) is gitignored. Phone-bookmarking is via Telegram bot, NOT remote DB — admin runs locally only.
- **Cron** at 6am Pacific via launchd. If Mac is asleep, pmset wake at 5:55 is required.
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
