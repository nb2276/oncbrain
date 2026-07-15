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
//
// v0.27 (cross-day entity resolution): a trial's per-date slug drifts
// (`prestige-psma` → `prestige-psma-2` on a same-name collision; `PRESTIGE` vs
// `prestige-psma` across days), so an exact-slug lookup silently loses the
// dossier. The safe fix is CURATOR-DECLARED aliases, not auto-stemming a `-\d+`
// suffix (that would cross-link `rtog-0539` ↔ `rtog-0848`, distinct trials whose
// number IS their identity). A dossier opts into the slugs it covers via YAML
// frontmatter:
//
//   ---
//   aliases: [prestige-psma, prestige-psma-2, prestige]
//   ---
//   <the dossier body>
//
// Resolution is authoritative (curator-owned): the machine never guesses a link.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const STUDIES_ROOT = resolve(process.cwd(), 'data/studies');

// Curator prior-context for a study slug, or null if none resolves. Resolution:
//   1. An exact dossier `<slug>.md`.
//   2. Else a dossier that declares `slug` in its `aliases:` frontmatter.
// The returned body has its frontmatter stripped, so the LLM never sees the
// `aliases:` line as content. `root` is injectable for tests; production uses
// the default data/studies dir.
export function loadStudyContext(slug: string, root: string = STUDIES_ROOT): string | null {
  if (!isSafeSlug(slug)) return null;
  const direct = readDossierBody(slug, root);
  if (direct !== null) return direct;
  const owner = aliasIndex(root).get(slug);
  if (owner && owner !== slug) {
    const body = readDossierBody(owner, root);
    if (body !== null) {
      // Surface every alias resolution in the build log. An over-broad curator
      // alias (e.g. `aliases: [prestige]`) could otherwise silently feed one
      // trial's prior-context to an unrelated study later assigned that slug —
      // an invisible wrong-merge in a clinical pipeline. The log makes it visible.
      console.warn(`[study-context] "${slug}" resolved via alias → dossier "${owner}"`);
      return body;
    }
  }
  return null;
}

// Read a single dossier's BODY (frontmatter stripped), or null if it's missing
// or empty. isSafeSlug + the STUDIES_ROOT prefix check keep this traversal-safe.
function readDossierBody(slug: string, root: string): string | null {
  if (!isSafeSlug(slug)) return null;
  const path = resolve(root, `${slug}.md`);
  if (!path.startsWith(root)) return null; // defense-in-depth against traversal
  if (!existsSync(path)) return null;
  try {
    const body = stripFrontmatter(readFileSync(path, 'utf-8'));
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

// Slugs in this codebase are kebab-case (or NCT bare digits) — strict enough
// that we can refuse anything containing slashes or path separators.
export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

// ---- YAML frontmatter helpers (pure) ----

// The raw text INSIDE a leading `---\n … \n---` frontmatter block, or null when
// the content doesn't open with one.
function frontmatterBlock(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  return m ? m[1]! : null;
}

// Content with a leading frontmatter block removed (trimmed). No block → the
// content trimmed as-is, so existing frontmatter-free dossiers are unaffected.
export function stripFrontmatter(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return (m ? content.slice(m[0].length) : content).trim();
}

// Parse the `aliases:` list from a dossier's frontmatter. Supports both the flow
// form (`aliases: [a, b, c]`) and the block form (`aliases:` then `- a` lines).
// Only isSafeSlug-valid, de-duplicated entries are returned; anything else is
// dropped silently (a bad alias must never widen the match or escape the dir).
export function parseDossierAliases(content: string): string[] {
  const fm = frontmatterBlock(content);
  if (!fm) return [];
  const out: string[] = [];

  const flow = fm.match(/^aliases:[ \t]*\[([^\]]*)\][ \t]*$/m);
  if (flow) {
    for (const raw of flow[1]!.split(',')) pushAlias(out, raw);
    return out;
  }

  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => /^aliases:[ \t]*$/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^[ \t]*$/.test(line)) continue; // a blank line inside the list is tolerated, not a terminator
      const bm = line.match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/);
      if (!bm) break; // first non-blank, non-list line ends the block
      pushAlias(out, bm[1]!);
    }
  }
  return out;
}

function pushAlias(out: string[], raw: string): void {
  // Strip a trailing `# comment` (a slug can't contain '#', so a spaced '#' is a
  // YAML comment) and surrounding quotes before validating.
  const alias = raw
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (alias && isSafeSlug(alias) && !out.includes(alias)) out.push(alias);
}

// ---- alias index (built once per build, memoized on the dir signature) ----
//
// loadStudyContext is called per study in Phase 2; a directory scan per call
// would be current-day-studies × corpus-size. This memo builds the alias map
// once and reuses it until the studies dir changes.

let _aliasIndexCache: { key: string; index: Map<string, string> } | null = null;

// Reset the memo — tests that mutate the studies dir within one process call
// this, since coarse mtime granularity could otherwise miss a same-path rewrite.
export function resetAliasIndexCache(): void {
  _aliasIndexCache = null;
}

// (mtime, size) signature of the *.md files under `root`, or null if absent.
function studiesDirSignature(root: string): string | null {
  if (!existsSync(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    try {
      const st = statSync(join(root, f));
      parts.push(`${f}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  return parts.sort().join('|');
}

// alias-slug → owning dossier slug. First writer wins, so a later dossier can't
// hijack an alias an earlier one already claimed (deterministic by filename sort).
function aliasIndex(root: string): Map<string, string> {
  const sig = studiesDirSignature(root);
  if (sig === null) return new Map();
  const key = `${root}|${sig}`;
  if (_aliasIndexCache && _aliasIndexCache.key === key) return _aliasIndexCache.index;

  const index = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return new Map();
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const dossierSlug = f.slice(0, -3);
    if (!isSafeSlug(dossierSlug)) continue;
    let content: string;
    try {
      content = readFileSync(join(root, f), 'utf-8');
    } catch {
      continue;
    }
    for (const alias of parseDossierAliases(content)) {
      if (alias === dossierSlug) continue; // the exact-match path already covers it
      if (!index.has(alias)) index.set(alias, dossierSlug);
    }
  }
  _aliasIndexCache = { key, index };
  return index;
}
