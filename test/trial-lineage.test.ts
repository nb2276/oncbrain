// Trial lineage: which of update / new-card / duplicate a same-trial
// resubmission is. The stakes are asymmetric — `update` and a certain
// `duplicate` UNPUBLISH a card that is already live — so most of this file is
// about what must NOT trigger a suppression.
import { describe, it, expect } from 'vitest';
import {
  classifyAgainstPrior,
  sameTrial,
  sameTrialIdentity,
  parseGuard,
  suppressionBlockers,
  primaryBlocker,
  isIdentityOnly,
  facetsCompatible,
  type TrialReport,
} from '../src/lib/trial-lineage.ts';

const rep = (o: Partial<TrialReport> & { date: string }): TrialReport => ({
  slug: 'trial',
  name: 'NRG-GU005',
  ncts: [],
  acronyms: [],
  disease_site: 'prostate',
  facet: 'primary-efficacy',
  maturity: 'full-publication',
  // Both readings must RECORD a follow-up before anything may be unpublished —
  // unknown is unknown, the same rule as endpoint and maturity. Fixtures that
  // want the unknown-follow-up path set it back to null explicitly.
  followup_months: 24,
  endpoint: 'Overall survival',
  stat_value: 'HR 0.62',
  stat_detail: null,
  ...o,
});

describe('sameTrialIdentity', () => {
  const id = (ncts: string[], keys: string[], site: string | null = 'prostate') => ({
    ncts: new Set(ncts),
    keys: new Set(keys),
    site,
  });

  it('matches on NCT overlap even across disease sites', () => {
    // The site is an LLM classification; the registration number is not.
    expect(sameTrialIdentity(id(['NCT1'], [], 'prostate'), id(['NCT1'], [], 'breast'))).toBe(true);
  });

  it('vetoes on NCT disagreement even when the acronym agrees', () => {
    // RADIOSA misprints ORIOLE's registration. An NCT-only rule would attribute
    // one trial's result to the other.
    expect(sameTrialIdentity(id(['NCT1'], ['ORIOLE']), id(['NCT2'], ['ORIOLE']))).toBe(false);
  });

  it('vetoes on acronym disagreement even when the NCT agrees', () => {
    expect(sameTrialIdentity(id(['NCT1'], ['PEACE2']), id(['NCT1'], ['PEACEV']))).toBe(false);
  });

  it('requires the same disease site for an acronym-only match', () => {
    expect(sameTrialIdentity(id([], ['PRIME'], 'breast'), id([], ['PRIME'], 'prostate'))).toBe(false);
    expect(sameTrialIdentity(id([], ['PRIME'], 'breast'), id([], ['PRIME'], 'breast'))).toBe(true);
  });

  it('abstains when a site is unknown on an acronym-only match', () => {
    expect(sameTrialIdentity(id([], ['PRIME'], null), id([], ['PRIME'], 'breast'))).toBe(false);
  });

  it('matches when one side has an NCT and the other does not, via acronym', () => {
    // The live GU005 case: the earlier card carries no NCT at all, the later
    // full publication registers one. An empty set is not a conflict.
    expect(sameTrialIdentity(id([], ['NRGGU005']), id(['NCT03367702'], ['NRGGU005']))).toBe(true);
  });

  it('does not match two readings sharing nothing', () => {
    expect(sameTrialIdentity(id([], [], 'prostate'), id([], [], 'prostate'))).toBe(false);
  });
});

describe('sameTrial identity accretion', () => {
  it('uses an acronym a source declared when the study name has none', () => {
    // The JAMA report is titled "Stereotactic Body Radiotherapy vs Moderately
    // Hypofractionated IMRT ..." — studyDedupKey finds no trial id in that, so
    // without the source-declared acronym this pair is invisible to lineage.
    const prior = rep({ date: '2026-07-08', name: 'NRG-GU005' });
    const current = rep({
      date: '2026-08-14',
      name: 'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT',
      acronyms: ['NRG-GU005'],
    });
    expect(sameTrial(current, prior)).toBe(true);
  });

  it('still vetoes when the declared acronym contradicts the name', () => {
    const prior = rep({ date: '2026-07-08', name: 'ORIOLE' });
    const current = rep({ date: '2026-08-14', name: 'RADIOSA', acronyms: ['RADIOSA'] });
    expect(sameTrial(current, prior)).toBe(false);
  });
});

describe('classifyAgainstPrior', () => {
  const prior = rep({ date: '2026-07-08', slug: 'nrg-gu005', ncts: ['NCT03367702'] });

  it('returns unrelated when no prior is the same trial', () => {
    const current = rep({ date: '2026-08-14', name: 'PACE-B', ncts: ['NCT01584258'] });
    expect(classifyAgainstPrior(current, [prior]).kind).toBe('unrelated');
  });

  it('returns unrelated when there is no prior at all', () => {
    expect(classifyAgainstPrior(rep({ date: '2026-08-14' }), []).kind).toBe('unrelated');
  });

  it('ignores priors dated on or after the study being built', () => {
    // A rebuild of an old date must never adopt a later date's card as its prior.
    const later = rep({ date: '2026-09-01', ncts: ['NCT03367702'] });
    expect(classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT03367702'] }), [later]).kind)
      .toBe('unrelated');
  });

  it('calls a different objective a new card, not an update', () => {
    const current = rep({
      date: '2026-08-14',
      ncts: ['NCT03367702'],
      facet: 'quality-of-life',
    });
    const v = classifyAgainstPrior(current, [prior]);
    expect(v.kind).toBe('new-card');
  });

  it('requires a shared NCT before an update may unpublish its predecessor', () => {
    // Every destructive branch takes the same bar. An acronym match rests on an
    // LLM disease-site call and on trial names reused across tumour types: two
    // unrelated same-site "PRIME" reports, one an abstract and one a paper,
    // satisfy every other update condition.
    const p = rep({ date: '2026-07-08', slug: 'prime-a', name: 'PRIME', ncts: [], maturity: 'conference-abstract' });
    const c = rep({ date: '2026-08-14', slug: 'prime-b', name: 'PRIME', ncts: [], maturity: 'full-publication' });
    const v = classifyAgainstPrior(c, [p]);
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.corroborated).toBe(false);
  });

  it('marks an update corroborated when the trials share a registration', () => {
    const p = rep({ date: '2026-07-08', ncts: ['NCT1'], maturity: 'conference-abstract' });
    const c = rep({ date: '2026-08-14', ncts: ['NCT1'], maturity: 'full-publication' });
    const v = classifyAgainstPrior(c, [p]);
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.corroborated).toBe(true);
  });

  it('checks the ENDPOINT before maturity can call it an update', () => {
    // Ordering bug: a prior conference card reporting OVERALL SURVIVAL and a new
    // full publication reporting PROGRESSION-FREE SURVIVAL share a facet, so the
    // maturity branch returned `update` and suppressed an OS card with a paper
    // that never reported OS. No amount of added maturity makes a PFS ratio an
    // update of an OS ratio.
    const os = rep({ date: '2026-07-08', ncts: ['NCT1'], maturity: 'conference-abstract', endpoint: 'Overall survival' });
    const pfs = rep({ date: '2026-08-14', ncts: ['NCT1'], maturity: 'full-publication', endpoint: 'Progression-free survival' });
    expect(classifyAgainstPrior(pfs, [os]).kind).toBe('new-card');
  });

  it('checks the ENDPOINT before longer follow-up can call it an update', () => {
    const os = rep({ date: '2026-07-08', ncts: ['NCT1'], followup_months: 24, endpoint: 'Overall survival' });
    const pfs = rep({ date: '2026-08-14', ncts: ['NCT1'], followup_months: 60, endpoint: 'Progression-free survival' });
    expect(classifyAgainstPrior(pfs, [os]).kind).toBe('new-card');
  });

  it('calls a matured publication an update', () => {
    const abstract = rep({
      date: '2026-07-08',
      slug: 'nrg-gu005',
      ncts: ['NCT03367702'],
      maturity: 'conference-abstract',
    });
    const current = rep({
      date: '2026-08-14',
      ncts: ['NCT03367702'],
      maturity: 'full-publication',
    });
    const v = classifyAgainstPrior(current, [abstract]);
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.prior.slug).toBe('nrg-gu005');
  });

  it('never calls a full publication an update of a later abstract', () => {
    // Maturity must move FORWARD. A conference re-presentation of an already
    // published trial is not a supersession of the paper.
    const paper = rep({ date: '2026-07-08', maturity: 'full-publication', ncts: ['NCT1'] });
    const current = rep({ date: '2026-08-14', maturity: 'conference-abstract', ncts: ['NCT1'] });
    expect(classifyAgainstPrior(current, [paper]).kind).toBe('duplicate');
  });

  it('calls longer follow-up an update', () => {
    const short = rep({ date: '2026-07-08', ncts: ['NCT1'], followup_months: 24 });
    const long = rep({ date: '2026-08-14', ncts: ['NCT1'], followup_months: 60 });
    const v = classifyAgainstPrior(long, [short]);
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.reason).toMatch(/24mo → 60mo/);
  });

  it('calls a moved estimate on the same endpoint an update', () => {
    const before = rep({ date: '2026-07-08', ncts: ['NCT1'], stat_value: 'HR 0.71' });
    const after = rep({ date: '2026-08-14', ncts: ['NCT1'], stat_value: 'HR 0.62' });
    expect(classifyAgainstPrior(after, [before]).kind).toBe('update');
  });

  it('treats a tightened CI at an identical point estimate as a move', () => {
    // A CI crossing back over 1.0 changes the conclusion even at the same point.
    const before = rep({ date: '2026-07-08', ncts: ['NCT1'], stat_detail: '95% CI 0.44-1.08' });
    const after = rep({ date: '2026-08-14', ncts: ['NCT1'], stat_detail: '95% CI 0.48-0.92' });
    expect(classifyAgainstPrior(after, [before]).kind).toBe('update');
  });

  it('does not call a DIFFERENT endpoint an update of the same facet', () => {
    // An OS hazard ratio is not an update of a PFS hazard ratio.
    const os = rep({ date: '2026-07-08', ncts: ['NCT1'], endpoint: 'Overall survival' });
    const pfs = rep({ date: '2026-08-14', ncts: ['NCT1'], endpoint: 'Progression-free survival' });
    expect(classifyAgainstPrior(pfs, [os]).kind).toBe('new-card');
  });

  it('calls an unchanged same-facet reading a duplicate', () => {
    const v = classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT03367702'] }), [prior]);
    expect(v.kind).toBe('duplicate');
  });

  it('marks a duplicate certain only on a SHARED NCT', () => {
    const v = classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT03367702'] }), [prior]);
    if (v.kind === 'duplicate') expect(v.certain).toBe(true);
  });

  it('marks an acronym-only duplicate UNcertain', () => {
    // Acronym-only identity rests on an LLM disease-site classification. That is
    // not a basis for unpublishing a card without asking.
    const noNct = rep({ date: '2026-07-08', slug: 'nrg-gu005', ncts: [] });
    const v = classifyAgainstPrior(rep({ date: '2026-08-14', ncts: [] }), [noNct]);
    expect(v.kind).toBe('duplicate');
    if (v.kind === 'duplicate') expect(v.certain).toBe(false);
  });

  it('marks a duplicate UNcertain when neither side records an endpoint', () => {
    // Two cards with no endpoint compare "equal" only because both are empty,
    // and the absence of a number is not evidence that the number did not move.
    // Every other certainty signal is present here — shared NCT, same maturity —
    // so this asserts the endpoint clause specifically.
    const p = rep({ date: '2026-07-08', ncts: ['NCT1'], endpoint: null, stat_value: null });
    const c = rep({ date: '2026-08-14', ncts: ['NCT1'], endpoint: null, stat_value: null });
    const v = classifyAgainstPrior(c, [p]);
    expect(v.kind).toBe('duplicate');
    if (v.kind === 'duplicate') {
      expect(v.certain).toBe(false);
      expect(v.reason).toMatch(/no endpoint recorded/);
    }
  });

  it('does not call an unnamed endpoint a new card', () => {
    // Unnamed is unknown, not different. Publishing a second card for the same
    // objective because neither reading named its endpoint is the over-split
    // mirror of the over-merge this feature exists to fix.
    const p = rep({ date: '2026-07-08', ncts: ['NCT1'], endpoint: null });
    const c = rep({ date: '2026-08-14', ncts: ['NCT1'], endpoint: 'Overall survival' });
    expect(classifyAgainstPrior(c, [p]).kind).toBe('duplicate');
  });

  it('marks a duplicate uncertain when maturity is unknown on either side', () => {
    const p = rep({ date: '2026-07-08', ncts: ['NCT1'], maturity: null });
    const v = classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT1'] }), [p]);
    if (v.kind === 'duplicate') expect(v.certain).toBe(false);
  });

  it('ABSTAINS when the current facet is unknown', () => {
    // Without a facet we cannot tell a different objective from a matured one,
    // and those call for opposite actions. Abstention degrades to the old nudge.
    const current = rep({ date: '2026-08-14', ncts: ['NCT03367702'], facet: null });
    expect(classifyAgainstPrior(current, [prior]).kind).toBe('unrelated');
  });

  it('ABSTAINS when the prior facet is unknown', () => {
    const p = rep({ date: '2026-07-08', ncts: ['NCT03367702'], facet: null });
    expect(classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT03367702'] }), [p]).kind)
      .toBe('unrelated');
  });

  it('ABSTAINS when two priors match but contradict each other', () => {
    // Two earlier cards sharing an acronym but registered differently both match
    // the current study while contradicting each other. Picking the more recent
    // would silently choose a trial.
    const a = rep({ date: '2026-07-01', slug: 'a', ncts: ['NCT1'], name: 'PRIME' });
    const b = rep({ date: '2026-07-08', slug: 'b', ncts: ['NCT2'], name: 'PRIME' });
    const current = rep({ date: '2026-08-14', ncts: [], name: 'PRIME' });
    expect(classifyAgainstPrior(current, [a, b]).kind).toBe('unrelated');
  });

  it('picks the most recent prior when several agree', () => {
    const old = rep({ date: '2026-06-01', slug: 'old', ncts: ['NCT1'], maturity: 'conference-abstract' });
    const mid = rep({ date: '2026-07-08', slug: 'mid', ncts: ['NCT1'], maturity: 'conference-abstract' });
    const v = classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT1'] }), [old, mid]);
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.prior.slug).toBe('mid');
  });
});

describe('parseGuard', () => {
  it('rejects off-enum facets and maturities', () => {
    expect(parseGuard.facet('primary-efficacy')).toBe('primary-efficacy');
    expect(parseGuard.facet('PRIMARY-EFFICACY')).toBeNull();
    expect(parseGuard.facet('efficacy')).toBeNull();
    expect(parseGuard.facet(null)).toBeNull();
    expect(parseGuard.maturity('full-publication')).toBe('full-publication');
    expect(parseGuard.maturity('preprint')).toBeNull();
  });
});

// LLM output trust boundary. `trial_acronyms` is model output, and keys are
// compared as SETS where overlap is a match — so unioning it into a card that
// already has a name key could only WIDEN identity, and on the update path a
// widened identity unpublishes a live card. Source acronyms are therefore a
// FALLBACK for a card that cannot name itself, never an ADDITION to one that can.
describe('source-declared acronyms cannot widen a card that names itself', () => {
  it('ignores a source acronym naming a DIFFERENT trial when the name has a key', () => {
    const prior = rep({ date: '2026-07-08', slug: 'p', name: 'PACE-B', ncts: [] });
    const current = rep({
      date: '2026-08-14',
      name: 'ORIOLE',
      // the model misattributed a comparator; without the fallback-only rule
      // this overlaps PACE-B and the ORIOLE card supersedes it
      acronyms: ['PACE-B'],
      ncts: [],
    });
    expect(sameTrial(current, prior)).toBe(false);
    expect(classifyAgainstPrior(current, [prior]).kind).toBe('unrelated');
  });

  it('still uses source acronyms when the name yields no key at all', () => {
    const prior = rep({ date: '2026-07-08', slug: 'p', name: 'NRG-GU005', ncts: [] });
    const current = rep({
      date: '2026-08-14',
      name: 'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT',
      acronyms: ['NRG-GU005'],
      ncts: [],
    });
    expect(sameTrial(current, prior)).toBe(true);
  });
});

// Second adversarial round. Each of these authorized an unpublish on evidence
// that did not actually establish the two cards reported the same result.
describe('what must NOT authorize an unpublish', () => {
  const base = (o: Partial<TrialReport> & { date: string }) =>
    rep({ ncts: ['NCT00000001'], maturity: 'conference-abstract', ...o });

  it('an UNNAMED endpoint, however much maturity was added', () => {
    // Unnamed is unknown, not equal. "Newer" says nothing about a measurement
    // nobody recorded, so this may link but must not drop.
    const v = classifyAgainstPrior(
      base({ date: '2026-08-14', maturity: 'full-publication' }),
      [base({ date: '2026-07-08', endpoint: null })],
    );
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.corroborated).toBe(false);
  });

  it('a maturity bump whose follow-up went BACKWARDS', () => {
    // A 24-month journal report does not supersede a published 60-month reading
    // just because journals outrank meetings.
    const v = classifyAgainstPrior(
      base({ date: '2026-08-14', maturity: 'full-publication', followup_months: 24 }),
      [base({ date: '2026-07-08', followup_months: 60 })],
    );
    expect(v.kind).toBe('update');
    if (v.kind === 'update') {
      expect(v.corroborated).toBe(false);
      expect(v.reason).toMatch(/follow-up regressed/);
    }
  });

  it('a stat that went MISSING rather than changed', () => {
    // "HR 0.62" replacing "HR 0.62, 95% CI 0.48-0.92" is less detail, not a new
    // result — and the richer prior is the one that would have been dropped.
    const v = classifyAgainstPrior(
      base({ date: '2026-08-14', stat_detail: null }),
      [base({ date: '2026-07-08', stat_detail: '95% CI 0.48-0.92' })],
    );
    expect(v.kind).toBe('duplicate');
  });
});

// The canonical longer-follow-up update was unreachable: the prompt classifies
// "10-year update of X" as long-term-followup, and the facet change was read as
// a different objective — so the one transition the vocabulary exists to
// describe always produced a new card instead.
describe('long-term-followup matures its parent objective', () => {
  it('is an update of the efficacy reading it extends', () => {
    const v = classifyAgainstPrior(
      rep({ date: '2026-08-14', ncts: ['NCT1'], facet: 'long-term-followup', followup_months: 120 }),
      [rep({ date: '2026-07-08', ncts: ['NCT1'], facet: 'primary-efficacy', followup_months: 24 })],
    );
    expect(v.kind).toBe('update');
  });

  it('does NOT collapse in the other direction', () => {
    const v = classifyAgainstPrior(
      rep({ date: '2026-08-14', ncts: ['NCT1'], facet: 'primary-efficacy' }),
      [rep({ date: '2026-07-08', ncts: ['NCT1'], facet: 'long-term-followup' })],
    );
    expect(v.kind).toBe('new-card');
  });

  it('leaves unrelated facet pairs as two findings', () => {
    const v = classifyAgainstPrior(
      rep({ date: '2026-08-14', ncts: ['NCT1'], facet: 'quality-of-life' }),
      [rep({ date: '2026-07-08', ncts: ['NCT1'], facet: 'primary-efficacy' })],
    );
    expect(v.kind).toBe('new-card');
  });
});

// Round three. Every one of these was a DIFFERENT route to the same bad
// outcome, which is why the preconditions now live in one function
// (suppressionBlocker) that every destructive branch consults, instead of each
// branch computing its own subset.
describe('suppressionBlocker is the single authorization gate', () => {
  const ok = (o: Partial<TrialReport> & { date: string }) =>
    rep({ ncts: ['NCT00000001'], maturity: 'full-publication', ...o });

  it('blocks a conference abstract from superseding a journal paper', () => {
    // Maturity regression. The older card is the more settled reading, and
    // "the newer file wins" is the wrong instinct for clinical evidence.
    const v = classifyAgainstPrior(
      ok({ date: '2026-08-14', maturity: 'conference-abstract', stat_value: '0.62' }),
      [ok({ date: '2026-07-08', stat_value: 'HR 0.62' })],
    );
    expect(v.kind).toBe('update');
    if (v.kind === 'update') {
      expect(v.corroborated).toBe(false);
      expect(v.reason).toMatch(/maturity regressed/);
    }
  });

  it('blocks a long-term report from removing a quality-of-life card', () => {
    // long-term-followup matures ONE parent. A trial's 10-year survival says
    // nothing about its patient-reported outcomes.
    expect(
      classifyAgainstPrior(
        ok({ date: '2026-08-14', facet: 'long-term-followup', followup_months: 120 }),
        [ok({ date: '2026-07-08', facet: 'quality-of-life', followup_months: 24 })],
      ).kind,
    ).toBe('new-card');
  });

  it('blocks a long-term report from removing a subgroup card', () => {
    expect(
      classifyAgainstPrior(
        ok({ date: '2026-08-14', facet: 'long-term-followup', followup_months: 120 }),
        [ok({ date: '2026-07-08', facet: 'subgroup-secondary', followup_months: 24 })],
      ).kind,
    ).toBe('new-card');
  });

  it('still lets long-term follow-up mature its primary-efficacy parent', () => {
    const v = classifyAgainstPrior(
      ok({ date: '2026-08-14', facet: 'long-term-followup', followup_months: 120 }),
      [ok({ date: '2026-07-08', facet: 'primary-efficacy', followup_months: 24 })],
    );
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.corroborated).toBe(true);
  });

  describe('a duplicate is only certain on SYMMETRIC evidence', () => {
    it('refuses when the prior has no statistic at all', () => {
      const v = classifyAgainstPrior(ok({ date: '2026-08-14' }), [
        ok({ date: '2026-07-08', stat_value: null }),
      ]);
      expect(v.kind).toBe('duplicate');
      if (v.kind === 'duplicate') expect(v.certain).toBe(false);
    });

    it('refuses when the prior carries a CI the new card lacks', () => {
      const v = classifyAgainstPrior(ok({ date: '2026-08-14', stat_detail: null }), [
        ok({ date: '2026-07-08', stat_detail: '95% CI 0.48-0.92' }),
      ]);
      expect(v.kind).toBe('duplicate');
      if (v.kind === 'duplicate') expect(v.certain).toBe(false);
    });

    it('refuses when the new card covers LESS follow-up', () => {
      const v = classifyAgainstPrior(ok({ date: '2026-08-14', followup_months: 24 }), [
        ok({ date: '2026-07-08', followup_months: 60 }),
      ]);
      expect(v.kind).toBe('duplicate');
      if (v.kind === 'duplicate') expect(v.certain).toBe(false);
    });
  });
});

// Round four: unknown follow-up gets the same fail-closed treatment as unknown
// maturity. A 60-month prior against a current card with no follow-up recorded,
// equal maturity and matching statistics became a `certain` duplicate and
// removed the richer reading, purely because "null < 60" is false.
describe('unknown follow-up fails closed', () => {
  it('refuses a duplicate when the new card records no follow-up', () => {
    const v = classifyAgainstPrior(
      rep({ date: '2026-08-14', ncts: ['NCT1'], followup_months: null }),
      [rep({ date: '2026-07-08', ncts: ['NCT1'], followup_months: 60 })],
    );
    expect(v.kind).toBe('duplicate');
    if (v.kind === 'duplicate') {
      expect(v.certain).toBe(false);
      expect(v.blocker).toMatch(/follow-up unknown/);
    }
  });

  it('refuses an update when the prior records no follow-up', () => {
    const v = classifyAgainstPrior(
      rep({ date: '2026-08-14', ncts: ['NCT1'], maturity: 'full-publication' }),
      [rep({ date: '2026-07-08', ncts: ['NCT1'], maturity: 'conference-abstract', followup_months: null })],
    );
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.corroborated).toBe(false);
  });
});

// Round four: the newest prior is not necessarily the one this study can
// supersede. An older efficacy card behind a newer quality-of-life card meant a
// later efficacy update compared itself against QoL, said `new-card`, and never
// reached its real predecessor.
describe('selects the newest COMPATIBLE prior', () => {
  it('skips a newer incompatible facet to reach the true predecessor', () => {
    const older = rep({ date: '2026-06-01', slug: 'eff-old', ncts: ['NCT1'], maturity: 'conference-abstract' });
    const newerQol = rep({ date: '2026-07-08', slug: 'qol', ncts: ['NCT1'], facet: 'quality-of-life' });
    const v = classifyAgainstPrior(rep({ date: '2026-08-14', ncts: ['NCT1'] }), [older, newerQol]);
    expect(v.kind).toBe('update');
    if (v.kind === 'update') expect(v.prior.slug).toBe('eff-old');
  });
});

// The blocker list is collected IN FULL, not short-circuited. Reporting only the
// first refusal meant a pair that also failed on maturity was labelled "no
// shared registration" — and that label is what the curator DM treats as "a
// human can resolve this, offer them the drop reply". The drop handler re-runs
// no evidence checks, so mislabelling one blocker as another was a hole through
// the whole gate.
describe('suppressionBlockers reports every refusal', () => {
  const b = (o: Partial<TrialReport> & { date: string }) =>
    rep({ ncts: [], maturity: 'conference-abstract', ...o });

  it('does not call it an identity gap when maturity ALSO regressed', () => {
    const bs = suppressionBlockers(
      b({ date: '2026-08-14' }),
      b({ date: '2026-07-08', maturity: 'full-publication' }),
      true,
    );
    expect(bs.map((x) => x.code).sort()).toEqual(['identity', 'maturity']);
    expect(primaryBlocker(bs)!.code).toBe('maturity');
    expect(isIdentityOnly(bs)).toBe(false);
  });

  it('reports identityOnly when the registration is the SOLE gap', () => {
    const bs = suppressionBlockers(b({ date: '2026-08-14' }), b({ date: '2026-07-08' }), true);
    expect(bs.map((x) => x.code)).toEqual(['identity']);
    expect(isIdentityOnly(bs)).toBe(true);
  });

  it('is empty when nothing refuses', () => {
    const ok = rep({ date: '2026-08-14', ncts: ['NCT1'], maturity: 'full-publication' });
    const prior = rep({ date: '2026-07-08', ncts: ['NCT1'], maturity: 'conference-abstract' });
    expect(suppressionBlockers(ok, prior, true)).toEqual([]);
  });
});

// Used where the FULL gate cannot run. At enrichment a source has no
// primary_endpoint — Phase 2 makes that at build time — so the endpoint and
// estimate preconditions are structurally unavailable and the facet is the
// strongest signal on hand.
describe('facetsCompatible', () => {
  it('accepts the same objective', () => {
    expect(facetsCompatible('primary-efficacy', 'primary-efficacy')).toBe(true);
  });

  it('accepts long-term follow-up maturing primary efficacy, forward only', () => {
    expect(facetsCompatible('long-term-followup', 'primary-efficacy')).toBe(true);
    expect(facetsCompatible('primary-efficacy', 'long-term-followup')).toBe(false);
  });

  it('rejects a different objective — dropping either would delete a finding', () => {
    expect(facetsCompatible('quality-of-life', 'primary-efficacy')).toBe(false);
    expect(facetsCompatible('long-term-followup', 'quality-of-life')).toBe(false);
    expect(facetsCompatible('safety-toxicity', 'primary-efficacy')).toBe(false);
  });

  it('treats unknown as incompatible on either side', () => {
    expect(facetsCompatible(null, 'primary-efficacy')).toBe(false);
    expect(facetsCompatible('primary-efficacy', null)).toBe(false);
    expect(facetsCompatible(null, null)).toBe(false);
  });
});
