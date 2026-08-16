// The build-time half of trial lineage: reading identity out of the source DB
// and deciding what to DO. The destructive branch (suppressing an already
// published card) is the one that matters, so most of this file constrains it.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, savePaper, saveSourceFacet } from '../src/lib/db.ts';
import {
  planLineage,
  priorReports,
  remainingAfterSuppress,
  sourceFacts,
  toTrialReport,
  findMergedPriors,
  type LineageArtifact,
  type LineageStudy,
} from '../src/lib/lineage-pass.ts';

type Db = ReturnType<typeof openDb>;

const artifact = (
  date: string,
  studies: Record<string, unknown>[],
  disease_site = 'prostate',
): LineageArtifact =>
  ({ date, digest: { sites: [{ disease_site, studies }] } }) as LineageArtifact;

describe('lineage-pass', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  // Seed a paper and classify it, returning its row id.
  const seedPaper = (
    o: {
      doi: string;
      title: string;
      abstract?: string;
      date?: string;
      facet?: string | null;
      maturity?: string | null;
      followup?: number | null;
      acronyms?: string[];
    },
  ): number => {
    const r = savePaper(db, {
      doi: o.doi,
      title: o.title,
      abstract: o.abstract ?? null,
      bookmark_date: o.date ?? '2026-07-08',
    });
    saveSourceFacet(db, 'paper', r.id, {
      facet: o.facet ?? 'primary-efficacy',
      maturity: o.maturity ?? 'conference-abstract',
      followup_months: o.followup ?? 24,
      trial_acronyms: o.acronyms ?? [],
    });
    return r.id;
  };

  describe('sourceFacts', () => {
    it('harvests NCTs and acronyms from a card’s sources', () => {
      const id = seedPaper({
        doi: '10.1000/a',
        title: 'SBRT vs MH-IMRT',
        abstract: 'NRG-GU005 randomised NCT03367702 patients.',
        acronyms: ['NRG-GU005'],
      });
      const f = sourceFacts(db, [{ type: 'paper', id }]);
      expect(f.ncts).toEqual(['NCT03367702']);
      expect(f.acronyms).toEqual(['NRG-GU005']);
      expect(f.facet).toBe('primary-efficacy');
    });

    it('takes the MOST MATURE maturity across sources', () => {
      // A card citing both the abstract and the paper reports the paper.
      const a = seedPaper({ doi: '10.1000/a', title: 'A', maturity: 'conference-abstract' });
      const b = seedPaper({ doi: '10.1000/b', title: 'B', maturity: 'full-publication' });
      const f = sourceFacts(db, [
        { type: 'paper', id: a },
        { type: 'paper', id: b },
      ]);
      expect(f.maturity).toBe('full-publication');
    });

    it('takes the LONGEST follow-up across sources', () => {
      const a = seedPaper({ doi: '10.1000/a', title: 'A', followup: 24 });
      const b = seedPaper({ doi: '10.1000/b', title: 'B', followup: 60 });
      const f = sourceFacts(db, [
        { type: 'paper', id: a },
        { type: 'paper', id: b },
      ]);
      expect(f.followup_months).toBe(60);
    });

    it('ABSTAINS on facet when its sources disagree', () => {
      // A card whose sources report different objectives is precisely the card
      // Phase 1 should have split. Refuse to pick one rather than act on it.
      const a = seedPaper({ doi: '10.1000/a', title: 'A', facet: 'primary-efficacy' });
      const b = seedPaper({ doi: '10.1000/b', title: 'B', facet: 'quality-of-life' });
      const f = sourceFacts(db, [
        { type: 'paper', id: a },
        { type: 'paper', id: b },
      ]);
      expect(f.facet).toBeNull();
    });

    it('ignores slide sources and unknown ids', () => {
      const f = sourceFacts(db, [
        { type: 'slide', id: 1 },
        { type: 'paper', id: 9999 },
      ]);
      expect(f.facet).toBeNull();
      expect(f.ncts).toEqual([]);
    });
  });

  describe('toTrialReport', () => {
    it('merges the card’s own nct with those its sources carry', () => {
      const id = seedPaper({ doi: '10.1000/a', title: 'T', abstract: 'NCT03367702' });
      const r = toTrialReport(db, '2026-08-14', 'prostate', {
        slug: 's',
        name: 'NRG-GU005',
        nct: 'NCT99999999',
        source_ids: [{ type: 'paper', id }],
      });
      expect(new Set(r!.ncts)).toEqual(new Set(['NCT03367702', 'NCT99999999']));
    });

    it('skips a study with no slug — nothing can link to or suppress it', () => {
      expect(toTrialReport(db, '2026-08-14', 'prostate', { name: 'X' })).toBeNull();
    });
  });

  describe('remainingAfterSuppress', () => {
    it('counts what would survive', () => {
      const a = artifact('2026-07-08', [{ slug: 'x' }, { slug: 'y' }]);
      expect(remainingAfterSuppress(a, 'x')).toBe(1);
      expect(remainingAfterSuppress(a, 'zzz')).toBe(2);
    });

    it('returns 0 when the target is the only study', () => {
      expect(remainingAfterSuppress(artifact('2026-07-08', [{ slug: 'x' }]), 'x')).toBe(0);
    });
  });

  describe('planLineage', () => {
    // The live case: an ASTRO abstract card, then the full JAMA publication.
    const gu005 = () => {
      const priorSrc = seedPaper({
        doi: '10.1000/astro',
        title: 'ASTRO 2025: Co-Primary Results from NRG-GU005',
        maturity: 'conference-abstract',
        acronyms: ['NRG-GU005'],
      });
      const currentSrc = seedPaper({
        doi: '10.1001/jama.2026.12627',
        title: 'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT',
        abstract: 'NRG-GU005 ... NCT03367702',
        date: '2026-08-14',
        maturity: 'full-publication',
        acronyms: ['NRG-GU005'],
      });
      return { priorSrc, currentSrc };
    };

    it('classifies a matured publication as an update and plans the suppression', () => {
      const { priorSrc, currentSrc } = gu005();
      const priors = [
        artifact('2026-07-08', [
          { slug: 'nrg-gu005', name: 'NRG-GU005', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper', id: priorSrc }] },
          { slug: 'other', name: 'PACE-B', source_ids: [] },
        ]),
      ];
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              {
                slug: 'nrg-gu005-jama',
                name: 'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT',
                primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, 
                source_ids: [{ type: 'paper' as const, id: currentSrc }],
              },
            ],
          },
        ],
      };
      const actions = planLineage(db, '2026-08-14', digest, priors, new Map(), true);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.verdict.kind).toBe('update');
      // The REAL GU005 pair shares no registration — the 2026-07-08 card's
      // sources carry the acronym six times and no NCT at all. Under the
      // registered-identity rule that is a supersedes LINK plus a curator ask,
      // not an automatic unpublish.
      expect(actions[0]!.suppress).toBeNull();
      expect(actions[0]!.declined).toMatch(/no shared registration/);
    });

    it('plans the suppression once both readings share a registration', () => {
      const priorSrc = seedPaper({
        doi: '10.1000/astro',
        title: 'ASTRO 2025: Co-Primary Results from NRG-GU005',
        abstract: 'Registered NCT03367702.',
        maturity: 'conference-abstract',
        acronyms: ['NRG-GU005'],
      });
      const currentSrc = seedPaper({
        doi: '10.1001/jama.2026.12627',
        title: 'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT',
        abstract: 'NRG-GU005 ... NCT03367702',
        date: '2026-08-14',
        maturity: 'full-publication',
        acronyms: ['NRG-GU005'],
      });
      const priors = [
        artifact('2026-07-08', [
          { slug: 'nrg-gu005', name: 'NRG-GU005', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper', id: priorSrc }] },
          { slug: 'other', name: 'PACE-B', source_ids: [] },
        ]),
      ];
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              {
                slug: 'nrg-gu005-jama',
                name: 'Stereotactic Body Radiotherapy vs Moderately Hypofractionated IMRT',
                primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, 
                source_ids: [{ type: 'paper' as const, id: currentSrc }],
              },
            ],
          },
        ],
      };
      const actions = planLineage(db, '2026-08-14', digest, priors, new Map(), true);
      expect(actions[0]!.verdict.kind).toBe('update');
      expect(actions[0]!.suppress).toEqual({
        date: '2026-07-08',
        slug: 'nrg-gu005',
        name: 'NRG-GU005',
        nct: 'NCT03367702',
        // Provenance is load-bearing, not decorative. Suppressing removes the
        // card from the published artifact, so the NEXT rebuild cannot hold its
        // slug and renames it — and once one trial has two cards they share an
        // acronym key, so name alone matches both and the override is refused as
        // ambiguous. Without these ids the suppression breaks on the very next
        // rebuild and the superseded card republishes.
        source_ids: [{ type: 'paper', id: priorSrc }],
      });
      expect(actions[0]!.declined).toBeNull();
    });

    it('REFUSES to suppress a date’s only study', () => {
      // Suppressing the last card leaves an orphaned headline: a published day
      // whose top_line describes studies the page no longer renders. Both sides
      // share a registration so the check under test is the empty-day one, not
      // the corroboration one.
      const priorSrc = seedPaper({
        doi: '10.1000/astro',
        title: 'ASTRO 2025: NRG-GU005',
        abstract: 'NCT03367702',
        maturity: 'conference-abstract',
      });
      const currentSrc = seedPaper({
        doi: '10.1001/jama.2026.12627',
        title: 'NRG-GU005 full report',
        abstract: 'NCT03367702',
        date: '2026-08-14',
        maturity: 'full-publication',
      });
      const priors = [
        artifact('2026-07-08', [
          { slug: 'nrg-gu005', name: 'NRG-GU005', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper', id: priorSrc }] },
        ]),
      ];
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              {
                slug: 'nrg-gu005-jama',
                name: 'NRG-GU005 (JAMA)',
                primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, 
                source_ids: [{ type: 'paper' as const, id: currentSrc }],
              },
            ],
          },
        ],
      };
      const actions = planLineage(db, '2026-08-14', digest, priors, new Map(), true);
      expect(actions[0]!.verdict.kind).toBe('update');
      expect(actions[0]!.suppress).toBeNull();
      expect(actions[0]!.declined).toMatch(/last surviving study/);
    });

    it('does NOT suppress on a new-card verdict', () => {
      const priorSrc = seedPaper({
        doi: '10.1000/qol',
        title: 'QoL from NRG-GU005',
        facet: 'quality-of-life',
        acronyms: ['NRG-GU005'],
      });
      const currentSrc = seedPaper({
        doi: '10.1000/eff',
        title: 'Efficacy from NRG-GU005',
        date: '2026-08-14',
        facet: 'primary-efficacy',
        acronyms: ['NRG-GU005'],
      });
      const priors = [
        artifact('2026-07-08', [
          { slug: 'gu005-qol', name: 'NRG-GU005', source_ids: [{ type: 'paper', id: priorSrc }] },
          { slug: 'keep', name: 'OTHER', source_ids: [] },
        ]),
      ];
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              {
                slug: 'gu005-eff',
                name: 'NRG-GU005',
                source_ids: [{ type: 'paper' as const, id: currentSrc }],
              },
            ],
          },
        ],
      };
      const actions = planLineage(db, '2026-08-14', digest, priors, new Map(), true);
      expect(actions[0]!.verdict.kind).toBe('new-card');
      expect(actions[0]!.suppress).toBeNull();
    });

    it('does NOT suppress an UNCERTAIN duplicate', () => {
      // Same facet, same maturity, nothing moved, but identity rests on the
      // acronym alone — no shared NCT. That goes to the curator, not to a
      // silent unpublish.
      const priorSrc = seedPaper({ doi: '10.1000/a', title: 'NRG-GU005 report', acronyms: ['NRG-GU005'] });
      const currentSrc = seedPaper({
        doi: '10.1000/b',
        title: 'NRG-GU005 report again',
        date: '2026-08-14',
        acronyms: ['NRG-GU005'],
      });
      const priors = [
        artifact('2026-07-08', [
          { slug: 'a', name: 'NRG-GU005', source_ids: [{ type: 'paper', id: priorSrc }] },
          { slug: 'keep', name: 'OTHER', source_ids: [] },
        ]),
      ];
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              { slug: 'b', name: 'NRG-GU005', source_ids: [{ type: 'paper' as const, id: currentSrc }] },
            ],
          },
        ],
      };
      const actions = planLineage(db, '2026-08-14', digest, priors, new Map(), true);
      expect(actions[0]!.verdict.kind).toBe('duplicate');
      expect(actions[0]!.suppress).toBeNull();
    });

    it('returns nothing when sources were never classified', () => {
      // A DB predating the facet migration, or FACET=off. Lineage abstains and
      // the pre-existing curator nudge stays the only behaviour.
      const r = savePaper(db, { doi: '10.1000/x', title: 'NRG-GU005', bookmark_date: '2026-07-08' });
      const priors = [
        artifact('2026-07-08', [
          { slug: 'a', name: 'NRG-GU005', source_ids: [{ type: 'paper', id: r.id }] },
          { slug: 'keep', name: 'OTHER', source_ids: [] },
        ]),
      ];
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              { slug: 'b', name: 'NRG-GU005', source_ids: [{ type: 'paper' as const, id: r.id }] },
            ],
          },
        ],
      };
      expect(planLineage(db, '2026-08-14', digest, priors)).toEqual([]);
    });

    it('ignores artifacts dated on or after the date being built', () => {
      const { currentSrc } = gu005();
      const digest = {
        sites: [
          {
            disease_site: 'prostate',
            studies: [
              { slug: 'b', name: 'NRG-GU005', source_ids: [{ type: 'paper' as const, id: currentSrc }] },
            ],
          },
        ],
      };
      const later = [artifact('2026-09-01', [{ slug: 'a', name: 'NRG-GU005', source_ids: [] }])];
      expect(planLineage(db, '2026-08-14', digest, later)).toEqual([]);
    });
  });

  describe('priorReports', () => {
    it('survives a malformed artifact rather than throwing', () => {
      const bad = [
        null,
        { date: 5, digest: { sites: [] } },
        { date: '2026-07-08', digest: null },
        { date: '2026-07-08', digest: { sites: [{ studies: null }] } },
      ] as unknown as LineageArtifact[];
      expect(() => priorReports(db, bad)).not.toThrow();
      expect(priorReports(db, bad)).toEqual([]);
    });
  });
});

describe('findMergedPriors', () => {
  let db2: ReturnType<typeof openDb>;
  beforeEach(() => {
    db2 = openDb(':memory:');
  });

  const seed = (doi: string, title: string, facet: string, date = '2026-07-08'): number => {
    const r = savePaper(db2, { doi, title, bookmark_date: date });
    saveSourceFacet(db2, 'paper', r.id, {
      facet,
      maturity: 'conference-abstract',
      followup_months: 24,
      trial_acronyms: ['NRG-GU005'],
    });
    return r.id;
  };

  it('reports a same-trial prior whose sources report two objectives', () => {
    // The live 2026-07-08 NRG-GU005 card: built from the trial's QoL paper AND
    // its co-primary efficacy paper. Suppressing it to make way for the full
    // efficacy publication would take the QoL reading down too.
    const qol = seed('10.1000/qol', 'QoL from NRG-GU005', 'quality-of-life');
    const eff = seed('10.1000/eff', 'Co-primary from NRG-GU005', 'primary-efficacy');
    const now = seed('10.1001/jama', 'SBRT vs MH-IMRT', 'primary-efficacy', '2026-08-14');

    const priors = [
      artifact('2026-07-08', [
        {
          slug: 'nrg-gu005',
          name: 'NRG-GU005',
          source_ids: [
            { type: 'paper', id: qol },
            { type: 'paper', id: eff },
          ],
        },
      ]),
    ];
    const digest = {
      sites: [
        {
          disease_site: 'prostate',
          studies: [
            { slug: 'jama', name: 'NRG-GU005', source_ids: [{ type: 'paper' as const, id: now }] },
          ],
        },
      ],
    };

    const merged = findMergedPriors(db2, '2026-08-14', digest, priors);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.slug).toBe('nrg-gu005');
    expect(merged[0]!.facets).toEqual(['primary-efficacy', 'quality-of-life']);

    // ...and lineage takes NO action on it, so the QoL reading survives.
    expect(planLineage(db2, '2026-08-14', digest, priors)).toEqual([]);
  });

  it('does not report a merged card belonging to a different trial', () => {
    const qol = seed('10.1000/qol', 'QoL from NRG-GU005', 'quality-of-life');
    const eff = seed('10.1000/eff', 'Co-primary from NRG-GU005', 'primary-efficacy');
    const other = savePaper(db2, {
      doi: '10.1000/pace',
      title: 'PACE-B',
      bookmark_date: '2026-08-14',
    });
    saveSourceFacet(db2, 'paper', other.id, {
      facet: 'primary-efficacy',
      maturity: 'full-publication',
      followup_months: null,
      trial_acronyms: ['PACE-B'],
    });
    const priors = [
      artifact('2026-07-08', [
        {
          slug: 'nrg-gu005',
          name: 'NRG-GU005',
          source_ids: [
            { type: 'paper', id: qol },
            { type: 'paper', id: eff },
          ],
        },
      ]),
    ];
    const digest = {
      sites: [
        {
          disease_site: 'prostate',
          studies: [
            { slug: 'pace', name: 'PACE-B', source_ids: [{ type: 'paper' as const, id: other.id }] },
          ],
        },
      ],
    };
    expect(findMergedPriors(db2, '2026-08-14', digest, priors)).toEqual([]);
  });
});

// The aggregate guards. Each of these was a live hole: the per-card empty-day
// check, the acronym-only auto-suppress, and treating partial classification as
// certainty all approved a destructive action they should have refused.
describe('lineage-pass destructive guards', () => {
  let db3: ReturnType<typeof openDb>;
  beforeEach(() => {
    db3 = openDb(':memory:');
  });

  const seed = (
    doi: string,
    title: string,
    o: { facet?: string | null; maturity?: string; date?: string; abstract?: string } = {},
  ): number => {
    const r = savePaper(db3, {
      doi,
      title,
      abstract: o.abstract ?? null,
      bookmark_date: o.date ?? '2026-07-08',
    });
    if (o.facet !== null) {
      saveSourceFacet(db3, 'paper', r.id, {
        facet: o.facet ?? 'primary-efficacy',
        maturity: o.maturity ?? 'conference-abstract',
        followup_months: 24,
        trial_acronyms: [],
      });
    }
    return r.id;
  };

  const digestOf = (studies: Record<string, unknown>[]) =>
    ({ sites: [{ disease_site: 'prostate', studies }] }) as unknown as {
      sites: { disease_site?: string | null; studies: LineageStudy[] }[];
    };

  it('REFUSES to empty a date when TWO of its cards are superseded in one build', () => {
    // Each check alone sees one survivor; together they take the date to zero.
    const pa = seed('10.1000/pa', 'TRIALA', { abstract: 'NCT00000001' });
    const pb = seed('10.1000/pb', 'TRIALB', { abstract: 'NCT00000002' });
    const ca = seed('10.1000/ca', 'TRIALA', { date: '2026-08-14', maturity: 'full-publication', abstract: 'NCT00000001' });
    const cb = seed('10.1000/cb', 'TRIALB', { date: '2026-08-14', maturity: 'full-publication', abstract: 'NCT00000002' });

    const priors = [
      artifact('2026-07-08', [
        { slug: 'a', name: 'TRIALA', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper', id: pa }] },
        { slug: 'b', name: 'TRIALB', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper', id: pb }] },
      ]),
    ];
    const digest = digestOf([
      { slug: 'a2', name: 'TRIALA', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper' as const, id: ca }] },
      { slug: 'b2', name: 'TRIALB', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper' as const, id: cb }] },
    ]);

    const actions = planLineage(db3, '2026-08-14', digest, priors, new Map(), true);
    const suppressed = actions.filter((a) => a.suppress).length;
    expect(suppressed).toBe(1); // the second is refused
    expect(actions.some((a) => (a.declined ?? '').includes('last surviving study'))).toBe(true);
  });

  it('counts a date’s EXISTING override toward the empty-day guard', () => {
    const pa = seed('10.1000/pa', 'TRIALA', { abstract: 'NCT00000001' });
    const ca = seed('10.1000/ca', 'TRIALA', { date: '2026-08-14', maturity: 'full-publication', abstract: 'NCT00000001' });
    const priors = [
      artifact('2026-07-08', [
        { slug: 'a', name: 'TRIALA', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper', id: pa }] },
        { slug: 'already-hidden', name: 'OTHER', source_ids: [] },
      ]),
    ];
    const digest = digestOf([{ slug: 'a2', name: 'TRIALA', primary_endpoint: { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null }, source_ids: [{ type: 'paper' as const, id: ca }] }]);

    // Without the existing override this would be allowed (1 survivor).
    const permissive = planLineage(db3, '2026-08-14', digest, priors, new Map(), true);
    expect(permissive[0]!.suppress).not.toBeNull();

    const withOverride = planLineage(
      db3,
      '2026-08-14',
      digest,
      priors,
      new Map([['2026-07-08', ['already-hidden']]]),
      true,
    );
    expect(withOverride[0]!.suppress).toBeNull();
    expect(withOverride[0]!.declined).toMatch(/last surviving study/);
  });

  it('does NOT auto-suppress on acronym-only identity, and says why', () => {
    const pa = seed('10.1000/pa', 'PRIME'); // no NCT anywhere
    const ca = seed('10.1000/ca', 'PRIME', { date: '2026-08-14', maturity: 'full-publication' });
    // Named endpoints on both sides, so identity is genuinely the SOLE gap —
    // otherwise the honest primary blocker is the missing endpoint, not identity.
    const EP = { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null };
    const priors = [
      artifact('2026-07-08', [
        { slug: 'a', name: 'PRIME', primary_endpoint: EP, source_ids: [{ type: 'paper', id: pa }] },
        { slug: 'keep', name: 'OTHER', source_ids: [] },
      ]),
    ];
    const digest = digestOf([
      { slug: 'a2', name: 'PRIME', primary_endpoint: EP, source_ids: [{ type: 'paper' as const, id: ca }] },
    ]);
    const actions = planLineage(db3, '2026-08-14', digest, priors, new Map(), true);
    expect(actions[0]!.verdict.kind).toBe('update');
    expect(actions[0]!.suppress).toBeNull();
    expect(actions[0]!.declined).toMatch(/no shared registration/);
  });

  it('treats a partially-classified card as UNKNOWN, not as its classified source', () => {
    // One classified efficacy source beside an UNCLASSIFIED one used to read as
    // an unambiguous efficacy card, making the whole merged card suppressible.
    const classified = seed('10.1000/x', 'TRIALA');
    const unclassified = seed('10.1000/y', 'TRIALA-QOL', { facet: null });
    const facts = sourceFacts(db3, [
      { type: 'paper', id: classified },
      { type: 'paper', id: unclassified },
    ]);
    expect(facts.facet).toBeNull();
    expect(facts.unclassifiedSources).toBe(1);
  });
});

// Round three: a facet is coarser than an endpoint. OS, DFS, PFS and local
// control all classify as `primary-efficacy`, so a card merged from an OS paper
// and a DFS paper passes unanimity — and the endpoint check is card-level, so a
// later OS publication matched it and would have removed the DFS finding too.
describe('a multi-paper prior is never auto-suppressed', () => {
  const digestOf = (studies: Record<string, unknown>[]) =>
    ({ sites: [{ disease_site: 'prostate', studies }] }) as unknown as {
      sites: { disease_site?: string | null; studies: LineageStudy[] }[];
    };
  let db4: ReturnType<typeof openDb>;
  beforeEach(() => {
    db4 = openDb(':memory:');
  });

  const paper = (doi: string, title: string, date = '2026-07-08'): number => {
    const r = savePaper(db4, { doi, title, abstract: 'NCT00000001', bookmark_date: date });
    saveSourceFacet(db4, 'paper', r.id, {
      facet: 'primary-efficacy',
      maturity: date === '2026-07-08' ? 'conference-abstract' : 'full-publication',
      followup_months: 24,
      trial_acronyms: [],
    });
    return r.id;
  };
  const EP = { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null };

  it('declines when the prior card was built from two papers', () => {
    const os = paper('10.1000/os', 'TRIALX overall survival');
    const dfs = paper('10.1000/dfs', 'TRIALX disease-free survival');
    const now = paper('10.1000/jama', 'TRIALX full report', '2026-08-14');

    const priors = [
      artifact('2026-07-08', [
        { slug: 'merged', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper', id: os }, { type: 'paper', id: dfs }] },
        { slug: 'keep', name: 'OTHER', source_ids: [] },
      ]),
    ];
    const digest = digestOf([
      { slug: 'new', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper' as const, id: now }] },
    ]);

    const actions = planLineage(db4, '2026-08-14', digest, priors, new Map(), true);
    expect(actions[0]!.verdict.kind).toBe('update');
    expect(actions[0]!.suppress).toBeNull();
    expect(actions[0]!.declined).toMatch(/prior card \(2 sources\) merges multiple sources/);
  });

  it('still allows a single-paper prior with a tweet alongside it', () => {
    // One result told twice is the common legitimate shape and must keep working.
    const p = paper('10.1000/abs', 'TRIALX abstract');
    const now = paper('10.1000/jama', 'TRIALX full report', '2026-08-14');
    const priors = [
      artifact('2026-07-08', [
        { slug: 'one', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper', id: p }, { type: 'slide', id: 9 }] },
        { slug: 'keep', name: 'OTHER', source_ids: [] },
      ]),
    ];
    const digest = digestOf([
      { slug: 'new', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper' as const, id: now }] },
    ]);
    const actions = planLineage(db4, '2026-08-14', digest, priors, new Map(), true);
    expect(actions[0]!.suppress).not.toBeNull();
  });
});

// Round four: the veto must cover BOTH sides. Counting only the prior left the
// mirror hole — a current card assembled from two papers can borrow
// full-publication or a longer follow-up from its DFS paper while its
// card-level endpoint reads OS, then supersede the prior OS card.
describe('an ambiguous CURRENT card is also never allowed to suppress', () => {
  let db5: ReturnType<typeof openDb>;
  beforeEach(() => {
    db5 = openDb(':memory:');
  });
  const EP = { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null };
  const mk = (doi: string, date: string, maturity: string): number => {
    const r = savePaper(db5, { doi, title: 'TRIALX', abstract: 'NCT00000001', bookmark_date: date });
    saveSourceFacet(db5, 'paper', r.id, {
      facet: 'primary-efficacy', maturity, followup_months: 24, trial_acronyms: [],
    });
    return r.id;
  };

  it('declines when the NEW card merges two papers', () => {
    const prior = mk('10.1000/p', '2026-07-08', 'conference-abstract');
    const a = mk('10.1000/a', '2026-08-14', 'full-publication');
    const b = mk('10.1000/b', '2026-08-14', 'full-publication');
    const priors = [
      artifact('2026-07-08', [
        { slug: 'old', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper', id: prior }] },
        { slug: 'keep', name: 'OTHER', source_ids: [] },
      ]),
    ];
    const digest = {
      sites: [{ disease_site: 'prostate', studies: [
        { slug: 'new', name: 'TRIALX', primary_endpoint: EP,
          source_ids: [{ type: 'paper' as const, id: a }, { type: 'paper' as const, id: b }] },
      ] }],
    } as unknown as { sites: { disease_site?: string | null; studies: LineageStudy[] }[] };
    const actions = planLineage(db5, '2026-08-14', digest, priors, new Map(), true);
    expect(actions[0]!.suppress).toBeNull();
    expect(actions[0]!.declined).toMatch(/new card \(2 sources\)/);
  });
});

// Default-off policy. The evidence gate and the permission to act on it are now
// separate questions, so a policy hold can offer the curator a one-reply drop
// while an evidence refusal never can.
describe('auto-suppress is default OFF', () => {
  let db6: ReturnType<typeof openDb>;
  beforeEach(() => {
    db6 = openDb(':memory:');
  });
  const EP = { name: 'Overall survival', stat_value: 'HR 0.62', stat_detail: null };
  const mk = (doi: string, date: string, maturity: string): number => {
    const r = savePaper(db6, { doi, title: 'TRIALX', abstract: 'NCT00000001', bookmark_date: date });
    saveSourceFacet(db6, 'paper', r.id, {
      facet: 'primary-efficacy', maturity, followup_months: 24, trial_acronyms: [],
    });
    return r.id;
  };
  const fixture = () => {
    const prior = mk('10.1000/p', '2026-07-08', 'conference-abstract');
    const now = mk('10.1000/n', '2026-08-14', 'full-publication');
    return {
      priors: [
        artifact('2026-07-08', [
          { slug: 'old', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper', id: prior }] },
          { slug: 'keep', name: 'OTHER', source_ids: [] },
        ]),
      ],
      digest: {
        sites: [{ disease_site: 'prostate', studies: [
          { slug: 'new', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper' as const, id: now }] },
        ] }],
      } as unknown as { sites: { disease_site?: string | null; studies: LineageStudy[] }[] },
    };
  };

  it('detects and links but never unpublishes by default', () => {
    const { priors, digest } = fixture();
    const actions = planLineage(db6, '2026-08-14', digest, priors);
    expect(actions[0]!.verdict.kind).toBe('update');
    expect(actions[0]!.gateAuthorized).toBe(true); // the evidence WAS sufficient
    expect(actions[0]!.suppress).toBeNull(); // policy withheld the action
    expect(actions[0]!.declined).toMatch(/auto-suppress disabled/);
  });

  it('acts when the flag is explicitly on', () => {
    const { priors, digest } = fixture();
    const actions = planLineage(db6, '2026-08-14', digest, priors, new Map(), true);
    expect(actions[0]!.suppress).not.toBeNull();
    expect(actions[0]!.declined).toBeNull();
  });

  it('an EVIDENCE refusal stays refused even with the flag on', () => {
    // The flag grants permission, never evidence. A maturity regression is not
    // something a policy switch can authorize.
    const prior = mk('10.1000/p2', '2026-07-08', 'full-publication');
    const now = mk('10.1000/n2', '2026-08-14', 'conference-abstract');
    const priors = [
      artifact('2026-07-08', [
        { slug: 'old', name: 'TRIALX', primary_endpoint: EP, source_ids: [{ type: 'paper', id: prior }] },
        { slug: 'keep', name: 'OTHER', source_ids: [] },
      ]),
    ];
    const digest = {
      sites: [{ disease_site: 'prostate', studies: [
        { slug: 'new', name: 'TRIALX',
          primary_endpoint: { ...EP, stat_value: '0.62' },
          source_ids: [{ type: 'paper' as const, id: now }] },
      ] }],
    } as unknown as { sites: { disease_site?: string | null; studies: LineageStudy[] }[] };

    const actions = planLineage(db6, '2026-08-14', digest, priors, new Map(), true);
    expect(actions[0]!.gateAuthorized).toBe(false);
    expect(actions[0]!.suppress).toBeNull();
    expect(actions[0]!.declined).toMatch(/maturity regressed/);
  });
});
