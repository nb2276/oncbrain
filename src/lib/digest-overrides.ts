// v0.8.2: durable per-date digest overrides. The 3-phase LLM regenerates the
// entire digest on every build:day, so hand-edits to data/digests/<date>.json
// don't survive a rebuild. This sidecar (data/overrides/<date>.json) is read at
// build time and applied as the final step before the artifact is written, so
// curator edits and removals are durable: suppress studies, override study text
// (tldr / name / bullets / verdict), or override the cross-site top_line/tldr.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { DigestOutput, DigestStudy } from './llm-pipeline.ts';
import { deriveSlug } from './slug.ts';
import {
  isValidModality,
  isValidIntent,
  isValidMethodology,
  MODALITY_VALUES,
  INTENT_VALUES,
  METHODOLOGY_VALUES,
} from './tags.ts';

// Study fields a curator may override. Identity/citation fields (slug,
// tweet_ids, source_ids) are intentionally excluded so per-study anchors and
// the NCT/PMID/DOI auto-link layer stay intact even when display text changes.
const EDITABLE_STUDY_KEYS = [
  'name',
  'tldr',
  'nct',
  'details',
  'verdict',
  'open_questions',
  'figures',
  // v0.4 single-figure fields retained so old override sidecars still apply.
  'key_figure_caption',
  'key_figure_url',
  'consort',
  // v0.10: cross-cutting tag fields. The Phase 2 LLM emits these but is
  // imperfect on hard semantic calls (palliative vs curative, phase 2 vs
  // phase 3). Curator overrides land here so a wrong emission can be fixed
  // without re-running the LLM. Pass null to explicitly clear the LLM's
  // emission ({modality: null} → study appears on no modality landing).
  'modality',
  'intent',
  'methodology',
] as const;

export type StudyEdit = Partial<Pick<DigestStudy, (typeof EDITABLE_STUDY_KEYS)[number]>>;

export type DigestOverrides = {
  // Override the cross-site headline / TL;DR.
  digest?: { top_line?: string; tldr?: string };
  // Drop these studies (matched by slug) from the digest entirely.
  suppress?: string[];
  // Override fields on specific studies, keyed by slug.
  edits?: Record<string, StudyEdit>;
};

export type OverrideSummary = {
  suppressed: string[]; // slugs actually dropped
  suppressMissing: string[]; // requested suppress slugs that matched no study
  edited: string[]; // slugs actually edited
  editMissing: string[]; // requested edit slugs that matched no study
  digestFields: string[]; // digest-level fields overridden
  // v0.10: tag-field overrides that failed validation at application time
  // (sidecar JSON bypassed the CLI's enum check, or the enum was tightened
  // after the override was written). Codex review caught the bypass path:
  // applyOverrides used to copy any string through, the tag index then
  // silently dropped invalid values to null, the build claimed "edited" but
  // shipped the study off the landing. Now invalid tag overrides are dropped
  // and surfaced here so the build log shows what happened.
  tagWarnings: string[];
};

export function overridesPath(date: string, dir = 'data/overrides'): string {
  return resolve(dir, `${date}.json`);
}

export function loadOverrides(date: string, dir = 'data/overrides'): DigestOverrides | null {
  const p = overridesPath(date, dir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as DigestOverrides;
}

// Write the override sidecar (creating the dir if needed). Returns the path.
export function saveOverrides(date: string, ov: DigestOverrides, dir = 'data/overrides'): string {
  const p = overridesPath(date, dir);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ov, null, 2) + '\n');
  return p;
}

function studySlug(study: DigestStudy): string {
  return study.slug ?? deriveSlug(study.name);
}

// Keep only whitelisted keys from a curator-supplied edit, so an override file
// can't clobber slug / citation fields by accident.
//
// v0.10: tag fields (modality/intent/methodology) are additionally enum-
// validated here. An invalid value coming in from a hand-edited sidecar JSON
// gets dropped to null with a warning surfaced through `tagWarnings` so the
// build CLI displays it. This closes the bypass Codex review surfaced: the
// CLI gates valid input but the sidecar is a separate trust boundary.
function pickEditable(edit: StudyEdit, slug: string): { picked: StudyEdit; warnings: string[] } {
  const out: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const k of EDITABLE_STUDY_KEYS) {
    if (edit[k] === undefined) continue;
    if (k === 'modality' || k === 'intent' || k === 'methodology') {
      const raw = edit[k];
      if (raw === null) {
        out[k] = null;
        continue;
      }
      if (typeof raw !== 'string') {
        warnings.push(`${slug}: invalid ${k} type (${typeof raw}); dropped`);
        continue;
      }
      const validator =
        k === 'modality' ? isValidModality :
        k === 'intent' ? isValidIntent :
        isValidMethodology;
      if (!validator(raw)) {
        const allowed =
          k === 'modality' ? MODALITY_VALUES :
          k === 'intent' ? INTENT_VALUES :
          METHODOLOGY_VALUES;
        warnings.push(`${slug}: invalid ${k} "${raw}" (not in ${allowed.join('|')}); dropped`);
        continue;
      }
      out[k] = raw;
    } else {
      out[k] = edit[k];
    }
  }
  return { picked: out as StudyEdit, warnings };
}

// Pure: apply overrides to a digest, returning a new digest plus a summary of
// what changed. Does not mutate the input.
export function applyOverrides(
  digest: DigestOutput,
  overrides: DigestOverrides,
): { digest: DigestOutput; summary: OverrideSummary } {
  const suppress = new Set(overrides.suppress ?? []);
  const edits = overrides.edits ?? {};
  const summary: OverrideSummary = {
    suppressed: [],
    suppressMissing: [],
    edited: [],
    editMissing: [],
    digestFields: [],
    tagWarnings: [],
  };

  const seenSlugs = new Set<string>();
  const droppedStudies: Array<{ slug: string; name: string; reason: string }> = [];

  const sites = digest.sites
    .map((site) => {
      const studies = site.studies
        .filter((study) => {
          const slug = studySlug(study);
          seenSlugs.add(slug);
          if (suppress.has(slug)) {
            summary.suppressed.push(slug);
            droppedStudies.push({ slug, name: study.name, reason: 'suppressed via override' });
            return false;
          }
          return true;
        })
        .map((study) => {
          const slug = studySlug(study);
          const edit = edits[slug];
          if (!edit) return study;
          summary.edited.push(slug);
          const { picked, warnings } = pickEditable(edit, slug);
          if (warnings.length > 0) summary.tagWarnings.push(...warnings);
          return { ...study, ...picked };
        });
      return { ...site, studies };
    })
    .filter((site) => site.studies.length > 0);

  // Requested slugs that didn't match any study — surfaced as warnings so a
  // typo'd slug doesn't silently no-op.
  for (const slug of suppress) if (!seenSlugs.has(slug)) summary.suppressMissing.push(slug);
  for (const slug of Object.keys(edits)) if (!seenSlugs.has(slug)) summary.editMissing.push(slug);

  const meta = {
    ...digest.meta,
    studies_analyzed: sites.reduce((n, s) => n + s.studies.length, 0),
    dropped: [...digest.meta.dropped, ...droppedStudies],
  };

  let top_line = digest.top_line;
  let tldr = digest.tldr;
  if (overrides.digest?.top_line !== undefined) {
    top_line = overrides.digest.top_line;
    summary.digestFields.push('top_line');
  }
  if (overrides.digest?.tldr !== undefined) {
    tldr = overrides.digest.tldr;
    summary.digestFields.push('tldr');
  }

  return { digest: { top_line, tldr, sites, meta }, summary };
}

// One-line human summary for build logs / CLI feedback.
export function formatOverrideSummary(s: OverrideSummary): string {
  const parts: string[] = [];
  if (s.suppressed.length) parts.push(`suppressed ${s.suppressed.length} (${s.suppressed.join(', ')})`);
  if (s.edited.length) parts.push(`edited ${s.edited.length} (${s.edited.join(', ')})`);
  if (s.digestFields.length) parts.push(`digest ${s.digestFields.join('+')}`);
  const warns: string[] = [];
  if (s.suppressMissing.length) warns.push(`suppress slug(s) not found: ${s.suppressMissing.join(', ')}`);
  if (s.editMissing.length) warns.push(`edit slug(s) not found: ${s.editMissing.join(', ')}`);
  if (s.tagWarnings.length) warns.push(...s.tagWarnings);
  let out = parts.length ? parts.join('; ') : 'no-op';
  if (warns.length) out += ` — WARN ${warns.join('; ')}`;
  return out;
}

// ---------------- CLI flag parsing (extracted for testability) ----------------

/**
 * One CLI tag flag's parse result. Used by build/manage-overrides.ts and by
 * the unit tests so the case-normalization + bareword + whitespace + enum
 * validation logic is exercised without spawning a child process.
 *
 * Symmetric with src/lib/llm-pipeline.ts:parseEnumTag (the Phase 2 LLM
 * normalization layer) — both lowercase before validating so a curator
 * typing "Radiation" doesn't hit the same case-sensitivity wall the LLM
 * adversarial review surfaced in PR #2.
 */
export type ParseTagFlagResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export type TagFlagField = 'modality' | 'intent' | 'methodology';

/**
 * Parse one CLI tag-flag value into the override edit. Handles:
 *   - Bareword (e.g. `--modality` with no `=`) → error (typo guard)
 *   - Explicit empty (`--modality=`) → null (clear LLM emission)
 *   - Whitespace-only (`--modality="   "`) → error (typo guard, NOT clear)
 *   - Mixed case (`--modality=Radiation`) → lowercased + validated
 *   - Out-of-enum (`--modality=immunotherapy`) → error with allowed list
 *
 * Adversarial-review fix (PR #16): the prior CLI loop trusted case-sensitive
 * validation and treated `--modality=   ` as a clear. Both gaps are closed
 * here and shared with the unit tests.
 */
export function parseTagFlag(field: TagFlagField, raw: unknown): ParseTagFlagResult {
  if (typeof raw === 'boolean') {
    return {
      ok: false,
      error: `--${field} requires a value. Use --${field}=<value> to set, or --${field}= (empty) to clear the LLM's emission.`,
    };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: `--${field} must be a string value`,
    };
  }
  // Distinguish explicit-empty (clear) from whitespace-only (typo guard).
  // raw === '' is the only signal that clears.
  if (raw === '') return { ok: true, value: null };
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') {
    return {
      ok: false,
      error: `--${field}="${raw}" is whitespace-only. Did you mean --${field}= (empty) to clear the LLM's emission?`,
    };
  }
  const validator =
    field === 'modality' ? isValidModality :
    field === 'intent' ? isValidIntent :
    isValidMethodology;
  const allowed =
    field === 'modality' ? MODALITY_VALUES :
    field === 'intent' ? INTENT_VALUES :
    METHODOLOGY_VALUES;
  if (!validator(normalized)) {
    return {
      ok: false,
      error: `invalid --${field}="${raw}". Allowed values: ${allowed.join(', ')}. Or use --${field}= (empty) to clear the LLM's emission.`,
    };
  }
  return { ok: true, value: normalized };
}
