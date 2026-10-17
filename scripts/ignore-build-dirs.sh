#!/bin/bash
# Keep Dropbox out of the generated directories. The repo lives under Dropbox's
# File Provider (~/Library/CloudStorage/Dropbox). File Provider honours ONLY
# the `com.apple.fileprovider.ignore#P` xattr; the legacy `com.dropbox.ignored`
# flag is not enough on its own. A dist/ without the File Provider attribute is
# synced, and the 1am launchd build then fails mid-write with "Unknown system
# error -11" (EDEADLK) while interactive builds usually win the race. That
# failed the nightly publish from 2026-10-05 to 10-17; setting only
# com.dropbox.ignored (the first fix) did not stop it.
#
# Runs as part of prebuild, so both flags are set before every build. A no-op
# off macOS (DigitalOcean builds on Linux, where there is no xattr command).
set -e
command -v xattr >/dev/null 2>&1 || exit 0
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for d in dist node_modules; do
  mkdir -p "$PROJECT_DIR/$d"
  xattr -w 'com.apple.fileprovider.ignore#P' 1 "$PROJECT_DIR/$d" 2>/dev/null || true
  xattr -w com.dropbox.ignored 1 "$PROJECT_DIR/$d" 2>/dev/null || true
done
