// v0.8.2: durable per-date digest overrides. The 3-phase LLM regenerates the
// entire digest on every build:day, so hand-edits to data/digests/<date>.json
// don't survive a rebuild. This sidecar (data/overrides/<date>.json) is read at
// build time and applied as the final step before the artifact is written, so
// curator edits and removals are durable: suppress studies, override study text
// (tldr / name / bullets / verdict), or override the cross-site top_line/tldr.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type {
  DigestOutput,
  DigestStudy,
  RelatedTrial,
  RelatedTrialsProvenance,
} from './llm-pipeline.ts';
import { RELATED_TRIAL_STATUSES } from './digest-data.ts';
import { deriveSlug } from './slug.ts';
import { assignSlugsForDate } from './slug-resolve.ts';
import { studyDedupKey } from './study-dedup.ts';
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
  // v0.27: curator's own study-level note (human editor's voice). Pass-through
  // string; empty value clears it (mapped to null by the CLI).
  'curator_note',
  'figures',
  // v0.4 single-figure fields retained so old override sidecars still apply.
  'key_figure_caption',
  'key_figure_url',
  'consort',
  // v0.45: the long-form interpretation. Editable for the same reason as the
  // other prose surfaces — it is the longest thing the LLM writes, so a bad one
  // must be fixable (or clearable with null) without re-running Phase 2.
  'interpretation',
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

// v0.13: curator-managed override of the per-study trials-to-watch
// affordance. Two flavors:
//
//   suppress: hide the nested trials block. Optional `questions` field
//     contains EXACT strings from study.open_questions whose trials
//     should be dropped. Omit `questions` to suppress all trials for
//     the study. Keys are full question strings (not indices) so a
//     Phase 2 reorder does not silently re-target the suppression
//     (codex round-2 #22).
//
//   set: replace the orchestrator's picks with a curator-vetted list.
//     On rebuild, set entries whose `answers_question` is no longer
//     in study.open_questions are DROPPED with a WARN (codex round-2
//     #23); entries that fail structural validation (bad NCT format,
//     out-of-enum status, bad date, overlong phrase, dup NCTs, >5
//     total) are also dropped with WARN (codex round-2 #24). When a
//     `set` override is applied, related_trials_provenance.rerank_outcome
//     is rewritten as 'pinned_by_curator' so downstream consumers can
//     see the source.
export type RelatedTrialsOverride =
  | { kind: 'suppress'; questions?: string[] }
  | { kind: 'set'; trials: RelatedTrial[] };

export type DigestOverrides = {
  // Override the cross-site headline / TL;DR.
  digest?: { top_line?: string; tldr?: string };
  // Drop these studies (matched by slug) from the digest entirely.
  suppress?: string[];
  // Override fields on specific studies, keyed by slug.
  edits?: Record<string, StudyEdit>;
  // v0.13: per-study related-trials overrides, keyed by study slug.
  related_trials?: Record<string, RelatedTrialsOverride>;
  // v0.50: what the targeted study WAS, so an override survives a rename.
  //
  // Every other key here is a slug, and a slug is derived from the name Phase 1
  // writes — so a rebuild renames studies and the override silently stops
  // matching. That happened twice in one release cycle: an edit no-op'd
  // (v0.45.1) and three suppressions republished hidden duplicates (v0.49.0).
  // Recorded by the CLI when the override is written; absent on older sidecars,
  // which keep working by slug alone.
  // `source_ids` is the strongest of the three and the reason the other two are
  // not enough. Trial lineage suppresses a superseded card automatically, and
  // the moment it does, that card leaves the published artifact — so the NEXT
  // rebuild cannot hold its slug and renames it, and the override goes stale.
  // Name matching cannot save it either once one trial has two cards: splitting
  // NRG-GU005 into a disease-free-survival card and a quality-of-life card gave
  // both the same studyDedupKey, so the acronym pass matched two studies, and an
  // ambiguous match is correctly refused. Provenance is what actually identifies
  // a card — the same source rows are the same card — which is the identity
  // slug persistence already uses.
  identity?: Record<
    string,
    { nct?: string | null; name?: string; source_ids?: { type: string; id: number }[] }
  >;
};

export type OverrideSummary = {
  suppressed: string[]; // slugs actually dropped
  suppressMissing: string[]; // requested suppress slugs that matched no study
  // v0.50: overrides whose slug no longer exists but whose recorded identity
  // matched a renamed study, as "old->new". Surfaced so a rename is visible in
  // the build log rather than silently absorbed.
  resolvedRenames: string[];
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
  // v0.13: related-trials override tracking.
  //   relatedTrialsSuppressed: slugs where a suppress override applied
  //   relatedTrialsSet: slugs where a set override applied
  //   relatedTrialsMissing: slugs requested in the override block but no
  //     study with that slug exists in this digest (typo / dropped study)
  //   relatedTrialsWarnings: per-entry validation drops (stale question
  //     string, bad NCT format, dup, too many, etc.)
  relatedTrialsSuppressed: string[];
  relatedTrialsSet: string[];
  relatedTrialsMissing: string[];
  relatedTrialsWarnings: string[];
};

// Prefix for an override key whose recorded identity did not resolve. Contains a
// NUL, so it can never collide with a slug.
const UNRESOLVED = '\u0000unresolved:';
export const stripUnresolved = (k: string): string =>
  k.startsWith(UNRESOLVED) ? k.slice(UNRESOLVED.length) : k;

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

// v0.13: structural validation for a curator-pinned RelatedTrial entry.
// Returns null when the entry is valid; otherwise a short string the apply
// path surfaces as a per-entry WARN. The sidecar is a trust boundary
// (curator hand-edit), so EVERY RelatedTrial field is checked here, not
// just the obvious identifiers. A field of the wrong shape would survive
// the `as RelatedTrial` cast and crash the renderer later. Codex round-2
// #24 + Claude PR-3 #1.
function validateRelatedTrialEntry(t: unknown): string | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'not an object';
  const e = t as Record<string, unknown>;
  if (typeof e.nct !== 'string' || !/^NCT\d{8}$/.test(e.nct)) return 'invalid nct format';
  if (
    typeof e.overall_status !== 'string' ||
    !(RELATED_TRIAL_STATUSES as readonly string[]).includes(e.overall_status)
  ) {
    return 'overall_status not in enum';
  }
  if (typeof e.brief_title !== 'string' || e.brief_title.trim().length === 0) return 'missing brief_title';
  if (typeof e.answers_question !== 'string' || e.answers_question.trim().length === 0) {
    return 'missing answers_question';
  }
  if (typeof e.relevance_phrase !== 'string' || e.relevance_phrase.trim().length === 0) {
    return 'missing relevance_phrase';
  }
  // Allow up to 80 chars here so a curator can paste a slightly longer pinned
  // phrase than the LLM cap; the renderer is the place to truncate further.
  if (e.relevance_phrase.length > 80) return 'relevance_phrase too long (>80)';
  // phase must be string[] | null (RelatedTrial contract). String alone
  // would pass downstream until something does .map() on it.
  if (e.phase !== null && (!Array.isArray(e.phase) || e.phase.some((x) => typeof x !== 'string'))) {
    return 'phase must be string[] or null';
  }
  // enrollment_count: number | null (and finite, not NaN).
  if (
    e.enrollment_count !== null &&
    (typeof e.enrollment_count !== 'number' || !Number.isFinite(e.enrollment_count))
  ) {
    return 'enrollment_count must be number or null';
  }
  if (e.primary_completion_date !== null && typeof e.primary_completion_date !== 'string') {
    return 'primary_completion_date must be string or null';
  }
  if (
    typeof e.primary_completion_date === 'string' &&
    !/^\d{4}(-\d{2})?$/.test(e.primary_completion_date)
  ) {
    return 'primary_completion_date must be YYYY or YYYY-MM';
  }
  if (e.brief_summary !== null && typeof e.brief_summary !== 'string') {
    return 'brief_summary must be string or null';
  }
  if (e.eligibility_brief !== null && typeof e.eligibility_brief !== 'string') {
    return 'eligibility_brief must be string or null';
  }
  if (!Array.isArray(e.conditions) || e.conditions.some((c) => typeof c !== 'string')) {
    return 'conditions must be string[]';
  }
  if (!Array.isArray(e.interventions)) {
    return 'interventions must be an array';
  }
  for (const iv of e.interventions) {
    if (!iv || typeof iv !== 'object' || Array.isArray(iv)) return 'interventions[] entries must be objects';
    const obj = iv as Record<string, unknown>;
    if (typeof obj.name !== 'string' || typeof obj.type !== 'string') {
      return 'interventions[] entries must have string name and type';
    }
  }
  return null;
}

// v0.13: apply one curator override to one study's related_trials.
// Returns the mutated study (or the same reference if no change).
// Writes warnings into the summary as it goes.
//
// `digestDate` (YYYY-MM-DD) is used as the deterministic `fetched_at`
// value when we synthesize a fresh provenance (curator pinned a set on a
// study that had no orchestrator output). Using wall-clock there would
// make rebuilds non-deterministic, breaking artifact-hash comparisons
// (codex PR-3 P2 + Claude PR-3 MEDIUM #8).
function applyRelatedTrialsOverride(
  study: DigestStudy,
  override: RelatedTrialsOverride,
  summary: OverrideSummary,
  slug: string,
  digestDate: string,
): DigestStudy {
  // Validate the override's discriminator. Hand-edits could carry an
  // unknown `kind` value that TS narrowing happily accepts at runtime
  // (codex PR-3 P2).
  if (override.kind !== 'suppress' && override.kind !== 'set') {
    summary.relatedTrialsWarnings.push(
      `${slug}: unknown override kind "${String((override as { kind?: unknown }).kind)}"; skipped`,
    );
    return study;
  }

  if (override.kind === 'suppress') {
    const questions = override.questions;
    // Empty array is treated as "no-op" rather than "suppress all" so a
    // curator hand-edit { questions: [] } doesn't surprise-wipe pinned
    // trials. Whole-study suppress is `questions` OMITTED, not empty
    // (claude PR-3 HIGH #3).
    if (questions === undefined) {
      summary.relatedTrialsSuppressed.push(slug);
      return { ...study, related_trials: [] };
    }
    if (!Array.isArray(questions)) {
      summary.relatedTrialsWarnings.push(`${slug}: suppress.questions must be an array; skipped`);
      return study;
    }
    if (questions.length === 0) {
      summary.relatedTrialsWarnings.push(
        `${slug}: suppress.questions is empty; treating as no-op (omit the field to suppress all)`,
      );
      return study;
    }
    if (questions.some((q) => typeof q !== 'string')) {
      summary.relatedTrialsWarnings.push(`${slug}: suppress.questions entries must be strings; skipped`);
      return study;
    }
    // Per-question suppress. Drop trials whose answers_question is in the
    // suppress list. Trims protect against trailing whitespace drift.
    const drop = new Set(questions.map((q) => q.trim()));
    const validQuestions = new Set(study.open_questions ?? []);
    // Symmetric with set: a stale question string surfaces as a warning so
    // the curator knows their suppress key drifted (Claude PR-3 LOW #9).
    for (const q of questions) {
      if (!validQuestions.has(q.trim())) {
        summary.relatedTrialsWarnings.push(
          `${slug}: suppress question "${q.trim()}" not in current study.open_questions (stale)`,
        );
      }
    }
    const filtered = (study.related_trials ?? []).filter(
      (t) => !drop.has(t.answers_question.trim()),
    );
    summary.relatedTrialsSuppressed.push(slug);
    return { ...study, related_trials: filtered };
  }

  // 'set' override.
  const trialsRaw = override.trials;
  if (!Array.isArray(trialsRaw)) {
    summary.relatedTrialsWarnings.push(`${slug}: set override trials is not an array`);
    return study;
  }
  const validQuestions = new Set(study.open_questions ?? []);
  const seenNct = new Set<string>();
  const validated: RelatedTrial[] = [];
  for (const t of trialsRaw) {
    if (validated.length >= 5) {
      summary.relatedTrialsWarnings.push(`${slug}: dropped extra pinned trials (cap 5)`);
      break;
    }
    const err = validateRelatedTrialEntry(t);
    if (err) {
      const id =
        t && typeof t === 'object' && 'nct' in (t as Record<string, unknown>)
          ? String((t as Record<string, unknown>).nct ?? '?')
          : '?';
      summary.relatedTrialsWarnings.push(`${slug}: dropped pinned trial ${id}: ${err}`);
      continue;
    }
    const trial = t as RelatedTrial;
    if (!validQuestions.has(trial.answers_question)) {
      summary.relatedTrialsWarnings.push(
        `${slug}: dropped pinned trial ${trial.nct}: answers_question not in current study.open_questions (stale)`,
      );
      continue;
    }
    if (seenNct.has(trial.nct)) {
      summary.relatedTrialsWarnings.push(`${slug}: dropped pinned trial ${trial.nct}: duplicate NCT`);
      continue;
    }
    seenNct.add(trial.nct);
    // Defensive copy: don't store a reference to the curator-supplied
    // object so a downstream caller mutating the loaded overrides cannot
    // corrupt the returned digest (claude PR-3 HIGH #2).
    const clone: RelatedTrial = {
      ...trial,
      phase: trial.phase === null ? null : [...trial.phase],
      conditions: [...trial.conditions],
      interventions: trial.interventions.map((iv) => ({ ...iv })),
    };
    validated.push(clone);
  }

  // Mark provenance so /api/v1 consumers can see this was curator-pinned,
  // not LLM-picked. Initialize a minimal provenance if the study didn't
  // already carry one (e.g. orchestrator never ran for this study). Use
  // the digest date for fetched_at so the artifact stays reproducible.
  const provenance: RelatedTrialsProvenance = study.related_trials_provenance
    ? { ...study.related_trials_provenance, rerank_outcome: 'pinned_by_curator' }
    : {
        queries_fired: [],
        queries_failed: [],
        candidates_returned: 0,
        fetched_at: digestDate,
        rerank_outcome: 'pinned_by_curator',
      };

  // Only count this as "set succeeded" when at least one entry survived
  // validation. A set that validated 0 entries is functionally an
  // abstention; the summary shouldn't claim "set 1 study" when the
  // artifact shows nothing pinned (claude PR-3 MEDIUM #5).
  if (validated.length > 0) {
    summary.relatedTrialsSet.push(slug);
    return {
      ...study,
      related_trials: validated,
      related_trials_provenance: provenance,
    };
  }
  return {
    ...study,
    related_trials: null,
    related_trials_provenance: provenance,
  };
}

// Pure: apply overrides to a digest, returning a new digest plus a summary of
// what changed. Does not mutate the input.
//
// `opts.digestDate` (YYYY-MM-DD) is used as the deterministic `fetched_at`
// value when a curator pins a trial set on a study that had no prior
// orchestrator output. Callers building production artifacts should pass
// the date; tests and callers that don't care about determinism may omit
// it (and get an ISO wall-clock value).
//
// `opts.studyDropped` says a Phase 2 call FAILED this run, so a card the date
// normally carries is absent for a reason that has nothing to do with the
// curator. It narrows how far a legacy (provenance-free) identity is trusted —
// see the re-point rules in reindex.
export function applyOverrides(
  digest: DigestOutput,
  overrides: DigestOverrides,
  opts: { digestDate?: string; studyDropped?: boolean } = {},
): { digest: DigestOutput; summary: OverrideSummary } {
  const suppress = new Set(overrides.suppress ?? []);
  const edits = overrides.edits ?? {};
  const relatedTrials = overrides.related_trials ?? {};
  const fetchedAtForPin = opts.digestDate ?? new Date().toISOString();
  const summary: OverrideSummary = {
    suppressed: [],
    suppressMissing: [],
    resolvedRenames: [],
    edited: [],
    editMissing: [],
    digestFields: [],
    tagWarnings: [],
    relatedTrialsSuppressed: [],
    relatedTrialsSet: [],
    relatedTrialsMissing: [],
    relatedTrialsWarnings: [],
  };

  // v0.50: an override targets a slug, and a rebuild can rename the study out
  // from under it. Re-point each stale key at the study its recorded identity
  // names, so the curator's decision survives the rename.
  //
  // NCT first, because a registration is an exact identifier. The acronym key
  // (studyDedupKey, shared with the cross-date duplicate finder) is the second
  // pass for the many studies that carry no NCT.
  //
  // A match must be UNIQUE. Two studies answering to one identity means the
  // override is ambiguous, and guessing would either drop a card the curator
  // wants or keep one they hid — both silent, both worse than reporting the
  // key as missing and letting the build refuse.
  function reindex<T>(
    table: Record<string, T>,
    live: Set<string>,
    identity: NonNullable<DigestOverrides['identity']>,
    studies: DigestStudy[],
    slugOf: (st: DigestStudy) => string,
    onRename: (from: string, to: string) => void,
  ): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(table)) {
      const id = identity[key];
      // Malformed sidecar JSON must never throw inside build:day — an override
      // file is hand-editable, and a bad entry has to degrade to "unmatched",
      // which the caller already reports, not to a failed nightly publish.
      // Malformed identity fails CLOSED: an entry missing a string type or an
      // integer id is dropped, and `{type:'paper', id:'44'}` must not match
      // numeric source 44 through string interpolation.
      // Distinguish ABSENT legacy provenance from PRESENT-BUT-INVALID. A
      // non-array value (`"corrupt"`, an object, a number) used to collapse to
      // [] and read as "no provenance recorded", which then took the live-slug
      // shortcut and suppressed whoever holds that slug now.
      // `in` throws a TypeError on a primitive, and an override sidecar is
      // hand-editable — `identity: { key: "corrupt" }` aborted the whole nightly
      // build:day. Narrow to an object first. A non-object entry, or an explicit
      // null source_ids, is PRESENT-BUT-INVALID, which must fail closed rather
      // than read as "legacy, no provenance recorded" and take the live-slug
      // shortcut.
      const idIsObject = typeof id === 'object' && id !== null;
      const entryMalformed = id !== undefined && !idIsObject;
      const provenancePresent =
        entryMalformed || (idIsObject && 'source_ids' in id && id.source_ids !== undefined);
      const rawSources = idIsObject && Array.isArray(id.source_ids) ? id.source_ids : [];
      const wantSources = rawSources.filter(
        (s): s is { type: string; id: number } =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as { type?: unknown }).type === 'string' &&
          Number.isInteger((s as { id?: unknown }).id),
      );
      // A recorded entry we could not parse means the identity is incomplete, so
      // refuse to act on it rather than match on the surviving subset.
      const identityCorrupt =
        entryMalformed ||
        rawSources.length !== wantSources.length ||
        (provenancePresent && !Array.isArray(idIsObject ? id.source_ids : undefined));
      const want = new Set(wantSources.map((s) => `${s.type}:${s.id}`));
      // EQUALITY, not overlap. `.some()` let a regenerated card built from
      // [paper:44, paper:43] match an override recorded for [paper:44] alone —
      // so a Phase 1 merge could hand the suppression a card carrying an
      // unrelated second objective, and take that finding down with it. The card
      // the override was written against is the card with exactly those sources.
      // Slides are excluded from the comparison on BOTH sides. A conference
      // slide can arrive for a past date long after the card was built, turning
      // [paper:44] into [paper:44, slide:7]; under whole-set equality that
      // silently invalidated the override, and an unmatched suppress is FATAL to
      // build:day — so one late photo could fail the nightly publish. Lineage
      // already treats a slide as non-substantive, and this agrees with it.
      const substantive = (refs: { type: string; id: number }[]): Set<string> =>
        new Set(refs.filter((r) => r.type !== 'slide').map((r) => `${r.type}:${r.id}`));
      const wantSubstantive = substantive(wantSources);
      const provenanceHit = (st: DigestStudy): boolean => {
        const have = substantive(st.source_ids ?? []);
        return (
          have.size === wantSubstantive.size && [...wantSubstantive].every((k) => have.has(k))
        );
      };

      // A LIVE slug is not proof of identity when provenance says otherwise.
      //
      // This used to short-circuit on `live.has(key)` alone, and that is unsafe
      // precisely because lineage now creates two cards per trial: suppressing a
      // card removes it from the artifact, the next rebuild renames the survivor,
      // and the vacated slug can be REUSED by the sibling card. The override then
      // hid whichever study happened to hold the old slug — the quality-of-life
      // card instead of the disease-free-survival one. When provenance is
      // recorded it must agree; when it disagrees, fall through and re-resolve.
      // Corrupt identity is NOT a licence to trust the slug. It used to short
      // through here, which is backwards: an override whose recorded identity we
      // cannot parse is exactly the one we cannot verify points at the right
      // card, and the slug it names may since have been inherited by a sibling.
      if (live.has(key) && !identityCorrupt) {
        const holder = studies.find((st) => slugOf(st) === key);
        if (wantSubstantive.size === 0 || !holder || provenanceHit(holder)) {
          out[key] = value;
          continue;
        }
      }
      const wantNct = idIsObject && typeof id.nct === 'string' ? id.nct.trim().toUpperCase() : '';
      const wantKey = idIsObject && typeof id.name === 'string' ? studyDedupKey(id.name) : null;
      let hits: DigestStudy[] = [];
      if (/^NCT\d{8}$/.test(wantNct)) {
        hits = studies.filter((st) => (st.nct ?? '').trim().toUpperCase() === wantNct);
      }
      if (hits.length !== 1 && wantKey) {
        hits = studies.filter((st) => studyDedupKey(st.name) === wantKey);
      }
      // Provenance is the most specific signal — a card IS its source rows — and
      // it is the only one that can separate two cards of ONE trial, which share
      // an acronym key and often carry no NCT. So it does not merely break ties:
      // whenever it is recorded, it FILTERS whatever the weaker passes proposed,
      // and it stands alone if they proposed nothing. A unique NCT or name hit
      // that provenance contradicts is the wrong card.
      if (identityCorrupt) {
        hits = []; // unparseable provenance → refuse to re-point at all
      } else if (wantSources.length > 0) {
        hits = (hits.length > 0 ? hits : studies).filter(provenanceHit);
      } else if (opts.studyDropped) {
        // LEGACY IDENTITY (nct/name, no source_ids) MAY NOT RE-POINT ACROSS A
        // PHASE 2 FAILURE.
        //
        // Provenance is the only signal that separates two cards of ONE trial,
        // and a legacy entry has none: NCT and acronym key are exactly the
        // fields an efficacy card and its quality-of-life sibling SHARE. So the
        // question is only ever "why is the recorded slug missing", and there
        // are two answers with opposite correct responses:
        //
        //   renamed  → re-point. This is what the identity block exists for and
        //              the overwhelmingly common case, so it stays the default.
        //   vanished → REFUSE. If Phase 2 failed on the card the override was
        //              written against, the NCT/name passes will resolve to its
        //              surviving sibling and suppress that instead — the curator
        //              retires the efficacy card and the QoL card comes down.
        //
        // `studyDropped` is what tells them apart, and it is the only signal
        // available: a rename leaves no casualty, a failure records one in
        // meta.dropped. Five committed sidecars are legacy-shaped today
        // (2026-05-17 extend-trial / radiosa-mfs-posthoc / rapchem, 2026-05-18
        // peace-2, 2026-05-31 enzarad), all suppressions, so this is live data.
        //
        // Refusing leaves the suppress unmatched, which build:day already
        // treats as fatal — loud and recoverable, versus silently deleting the
        // wrong card.
        hits = [];
      }
      if (hits.length === 1) {
        const to = slugOf(hits[0]);
        out[to] = value;
        onRename(key, to);
      } else if (identityCorrupt || wantSubstantive.size > 0) {
        // Identity WAS recorded and did not resolve. Writing the key back would
        // apply the override to whatever study holds that slug today — the
        // sibling-card reuse this whole mechanism exists to prevent. Park it
        // under a sentinel that can never equal a slug so it is reported
        // missing (fatal for a suppress) instead of hitting the wrong card.
        out[`${UNRESOLVED}${key}`] = value;
      } else {
        out[key] = value; // no identity recorded: legacy slug-only behaviour
      }
    }
    return out;
  }

  const seenSlugs = new Set<string>();
  const droppedStudies: Array<{ slug: string; name: string; reason: string }> = [];

  // Match overrides against the COLLISION-RESOLVED slug (assignSlugsForDate over
  // the flattened per-date study list, in the SAME order the renderer uses),
  // not the raw per-study slug. Raw matching meant two studies sharing a base
  // slug were BOTH dropped by a single suppress (and double-counted), while the
  // curator could never target the "-2" one shown on the page. The resolved
  // slug is unique per study, so a suppress/edit hits exactly one. Keyed by
  // object identity.
  const allStudies = digest.sites.flatMap((s) => s.studies);
  const resolvedSlugList = assignSlugsForDate(allStudies);
  const slugByStudy = new Map<DigestStudy, string>();
  allStudies.forEach((st, i) => slugByStudy.set(st, resolvedSlugList[i] ?? studySlug(st)));
  const slugFor = (study: DigestStudy): string => slugByStudy.get(study) ?? studySlug(study);

  // Re-point stale override keys at renamed studies (v0.50). Runs before any
  // table is consulted, so suppress/edit/related-trials all see live slugs.
  const liveSlugs = new Set(allStudies.map(slugFor));
  const identity = overrides.identity ?? {};
  const renamed = new Set<string>();
  const noteRename = (from: string, to: string) => renamed.add(`${from} → ${to}`);
  const suppressTable = reindex(
    Object.fromEntries([...suppress].map((k) => [k, true as const])),
    liveSlugs, identity, allStudies, slugFor, noteRename,
  );
  const suppressKeys = new Set(Object.keys(suppressTable));
  const editsTable = reindex(edits, liveSlugs, identity, allStudies, slugFor, noteRename);
  const relatedTable = reindex(relatedTrials, liveSlugs, identity, allStudies, slugFor, noteRename);
  summary.resolvedRenames.push(...renamed);

  const sites = digest.sites
    .map((site) => {
      const studies = site.studies
        .filter((study) => {
          const slug = slugFor(study);
          seenSlugs.add(slug);
          if (suppressKeys.has(slug)) {
            summary.suppressed.push(slug);
            droppedStudies.push({ slug, name: study.name, reason: 'suppressed via override' });
            return false;
          }
          return true;
        })
        .map((study) => {
          const slug = slugFor(study);
          let next = study;
          const edit = editsTable[slug];
          if (edit) {
            summary.edited.push(slug);
            const { picked, warnings } = pickEditable(edit, slug);
            if (warnings.length > 0) summary.tagWarnings.push(...warnings);
            next = { ...next, ...picked };
          }
          // v0.13: related-trials override applied AFTER the field edits, so
          // a curator can simultaneously edit open_questions AND pin a
          // trial set in the same override file (the set's answers_question
          // membership check runs against the post-edit open_questions).
          const rtOverride = relatedTable[slug];
          if (rtOverride) {
            next = applyRelatedTrialsOverride(next, rtOverride, summary, slug, fetchedAtForPin);
          }
          return next;
        });
      return { ...site, studies };
    })
    .filter((site) => site.studies.length > 0);

  // Requested slugs that didn't match any study so a typo'd slug doesn't
  // silently no-op.
  for (const slug of suppressKeys)
    if (!seenSlugs.has(slug)) summary.suppressMissing.push(stripUnresolved(slug));
  for (const slug of Object.keys(editsTable)) if (!seenSlugs.has(slug)) summary.editMissing.push(slug);
  for (const slug of Object.keys(relatedTable)) {
    if (!seenSlugs.has(slug)) summary.relatedTrialsMissing.push(slug);
  }

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
  if (s.relatedTrialsSuppressed.length) {
    parts.push(`trials-suppress ${s.relatedTrialsSuppressed.length} (${s.relatedTrialsSuppressed.join(', ')})`);
  }
  if (s.relatedTrialsSet.length) {
    parts.push(`trials-set ${s.relatedTrialsSet.length} (${s.relatedTrialsSet.join(', ')})`);
  }
  const warns: string[] = [];
  if (s.suppressMissing.length) warns.push(`suppress slug(s) not found: ${s.suppressMissing.join(', ')}`);
  if (s.editMissing.length) warns.push(`edit slug(s) not found: ${s.editMissing.join(', ')}`);
  if (s.relatedTrialsMissing.length) {
    warns.push(`related-trials slug(s) not found: ${s.relatedTrialsMissing.join(', ')}`);
  }
  if (s.tagWarnings.length) warns.push(...s.tagWarnings);
  if (s.relatedTrialsWarnings.length) warns.push(...s.relatedTrialsWarnings);
  if (s.resolvedRenames.length) parts.push(`re-pointed ${s.resolvedRenames.join(', ')}`);
  let out = parts.length ? parts.join('; ') : 'no-op';
  if (warns.length) out += `; WARN ${warns.join('; ')}`;
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
