// Read-only curator notes lookup for the Phase 2 per-study agent.
//
// Codex's key v0.4 concern: append-only "study dossiers" written by the LLM
// and fed back as context create a feedback loop — model hallucinations
// become sticky context for the next build. We deliberately avoid that:
//
//   - This module ONLY READS from data/studies/<slug>.md
//   - The build pipeline NEVER writes to that directory
//   - That directory is hand-curated (or empty — both fine)
//
// If the curator wants to anchor future analyses of a study (e.g., add a note
// about a specific bias, a comparator they want emphasized, a counter-claim
// to remember), they create/edit data/studies/<slug>.md by hand. The LLM
// reads but cannot modify. Provenance stays human.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const STUDIES_ROOT = resolve(process.cwd(), 'data/studies');

// Returns null if no file exists for this slug, or if the file is empty.
// Returns the raw markdown contents otherwise.
export function loadStudyContext(slug: string): string | null {
  if (!isSafeSlug(slug)) return null;
  const path = resolve(STUDIES_ROOT, `${slug}.md`);
  if (!path.startsWith(STUDIES_ROOT)) return null; // defense-in-depth against traversal
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, 'utf-8').trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

// Slugs in this codebase are kebab-case (or NCT bare digits) — strict enough
// that we can refuse anything containing slashes or path separators.
export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}
