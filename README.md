# oncbrain

Curated AI-summarized digest of oncology updates. Continual cadence with prominence during major meetings (ASCO, ESMO, ASTRO, etc.).

**Live:** https://oncbrain.oncologytoolkit.com · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Current version:** 0.8.0

## Architecture

```
INGESTION                LOCAL (laptop)              GITHUB              DIGITALOCEAN
─────────                ──────────────              ──────              ────────────
Telegram bot ─────┐                                                       App Platform
                  ├─▶ SQLite (oncbrain.db)            ▲                   (static site)
admin form @ 3001 ┘     │                             │                          │
                        │                             │                          ▼
                        ▼                             │                   public reads
                  build pipeline (npm run build:day): │                   static HTML at
                    oEmbed fetch pending tweets       │                   oncbrain.oncologytoolkit.com
                    LLM cluster + summarize           │
                    write data/digests/<date>.json    │
                    write data/obsidian/<date>.md     │
                        │                             │
                        └─▶ git push ─────────────────┘
                                                      │
                                                      └─▶ auto-deploy on push
```

Admin form, Telegram poller, and build pipeline run locally only. The public site is pure static HTML.

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
```

## Adding content

Two ingestion paths, both write to the same SQLite queue. Use either or both.

### Path A: Telegram bot (mobile-friendly, primary path)

1. Open Telegram, find `@BotFather`, send `/newbot`. Get a token, paste it into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Optional: create a private Telegram channel and add the bot as admin.
3. Throughout the day, DM the bot: tweet URLs, paper links (DOI / PubMed / journal pages), full-text PDFs, or slide photos (or post them in your private channel).
4. When ready to publish:

```bash
npm run pull:telegram   # fetches all new messages, saves URLs as today's bookmarks
```

The bot also recognizes a `/note <text>` command on the same message to attach a curator note.

### Path B: localhost admin form

```bash
npm run admin           # http://localhost:3001
# Paste a tweet URL → date defaults to today → optional conference tag → optional note → save.
```

If oEmbed fails for a tweet, expand "Manual paste fallback" on the form and paste the tweet text directly.

## Publishing a digest

```bash
npm run build:day                              # today's date
npm run build:day -- --date=2026-05-18         # a specific date
npm run build:day -- --backfill                # every date with bookmarks (re-run is idempotent)
npm run build:day -- --dry-run                 # no LLM call, see what would happen

npm run build                                  # Astro static build (preview locally with: npm run preview)

git add data
git commit -m "$(date +%Y-%m-%d)"
git push                                       # DigitalOcean auto-deploys in ~40 sec
```

## Digest format (IMRD)

Each digest follows scientific paper structure for 90-second quick reference:

- **Top line** — one-sentence lede with the headline number (e.g. "RCC SBRT achieves 100% local control at 5 years")
- **TL;DR** — 2-3 sentence cross-topic synthesis
- **Per cluster:** subspecialty emoji + topic name, then
  - 🧪 Intro — clinical context, why this matters
  - 📐 Methods — trial design (optional)
  - 📊 Results — bullets with effect sizes verbatim from sources
  - 💭 Discussion — implications, open questions (optional)
  - 📚 Sources — collapsible, each linked back to the original X post

Subspecialty emojis (the LLM picks): 🌸 breast · 🎯 SABR/precision · 🍇 GU · 📡 radonc · 💊 systemic · 🛡️ IO · 🧠 CNS · 🩸 heme · 🫁 lung · 🌽 GI · 🧬 molecular · 🔪 surgery · 🧒 peds · 🧓 supportive · ⚠️ safety.

## Autopilot (optional)

Run the full chain every day at 06:00 local without touching anything:

```bash
npm run cron:install                                          # registers macOS launchd job
sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00              # wake laptop 5 min before (sleep guard)
```

Each run: `pull:telegram → build:day yesterday + today → astro build → git push`. Idempotent — empty days are no-ops. Logs append to `~/Library/Logs/oncbrain-cron.log`. Uninstall with `npm run cron:uninstall`; test manually with `npm run cron:test`.

## URLs

- `https://oncbrain.oncologytoolkit.com/` — recent studies, disease-site nav, live search
- `https://oncbrain.oncologytoolkit.com/2026-05-18/` — one day's digest
- `https://oncbrain.oncologytoolkit.com/sites/breast/` — all studies for one disease site
- `https://oncbrain.oncologytoolkit.com/conferences/asco2026/` — all days tagged with a conference
- `https://oncbrain.oncologytoolkit.com/about/` — disclaimer + curator info
- `https://oncbrain.oncologytoolkit.com/api` — RSS feed + JSON API docs
- `https://oncbrain.oncologytoolkit.com/feed.xml` — RSS feed (latest 30 studies)

## Obsidian integration

Every `npm run build:day` also writes Obsidian-flavored markdown to `data/obsidian/<date>[-<conf>].md`:

- YAML frontmatter (date, conference, tags, source-count, url)
- Wikilinks for NCT trial numbers, PMIDs, DOIs, conference notes, neighboring dates
- Callout for TL;DR
- Sources per cluster with curator notes

Symlink `data/obsidian/` into your Obsidian vault, or open the repo as a vault directly. Backlinks across digests show up in Obsidian's graph view.

## LLM backend

Two paths via `LLM_BACKEND` env var:

- `LLM_BACKEND=api` (default) — Anthropic API. `ANTHROPIC_API_KEY` required. Pay per token (~$0.05–0.10 per digest).
- `LLM_BACKEND=claude-cli` — shells out to `claude -p`. Billed to your Claude Code subscription. Best for prompt-iteration loops.

## Tests

```bash
npm test           # all tests once
npm run test:watch # watch mode
```

469 tests across DB + schema migrations, ingestion (Telegram, PubMed, Crossref, PDF text + OCR), the three-phase LLM pipeline, SSRF / DOI / paper-URL / HTML-meta helpers, Obsidian export, RSS + JSON API output, NCT coverage dedup, and citation extraction.

## Eval

When iterating on `prompts/digest-v2.txt`, run the eval before shipping a change:

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

AI-generated summaries of public social media content. **Not medical advice.** Verify against primary sources (clinicaltrials.gov, PubMed, conference proceedings) before any clinical use.

## License

MIT.
