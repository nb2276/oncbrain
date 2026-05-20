#!/bin/bash
# Install (or reinstall) the oncbrain daily-digest launchd job.
#
# Usage: scripts/launchd/install.sh
#
# Templates absolute paths into the plist (project dir, $HOME, Node bin
# directory discovered via `command -v node`), copies it into
# ~/Library/LaunchAgents/, and loads it with launchctl. Re-running is safe —
# the prior copy is unloaded first.

set -euo pipefail

# pwd -P resolves symlinks to the physical path. This repo lives under Dropbox,
# which macOS exposes both as ~/Dropbox (legacy symlink) and the canonical
# ~/Library/CloudStorage/Dropbox/... path. A launchd agent firing against the
# ~/Dropbox symlink can hit "Operation not permitted" (TCC keys on the real
# path), so bake the canonical path into the plist regardless of how this
# script was invoked.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

PLIST_NAME="com.oncbrain.daily-digest.plist"
TEMPLATE="$SCRIPT_DIR/$PLIST_NAME"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ ! -f "$TEMPLATE" ]; then
  echo "✗ Missing template: $TEMPLATE" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ Could not find 'node' on PATH. Install Node first." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

# Template the plist with discovered paths.
sed \
  -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__NODE_DIR__|$NODE_DIR|g" \
  "$TEMPLATE" >"$TARGET"

# Make the runner script executable. (Idempotent.)
chmod +x "$PROJECT_DIR/scripts/daily-build.sh"

# Reload the agent.
launchctl unload "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"

echo "✓ Installed: $TARGET"
echo "  - Schedule: 6:00 AM local time daily"
echo "  - Project:  $PROJECT_DIR"
echo "  - Node:     $NODE_BIN"
echo "  - Log:      $HOME/Library/Logs/oncbrain-cron.log"
echo ""
echo "Verify it's loaded:"
echo "  launchctl list | grep oncbrain"
echo ""
echo "Run it now (without waiting until 6 AM):"
echo "  launchctl start com.oncbrain.daily-digest"
echo "  # then: tail -f $HOME/Library/Logs/oncbrain-cron.log"
echo ""
echo "If your Mac sleeps at 6 AM, also run (once, requires sudo):"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00"
