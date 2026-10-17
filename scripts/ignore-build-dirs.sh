#!/bin/bash
# Keep Dropbox out of the generated directories. The repo lives under Dropbox's
# File Provider (~/Library/CloudStorage/Dropbox), which syncs anything without
# the com.dropbox.ignored xattr. A `rm -rf dist` drops the flag with the
# directory, the next build recreates dist/ unflagged, and once Dropbox starts
# syncing it astro's writes fail with "Unknown system error -11" (EDEADLK).
# That failed the 1am publish for 12 nights in October 2026.
#
# Runs as part of prebuild, so the flag is set before every build. A no-op off
# macOS (DigitalOcean builds on Linux, where there is no xattr command).
set -e
command -v xattr >/dev/null 2>&1 || exit 0
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for d in dist node_modules; do
  mkdir -p "$PROJECT_DIR/$d"
  xattr -w com.dropbox.ignored 1 "$PROJECT_DIR/$d" 2>/dev/null || true
done
