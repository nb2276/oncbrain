import { describe, it, expect } from 'vitest';
import {
  CONTENT_TYPE_VALUES,
  DEFAULT_CONTENT_TYPE,
  isValidContentType,
  parseContentType,
  stripReviewVerdicts,
  type ContentType,
} from '../src/lib/content-type.ts';

describe('content-type enum', () => {
  it('exposes exactly the two values', () => {
    expect([...CONTENT_TYPE_VALUES]).toEqual(['study_report', 'review']);
  });

  it('defaults to study_report (back-compat: absent === study_report)', () => {
    expect(DEFAULT_CONTENT_TYPE).toBe('study_report');
  });
});

describe('isValidContentType', () => {
  it('accepts the two enum values', () => {
    expect(isValidContentType('study_report')).toBe(true);
    expect(isValidContentType('review')).toBe(true);
  });
  it('rejects anything else', () => {
    for (const v of ['Review', 'STUDY', 'topic-review', '', null, undefined, 3, {}]) {
      expect(isValidContentType(v)).toBe(false);
    }
  });
});

describe('parseContentType', () => {
  it('passes through valid values', () => {
    expect(parseContentType('review')).toBe('review');
    expect(parseContentType('study_report')).toBe('study_report');
  });
  it('normalizes case + separators a model might emit', () => {
    expect(parseContentType('Review')).toBe('review');
    expect(parseContentType('  STUDY-REPORT ')).toBe('study_report');
    expect(parseContentType('study report')).toBe('study_report');
  });
  it('falls back to the default for missing/invalid (never throws)', () => {
    expect(parseContentType(undefined)).toBe('study_report');
    expect(parseContentType(null)).toBe('study_report');
    expect(parseContentType('narrative')).toBe('study_report');
    expect(parseContentType(42)).toBe('study_report');
  });
});

describe('stripReviewVerdicts (Codex #9 post-override invariant)', () => {
  const mkVerdict = () => ({ soc_implication: 'confirmatory', rationale: 'x', audience: null });

  it('nulls the verdict on a review study, leaves study_report verdicts intact', () => {
    const digest = {
      sites: [
        {
          studies: [
            { content_type: 'review' as ContentType, verdict: mkVerdict() },
            { content_type: 'study_report' as ContentType, verdict: mkVerdict() },
            { verdict: mkVerdict() }, // no content_type === study_report
          ],
        },
      ],
    };
    const stripped = stripReviewVerdicts(digest);
    expect(stripped).toBe(1);
    expect(digest.sites[0]!.studies[0]!.verdict).toBeUndefined();
    expect(digest.sites[0]!.studies[1]!.verdict).toBeDefined();
    expect(digest.sites[0]!.studies[2]!.verdict).toBeDefined();
  });

  it('survives a curator override that re-set a verdict on a review', () => {
    // Simulates the builder order: overrides run first (and could set a
    // verdict), THEN stripReviewVerdicts runs and must remove it.
    const review = { content_type: 'review' as ContentType, verdict: undefined as unknown };
    review.verdict = mkVerdict(); // an override re-introduced a verdict
    stripReviewVerdicts({ sites: [{ studies: [review] }] });
    expect(review.verdict).toBeUndefined();
  });

  it('strips reviews across MULTIPLE sites (exercises the outer site loop)', () => {
    const digest = {
      sites: [
        { studies: [{ content_type: 'review' as ContentType, verdict: mkVerdict() }] },
        {
          studies: [
            { content_type: 'study_report' as ContentType, verdict: mkVerdict() },
            { content_type: 'review' as ContentType, verdict: mkVerdict() },
          ],
        },
      ],
    };
    expect(stripReviewVerdicts(digest)).toBe(2);
    expect(digest.sites[0]!.studies[0]!.verdict).toBeUndefined();
    expect(digest.sites[1]!.studies[0]!.verdict).toBeDefined(); // study_report kept
    expect(digest.sites[1]!.studies[1]!.verdict).toBeUndefined(); // review in a later site
  });

  it('is idempotent and a no-op when reviews already lack a verdict', () => {
    const digest = {
      sites: [{ studies: [{ content_type: 'review' as ContentType }] }],
    };
    expect(stripReviewVerdicts(digest)).toBe(0);
    expect(stripReviewVerdicts(digest)).toBe(0);
  });
});
