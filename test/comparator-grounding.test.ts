// A trial the digest NAMES must be a trial the digest was GIVEN — at least when
// it attaches a number to it. Phase 2 is asked for comparative context, so it
// reaches for the trials that define practice, which are by construction absent
// from the day's sources. The eval judge caught it inventing "VISION (NEJM 2021)
// ... rPFS HR 0.40" and characterising DESTINY-Breast04, neither of which appears
// in any input.
import { describe, it, expect } from 'vitest';
import {
  namedTrialsIn,
  ungroundedComparatorClaims,
  withholdUngroundedComparators,
  formatGroundingWithholds,
  droppedDiseaseStates,
  conflictingState,
} from '../src/lib/comparator-grounding.ts';

describe('namedTrialsIn', () => {
  it('reads trial names including hyphenated and numbered forms', () => {
    expect(namedTrialsIn('VISION and DESTINY-Breast04 and NRG-GU005 and PEACE-2'))
      .toEqual(['VISION', 'DESTINY-Breast04', 'NRG-GU005', 'PEACE-2']);
  });

  it('ignores endpoints, statistics, modalities and genes', () => {
    expect(namedTrialsIn('OS and PFS by HR with SBRT for HER2-low disease')).toEqual([]);
  });

  it('ignores journals, drug classes and design shorthand', () => {
    // Comparative prose cites these constantly; none is a trial whose absence
    // from the sources should withhold a section.
    expect(namedTrialsIn('NEJM 2021, an ARPI, an RCT with QOL and MCID')).toEqual([]);
  });

  it('ignores staging descriptors, phases and modalities', () => {
    // All three were measured as false positives against the published corpus.
    expect(namedTrialsIn('N0M0 phase III disease treated with SRS BID')).toEqual([]);
  });

  it('ignores compounds that do not lead with an acronym', () => {
    expect(namedTrialsIn('177Lu-PSMA-617 and T-DXd')).toEqual([]);
  });
});

describe('ungroundedComparatorClaims', () => {
  const SOURCE =
    'PRESTIGE-PSMA randomised 400 patients. rPFS HR 0.41 (95% CI 0.29-0.57), p<0.001.';

  it('flags a figure attached to a trial the source never mentions', () => {
    expect(
      ungroundedComparatorClaims('vs TALAPRO-2 (all-comer mCRPC 1L, HR 0.63): tighter here', SOURCE),
    ).toEqual(['TALAPRO-2']);
  });

  it('flags the measured VISION shape', () => {
    expect(
      ungroundedComparatorClaims(
        'VISION (NEJM 2021): Lu-PSMA-617 monotherapy rPFS HR 0.40 vs SOC in post-taxane mCRPC.',
        SOURCE,
      ),
    ).toEqual(['VISION']);
  });

  it('flags a sibling trial the source does NOT name', () => {
    // The dedup-key path cannot make this call: DESTINY-Breast04 and
    // DESTINY-Breast06 both reduce to the key "DESTINY", so a fabricated
    // sibling would pass. Literal comparison is what separates them.
    const src = 'DESTINY-Breast06 tested T-DXd. PFS 13.2 vs 8.1 months.';
    expect(ungroundedComparatorClaims('DESTINY-Breast04 reported HR 0.64 in a later line.', src))
      .toEqual(['DESTINY-Breast04']);
  });

  it('ALLOWS naming a prior trial as context with no figure attached', () => {
    // This is what the comparative sections are for, and 85% of the published
    // corpus does it. A rule that withheld this would delete the product.
    expect(
      ungroundedComparatorClaims(
        'SABR-COMET tested MDT in oligometastatic disease; this trial extends the question.',
        SOURCE,
      ),
    ).toEqual([]);
  });

  it('ALLOWS a comparator named beside THIS study’s own numbers', () => {
    // Measured false positive: "A 100% LC figure is in line with ... (IROCK
    // pooled analyses report high LC)" — the figure is the card's own and IROCK
    // carries none. Attachment, not co-occurrence, is what makes a claim.
    const src = 'Local control was 100% at 5 years.';
    expect(ungroundedComparatorClaims('A 100% LC figure is in line with IROCK series.', src))
      .toEqual([]);
  });

  it('ALLOWS a figure attached to a trial the source DOES name', () => {
    const src = 'Compared with POP-RT, which enrolled 224 patients at a single centre.';
    expect(ungroundedComparatorClaims('vs POP-RT (single-center, N=224), which reported benefit.', src))
      .toEqual([]);
  });

  it('says nothing about prose with no statistic at all', () => {
    expect(ungroundedComparatorClaims('VISION established the modality.', SOURCE)).toEqual([]);
  });
});

describe('withholdUngroundedComparators', () => {
  const SOURCE = 'PRESTIGE-PSMA randomised 400 patients. rPFS HR 0.41.';

  it('withholds the offending bullet and keeps the grounded ones', () => {
    const study = {
      slug: 'prestige-psma',
      name: 'PRESTIGE-PSMA',
      details: [
        'rPFS HR 0.41 favouring the combination',
        'vs VISION (NEJM 2021, rPFS HR 0.40): a different line of therapy',
        'Toxicity was manageable',
      ],
    };
    const w = withholdUngroundedComparators(study, SOURCE);
    expect(study.details).toEqual([
      'rPFS HR 0.41 favouring the combination',
      'Toxicity was manageable',
    ]);
    expect(w).toEqual([{ slug: 'prestige-psma', surface: 'details[1]', trials: ['VISION'] }]);
  });

  it('withholds one analysis section, not the whole fold', () => {
    const study = {
      slug: 's',
      name: 'S',
      analysis_sections: [
        { label: 'Design', body: 'Randomised, 400 patients.' },
        { label: 'vs leading data', body: 'VISION (NEJM 2021) reported rPFS HR 0.40.' },
      ],
    };
    withholdUngroundedComparators(study, SOURCE);
    expect(study.analysis_sections).toEqual([{ label: 'Design', body: 'Randomised, 400 patients.' }]);
  });

  it('nulls a long-form surface rather than publishing a fabricated comparator', () => {
    // Auditing only where the failure was first measured is how a fix guards the
    // mechanism and leaves the other doors open.
    const study = {
      slug: 's',
      name: 'S',
      significance: 'Against VISION (n=831, HR 0.40) this matters.',
      interpretation: 'A grounded read with no comparator figures.',
      monday_clinic: 'Offer it to the PSMA-PET positive patient.',
    };
    withholdUngroundedComparators(study, SOURCE);
    expect(study.significance).toBeNull();
    expect(study.interpretation).toBe('A grounded read with no comparator figures.');
    expect(study.monday_clinic).toBe('Offer it to the PSMA-PET positive patient.');
  });

  it('leaves a fully grounded study untouched', () => {
    const study = {
      slug: 's',
      name: 'S',
      details: ['rPFS HR 0.41 in 400 patients'],
      analysis_sections: [{ label: 'Results', body: 'HR 0.41.' }],
      significance: 'Moves the first-line decision.',
    };
    const before = JSON.parse(JSON.stringify(study));
    expect(withholdUngroundedComparators(study, SOURCE)).toEqual([]);
    expect(study).toEqual(before);
  });
});

describe('formatGroundingWithholds', () => {
  it('reports a clean audit', () => {
    expect(formatGroundingWithholds([])).toMatch(/every named trial is in source/);
  });

  it('names what was withheld and why', () => {
    const out = formatGroundingWithholds([
      { slug: 'talapro-3', surface: 'details[5]', trials: ['TALAPRO-2'] },
    ]);
    expect(out).toContain('withheld 1 surface');
    expect(out).toContain('talapro-3 · details[5]: withheld — TALAPRO-2 not in source');
  });
});

// The mirror question. Grounding asks "did the card claim something the source
// didn't say"; this asks "did the card DROP something the source did say, where
// dropping it changes the medicine". The judge caught EMBARK genericised to
// "biochemical recurrence with rising PSA" with the source's "nmCRPC" absent
// from every surface, and called it "a clinically material population
// misstatement, not a stylistic trim".
describe('droppedDiseaseStates', () => {
  const SRC = 'EMBARK final OS: enzalutamide + leuprolide in nmCRPC with rising PSA. OS HR 0.76.';

  it('flags a state the source names and the card never repeats', () => {
    const study = {
      name: 'EMBARK',
      tldr: 'Final OS HR 0.76 in biochemical recurrence with rising PSA after primary therapy.',
      details: ['Survival benefit confirmed'],
    };
    expect(droppedDiseaseStates(study, SRC)).toEqual(['nmCRPC']);
  });

  it('is quiet when ANY surface carries the state', () => {
    // A card that uses the state anywhere has not lost it.
    const study = { name: 'EMBARK', tldr: 'OS HR 0.76.', details: ['Enzalutamide in nmCRPC'] };
    expect(droppedDiseaseStates(study, SRC)).toEqual([]);
  });

  it('checks verdict.audience, which is where a population gate belongs', () => {
    const withAudience = {
      name: 'EMBARK',
      tldr: 'OS HR 0.76.',
      verdict: { audience: 'nmCRPC with rising PSA on ADT' },
    };
    expect(droppedDiseaseStates(withAudience, SRC)).toEqual([]);
  });

  it('accepts a MORE specific state as covering the looser one', () => {
    // A card saying "nmCRPC" has not dropped "mCRPC".
    const src = 'Enzalutamide in mCRPC and specifically nmCRPC.';
    const study = { name: 'E', tldr: 'Studied in nmCRPC.', details: [] };
    expect(droppedDiseaseStates(study, src)).toEqual([]);
  });

  it('says nothing when the source names no disease state', () => {
    expect(droppedDiseaseStates({ name: 'X', tldr: 'HR 0.62.', details: [] }, 'PFS 13.2 vs 8.1mo.'))
      .toEqual([]);
  });
});

// Plain substring search inverts the meaning here: "nmCRPC" CONTAINS "mCRPC",
// so a source saying only non-metastatic castration-resistant would report
// METASTATIC as dropped — reporting a population the source never named.
describe('disease-state matching is token-aware', () => {
  it('does not read nmCRPC as also naming mCRPC', () => {
    const study = { name: 'E', tldr: 'Rising PSA after primary therapy.', details: [] };
    expect(droppedDiseaseStates(study, 'enzalutamide in nmCRPC with rising PSA')).toEqual(['nmCRPC']);
  });

  it('does not read HER2-low as also naming HER2-positive', () => {
    const study = { name: 'D', tldr: 'T-DXd after endocrine therapy.', details: [] };
    expect(droppedDiseaseStates(study, 'T-DXd in HER2-low metastatic breast cancer'))
      .toEqual(['HER2-low']);
  });
});

// A watched trial whose population contradicts the study's. The reader clicks it
// expecting an answer for the patient the study was about; mCRPC and mHSPC are
// different diseases, and an adjacent-population trial quietly wastes the click.
describe('conflictingState', () => {
  it('flags a hormone-sensitivity contradiction', () => {
    expect(conflictingState('PRESTIGE-PSMA in PSMA-PET+ mCRPC', 'enrolling mHSPC patients'))
      .toBe('mCRPC vs mHSPC');
  });

  it('flags a HER2-status contradiction', () => {
    expect(conflictingState('T-DXd in HER2-low mBC', 'HER2-positive advanced breast cancer'))
      .toBe('HER2-low vs HER2-positive');
  });

  it('flags a metastatic-state contradiction', () => {
    expect(conflictingState('enzalutamide in nmCRPC', 'patients with mCRPC')).toBeTruthy();
  });

  it('passes a matching state', () => {
    expect(conflictingState('PRESTIGE-PSMA in mCRPC', 'docetaxel + Lu-PSMA in mCRPC')).toBeNull();
  });

  it('passes a trial enrolling BOTH states', () => {
    // Covering the study's population is not a contradiction, whatever else the
    // trial also enrols.
    expect(conflictingState('study in mCRPC', 'cohorts in mHSPC and mCRPC')).toBeNull();
  });

  it('is silent when neither side names a state', () => {
    expect(conflictingState('a study of radiotherapy', 'a trial of radiotherapy')).toBeNull();
  });
});

// Synonyms are not opposites. A flat exclusive list treated mHSPC and mCSPC as
// contradictory and would have dropped a legitimate watch: hormone-sensitive and
// castration-sensitive are the same state, written two ways by two literatures.
describe('conflictingState knows synonyms from opposites', () => {
  it('does NOT flag mHSPC against mCSPC', () => {
    expect(conflictingState('A-DREAM in mHSPC', 'intermittent ADT in mCSPC')).toBeNull();
  });

  it('does NOT flag hormone-sensitive against castration-sensitive', () => {
    expect(conflictingState('study in hormone-sensitive disease', 'castration-sensitive cohort'))
      .toBeNull();
  });

  it('still flags castration-SENSITIVE against castration-RESISTANT', () => {
    expect(conflictingState('TALAPRO-3 in mCSPC', 'TALAPRO-2 in mCRPC')).toBe('mCSPC vs mCRPC');
  });

  it('still flags metastatic against non-metastatic within one sensitivity', () => {
    expect(conflictingState('study in mCRPC', 'trial in nmCRPC')).toBe('mCRPC vs nmCRPC');
  });
});
