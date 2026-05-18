#!/bin/bash
# Remove the oncbrain daily-digest launchd job. Reversal of install.sh.
#
# Usage: scripts/launchd/uninstall.sh

set -euo pipefail

PLIST_NAME="com.oncbrain.daily-digest.plist"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ ! -f "$TARGET" ]; then
  echo "Not installed: $TARGET"
  exit 0
fi

launchctl unload "$TARGET" 2>/dev/null || true
rm -f "$TARGET"
echo "✓ Removed: $TARGET"
echo ""
echo "(The pmset wake schedule, if you set one, remains. To clear it:)"
echo "  sudo pmset repeat cancel"
