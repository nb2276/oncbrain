#!/bin/bash
# v0.5 Phase E: symlink public/slides → data/slide-photos so Astro's static
# build copies slide photos to dist/slides/. Local-only by default; the
# data/slide-photos/ tree is gitignored, so DO sees no slides on prod builds
# unless the curator explicitly commits specific images via `git add -f`.
#
# Idempotent: skips if symlink already points to the right target.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SLIDES_SRC="$PROJECT_DIR/data/slide-photos"
SLIDES_LINK="$PROJECT_DIR/public/slides"

# Ensure source exists (don't error if empty; just create the dir).
mkdir -p "$SLIDES_SRC"

if [ -L "$SLIDES_LINK" ]; then
  CURRENT_TARGET="$(readlink "$SLIDES_LINK")"
  if [ "$CURRENT_TARGET" = "../data/slide-photos" ] || [ "$CURRENT_TARGET" = "$SLIDES_SRC" ]; then
    exit 0  # already correct
  fi
  rm "$SLIDES_LINK"
fi

if [ -d "$SLIDES_LINK" ] && [ ! -L "$SLIDES_LINK" ]; then
  echo "link-slides: public/slides exists as a real directory; refusing to overwrite"
  echo "  remove it manually if you want the symlink: rm -rf public/slides"
  exit 0
fi

ln -snf ../data/slide-photos "$SLIDES_LINK"
echo "link-slides: linked public/slides → data/slide-photos"
