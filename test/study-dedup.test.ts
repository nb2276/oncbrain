import { describe, it, expect } from 'vitest';
import {
  studyDedupKey,
  extractTextAcronymKeys,
  findCrossDateDuplicates,
  type DedupArtifact,
} from '../src/lib/study-dedup.ts';

describe('studyDedupKey', () => {
  it('keys a plain trial acronym, ignoring the parenthetical', () => {
    expect(studyDedupKey('HYDRA (MARCAP)')).toBe('HYDRA');
    expect(studyDedupKey('HYDRA (MARCAP Consortium)')).toBe('HYDRA'); // same key as above
    expect(studyDedupKey('ENZARAD (ANZUP 1303)')).toBe('ENZARAD');
    expect(studyDedupKey('RAPCHEM (BOOG 2010-03)')).toBe('RAPCHEM');
    expect(studyDedupKey('ARTO')).toBe('ARTO');
    expect(studyDedupKey('SUPREMO')).toBe('SUPREMO');
  });

  it('normalizes separators so spelling variants collapse', () => {
    expect(studyDedupKey('EORTC 22922')).toBe('EORTC22922');
    expect(studyDedupKey('EORTC-22922')).toBe('EORTC22922');
    expect(studyDedupKey('EORTC22922 (IM-MS)')).toBe('EORTC22922');
  });

  it('keeps distinct cooperative-group study numbers distinct', () => {
    expect(studyDedupKey('EORTC 22922')).not.toBe(studyDedupKey('EORTC 22033'));
    expect(studyDedupKey('NRG-GU005')).toBe('NRGGU005');
  });

  it('keeps versioned trial families distinct (PEACE-2 vs PEACE-V)', () => {
    const a = studyDedupKey('PEACE-2');
    const b = studyDedupKey('PEACE-V');
    expect(a).toBe('PEACE2');
    expect(b).toBe('PEACEV');
    expect(a).not.toBe(b);
  });

  it('returns null for a bare cooperative-group name (cannot discriminate)', () => {
    expect(studyDedupKey('EORTC')).toBeNull();
    expect(studyDedupKey('NRG')).toBeNull();
    expect(studyDedupKey('DBCG')).toBeNull();
  });

  it('returns null for a society / guideline / conference lead token', () => {
    expect(studyDedupKey('ARS Appropriate Use Criteria: Intraprostatic Recurrence')).toBeNull();
    expect(studyDedupKey('ASTRO 2024: SBRT for Unfavorable Intermediate-Risk Prostate Cancer')).toBeNull();
    expect(studyDedupKey('ASCO 2025 plenary')).toBeNull();
  });

  it('returns null for endpoint / stat / pattern-blacklisted lead tokens', () => {
    expect(studyDedupKey('OS benefit in the pooled analysis')).toBeNull();
    expect(studyDedupKey('PFS was not reached')).toBeNull();
    expect(studyDedupKey('PHASE3 readout')).toBeNull();
  });

  it('does not grab the stray capital of a following Titlecase word', () => {
    // "NRG Oncology RTOG 0539" must NOT collapse to "NRGO" (would collide with
    // the unrelated RTOG 0848). "NRG" alone is a bare group → null.
    expect(studyDedupKey('NRG Oncology RTOG 0539')).toBeNull();
    expect(studyDedupKey('NRG Oncology/RTOG 0848')).toBeNull();
    // "EXTEND Trial" is the EXTEND trial, keyed cleanly without the "T" of Trial.
    expect(studyDedupKey('EXTEND Trial')).toBe('EXTEND');
  });

  it('keys "PEACE-2" and "PEACE 2" identically but apart from "PEACE-V"', () => {
    expect(studyDedupKey('PEACE-2')).toBe(studyDedupKey('PEACE 2'));
    expect(studyDedupKey('PEACE 2')).toBe('PEACE2');
    expect(studyDedupKey('PEACE-V')).not.toBe(studyDedupKey('PEACE 2'));
  });

  it('returns null when there is no all-caps leading identifier', () => {
    expect(studyDedupKey('10-yr SBRT for Prostate Cancer (Meier et al.)')).toBeNull();
    expect(studyDedupKey('177Lu-PSMA in mCRPC')).toBeNull();
    expect(studyDedupKey('')).toBeNull();
    expect(studyDedupKey('A pooled analysis')).toBeNull(); // "A" too short
  });
});

describe('extractTextAcronymKeys', () => {
  it('pulls contiguous trial tokens from free text', () => {
    const keys = extractTextAcronymKeys('New HYDRA data confirm the ENZARAD signal at ASCO.');
    expect(keys.has('HYDRA')).toBe(true);
    expect(keys.has('ENZARAD')).toBe(true);
    expect(keys.has('ASCO')).toBe(false); // society prefix → no key
  });

  it('does not emit bare group or endpoint tokens', () => {
    const keys = extractTextAcronymKeys('EORTC reported OS and PFS were similar; RT well tolerated.');
    expect(keys.size).toBe(0);
  });

  it('is empty for text with no trial tokens', () => {
    expect(extractTextAcronymKeys('the median follow-up was 5 years').size).toBe(0);
    expect(extractTextAcronymKeys('').size).toBe(0);
  });
});

function art(date: string, studies: DedupArtifact['digest']['sites'][number]['studies']): DedupArtifact {
  return { date, digest: { sites: [{ studies }] } };
}

describe('findCrossDateDuplicates', () => {
  it('flags the same acronym across two dates', () => {
    const dups = findCrossDateDuplicates([
      art('2026-07-08', [{ slug: 'hydra-marcap-mhfrt', name: 'HYDRA (MARCAP Consortium)', nct: null }]),
      art('2026-07-09', [{ slug: 'hydra-marcap', name: 'HYDRA (MARCAP)', nct: null }]),
    ]);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.reason).toBe('shared-acronym');
    expect(dups[0]!.matchKey).toBe('HYDRA');
    expect(dups[0]!.occurrences.map((o) => o.date)).toEqual(['2026-07-08', '2026-07-09']); // oldest first
  });

  it('flags the same NCT across two dates and does not double-report the acronym', () => {
    const dups = findCrossDateDuplicates([
      art('2026-06-12', [{ slug: 'arto', name: 'ARTO', nct: 'NCT03449719' }]),
      art('2026-07-07', [{ slug: 'arto', name: 'ARTO', nct: 'NCT03449719' }]),
    ]);
    expect(dups).toHaveLength(1); // NCT candidate only; acronym set is redundant
    expect(dups[0]!.reason).toBe('shared-nct');
    expect(dups[0]!.matchKey).toBe('NCT03449719');
  });

  it('does not flag a same-day repeat (cross-DATE only)', () => {
    const dups = findCrossDateDuplicates([
      art('2026-07-09', [
        { slug: 'hydra-a', name: 'HYDRA (a)', nct: null },
        { slug: 'hydra-b', name: 'HYDRA (b)', nct: null },
      ]),
    ]);
    expect(dups).toHaveLength(0);
  });

  it('does not flag distinct trials that share a cooperative-group prefix', () => {
    const dups = findCrossDateDuplicates([
      art('2026-05-17', [{ slug: 'eortc-22033', name: 'EORTC 22033', nct: null }]),
      art('2026-05-21', [{ slug: 'eortc-22922', name: 'EORTC 22922', nct: null }]),
    ]);
    expect(dups).toHaveLength(0); // different study numbers → different keys
  });

  it('surfaces a review occurrence with its isReview flag set', () => {
    const dups = findCrossDateDuplicates([
      art('2026-07-07', [{ slug: 'supremo', name: 'SUPREMO', nct: null, content_type: 'study_report' }]),
      art('2026-07-09', [{ slug: 'supremo-crit', name: 'SUPREMO', nct: null, content_type: 'review' }]),
    ]);
    expect(dups).toHaveLength(1);
    const review = dups[0]!.occurrences.find((o) => o.date === '2026-07-09');
    expect(review?.isReview).toBe(true);
  });

  it('returns nothing when no trial spans multiple dates', () => {
    expect(
      findCrossDateDuplicates([
        art('2026-07-08', [{ slug: 'a', name: 'ARTO', nct: null }]),
        art('2026-07-09', [{ slug: 'b', name: 'HYDRA', nct: null }]),
      ]),
    ).toHaveLength(0);
  });

  it('does not flag same-acronym cards that carry different NCTs (different trials)', () => {
    const dups = findCrossDateDuplicates([
      art('2026-06-09', [{ slug: 'a', name: 'ARTO', nct: 'NCT00000001' }]),
      art('2026-06-10', [{ slug: 'b', name: 'ARTO', nct: 'NCT00000002' }]),
    ]);
    expect(dups).toHaveLength(0); // registered identity overrides an acronym collision
  });

  it('still flags a same-acronym pair when only one side has an NCT', () => {
    const dups = findCrossDateDuplicates([
      art('2026-06-09', [{ slug: 'a', name: 'ARTO', nct: null }]),
      art('2026-06-10', [{ slug: 'b', name: 'ARTO', nct: 'NCT00000002' }]),
    ]);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.reason).toBe('shared-acronym');
  });
});
