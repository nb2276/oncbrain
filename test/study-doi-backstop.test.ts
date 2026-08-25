// A citation the summariser dropped. The eval judge caught a card losing
// "doi:10.1056/NEJMoa2406909" that its own source tweet supplied — a link the
// reader could have followed, gone. `nct` survives summarisation because the
// prompt asks for it by name; a DOI arriving in tweet text had nowhere to go
// until the study schema gained a `doi` field and this backstop under it.
import { describe, it, expect } from 'vitest';
import { soleDoiIn, ownRegistrations } from '../src/lib/extract.ts';
import { doiAsWritten, doiSpellingIn, normalizeDoi } from '../src/lib/doi.ts';

describe('soleDoiIn', () => {
  it('recovers the DOI a source tweet states', () => {
    // Verbatim, not normalised: "10.1056/NEJMoa2406909" is how the journal
    // writes it, and a quoted identifier must not be silently case-altered.
    expect(soleDoiIn('DESTINY-Breast06: PFS 13.2 vs 8.1mo. NCT04494425. doi:10.1056/NEJMoa2406909'))
      .toBe('10.1056/NEJMoa2406909');
  });

  it('accepts a doi.org URL form', () => {
    expect(soleDoiIn('see https://doi.org/10.1001/jama.2026.12627 for the full report'))
      .toBe('10.1001/jama.2026.12627');
  });

  it('ABSTAINS when the text carries two different DOIs', () => {
    // A study whose own publication cannot be picked without guessing, and a
    // wrong DOI points the reader at someone else's paper.
    expect(soleDoiIn('doi:10.1056/aaa1111 and also doi:10.1200/bbb2222')).toBeNull();
  });

  it('collapses the SAME DOI repeated in different case, keeping the first spelling', () => {
    // Uniqueness is judged on the normalised form so these are ONE doi, not two;
    // the spelling the source led with is what comes back.
    expect(soleDoiIn('doi:10.1056/NEJMoa2406909 — see https://doi.org/10.1056/nejmoa2406909'))
      .toBe('10.1056/NEJMoa2406909');
  });

  it('returns null when no DOI is present', () => {
    expect(soleDoiIn('ARANOTE: HR 0.55. NCT04146091.')).toBeNull();
    expect(soleDoiIn('')).toBeNull();
    expect(soleDoiIn(null)).toBeNull();
  });
});

// Trial identity is the strongest signal lineage has: a shared NCT authorises an
// automatic unpublish where an acronym never can. So an NCT that is merely CITED
// must not join it — an abstract naming a comparator's registration would
// otherwise put that trial's identity onto this card, and let a later paper
// about the comparator supersede it.
describe('ownRegistrations', () => {
  // THE LONE-NCT EXEMPTION WAS THE BUG, and this test was defending it.
  //
  // It rested on a measurement that had gone stale ("every one of the 15
  // NCT-bearing papers in the corpus is this shape"). Re-measured over all 35:
  // 30 cite exactly one NCT and 10 of those are UNCUED, including an ASTRO 2024
  // SBRT abstract whose only NCT is RTOG 9408's (NCT00002597, named as
  // historical context) and a hormone-duration paper whose only NCT is NRG
  // GU006's (NCT03371719). Both cards were carrying another trial's identity —
  // the one piece of evidence that authorises an automatic unpublish.
  it('abstains on a lone NCT with no registration cue', () => {
    expect(ownRegistrations('PRESTIGE-PSMA randomised 400 pts. NCT04567890.')).toEqual([]);
  });

  it('takes a lone NCT once a cue claims it', () => {
    expect(
      ownRegistrations('PRESTIGE-PSMA randomised 400 pts. Trial registration: NCT04567890.'),
    ).toEqual(['NCT04567890']);
  });

  // The cue list is measured, not guessed, so it has to cover how sources
  // actually write it: a singular "Clinicaltrial.gov", JCO's "Clinical trial
  // information:", and the ﬁ ligature pdftotext emits for "identifier".
  it('recognises the registration phrasings the corpus really uses', () => {
    expect(ownRegistrations('Clinicaltrial.gov\nID: NCT06549920.')).toEqual(['NCT06549920']);
    expect(ownRegistrations('Clinical trial information: NCT04214262 .')).toEqual(['NCT04214262']);
    expect(ownRegistrations('registered at ClinicalTrials.gov (identi\uFB01er: NCT02533271).')).toEqual([
      'NCT02533271',
    ]);
  });

  // The live cases that motivated the change.
  it('refuses a comparator trial named as context', () => {
    expect(
      ownRegistrations('EBRT, IGRT, RTOG 9408 (NCT00002597) informed the design.'),
    ).toEqual([]);
    expect(ownRegistrations('NRG GU006 (NCT03371719) aims to personalise hormone therapy.')).toEqual(
      [],
    );
  });

  it('picks the CUED registration when a comparator is also cited', () => {
    expect(
      ownRegistrations(
        'Compared with VISION (NCT03511664), our trial. Registration: ClinicalTrials.gov NCT03367702.',
      ),
    ).toEqual(['NCT03367702']);
  });

  it('recognises the common registration phrasings', () => {
    expect(ownRegistrations('cite NCT01111111. Trial registration: NCT02222222')).toEqual(['NCT02222222']);
    expect(ownRegistrations('vs NCT01111111. Registered at ClinicalTrials.gov, NCT02222222'))
      .toEqual(['NCT02222222']);
    expect(ownRegistrations('vs NCT01111111. ClinicalTrials.gov identifier NCT02222222'))
      .toEqual(['NCT02222222']);
  });

  it('ABSTAINS when several are cited and none is claimed', () => {
    // Guessing which is the subject's own is how a comparator's identity gets
    // adopted, and identity is exactly the thing this must not get wrong.
    expect(ownRegistrations('We compare NCT03511664 against NCT04567890 informally.')).toEqual([]);
  });

  it('returns nothing when no registration is stated', () => {
    expect(ownRegistrations('No registration stated.')).toEqual([]);
    expect(ownRegistrations('')).toEqual([]);
    expect(ownRegistrations(null)).toEqual([]);
  });
});

// A cue governs the FIRST registration after it, not every NCT nearby. Each id
// used to scan its own preceding window independently, so a cue bled forward
// across an intervening registration and the comparator satisfied registered
// identity — the exact failure this function exists to prevent.
describe('ownRegistrations: a cue does not bleed onto the next NCT', () => {
  it('claims only the registration the cue introduces', () => {
    expect(ownRegistrations('Trial registration: NCT11111111; comparator NCT22222222'))
      .toEqual(['NCT11111111']);
  });

  it('still finds the own registration when the comparator comes FIRST', () => {
    expect(
      ownRegistrations(
        'Compared with VISION (NCT03511664). Registration: ClinicalTrials.gov NCT03367702.',
      ),
    ).toEqual(['NCT03367702']);
  });

  it('accepts two genuinely cued registrations', () => {
    // A trial reporting two registrations (e.g. a companion study) is real; the
    // rule is "each must earn its own cue", not "at most one".
    expect(ownRegistrations('Registration: NCT11111111 and registered as NCT22222222'))
      .toEqual(['NCT11111111', 'NCT22222222']);
  });

  it('still abstains when neither is claimed', () => {
    expect(ownRegistrations('We compare NCT03511664 against NCT04567890.')).toEqual([]);
  });
});

// A QUOTED IDENTIFIER IS REPRODUCED VERBATIM — the same rule that governs effect
// sizes. normalizeDoi lowercases, which is right for the `lower(doi)` dedup
// index and wrong for a citation on the card: NEJM registers
// "10.1056/NEJMoa2406909". The eval judge caught the published digest carrying
// "10.1056/nejmoa2406909".
describe('DOI casing', () => {
  it('keeps the registrant spelling while canonicalising the shape', () => {
    for (const surface of [
      '10.1056/NEJMoa2406909',
      'doi:10.1056/NEJMoa2406909',
      'https://doi.org/10.1056/NEJMoa2406909',
      'https://www.nejm.org/doi/full/10.1056/NEJMoa2406909',
    ]) {
      expect(doiAsWritten(surface)).toBe('10.1056/NEJMoa2406909');
      // ...and identity still collapses every surface form onto one key.
      expect(normalizeDoi(surface)).toBe('10.1056/nejmoa2406909');
    }
  });

  it('rejects exactly what normalizeDoi rejects', () => {
    // The two share a pipeline so they can never disagree about what a DOI is.
    for (const s of ['not a doi', '', '10.x/y']) {
      expect(doiAsWritten(s) === null).toBe(normalizeDoi(s) === null);
    }
  });

  it('recovers the source spelling for a DOI stored lowercased', () => {
    // papers.doi is normalized to back the unique index, so the column knows
    // WHICH doi and the source text knows how it is SPELLED.
    expect(doiSpellingIn('10.1056/nejmoa2406909', 'PFS 13.2mo. doi:10.1056/NEJMoa2406909')).toBe(
      '10.1056/NEJMoa2406909',
    );
  });

  it('returns null when the DOI never appears in the text', () => {
    // Normal for a paper ingested BY DOI that never repeats it in prose; the
    // caller falls back to the column's own spelling.
    expect(doiSpellingIn('10.1001/jama.2026.12627', 'No identifier in this abstract.')).toBeNull();
  });
});
