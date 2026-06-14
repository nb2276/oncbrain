import { describe, it, expect } from 'vitest';
import { railEmojiForStudy, VERDICT_META } from '../src/lib/verdict.ts';

describe('railEmojiForStudy (v0.16 — shared rail glyph)', () => {
  it('returns the verdict emoji when a verdict is present', () => {
    expect(railEmojiForStudy({ verdict: { soc_implication: 'practice-changing' } })).toBe(
      VERDICT_META['practice-changing'].emoji,
    );
    expect(railEmojiForStudy({ verdict: { soc_implication: 'unclear' } })).toBe(
      VERDICT_META['unclear'].emoji,
    );
  });

  it('returns 🗞️ for a verdict-less review (reads as a press round-up)', () => {
    expect(railEmojiForStudy({ content_type: 'review' })).toBe('🗞️');
    // verdict wins over content_type if somehow both present (defensive).
    expect(
      railEmojiForStudy({ content_type: 'review', verdict: { soc_implication: 'confirmatory' } }),
    ).toBe(VERDICT_META['confirmatory'].emoji);
  });

  it('falls through to 🗞️ for a review whose verdict has an unrecognized soc', () => {
    // verdictMetaFor returns null for an unknown soc_implication, so the review
    // branch applies — the "verdict wins" path only wins for a KNOWN verdict.
    expect(
      railEmojiForStudy({
        content_type: 'review',
        verdict: { soc_implication: 'bogus' as never },
      }),
    ).toBe('🗞️');
  });

  it('returns the neutral dot for a study that simply lacks a verdict', () => {
    expect(railEmojiForStudy({})).toBe('·');
    expect(railEmojiForStudy({ content_type: 'study_report' })).toBe('·');
    expect(railEmojiForStudy({ verdict: null, content_type: null })).toBe('·');
  });
});
