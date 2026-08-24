// A citation the summariser dropped. The eval judge caught a card losing
// "doi:10.1056/NEJMoa2406909" that its own source tweet supplied — a link the
// reader could have followed, gone. `nct` survives summarisation because the
// prompt asks for it by name; a DOI arriving in tweet text had nowhere to go
// until the study schema gained a `doi` field and this backstop under it.
import { describe, it, expect } from 'vitest';
import { soleDoiIn, ownRegistrations } from '../src/lib/extract.ts';

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
  it('takes a lone NCT as the source’s own', () => {
    // Every one of the 15 NCT-bearing papers in the corpus is this shape, so the
    // stricter rules below cost nothing today.
    expect(ownRegistrations('PRESTIGE-PSMA randomised 400 pts. NCT04567890.')).toEqual(['NCT04567890']);
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
