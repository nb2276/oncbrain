#!/bin/bash
# Date derivation for the daily publish, split out of daily-build.sh so it can be
# tested against real git repos (test/publish-dates.test.ts sources this file).
#
# WHY THIS EXISTS. daily-build.sh announces the dates it published. It used to
# derive them from the STAGED changes of the current run only. When a push fails,
# v0.32 correctly clears the announce list — nothing reached DigitalOcean, so
# nothing is announceable — but the commit stays on local main, ahead of origin.
# The NEXT run stages its own changes, derives only its own dates, and pushes:
# the stranded date deploys inside that push and is never announced at all.
#
# The fix is to treat "ahead of the remote" as part of what this run is about to
# publish, because that is literally what the push sends.

# Dates whose digest artifact differs in HEAD from <base-ref> — the NET effect a
# push would have on the deployed tree.
#
#   $1 repo dir   $2 base ref (e.g. origin/main, FETCH_HEAD)
#
# NET, not "paths touched across the ahead commits". If one unpushed commit adds
# a date and a later one reverts or deletes it, the deployed tree will not have
# it, and announcing it would link a page that does not exist. --diff-filter=AM
# keeps added/modified and drops deletions, so unpublishing a day stays silent.
#
# Empty when the base ref is unknown (offline, fresh clone). Under-announcing is
# the safe direction; announcing something undeployed is the cardinal sin here.
unpushed_digest_dates() {
  local repo="$1" base="$2"
  git -C "$repo" rev-parse --verify -q "$base" >/dev/null 2>&1 || return 0
  git -C "$repo" diff --name-only --diff-filter=AM "$base" HEAD -- data/digests 2>/dev/null \
    | sed -nE 's|.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.json$|\1|p' \
    | sort -u
}

# Dates from the currently STAGED digest changes — this run's own output.
staged_digest_dates() {
  local repo="$1"
  git -C "$repo" diff --cached --name-only -- data/digests 2>/dev/null \
    | sed -nE 's|.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.json$|\1|p' \
    | sort -u
}

# Merge two newline-separated date lists: dedupe, drop blanks. Either may be
# empty, which is the common case (no backlog).
union_dates() {
  printf '%s\n%s\n' "$1" "$2" | sed '/^$/d' | sort -u
}

# Resolve the ref to compare against, refreshing it first. Prefers the freshly
# fetched FETCH_HEAD, falls back to the remote-tracking ref, and prints nothing
# when neither exists so callers degrade instead of comparing against garbage.
resolve_remote_base() {
  local repo="$1"
  # FETCH_HEAD is only trustworthy when THIS fetch succeeded. The file persists
  # from earlier runs, so preferring it unconditionally would compare against a
  # stale remote while offline and invent a backlog — which double-announces a
  # date that is already deployed and already announced.
  if git -C "$repo" fetch origin main >/dev/null 2>&1 \
    && git -C "$repo" rev-parse --verify -q FETCH_HEAD >/dev/null 2>&1; then
    echo FETCH_HEAD
  elif git -C "$repo" rev-parse --verify -q origin/main >/dev/null 2>&1; then
    echo origin/main
  fi
}
