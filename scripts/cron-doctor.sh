#!/bin/bash
# cron-doctor: surface why the 6am cron didn't run.
#
# When the cron skips a night, the causes are usually one of:
#   1. launchd job not loaded (never installed, or unloaded)
#   2. Plist path drift (Dropbox / CloudStorage / homebrew Node)
#   3. Mac asleep at 6am with no pmset wake schedule
#   4. launchd fired but script returned non-zero (perms, env, network)
#   5. Pipeline ran but produced no content (no bookmarks)
#
# This script checks each layer and prints a pass/fail line. Run after
# any unexplained gap in the digest cadence.
#
# Usage: npm run cron:doctor

set -u

LABEL="com.oncbrain.daily-digest"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOGFILE="$HOME/Library/Logs/oncbrain-cron.log"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass() { printf "  ✅ %s\n" "$*"; }
fail() { printf "  ❌ %s\n" "$*"; }
warn() { printf "  ⚠️  %s\n" "$*"; }
info() { printf "  ·  %s\n" "$*"; }

echo ""
echo "━━━ cron-doctor: oncbrain daily digest ━━━"
echo "time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""

# ── 1. launchd registration ────────────────────────────────────────────
echo "1) launchd job"
if [ ! -f "$PLIST" ]; then
  fail "plist missing at $PLIST"
  fail "run 'npm run cron:install' to install"
else
  pass "plist present: $PLIST"
fi
LAUNCH_LINE=$(launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label {print $0}')
if [ -z "$LAUNCH_LINE" ]; then
  fail "job NOT loaded in launchctl (launchctl list shows nothing)"
  fail "run 'launchctl bootstrap gui/$UID $PLIST' to load"
else
  PID=$(echo "$LAUNCH_LINE" | awk '{print $1}')
  STATUS=$(echo "$LAUNCH_LINE" | awk '{print $2}')
  pass "job loaded: PID=$PID, last-exit-status=$STATUS"
  case "$STATUS" in
    0)   info "last run succeeded" ;;
    126) warn "exit 126 = command-not-executable. Likely stale (recheck after a real fire)." ;;
    127) fail "exit 127 = command-not-found. Plist path may be wrong." ;;
    -)   info "no run since load" ;;
    *)   warn "non-zero last exit ($STATUS). Inspect log near the last 6am window." ;;
  esac
fi

# ── 2. Plist points to an executable script ────────────────────────────
echo ""
echo "2) plist target"
if [ -f "$PLIST" ]; then
  SCRIPT_PATH=$(plutil -extract ProgramArguments.0 raw "$PLIST" 2>/dev/null || echo "")
  WD_PATH=$(plutil -extract WorkingDirectory raw "$PLIST" 2>/dev/null || echo "")
  info "script:  $SCRIPT_PATH"
  info "workdir: $WD_PATH"
  if [ -x "$SCRIPT_PATH" ]; then
    pass "script exists and is executable"
  elif [ -f "$SCRIPT_PATH" ]; then
    fail "script exists but is NOT executable. chmod +x $SCRIPT_PATH"
  else
    fail "script does NOT exist at the plist path"
  fi
  if [ -d "$WD_PATH" ]; then
    pass "workdir exists"
  else
    fail "workdir does NOT exist. Reinstall plist with current paths: 'npm run cron:install'"
  fi
  # Detect Dropbox / CloudStorage drift: the canonical path on modern
  # macOS is ~/Library/CloudStorage/Dropbox/..., but ~/Dropbox is a
  # symlink to it. Both resolve to the same file; if Apple ever changes
  # this, the plist that hardcodes one path will break.
  if echo "$SCRIPT_PATH" | grep -q "/Users/$USER/Dropbox/"; then
    info "plist uses legacy ~/Dropbox symlink (still works; resolves via CloudStorage)"
  fi
fi

# ── 2b. LLM CLI reachable under the launchd environment ────────────────
# The default LLM backend (claude-cli) shells out to `claude -p`. launchd does
# NOT source the shell profile, so ~/.local/bin is off PATH; a bare `claude`
# spawn then ENOENTs and the build silently produces nothing. Probe the binary
# the way launchd actually sees it (plist PATH only, no profile).
echo ""
echo "2b) LLM CLI reachability (claude-cli backend)"
CLAUDE_REACHABLE=0
if [ -f "$PLIST" ]; then
  PLIST_PATH=$(plutil -extract EnvironmentVariables.PATH raw "$PLIST" 2>/dev/null || echo "")
  PLIST_CLAUDE=$(plutil -extract EnvironmentVariables.CLAUDE_BIN raw "$PLIST" 2>/dev/null || echo "")
  if [ -n "$PLIST_CLAUDE" ]; then
    info "plist CLAUDE_BIN: $PLIST_CLAUDE"
    if [ -x "$PLIST_CLAUDE" ]; then
      pass "CLAUDE_BIN points to an executable"
      CLAUDE_REACHABLE=1
    else
      fail "CLAUDE_BIN is set but not executable"
    fi
  else
    warn "no CLAUDE_BIN in plist; backend falls back to PATH lookup for 'claude'"
  fi
  if [ -n "$PLIST_PATH" ]; then
    RESOLVED=$(env -i PATH="$PLIST_PATH" HOME="$HOME" /usr/bin/which claude 2>/dev/null || true)
    if [ -n "$RESOLVED" ]; then
      pass "claude resolves under the plist PATH: $RESOLVED"
      CLAUDE_REACHABLE=1
    elif [ "$CLAUDE_REACHABLE" -eq 1 ]; then
      info "claude not on the plist PATH, but CLAUDE_BIN covers it"
    else
      fail "claude NOT found under the plist PATH and no usable CLAUDE_BIN"
      fail "this is the ENOENT failure mode (build runs, LLM calls fail silently)"
      fail "fix: npm run cron:install   # rediscovers claude + bakes the path in"
    fi
  fi
else
  info "(plist missing — see section 1)"
fi

# ── 3. pmset wake schedule (critical for laptop overnight) ─────────────
echo ""
echo "3) pmset wake schedule"
SCHED=$(pmset -g sched 2>&1)
if echo "$SCHED" | grep -qiE "wake|poweron"; then
  pass "wake schedule present"
  echo "$SCHED" | sed 's/^/     /'
else
  fail "NO wake schedule. If Mac sleeps overnight, launchd will NOT fire 6am cron."
  info "fix: sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00"
fi

# ── 4. Was the Mac asleep at the last 6am window? ──────────────────────
echo ""
echo "4) sleep/wake activity in the last 24h"
# pmset -g log only kept on recent macOS; fall back to log show.
SLEEP_WAKE=$(pmset -g log 2>/dev/null | tail -200 | grep -E "Sleep|Wake|DarkWake" | tail -10 || true)
if [ -z "$SLEEP_WAKE" ]; then
  info "(pmset log empty; check 'log show --predicate \"subsystem == \\\"com.apple.kernel.powerd\\\"\"' for details)"
else
  echo "$SLEEP_WAKE" | sed 's/^/     /'
fi

# ── 5. Last actual cron firings vs manual runs ─────────────────────────
echo ""
echo "5) recent run history"
if [ -f "$LOGFILE" ]; then
  HEADERS=$(grep "oncbrain daily build" "$LOGFILE" 2>/dev/null | tail -10)
  if [ -z "$HEADERS" ]; then
    warn "log file present but no run headers found yet"
  else
    echo "$HEADERS" | sed 's/^/     /'
    echo ""
    NIGHT_RUNS=$(echo "$HEADERS" | grep -E "0[5-7]:[0-5][0-9]:[0-9]{2}" | wc -l | tr -d ' ')
    if [ "$NIGHT_RUNS" -gt 0 ]; then
      pass "$NIGHT_RUNS run(s) in the 05:00-07:00 window (real cron firings)"
    else
      warn "no run timestamps fall in the 5-7am window. Every recorded run was likely manual."
    fi
  fi
else
  fail "log file missing: $LOGFILE (job has never written output)"
fi

# ── 6. Inbox / source backlog ──────────────────────────────────────────
echo ""
echo "6) source backlog (would the next run produce content?)"
DB="$REPO_ROOT/oncbrain.db"
if [ ! -f "$DB" ]; then
  warn "no oncbrain.db at $DB (npm run pull:telegram has never run, or DB is elsewhere)"
else
  if command -v sqlite3 >/dev/null 2>&1; then
    PENDING_INBOX=$(sqlite3 "$DB" "SELECT COUNT(*) FROM inbox_items WHERE enrichment_status='pending';" 2>/dev/null || echo "?")
    BOOKMARKS_TODAY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM bookmarks WHERE bookmark_date=date('now','localtime');" 2>/dev/null || echo "?")
    LAST_INBOX=$(sqlite3 "$DB" "SELECT MAX(received_at) FROM inbox_items;" 2>/dev/null || echo "?")
    info "pending inbox items: $PENDING_INBOX"
    info "bookmarks dated today: $BOOKMARKS_TODAY"
    if [ -n "$LAST_INBOX" ] && [ "$LAST_INBOX" != "?" ] && [ "$LAST_INBOX" != "" ]; then
      info "last inbox arrival: $(date -r $((LAST_INBOX / 1000)) '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "$LAST_INBOX (ms)")"
    fi
    if [ "$BOOKMARKS_TODAY" = "0" ] && [ "$PENDING_INBOX" = "0" ]; then
      warn "next run would skip (no new content); not a cron failure, just nothing to publish"
    fi
  else
    info "sqlite3 CLI not available; install with 'brew install sqlite' for backlog inspection"
  fi
fi

# ── 7. Telegram offset (puller progress) ───────────────────────────────
echo ""
echo "7) Telegram puller state"
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  OFFSET=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='telegram_offset';" 2>/dev/null)
  if [ -n "$OFFSET" ]; then
    info "telegram offset: $OFFSET (next pull starts here)"
  else
    info "no telegram_offset set (puller has never run, or hasn't seen any messages)"
  fi
fi

echo ""
echo "━━━ recommended actions ━━━"
# Aggregate findings into a short action list at the bottom so the reader
# doesn't have to re-read each section to know what to do next.
ACTIONS=()
if ! pmset -g sched 2>&1 | grep -qiE "wake|poweron"; then
  ACTIONS+=("sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00   # wake the Mac 5min before the 6am fire")
fi
if [ ! -f "$PLIST" ] || [ -z "$(launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label {print}')" ]; then
  ACTIONS+=("npm run cron:install   # install/reload the launchd plist")
elif [ "$CLAUDE_REACHABLE" -eq 0 ]; then
  ACTIONS+=("npm run cron:install   # claude CLI unreachable under launchd → re-bake PATH/CLAUDE_BIN")
fi
if [ "${#ACTIONS[@]}" -eq 0 ]; then
  echo "  (nothing to fix from this run; if the cron still misses fires, check"
  echo "   the next overnight log entry and re-run cron:doctor in the morning)"
else
  for a in "${ACTIONS[@]}"; do
    echo "  $a"
  done
fi
echo ""
echo "━━━ done ━━━"
echo ""
