// A citation the summariser dropped. The eval judge caught a card losing
// "doi:10.1056/NEJMoa2406909" that its own source tweet supplied — a link the
// reader could have followed, gone. `nct` survives summarisation because the
// prompt asks for it by name; a DOI arriving in tweet text had nowhere to go
// until the study schema gained a `doi` field and this backstop under it.
import { describe, it, expect } from 'vitest';
import { soleDoiIn } from '../src/lib/extract.ts';

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
