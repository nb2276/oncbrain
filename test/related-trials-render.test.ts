import { describe, it, expect } from 'vitest';
import {
  statusPillText,
  statusAriaLabel,
  formatPhaseChip,
  formatTrialSubline,
  groupTrialsByQuestion,
  watchingTrialsBadge,
  hasTrialSubline,
} from '../src/lib/related-trials-render.ts';
import type { RelatedTrial } from '../src/lib/digest-data.ts';

function rt(over: Partial<RelatedTrial> & { nct: string; answers_question: string }): RelatedTrial {
  // 'in' check so explicit `null` overrides don't get silently replaced by
  // the default. Vanilla `??` would convert null to the fallback.
  const pickOr = <K extends keyof RelatedTrial>(k: K, fallback: RelatedTrial[K]): RelatedTrial[K] =>
    (k in over ? (over[k] as RelatedTrial[K]) : fallback);
  return {
    nct: over.nct,
    brief_title: pickOr('brief_title', `Trial ${over.nct}`),
    overall_status: pickOr('overall_status', 'RECRUITING'),
    phase: pickOr('phase', ['PHASE3']),
    enrollment_count: pickOr('enrollment_count', 100),
    primary_completion_date: pickOr('primary_completion_date', '2027-03'),
    brief_summary: pickOr('brief_summary', null),
    conditions: pickOr('conditions', []),
    interventions: pickOr('interventions', []),
    eligibility_brief: pickOr('eligibility_brief', null),
    answers_question: over.answers_question,
    relevance_phrase: pickOr('relevance_phrase', 'matches the question'),
  };
}

describe('statusPillText', () => {
  it('returns the short two-token form for each accepted status', () => {
    expect(statusPillText('RECRUITING')).toBe('recruiting');
    expect(statusPillText('NOT_YET_RECRUITING')).toBe('not yet');
    expect(statusPillText('ACTIVE_NOT_RECRUITING')).toBe('active');
    expect(statusPillText('ENROLLING_BY_INVITATION')).toBe('invite only');
  });
});

describe('statusAriaLabel', () => {
  it('expands ACTIVE_NOT_RECRUITING so screen readers do not mishear "active" as "recruiting now"', () => {
    expect(statusAriaLabel('ACTIVE_NOT_RECRUITING')).toContain('not recruiting');
    expect(statusAriaLabel('NOT_YET_RECRUITING')).toBe('not yet recruiting');
    expect(statusAriaLabel('ENROLLING_BY_INVITATION')).toContain('invitation');
  });
});

describe('formatPhaseChip', () => {
  it('returns "Phase 3" for ["PHASE3"]', () => {
    expect(formatPhaseChip(['PHASE3'])).toBe('Phase 3');
  });

  it('joins multi-phase as "Phase 1/2"', () => {
    expect(formatPhaseChip(['PHASE1', 'PHASE2'])).toBe('Phase 1/2');
  });

  it('returns null when phase is null or empty (codex round-2 #30: no "—" placeholder)', () => {
    expect(formatPhaseChip(null)).toBeNull();
    expect(formatPhaseChip([])).toBeNull();
  });

  it('returns null when every phase entry is whitespace after stripping prefix', () => {
    expect(formatPhaseChip(['PHASE', 'PHASE'])).toBeNull();
  });

  it('handles odd CT.gov values like NA / EARLY_PHASE1 (defensive but visible)', () => {
    expect(formatPhaseChip(['NA'])).toBe('Phase NA');
    expect(formatPhaseChip(['EARLY_PHASE1'])).toBe('Phase Early 1');
  });
});

describe('formatTrialSubline', () => {
  it('joins all three fields with middle dots when present', () => {
    expect(
      formatTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: 1200,
          primary_completion_date: '2027-03',
          relevance_phrase: 'directly tests the question',
        }),
      ),
    ).toBe('n=1200 · primary completion 2027-03 · directly tests the question');
  });

  it('drops missing enrollment_count cleanly (no leading "·")', () => {
    expect(
      formatTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: null,
          primary_completion_date: '2027-03',
          relevance_phrase: 'phrase',
        }),
      ),
    ).toBe('primary completion 2027-03 · phrase');
  });

  it('drops missing primary_completion_date cleanly', () => {
    expect(
      formatTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          primary_completion_date: null,
        }),
      ),
    ).toBe('n=100 · matches the question');
  });

  it('drops every field cleanly (returns empty string when all null)', () => {
    expect(
      formatTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: null,
          primary_completion_date: null,
          relevance_phrase: '',
        }),
      ),
    ).toBe('');
  });

  it('handles a whitespace-only relevance_phrase as if empty', () => {
    expect(
      formatTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: null,
          primary_completion_date: null,
          relevance_phrase: '   ',
        }),
      ),
    ).toBe('');
  });

  it('rejects NaN enrollment_count (would render as "n=NaN" otherwise)', () => {
    expect(
      formatTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: NaN,
          primary_completion_date: null,
          relevance_phrase: '',
        }),
      ),
    ).toBe('');
  });
});

describe('groupTrialsByQuestion', () => {
  const Q1 = 'Optimal sequencing vs cabazitaxel';
  const Q2 = 'Durability of response beyond 2 years';

  it('groups trials by their answers_question key', () => {
    const t1 = rt({ nct: 'NCT05000001', answers_question: Q1 });
    const t2 = rt({ nct: 'NCT05000002', answers_question: Q1 });
    const t3 = rt({ nct: 'NCT05000003', answers_question: Q2 });
    const grouped = groupTrialsByQuestion([t1, t2, t3]);
    expect(grouped.get(Q1)!.map((t) => t.nct)).toEqual(['NCT05000001', 'NCT05000002']);
    expect(grouped.get(Q2)!.map((t) => t.nct)).toEqual(['NCT05000003']);
  });

  it('returns an empty Map for null / undefined input', () => {
    expect(groupTrialsByQuestion(null).size).toBe(0);
    expect(groupTrialsByQuestion(undefined).size).toBe(0);
    expect(groupTrialsByQuestion([]).size).toBe(0);
  });

  it('preserves input order within each group (so primary_completion_date sort survives)', () => {
    const a = rt({ nct: 'NCT0500A', answers_question: Q1, primary_completion_date: '2026-10' });
    const b = rt({ nct: 'NCT0500B', answers_question: Q1, primary_completion_date: '2027-03' });
    const c = rt({ nct: 'NCT0500C', answers_question: Q1, primary_completion_date: '2027-06' });
    expect(groupTrialsByQuestion([a, b, c]).get(Q1)!.map((t) => t.nct)).toEqual([
      'NCT0500A',
      'NCT0500B',
      'NCT0500C',
    ]);
  });
});

describe('watchingTrialsBadge', () => {
  it('returns null when zero trials so the badge is omitted', () => {
    expect(watchingTrialsBadge(null)).toBeNull();
    expect(watchingTrialsBadge(undefined)).toBeNull();
    expect(watchingTrialsBadge([])).toBeNull();
  });

  it('returns singular for 1 trial', () => {
    expect(watchingTrialsBadge([rt({ nct: 'NCT05000001', answers_question: 'q' })])).toBe('1 trial watching');
  });

  it('returns plural for N trials', () => {
    const trials = Array.from({ length: 3 }, (_, i) =>
      rt({ nct: `NCT0500000${i}`, answers_question: 'q' }),
    );
    expect(watchingTrialsBadge(trials)).toBe('3 trials watching');
  });
});

describe('hasTrialSubline', () => {
  it('true when any field is non-empty', () => {
    expect(
      hasTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: 100,
          primary_completion_date: null,
          relevance_phrase: '',
        }),
      ),
    ).toBe(true);
  });

  it('false when every field is null/empty', () => {
    expect(
      hasTrialSubline(
        rt({
          nct: 'NCT05000001',
          answers_question: 'q',
          enrollment_count: null,
          primary_completion_date: null,
          relevance_phrase: '',
        }),
      ),
    ).toBe(false);
  });
});
