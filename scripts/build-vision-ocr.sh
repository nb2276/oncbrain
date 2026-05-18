#!/bin/bash
# Compile scripts/vision-ocr.swift → scripts/vision-ocr (Apple Vision OCR binary).
# Idempotent: skips compile if binary is newer than source.
# macOS-only (relies on Vision framework). Exits silently with code 0 on
# non-macOS so npm scripts don't fail in CI / Linux containers.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/vision-ocr.swift"
BIN="$SCRIPT_DIR/vision-ocr"

if [ "$(uname)" != "Darwin" ]; then
  echo "vision-ocr: skipping build (not macOS, no Vision framework available)"
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "vision-ocr: swiftc not found. Install Xcode Command Line Tools: xcode-select --install"
  echo "vision-ocr: continuing without OCR — build will still work, just no on-device text extraction"
  exit 0
fi

if [ -f "$BIN" ] && [ "$BIN" -nt "$SRC" ]; then
  echo "vision-ocr: binary up-to-date, skipping compile"
  exit 0
fi

echo "vision-ocr: compiling $SRC → $BIN"
swiftc "$SRC" -o "$BIN"
echo "vision-ocr: built successfully"
