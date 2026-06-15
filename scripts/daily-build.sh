#!/bin/bash
# Daily oncbrain pipeline. Runs from launchd at 6am local (or manually).
#
# Pipeline (v0.5+):
#   1. pull:telegram    — drain new bot messages into inbox_items queue
#   2. enrich:inbox     — process pending items (tweets enrich now; papers
#                         + slides land in v0.5 Phase B + C, deferred)
#   3. build:day        — regenerate yesterday's + today's digests
#                         (covers the late-evening-message case where a
#                          tweet sent at 11pm local got dated to yesterday)
#   4. astro build      — static site
#   5. git commit/push  — DigitalOcean auto-deploys
#
# All output goes to ~/Library/Logs/oncbrain-cron.log.
#
# Failure semantics: the pipeline always runs to the end (a failed stage never
# aborts later stages — yesterday failing must not stop today building), but the
# script EXITS NON-ZERO if any critical stage failed. launchd records the exit
# status, so a silent ENOENT/build break shows up as `last exit code != 0` in
# `launchctl print` instead of masquerading as a healthy run. Critical stages:
# pull:telegram, enrich:inbox, build:day, astro build, git push. Non-critical:
# notify:curator.

set -uo pipefail

# Tracks whether any critical stage failed. Checked at the very end → exit code.
FAILED=0
# Tracks specifically whether a build:day stage failed. Gates publishing: we must
# NOT auto-commit/push when a digest build failed, or a transient mid-pipeline
# failure (NCBI flake, LLM ENOENT) could publish a partial-day / stale-day state
# to the public site while the run still reports FAILED only via exit code.
DIGEST_FAILED=0

# Run a critical stage. Logs a loud failure line and flips FAILED, but does NOT
# abort — later stages still run so a single broken date doesn't sink the day.
critical() {
  local label="$1"; shift
  "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  ✗ $label FAILED (exit $rc)"
    FAILED=1
  fi
}

# Like critical(), but also flips DIGEST_FAILED so the publish stage can refuse
# to commit/push when any digest build failed (not just astro).
critical_digest() {
  local label="$1"; shift
  "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  ✗ $label FAILED (exit $rc)"
    FAILED=1
    DIGEST_FAILED=1
  fi
}

# Resolve project root regardless of where script was invoked from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$HOME/Library/Logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/oncbrain-cron.log"

# launchd runs with a minimal PATH. Add the locations npm/node/git/claude typically
# live. (The install script discovers Node + claude at install time and bakes their
# paths into the launchd plist, but we also extend here as belt-and-suspenders for
# manual invocations and stale plists.) ~/.local/bin is where the claude CLI lives;
# without it the claude-cli LLM backend spawns a bare `claude` that ENOENTs.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

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
  # LLM_BACKEND usually lives in .env, which Node (not bash) loads — so bash can't
  # report the effective value. Show what bash sees, and the binary it resolves,
  # so an ENOENT class failure is diagnosable straight from the log header.
  echo "  LLM backend (bash-visible): ${LLM_BACKEND:-unset → Node resolves from .env}"
  echo "  claude:  ${CLAUDE_BIN:-$(command -v claude || echo 'NOT FOUND on PATH')}"
  echo "  node:    $(command -v node || echo 'NOT FOUND')  |  git: $(command -v git || echo 'NOT FOUND')"
  echo "════════════════════════════════════════════════════════════"

  echo ""
  echo "→ Pulling Telegram → inbox"
  critical "pull:telegram" npm run pull:telegram --silent

  echo ""
  echo "→ Enriching inbox items"
  critical "enrich:inbox" npm run enrich:inbox --silent

  echo ""
  echo "→ Building digests for $YESTERDAY"
  critical_digest "build:day $YESTERDAY" npm run build:day --silent -- --date="$YESTERDAY"

  echo ""
  echo "→ Building digests for $TODAY"
  critical_digest "build:day $TODAY" npm run build:day --silent -- --date="$TODAY"

  echo ""
  echo "→ Building Astro site"
  if npm run build --silent; then
    ASTRO_OK=1
  else
    echo "  ✗ astro build FAILED; skipping commit"
    ASTRO_OK=0
    FAILED=1
  fi

  # A failed local astro build means the same build would break on DigitalOcean,
  # so don't commit/push content that would deploy a broken site. A failed
  # build:day means the digest content may be partial/stale, so we must not
  # auto-publish it either. Skip publishing in both cases (FAILED is already set),
  # but keep running so notify/exit-status still fire.
  CHANGED_DATES=""
  if [ "$ASTRO_OK" = 1 ] && [ "$DIGEST_FAILED" = 0 ]; then
    echo ""
    echo "→ Staging data/ for commit"
    git add data 2>/dev/null || true

    # Which digest dates actually changed this run? A late-evening tweet can land
    # on yesterday's date, so notifying only $TODAY would miss it. Derive the
    # changed dates from the staged digest files (capture before the commit).
    CHANGED_DATES="$(git diff --cached --name-only -- data/digests 2>/dev/null \
      | sed -nE 's|.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.json$|\1|p' | sort -u)"

    if git diff --cached --quiet -- data; then
      echo "  (no new digest content — nothing to commit)"
    else
      # Scope the commit to the data/ pathspec. Without it, a source file the
      # curator left staged the night before would ride along into the "auto"
      # commit and deploy to production. (The repo rule: stage explicit paths,
      # never let an unscoped commit sweep the whole index.)
      git commit -m "auto: $TODAY 6am pull" -- data
      if git push 2>&1; then
        echo "  pushed → DigitalOcean will auto-deploy"
      else
        echo "  ✗ git push FAILED (auth? — check ssh-agent / keychain)"
        FAILED=1
      fi
    fi
  elif [ "$DIGEST_FAILED" = 1 ]; then
    echo ""
    echo "  ✗ a build:day stage failed — skipping commit/push (no auto-publish of a partial/stale day; build manually + studio-publish)"
  fi

  echo ""
  echo "→ Notifying curator"
  if [ -z "$CHANGED_DATES" ]; then
    echo "  (no digest changed — nothing to notify)"
  else
    for d in $CHANGED_DATES; do
      echo "  → $d"
      npm run notify:curator --silent -- --date="$d" || echo "  ⚠ notify:curator $d exited non-zero (continuing)"
    done
  fi

  # T5 distribution: post each changed digest to the public Telegram channel.
  # No-op until TELEGRAM_CHANNEL_ID is set (notify:channel self-skips), so this
  # is safe to ship before the channel exists.
  echo ""
  echo "→ Posting to channel"
  if [ -z "$CHANGED_DATES" ]; then
    echo "  (no digest changed — nothing to post)"
  else
    for d in $CHANGED_DATES; do
      echo "  → $d"
      npm run notify:channel --silent -- --date="$d" || echo "  ⚠ notify:channel $d exited non-zero (continuing)"
    done
  fi

  echo ""
  if [ "$FAILED" -ne 0 ]; then
    echo "✗ Done WITH FAILURES at $(date '+%Y-%m-%d %H:%M:%S %Z') — see ✗ lines above"
  else
    echo "✓ Done at $(date '+%Y-%m-%d %H:%M:%S %Z')"
  fi
} >>"$LOG_FILE" 2>&1

exit "$FAILED"
