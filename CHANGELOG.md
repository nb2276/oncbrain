# Changelog

All notable changes to oncbrain are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
