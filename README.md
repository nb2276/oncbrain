# oncbrain

Curated AI-summarized digest of oncology meeting tweets.

## Architecture

```
LOCAL (laptop)                      GITHUB                DIGITALOCEAN
─────────────────                   ──────                ────────────
admin form @ localhost:3001           ▲                   App Platform
  │                                   │                   (static site)
  ├─▶ SQLite (~/oncbrain.db)          │                          │
  │                                   │                          ▼
build pipeline:                       │                   public reads
  fetch tweets via oEmbed             │                   static HTML
  call LLM (cluster, summarize,       │
    extract NCT/PubMed)               │
  write to /dist/*.html               │
  │                                   │
  └─▶ git commit + push ─────────────▶┘
                                      │
                                      └─▶ auto-deploy on push
```

Admin and build pipeline run locally only. The public site is pure static HTML.

## Setup

```bash
cp .env.example .env
# Add ANTHROPIC_API_KEY, set PUBLIC_CURATOR_NAME / _HANDLE / _SITE_NAME
npm install
```

## Daily use

```bash
# Start the admin form (localhost only)
npm run admin
# Visit http://localhost:3001 to add bookmarks during a meeting day

# Build a day's digest
npm run build:day -- --conf=asco2026 --day=2

# Build the static site
npm run build

# Preview locally
npm run preview

# Commit + push → DigitalOcean auto-deploys
git add data/digests dist
git commit -m "asco2026 day 2"
git push
```

## LLM backend

Two paths via `LLM_BACKEND` env var:

- `LLM_BACKEND=api` (default) — Anthropic API, `ANTHROPIC_API_KEY` required, pay per token
- `LLM_BACKEND=claude-cli` — shells out to `claude -p`, billed to your Claude Code subscription

## Tests

```bash
npm test           # all tests once
npm run test:watch # watch mode
```

## Eval

When iterating on `prompts/digest-v1.txt`, run the eval before shipping:

```bash
npm run eval                       # all fixtures
npm run eval -- --save-baseline    # capture current as baseline
npm run eval -- --compare-baseline # compare new run to baseline
```

## Takedown requests

Email the curator handle in `.env`. 24-hour SLA. Procedure: delete the bookmark row from SQLite, rebuild the affected day, redeploy.

## Disclaimer

AI-generated summaries of public social media content. Not medical advice. Verify against primary sources (clinicaltrials.gov, PubMed, conference proceedings) before any clinical use.

## License

MIT.
