// Write a file so a reader never sees it half-written.
//
// The digest artifact and the override sidecars are both read back by other
// processes — `rebuild:queued` spawns build:day, the 1am cron runs the pull,
// enrich, build and publish stages in sequence, and the curator can be replying
// to a DM the whole time. A plain writeFileSync on a multi-kilobyte JSON file is
// not one operation: a crash, a full disk, or a laptop sleeping mid-write leaves
// a truncated file on disk.
//
// That matters here more than it usually would, because of what reads them:
//
//   · A torn override sidecar fails JSON.parse. loadOverrides treats an
//     unreadable file as "no overrides", so every suppression on that date
//     silently stops applying and previously-hidden cards republish.
//   · A torn digest artifact is a published date that no longer parses, and the
//     dates that read it (prior-estimate, lineage coverage, find:dups) all
//     degrade to "no prior coverage" — which is the input state that makes
//     lineage treat a returning trial as brand new.
//
// Write to a sibling temp file, fsync it, then rename. rename(2) within a
// directory is atomic on macOS and Linux: a concurrent reader sees either the
// old complete file or the new complete file, never a partial one. The fsync
// before the rename is what makes that survive a power loss rather than just a
// crash — without it the rename can land while the data is still in the page
// cache.

import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/**
 * Atomically replace `path` with `contents`.
 *
 * The temp file is a sibling, never in the system temp dir: rename is only
 * atomic within a filesystem, and /tmp is frequently a different one, where
 * rename silently degrades to copy-then-delete and reopens the torn-read window.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  // `process.pid` keeps two concurrent writers off each other's temp file. The
  // leading dot keeps it out of directory listings that glob *.json — data/digests
  // is read with readdirSync and a stray temp file there would parse as a date.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents);
    // Flush the DATA before the rename publishes the name.
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    // Never leave the temp file behind on a failed write — data/digests is
    // enumerated by getStaticPaths and data/overrides by the build.
    try {
      unlinkSync(tmp);
    } catch {
      // already gone, or never created
    }
    throw err;
  }
}
