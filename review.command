#!/bin/bash
# Double-click launcher (macOS Finder) that jumps straight into the curator
# review/approval process for review-discussed trials (the interactive @clack
# queue). Same as the studio TUI's "Review resolved trials" option, one click.
# Approved trials enter the next build as study cards; nothing publishes here.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:$PATH"
exec npm run resolve:review-trials -- --review
