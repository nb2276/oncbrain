#!/bin/bash
# Daily oncbrain pipeline. Runs from launchd at 3am local (or manually).
#
# Pipeline:
#   1. pull:telegram    — drain new bot messages into bookmark queue
#   2. build:day        — regenerate yesterday's + today's digests
#                         (covers the late-evening-message case where a
#                          tweet sent at 11pm local got dated to yesterday)
#   3. astro build      — static site
#   4. git commit/push  — DigitalOcean auto-deploys
#
# All output goes to ~/Library/Logs/oncbrain-cron.log.
# Exits 0 even on partial failure (logged) so the next day's run still fires.

set -uo pipefail

# Resolve project root regardless of where script was invoked from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$HOME/Library/Logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/oncbrain-cron.log"

# launchd runs with a minimal PATH. Add the locations npm/node/git typically live.
# (The install script discovers Node at install time and bakes the absolute path
#  into the launchd plist's PATH env var, but we also extend here as a belt-
#  and-suspenders for manual `npm run cron:test` invocations.)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# We deliberately do NOT source .env here. The Node scripts (tsx + dotenv/config)
# load it themselves with proper unquoted-value handling. Bash 'source' would
# choke on values containing spaces or commas (e.g. PUBLIC_SITE_NAME).

# Today and yesterday in LOCAL time (matches the bookmark_date convention used
# by Telegram ingest). macOS `date` syntax — different from GNU date.
TODAY="$(date +%Y-%m-%d)"
YESTERDAY="$(date -v-1d +%Y-%m-%d)"

# --- run logged ---
{
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') — oncbrain daily build"
  echo "  project: $PROJECT_DIR"
  echo "  target dates: $YESTERDAY, $TODAY"
  echo "  LLM backend: ${LLM_BACKEND:-api}"
  echo "════════════════════════════════════════════════════════════"

  echo ""
  echo "→ Pulling Telegram"
  npm run pull:telegram --silent || echo "  ⚠ pull:telegram exited non-zero (continuing)"

  echo ""
  echo "→ Building digests for $YESTERDAY"
  npm run build:day --silent -- --date="$YESTERDAY" || echo "  ⚠ build:day $YESTERDAY exited non-zero (continuing)"

  echo ""
  echo "→ Building digests for $TODAY"
  npm run build:day --silent -- --date="$TODAY" || echo "  ⚠ build:day $TODAY exited non-zero (continuing)"

  echo ""
  echo "→ Building Astro site"
  npm run build --silent || { echo "  ✗ astro build failed; aborting commit"; exit 0; }

  echo ""
  echo "→ Staging data/ for commit"
  git add data 2>/dev/null || true

  if git diff --cached --quiet -- data; then
    echo "  (no new digest content — nothing to commit)"
  else
    git commit -m "auto: $TODAY 3am pull"
    if git push 2>&1; then
      echo "  pushed → DigitalOcean will auto-deploy"
    else
      echo "  ✗ git push failed (auth? — check ssh-agent / keychain)"
    fi
  fi

  echo ""
  echo "✓ Done at $(date '+%Y-%m-%d %H:%M:%S %Z')"
} >>"$LOG_FILE" 2>&1
