import { describe, it, expect } from 'vitest';
import { detectConference, detectConferenceFromTexts } from '../src/lib/conference-detect.ts';

describe('detectConference — hashtags', () => {
  it('detects #ASCO26 → asco-2026', () => {
    const hit = detectConference('Practice-changing data #ASCO26');
    expect(hit).toEqual({
      slug: 'asco-2026',
      name: 'ASCO Annual Meeting 2026',
      hashtag: '#ASCO26',
      year: 2026,
    });
  });

  it('accepts a four-digit hashtag (#AACR2025 → aacr-2025)', () => {
    expect(detectConference('#AACR2025 abstract')?.slug).toBe('aacr-2025');
    expect(detectConference('#AACR2025 abstract')?.year).toBe(2025);
  });

  it('handles each flagship series', () => {
    expect(detectConference('#ESMO25')?.slug).toBe('esmo-2025');
    expect(detectConference('#ASTRO24')?.slug).toBe('astro-2024');
    expect(detectConference('#ASH24')?.slug).toBe('ash-2024');
    expect(detectConference('#SABCS24')?.slug).toBe('sabcs-2024');
  });

  it('detects ASCO subspecialty symposia by bare or prefixed hashtag', () => {
    expect(detectConference('#GU26')?.slug).toBe('ascogu-2026');
    expect(detectConference('#ASCOGU26')?.slug).toBe('ascogu-2026');
    expect(detectConference('#GI26')?.slug).toBe('ascogi-2026');
    expect(detectConference('#ASCOGI26')?.slug).toBe('ascogi-2026');
  });

  it('does not let #ASCOGU26 also match the flagship ASCO series', () => {
    const hit = detectConference('#ASCOGU26');
    expect(hit?.slug).toBe('ascogu-2026');
    expect(hit?.name).toBe('ASCO Genitourinary Cancers Symposium 2026');
  });

  it('produces a canonical two-digit hashtag even from a four-digit input', () => {
    expect(detectConference('#ESMO2024')?.hashtag).toBe('#ESMO24');
  });

  it('ignores a malformed three-digit hashtag', () => {
    expect(detectConference('#ASCO260 is not a year')).toBeNull();
  });

  it('rejects an out-of-range hashtag year (no asco-2099 from #ASCO99)', () => {
    expect(detectConference('#ASCO99')).toBeNull();
    expect(detectConference('#ESMO2099')).toBeNull();
  });

  it('does not match the unrelated #ASHG (genetics) tag', () => {
    expect(detectConference('Great talk at #ASHG meeting')).toBeNull();
  });
});

describe('detectConference — meeting URL hosts', () => {
  it('detects a meetings.asco.org link, taking the year from the source date', () => {
    const hit = detectConference('https://meetings.asco.org/abstracts-presentations/12345', {
      defaultYear: 2026,
    });
    expect(hit?.slug).toBe('asco-2026');
  });

  it('prefers a year embedded in the URL over the default year', () => {
    const hit = detectConference('https://meetings.asco.org/2024/sessions/abc', {
      defaultYear: 2026,
    });
    expect(hit?.slug).toBe('asco-2024');
  });

  it('detects oncologypro.esmo.org and meetings.astro.org and ash.confex.com', () => {
    expect(detectConference('https://oncologypro.esmo.org/meeting-resources/x', { defaultYear: 2025 })?.slug).toBe('esmo-2025');
    expect(detectConference('https://meetings.astro.org/x', { defaultYear: 2025 })?.slug).toBe('astro-2025');
    expect(detectConference('https://ash.confex.com/ash/2024/webprogram/Paper1.html')?.slug).toBe('ash-2024');
  });

  it('matches a true subdomain but rejects a look-alike spoof host', () => {
    expect(detectConference('https://x.meetings.asco.org/a', { defaultYear: 2026 })?.slug).toBe('asco-2026');
    expect(detectConference('https://meetings.asco.org.evil.test/a', { defaultYear: 2026 })).toBeNull();
  });

  it('does not tag the journal host ascopubs.org as a meeting', () => {
    expect(detectConference('https://ascopubs.org/doi/10.1200/JCO.24.00001', { defaultYear: 2026 })).toBeNull();
  });

  it('returns null for a host match with no derivable year', () => {
    // No URL year and no defaultYear → cannot form a slug.
    expect(detectConference('https://meetings.asco.org/abstracts/12345')).toBeNull();
  });

  it('falls back to the default year when the URL year is out of range', () => {
    // /2050/ is outside the 2010–2039 meeting-year window, so it is ignored.
    expect(detectConference('https://meetings.asco.org/2050/x', { defaultYear: 2026 })?.slug).toBe('asco-2026');
  });
});

describe('detectConference — prose', () => {
  it('detects "2026 ASCO Annual Meeting"', () => {
    expect(detectConference('Presented at the 2026 ASCO Annual Meeting.')?.slug).toBe('asco-2026');
  });

  it('detects a year that trails the phrase within the window', () => {
    expect(detectConference('ASCO Annual Meeting (Chicago, May 31–June 4, 2026)')?.slug).toBe('asco-2026');
  });

  it('detects the GU symposium by name', () => {
    expect(detectConference('2026 Genitourinary Cancers Symposium')?.slug).toBe('ascogu-2026');
  });

  it('picks the year nearest the phrase, not the first in the window', () => {
    expect(detectConference('Builds on 2024 data; 2026 ASCO Annual Meeting')?.slug).toBe('asco-2026');
  });

  it('requires a nearby year — a bare meeting mention does not match', () => {
    expect(detectConference('Updated ASCO Annual Meeting guidance is pending')).toBeNull();
  });

  it('does not tag generic society mentions without a meeting phrase', () => {
    expect(detectConference('Per ASCO and ESMO recommendations in 2026')).toBeNull();
  });

  // Regression: real ingested sources brand radonc meetings as "<ACRONYM> <year>"
  // (abstract titles, slide footers), not "<ACRONYM> Annual Meeting". Prose used
  // to require the formal phrase, so these all landed at conference_slug=null.
  it('detects the "ASTRO 2025" abstract brand (not just "ASTRO Annual Meeting")', () => {
    expect(detectConference('ASTRO 2025: Co-Primary Results from NRG-GU005')?.slug).toBe('astro-2025');
    expect(detectConference('Hanlon et al abstract ASTRO 2024)')?.slug).toBe('astro-2024');
  });

  it('does not mis-tag "AUA/ASTRO guidelines" as the ASTRO meeting', () => {
    // year sits BEFORE the acronym and no year trails it → not the meeting.
    expect(detectConference('The 2022 AUA/ASTRO guidelines recommend 18-36 months')).toBeNull();
  });
});

describe('detectConference — ESTRO (v0.31 regression)', () => {
  it('detects the #ESTRO26 hashtag → estro-2026', () => {
    const hit = detectConference('OLIGOMA trial results just dropped at #ESTRO26 and they are massive');
    expect(hit?.slug).toBe('estro-2026');
    expect(hit?.year).toBe(2026);
    expect(hit?.hashtag).toBe('#ESTRO26');
  });

  it('detects the "ESTRO 2026" prose brand, including across a newline', () => {
    expect(detectConference('interim analysis at ESTRO 2026')?.slug).toBe('estro-2026');
    expect(detectConference('Prostate Cancer\nESTRO\n2026\nSTOCKHOLM')?.slug).toBe('estro-2026');
  });

  it('does not mis-tag GEC-ESTRO / ESMO-ESTRO / "(ESTRO) guidelines" (no adjacent year)', () => {
    expect(detectConference('(GEC-ESTRO) Breast Cancer Working Group')).toBeNull();
    expect(detectConference('ESMO-ESTRO advises caution in 2026')).toBeNull();
    expect(detectConference('Society for Radiotherapy and Oncology (ESTRO) clinical guidelines')).toBeNull();
  });

  it('keeps ESTRO and ASTRO distinct (no cross-match)', () => {
    expect(detectConference('#ESTRO26')?.slug).toBe('estro-2026');
    expect(detectConference('#ASTRO26')?.slug).toBe('astro-2026');
    expect(detectConference('ESTRO 2026')?.slug).toBe('estro-2026');
    expect(detectConference('ASTRO 2026')?.slug).toBe('astro-2026');
  });
});

describe('detectConference — precedence + misc', () => {
  it('a hashtag year beats a host default year', () => {
    const hit = detectConference('https://meetings.asco.org/x #ASCO26', { defaultYear: 2030 });
    expect(hit?.year).toBe(2026);
  });

  it('a host match beats a prose match', () => {
    // ESMO host (2025) + ASCO prose (2019) → host wins.
    const hit = detectConference(
      'See https://oncologypro.esmo.org/x — builds on the 2019 ASCO Annual Meeting',
      { defaultYear: 2025 },
    );
    expect(hit?.slug).toBe('esmo-2025');
  });

  it('returns null for non-conference clinical text', () => {
    expect(detectConference('Phase 3 trial in metastatic castration-resistant prostate cancer')).toBeNull();
  });

  it('returns null for empty/nullish input', () => {
    expect(detectConference('')).toBeNull();
    expect(detectConference(null)).toBeNull();
    expect(detectConference(undefined)).toBeNull();
  });
});

describe('detectConferenceFromTexts', () => {
  it('detects across multiple fields and ignores nullish ones', () => {
    const hit = detectConferenceFromTexts([null, 'curator note', undefined, 'final results #ESMO25']);
    expect(hit?.slug).toBe('esmo-2025');
  });

  it('returns null when no field carries a meeting signal', () => {
    expect(detectConferenceFromTexts([null, 'just a note', undefined])).toBeNull();
  });
});
