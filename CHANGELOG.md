# Changelog

All notable changes to oncbrain are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
