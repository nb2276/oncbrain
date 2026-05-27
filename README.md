# oncbrain

Curated, AI-summarized digest of oncology meeting research. Continual cadence with prominence during major meetings (ASCO, ESMO, ASTRO, AACR, plus subspecialty meets). One oncologist curates the sources; an AI pipeline summarizes each study with comparative-literature context and a standard-of-care verdict.

**Live:** https://oncbrain.oncologytoolkit.com · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Current version:** 0.8.0

## Architecture

```
INGESTION                LOCAL (laptop only)                       GITHUB        DIGITALOCEAN
─────────                ───────────────────                       ──────        ────────────
Telegram bot ─────┐      pull:telegram ─▶ inbox_items queue                      App Platform
  tweets,         │                          │                      ▲           (static site)
  paper URLs /    ├──▶   enrich:inbox  ◀──────┘                      │                  │
  DOIs / PMIDs,   │        oEmbed · PubMed · Crossref ·              │                  ▼
  PDFs, slides    │        PDF text + Apple Vision OCR               │           public reads
admin form @ 3001 ┘                       ▼                          │           static HTML +
                         SQLite (oncbrain.db): bookmarks /           │           RSS + JSON API
                         papers / slide_uploads                      │           at oncbrain.
                                          │                          │           oncologytoolkit.com
                         build:day ─▶ 3-phase LLM (group →           │
                           per-study agent → synthesis) +            │
                           SOC verdict + literature comparison       │
                                          │                          │
                         data/digests/<date>.json     (committed)    │
                         data/obsidian/<date>.md       (committed)   │
                         data/obsidian/papers/<site>/  (gitignored)  │
                                          │                          │
                         astro build ─▶ HTML + /feed.xml +           │
                           /api/v1/*.json  ──▶ git push ─────────────┘
                                                                     │
                                                                     └─▶ auto-deploy on push
```

Admin form, Telegram poller, enrichment, and build pipeline run locally only. The public site is pure static HTML (plus the RSS feed and JSON API, also static). Full-text PDFs are filed into a gitignored Obsidian vault and never published.

## Setup (one time)

```bash
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY=sk-ant-...                (or set LLM_BACKEND=claude-cli)
#   TELEGRAM_BOT_TOKEN=...                       (from @BotFather — optional but recommended)
#   PUBLIC_CURATOR_NAME=Your Name, MD
#   PUBLIC_CURATOR_HANDLE=@yourhandle
#   PUBLIC_SITE_NAME=onc brain
#   PUBLIC_SITE_URL=https://oncbrain.oncologytoolkit.com
npm install
brew install poppler                            # PDF text + scanned-page rasterize (for PDF ingestion)
npm run setup:vision                            # compile the Apple Vision OCR binary (macOS only)
```

`poppler` and the Vision binary are only needed for PDF + slide ingestion; the rest runs without them (a missing binary yields a clear Telegram reply, not a crash).

## Adding content

Two ingestion paths, both write to the same SQLite inbox queue. Use either or both.

### Path A: Telegram bot (mobile-friendly, primary path)

1. Open Telegram, find `@BotFather`, send `/newbot`. Get a token, paste it into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Optional: create a private Telegram channel and add the bot as admin.
3. Throughout the day, DM the bot: tweet URLs, paper links (DOI / PubMed / journal pages), full-text PDFs, or slide photos (or post them in your private channel).
4. Drain the queue and enrich the items into bookmarks / papers / slides:

```bash
npm run pull:telegram   # writes each new message to the inbox_items queue (offset-safe, no enrichment)
npm run enrich:inbox    # tweets → oEmbed, papers → PubMed/Crossref, PDFs → text/OCR + vault filing
```

The bot also recognizes a `/note <text>` command on the same message to attach a curator note, and replies with what it ingested (or a named reason if it could not).

### Path B: localhost admin form

```bash
npm run admin           # http://localhost:3001
# Paste a tweet URL → date defaults to today → optional conference tag → optional note → save.
```

If oEmbed fails for a tweet, expand "Manual paste fallback" on the form and paste the tweet text directly.

## Publishing a digest

```bash
# 1. Ingest first (see "Adding content"):
npm run pull:telegram && npm run enrich:inbox

# 2. Build one date's digest:
npm run build:day                              # today's date
npm run build:day -- --date=2026-05-18         # a specific date
npm run build:day -- --backfill                # every date with sources (re-run is idempotent)
npm run build:day -- --dry-run                 # no LLM call, see what would happen

# Or curate interactively — suppress/edit studies, build, ingest — in one TUI:
npm run studio

# 3. Static build + publish:
npm run build                                  # Astro static build (preview locally with: npm run preview)
git add data/digests data/obsidian             # explicit paths — papers/ is gitignored, never staged
git commit -m "$(date +%Y-%m-%d)"
git push                                        # DigitalOcean auto-deploys in ~40 sec
```

## Digest format

Organized by **disease site** (22-slug enum, see `DESIGN.md`), newest date first. Built for 90-second scanning:

- **Top line** — one-sentence lede with the headline number.
- **TL;DR** — 2-3 sentence cross-site synthesis (also the home-page hero).
- **Per study card (triage-first):** rests at its triage layer — trial name, the eligible population ("For …"), a one-line **TL;DR** (effect sizes verbatim), a **standard-of-care verdict** pill (practice-changing / challenges-SOC / confirmatory / early-signal / caveats-dominate / unclear), and a 🔗 **"vs leading data"** comparator callout. Figures sit in their own column on wide screens (under the triage layer on narrow ones). The depth folds behind a tap and flows like a paper — **Methods** (design, regimen, CONSORT participant flow), **Results** (effect sizes + comparison tables), **Critique** (methodological caveats), then **Open questions** and source attribution. **Sources** (🐦 📄 🩻) are a separate collapsible.
  - On mobile the depth stays folded for the 90-second scan; on desktop (≥1024px) it auto-expands, and a sticky **triage rail** (≥1200px) lists every study by verdict for quick jumping.

Disease-site emoji anchors live in `DESIGN.md`; the per-study bullet + verdict emoji vocabulary and voice rules live in `VOICE.md`.

## Autopilot (optional)

Run the full chain every day at 06:00 local without touching anything:

```bash
npm run cron:install                                          # registers macOS launchd job
sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00              # wake laptop 5 min before (sleep guard)
```

Each run: `pull:telegram → enrich:inbox → build:day (yesterday + today) → astro build → git push`. Idempotent — empty days are no-ops. Logs append to `~/Library/Logs/oncbrain-cron.log`. Uninstall with `npm run cron:uninstall`; test manually with `npm run cron:test`; diagnose a missed run with `npm run cron:doctor`.

## URLs

- `https://oncbrain.oncologytoolkit.com/` — recent studies, disease-site nav, live search
- `https://oncbrain.oncologytoolkit.com/2026-05-18/` — one day's digest
- `https://oncbrain.oncologytoolkit.com/sites/breast/` — all studies for one disease site
- `https://oncbrain.oncologytoolkit.com/conferences/asco2026/` — all days tagged with a conference
- `https://oncbrain.oncologytoolkit.com/about/` — what it is, how it works, curator
- `https://oncbrain.oncologytoolkit.com/api` — RSS feed + JSON API docs
- `https://oncbrain.oncologytoolkit.com/feed.xml` — RSS feed (latest 30 studies)

## Output feeds (RSS + JSON API)

Every build emits a public, static, no-auth feed and API so other apps can read the digest:

- `/feed.xml` — RSS 2.0, latest 30 studies (name + verdict + audience + TL;DR, deep-linked).
- `/api/v1/digests.json` — index of published days with counts.
- `/api/v1/digest/<date>.json` — one day's digest (summaries only; no copyrighted full text).
- `/api/v1/study/<slug>.json` — one study across every date it was covered.

No CORS header yet, so browser cross-origin `fetch()` is blocked; readers and server-side consumers work. See `/api` for the full rundown.

## Obsidian integration

Every `npm run build:day` also writes Obsidian-flavored markdown to `data/obsidian/<date>[-<conf>].md`:

- YAML frontmatter (date, conference, tags, source-count, url)
- Wikilinks for NCT trial numbers, PMIDs, DOIs, conference notes, neighboring dates
- Callout for TL;DR
- Sources per study with curator notes
- Filed full-text PDFs at `data/obsidian/papers/<site>/<slug>.pdf` (gitignored, local-only), embedded into the daily note as a `[[wikilink]]` — the vault doubles as a private research library

Symlink `data/obsidian/` into your Obsidian vault, or open the repo as a vault directly. Backlinks across digests show up in Obsidian's graph view.

## LLM backend

Two paths via `LLM_BACKEND` env var:

- `LLM_BACKEND=claude-cli` — shells out to `claude -p`, billed to your Claude Code subscription (no per-token cost). The default for routine builds.
- `LLM_BACKEND=api` — Anthropic API; `ANTHROPIC_API_KEY` required. Pay per token. Adds vision, prompt caching, and extended thinking.

**Prompt caching (api):** VOICE.md is sent once as a cache-flagged block shared across every call in a build, so a busy day reuses it (~10% billing on hits) instead of re-billing it ~20×.

**Deeper analysis (optional config):**

- `DIGEST_MODEL` — model for all phases (default sonnet).
- `DIGEST_STUDY_MODEL` — Phase 2 only (the deep per-study step), e.g. `opus` on cli / `claude-opus-4-7` on api.
- `DIGEST_THINKING=8000` — Phase 2 extended-thinking budget in tokens (**api backend only**).

## Tests

```bash
npm test           # all tests once
npm run test:watch # watch mode
npx astro check    # type check (0 errors expected)
```

493 tests across DB + schema migrations, ingestion (Telegram, PubMed, Crossref, PDF text + OCR), the three-phase LLM pipeline (incl. prompt caching + extended thinking), SSRF / DOI / paper-URL / HTML-meta helpers, Obsidian export, RSS + JSON API output, NCT coverage dedup, and citation extraction.

## Eval

When iterating on the digest prompts (`prompts/digest-v5-*.txt`), run the eval before shipping a change:

```bash
npm run eval                       # all fixtures
npm run eval -- --save-baseline    # capture current as baseline
npm run eval -- --compare-baseline # diff this run vs baseline
```

The judge scores on factual accuracy, clinical relevance, citation correctness, clustering quality, and hallucinations (any hallucination caps overall at 5/10).

## Conferences (optional)

Conferences are an optional tag on bookmarks. When all bookmarks for a date share one conference, the published digest displays that conference's badge. Add conferences via `http://localhost:3001/conferences` (admin form).

## Takedown requests

Email the curator handle in `.env`. 24-hour SLA. Procedure: delete the bookmark row from the admin queue, re-run `npm run build:day --date=<affected date>`, push.

## Disclaimer

AI-generated summaries of public research and social-media content. **Not medical advice.** Verify against primary sources (clinicaltrials.gov, PubMed, conference proceedings) before any clinical use.

## License

MIT.
