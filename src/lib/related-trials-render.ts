// Render helpers for the v0.13 "Trials to watch" affordance in StudyCard.astro.
//
// Extracted from the Astro template so the per-trial sub-line formatter,
// status-pill text, and badge text are unit-testable. The Astro file imports
// these and only handles markup + scoped CSS.
//
// Design references:
//   - docs/plans/v0.13-related-open-trials.md (v3.1 after design review)
//   - DESIGN.md "Disease-site emoji anchors" (the 🟡/🔵/🟢 collision the
//     design review caught)
//   - codex round-2 #30 (phase chip dropped when phase[] is empty/null)

import type { RelatedTrial, RelatedTrialStatus } from './digest-data.ts';

// v0.13: status text pill values. Short two-token labels at .section-label
// typography. Text, NOT colored circle emojis: DESIGN.md already uses 🟡
// for hepatobiliary disease-site anchor and 🚀↔️🔄🧪⚠️❔ for the verdict
// pill, so a four-circle status set would collide visually.
const STATUS_PILL_TEXT: Readonly<Record<RelatedTrialStatus, string>> = {
  RECRUITING: 'recruiting',
  NOT_YET_RECRUITING: 'not yet',
  ACTIVE_NOT_RECRUITING: 'active',
  ENROLLING_BY_INVITATION: 'invite only',
};

// Long-form labels for the aria-label on each pill. Screen readers get the
// expanded clinical meaning so "active" doesn't mean "enrolling now" to a
// listener (it specifically means enrollment closed, follow-up ongoing).
const STATUS_ARIA_LABEL: Readonly<Record<RelatedTrialStatus, string>> = {
  RECRUITING: 'recruiting',
  NOT_YET_RECRUITING: 'not yet recruiting',
  ACTIVE_NOT_RECRUITING: 'active, not recruiting',
  ENROLLING_BY_INVITATION: 'enrolling by invitation only',
};

export function statusPillText(s: RelatedTrialStatus): string {
  return STATUS_PILL_TEXT[s];
}

export function statusAriaLabel(s: RelatedTrialStatus): string {
  return STATUS_ARIA_LABEL[s];
}

// Format the phase chip text. Returns null when phase is empty/null so the
// caller can skip rendering the chip entirely (codex round-2 #30: no "—"
// placeholder, just drop the element).
export function formatPhaseChip(phase: string[] | null): string | null {
  if (!phase || phase.length === 0) return null;
  // CT.gov emits values like "PHASE1", "PHASE2", "EARLY_PHASE1", "NA". The
  // chip reads "Phase <values>", so each entry is normalized to its
  // distinguishing fragment (e.g. "PHASE3" → "3", "EARLY_PHASE1" → "Early 1",
  // "NA" → "NA"). Strip PHASE anywhere it appears; title-case prose tokens
  // (Early, Phase) while keeping short acronyms (NA, II, IV) and bare
  // digits intact.
  const cleaned = phase
    .map((p) => formatSinglePhase(p))
    .filter((p) => p.length > 0);
  if (cleaned.length === 0) return null;
  return `Phase ${cleaned.join('/')}`;
}

function formatSinglePhase(raw: string): string {
  return raw
    .split(/[_\s]+/)
    .map((tok) => tok.replace(/^PHASE$/i, '').trim())
    .filter((tok) => tok.length > 0)
    .map((tok) => {
      // Strip leading PHASE prefix attached to a token like PHASE3 / PHASE1.
      const stripped = tok.replace(/^PHASE/i, '');
      if (stripped.length === 0) return '';
      // Pure digits ("3") and short acronyms ("NA", "II") stay as is.
      if (/^[0-9]+$/.test(stripped)) return stripped;
      if (/^[A-Z]{2,3}$/.test(stripped)) return stripped;
      // Title-case prose tokens ("EARLY" → "Early").
      return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
    })
    .filter((tok) => tok.length > 0)
    .join(' ');
}

// Format the per-trial sub-line: enrollment count, primary completion date,
// relevance phrase, joined with middle-dots. Each field is skipped (along
// with its leading separator) when null/empty so the line doesn't carry a
// trailing or leading "·".
export function formatTrialSubline(trial: RelatedTrial): string {
  const parts: string[] = [];
  if (trial.enrollment_count !== null && Number.isFinite(trial.enrollment_count)) {
    parts.push(`n=${trial.enrollment_count}`);
  }
  if (trial.primary_completion_date) {
    parts.push(`primary completion ${trial.primary_completion_date}`);
  }
  if (trial.relevance_phrase && trial.relevance_phrase.trim().length > 0) {
    parts.push(trial.relevance_phrase.trim());
  }
  return parts.join(' · ');
}

// Group the post-rerank trial list by the open question each pick watches.
// Returns a Map keyed by the EXACT question string so the template's
// per-<li> lookup can find the watchers for each question. The PR-1 parser
// already enforces that every `answers_question` is in study.open_questions
// (INVARIANT 2), so this lookup never sees a question that the renderer
// doesn't also see.
export function groupTrialsByQuestion(
  trials: RelatedTrial[] | null | undefined,
): Map<string, RelatedTrial[]> {
  const out = new Map<string, RelatedTrial[]>();
  if (!trials) return out;
  for (const t of trials) {
    const arr = out.get(t.answers_question) ?? [];
    arr.push(t);
    out.set(t.answers_question, arr);
  }
  return out;
}

// Depth-fold summary badge text. Returns null when the study has zero
// watching trials so the template can skip rendering the badge entirely.
// Singular/plural handled inline.
export function watchingTrialsBadge(
  trials: RelatedTrial[] | null | undefined,
): string | null {
  const n = trials?.length ?? 0;
  if (n === 0) return null;
  return `${n} trial${n === 1 ? '' : 's'} watching`;
}

// Whether the sub-line under a trial row has any content (so the renderer
// can omit the empty line2 when every sub-line field is null).
export function hasTrialSubline(trial: RelatedTrial): boolean {
  return (
    (trial.enrollment_count !== null && Number.isFinite(trial.enrollment_count)) ||
    Boolean(trial.primary_completion_date) ||
    Boolean(trial.relevance_phrase && trial.relevance_phrase.trim().length > 0)
  );
}
