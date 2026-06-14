#!/bin/bash
# Double-click launcher (macOS Finder) for the oncbrain studio TUI:
# manage studies, resolve + review discussed trials, build a day, pull + enrich.
# Lives at the repo root so Finder runs it; cd's to its own dir so npm resolves
# the project. Homebrew node/npm path is prepended in case Finder's env is bare.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:$PATH"
exec npm run studio
