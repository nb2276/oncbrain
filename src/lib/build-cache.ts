// v0.30: resume cache for build:day. The pipeline builds a date ATOMICALLY
// (Phase 1 group → Phase 2 one LLM call per study → Phase 3 synthesis) and only
// writes the digest if every phase succeeds. A big multi-study date can exhaust
// the claude-cli session window mid-build, and because nothing is written, a
// retry re-runs the WHOLE date — re-burning the studies that already succeeded.
//
// This is a CONTENT-ADDRESSED cache: each phase's result is keyed by a hash of its
// inputs (source text/OCR, model, and a fingerprint of the prompt files). On a
// re-run, unchanged work is a cache hit and skips the LLM call, so a session-
// limited date finishes across windows. Changing a source or a prompt changes the
// key → automatic invalidation. Gated behind opts.resumeCache so tests + the API
// backend (no session limit) are unaffected. Cache lives in the gitignored
// data/.cache/build/ and stores only derived digest data (no copyrighted source).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const CACHE_DIR = resolve(process.cwd(), 'data/.cache/build');
const CACHE_VERSION = 'v2';
// TTL scopes the cache to a RESUME window, not a permanent content cache. A
// session-limited build finishes on a re-run within a few hours; a next-day
// build (the 1am cron) or a `rebuild:queued`/`--backfill` refresh gets a fresh
// build, so cached-but-time-varying data (ClinicalTrials.gov status) can't go
// stale. 6h comfortably covers the ~5h claude-cli session window.
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

// Fingerprint the prompt files so any prompt / VOICE / perspective edit
// invalidates the whole cache — a prompt change must rebuild, not serve stale
// output. Perspective files are injected into Phase 2 + Phase 3, so they count.
let _promptFp: string | null = null;
function promptFingerprint(): string {
  if (_promptFp !== null) return _promptFp;
  const h = createHash('sha256');
  const files = [
    'prompts/digest-v5-grouping.txt',
    'prompts/digest-v5-study-agent.txt',
    'prompts/digest-v5-synthesis.txt',
    'VOICE.md',
  ];
  // Include every perspective file (radonc/medonc/…), sorted for stability.
  try {
    const dir = resolve(process.cwd(), 'prompts/perspectives');
    for (const n of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
      files.push(`prompts/perspectives/${n}`);
    }
  } catch {
    /* no perspectives dir → nothing to add */
  }
  for (const f of files) {
    try {
      h.update(f); // path, so a rename also invalidates
      h.update(readFileSync(resolve(process.cwd(), f), 'utf8'));
    } catch {
      /* a missing file just contributes its path to the fingerprint */
    }
  }
  _promptFp = h.digest('hex').slice(0, 16);
  return _promptFp;
}

// Stable key for a phase result. `namespace` is the phase ('group' | 'study' |
// 'synth'); `payload` is the JSON-serialisable set of inputs that determine it.
export function buildCacheKey(namespace: string, payload: unknown): string {
  const h = createHash('sha256');
  h.update(CACHE_VERSION);
  h.update(promptFingerprint());
  h.update(namespace);
  h.update(JSON.stringify(payload));
  return `${namespace}-${h.digest('hex').slice(0, 40)}`;
}

// Returns null on a miss, a parse failure, OR an entry older than the TTL — so a
// stale cache can never answer a fresh (next-day / refresh) build.
export function readBuildCache<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | null {
  try {
    const f = resolve(CACHE_DIR, `${key}.json`);
    if (!existsSync(f)) return null;
    if (Date.now() - statSync(f).mtimeMs > ttlMs) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeBuildCache(key: string, value: unknown): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    // temp-write + rename so a crash mid-write can't leave a truncated file.
    const dest = resolve(CACHE_DIR, `${key}.json`);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, dest);
  } catch {
    /* best-effort: a cache write failure must never fail the build */
  }
}
