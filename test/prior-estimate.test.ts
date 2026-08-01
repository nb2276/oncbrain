// v0.37 (E5): longitudinal magnitude. The stakes here are attribution, not
// layout — showing "updated from HR 0.71" against the wrong trial states a
// clinical result that no source reported. Every ambiguous case must resolve to
// null, so most of this file is about what must NOT match.
import { describe, it, expect } from 'vitest';
import {
  buildPriorIndex,
  findPriorEstimate,
  type PriorIndexStudy,
} from '../src/lib/prior-estimate.ts';

const pe = (stat_value: string, stat_detail: string | null = null, name = 'Overall survival') => ({
  name, klass: 'overall-survival', stat_value, stat_detail,
});

const study = (o: Partial<PriorIndexStudy> & { date: string }): PriorIndexStudy => ({
  slug: 'trial', name: 'TRIALNAME', nct: null, disease_site: 'prostate',
  primary_endpoint: pe('HR 0.62'), ...o,
});

describe('buildPriorIndex', () => {
  it('indexes only studies carrying a parseable ratio', () => {
    const idx = buildPriorIndex([
      study({ date: '2026-01-01', primary_endpoint: pe('HR 0.62', '95% CI 0.44-0.88') }),
      study({ date: '2026-01-02', primary_endpoint: pe('15.8 vs 12.3 mo') }),
      study({ date: '2026-01-03', primary_endpoint: null }),
    ]);
    expect(idx).toHaveLength(1);
    expect(idx[0]!.stat_value).toBe('HR 0.62');
  });
});

describe('findPriorEstimate', () => {
  it('finds an earlier reading of the same trial when the magnitude moved', () => {
    const index = buildPriorIndex([
      study({ date: '2026-01-01', nct: 'NCT01', primary_endpoint: pe('HR 0.71', '95% CI 0.50-1.01') }),
    ]);
    const prior = findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.62', '95% CI 0.44-0.88') }),
      index,
    );
    expect(prior).not.toBeNull();
    expect(prior!.stat_value).toBe('HR 0.71');
    expect(prior!.date).toBe('2026-01-01');
    expect(prior!.point).toBe(0.71);
  });

  it('matches on the discriminating acronym when neither card has an NCT', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', name: 'PEACE-2', primary_endpoint: pe('HR 0.81') })]);
    const prior = findPriorEstimate(
      study({ date: '2026-02-01', name: 'PEACE 2', primary_endpoint: pe('HR 0.74') }),
      index,
    );
    expect(prior?.stat_value).toBe('HR 0.81');
  });

  // Trial acronyms are reused freely across tumour types. A bare "PRIME" in
  // breast and a bare "PRIME" in prostate are two different trials, and with no
  // NCT on either side the acronym is the only thing that matches.
  it('refuses an acronym-only match across disease sites', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', name: 'PRIME', disease_site: 'breast', primary_endpoint: pe('HR 0.90') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', name: 'PRIME', disease_site: 'prostate', primary_endpoint: pe('HR 0.62') }),
      index,
    )).toBeNull();
  });

  // A registration number IS definitive, so it outranks the site guard — the
  // disease site is an LLM classification and can legitimately differ per build.
  it('still matches on a shared NCT across disease sites', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', name: 'TRIALX', nct: 'NCT01', disease_site: 'breast', primary_endpoint: pe('HR 0.90') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', name: 'TRIALX', nct: 'NCT01', disease_site: 'other', primary_endpoint: pe('HR 0.62') }),
      index,
    )?.stat_value).toBe('HR 0.90');
  });

  // Two earlier cards can each match the current study while contradicting each
  // other. Picking the more recent would silently choose which trial to cite.
  it('abstains when two mutually inconsistent priors both match', () => {
    const index = buildPriorIndex([
      study({ date: '2026-01-01', name: 'TRIALX', nct: 'NCT01', primary_endpoint: pe('HR 0.92') }),
      study({ date: '2026-03-01', name: 'TRIALX', nct: 'NCT99', primary_endpoint: pe('HR 0.71') }),
    ]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', name: 'TRIALX', primary_endpoint: pe('HR 0.62') }),
      index,
    )).toBeNull();
  });

  // axisBucket collapses every PFS variant into one bucket, which is right for
  // sharing an axis and wrong for claiming an update: a different assessment or
  // population is a different result, not a revision of the same one.
  it('refuses to call a different PFS variant an update of another', () => {
    const index = buildPriorIndex([study({
      date: '2026-01-01', nct: 'NCT01',
      primary_endpoint: pe('HR 0.54', null, 'Investigator-assessed progression-free survival'),
    })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.40', null, 'CNS progression-free survival by BICR') }),
      index,
    )).toBeNull();
  });

  it('tolerates cosmetic endpoint-name differences', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', nct: 'NCT01', primary_endpoint: pe('HR 0.90', null, 'Overall Survival') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.62', null, 'overall-survival') }),
      index,
    )?.stat_value).toBe('HR 0.90');
  });

  it('abstains when the endpoint is unnamed rather than guessing it is the same', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', nct: 'NCT01', primary_endpoint: { name: null, klass: 'overall-survival', stat_value: 'HR 0.90', stat_detail: null } })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: { name: null, klass: 'overall-survival', stat_value: 'HR 0.62', stat_detail: null } }),
      index,
    )).toBeNull();
  });

  // The whole point of the feature: an unchanged number is not news, and drawing
  // a second identical dot would be noise claiming something happened.
  it('abstains when the estimate is unchanged', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', nct: 'NCT01', primary_endpoint: pe('HR 0.81', '95% CI 0.63-1.03') })]);
    expect(findPriorEstimate(
      study({ date: '2026-02-01', nct: 'NCT01', primary_endpoint: pe('HR 0.81', '95% CI 0.63-1.03') }),
      index,
    )).toBeNull();
  });

  // A CI that tightens across 1.0 changes the conclusion even at an identical
  // point estimate. That IS the update worth surfacing.
  it('reports a tightened interval at an unchanged point estimate', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', nct: 'NCT01', primary_endpoint: pe('HR 0.81', '95% CI 0.63-1.03') })]);
    const prior = findPriorEstimate(
      study({ date: '2026-02-01', nct: 'NCT01', primary_endpoint: pe('HR 0.81', '95% CI 0.70-0.94') }),
      index,
    );
    expect(prior?.stat_detail).toBe('95% CI 0.63-1.03');
  });

  // RADIOSA publishes ORIOLE's NCT02680587. An NCT-only rule would confidently
  // attribute one trial's estimate to the other, which is exactly the failure
  // this feature must never produce.
  it('refuses a match when the acronyms disagree, even if the NCT agrees', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', name: 'ORIOLE', nct: 'NCT02680587', primary_endpoint: pe('HR 0.30') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', name: 'RADIOSA', nct: 'NCT02680587', primary_endpoint: pe('HR 0.62') }),
      index,
    )).toBeNull();
  });

  it('refuses a match when the NCTs disagree, even if the acronym agrees', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', name: 'PEACE-2', nct: 'NCT01', primary_endpoint: pe('HR 0.81') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', name: 'PEACE-2', nct: 'NCT99', primary_endpoint: pe('HR 0.74') }),
      index,
    )).toBeNull();
  });

  // An OS hazard ratio is not an update of a PFS hazard ratio. Presenting one as
  // the other would invent a result the trial never reported.
  it('refuses to call a different endpoint an update', () => {
    const index = buildPriorIndex([study({
      date: '2026-01-01', nct: 'NCT01',
      primary_endpoint: pe('HR 0.71', null, 'Progression-free survival'),
    })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.62', null, 'Overall survival') }),
      index,
    )).toBeNull();
  });

  // A rebuild of an old date must not adopt a LATER date's number as its prior.
  it('only ever looks backwards', () => {
    const index = buildPriorIndex([study({ date: '2026-12-01', nct: 'NCT01', primary_endpoint: pe('HR 0.55') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.62') }),
      index,
    )).toBeNull();
  });

  it('takes the most recent of several earlier readings', () => {
    const index = buildPriorIndex([
      study({ date: '2026-01-01', nct: 'NCT01', primary_endpoint: pe('HR 0.90') }),
      study({ date: '2026-03-01', nct: 'NCT01', primary_endpoint: pe('HR 0.71') }),
    ]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.62') }),
      index,
    )?.stat_value).toBe('HR 0.71');
  });

  // Two unrelated studies must never pair up just because both lack identifiers.
  it('never matches on absent identifiers alone', () => {
    const index = buildPriorIndex([study({ date: '2026-01-01', name: '10-yr outcomes after SBRT', primary_endpoint: pe('HR 0.71') })]);
    expect(findPriorEstimate(
      study({ date: '2026-06-01', name: 'Long-term results of hypofractionation', primary_endpoint: pe('HR 0.62') }),
      index,
    )).toBeNull();
  });

  it('ignores a self-match when the study is already in the index', () => {
    const self = study({ date: '2026-06-01', nct: 'NCT01', primary_endpoint: pe('HR 0.62') });
    expect(findPriorEstimate(self, buildPriorIndex([self]))).toBeNull();
  });
});
