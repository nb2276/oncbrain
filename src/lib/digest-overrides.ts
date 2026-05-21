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
  'key_figure_caption',
  'key_figure_url',
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
function pickEditable(edit: StudyEdit): StudyEdit {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE_STUDY_KEYS) {
    if (edit[k] !== undefined) out[k] = edit[k];
  }
  return out as StudyEdit;
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
          const edit = edits[studySlug(study)];
          if (!edit) return study;
          summary.edited.push(studySlug(study));
          return { ...study, ...pickEditable(edit) };
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
  let out = parts.length ? parts.join('; ') : 'no-op';
  if (warns.length) out += ` — WARN ${warns.join('; ')}`;
  return out;
}
