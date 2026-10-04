import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseContentType,
  isNonStudyContent,
  parsePresentation,
  groundPresentation,
  speakerGrounded,
  scrubSpeakerName,
  speakerNameRemains,
  stripReviewVerdicts,
  enforcePresentationInvariants,
} from '../src/lib/content-type.ts';
import {
  buildDigest,
  parseGroupingResponse,
  parseStudyAgentResponse,
  sourceNumberCheck,
  FIRST_PERSON_TALK,
} from '../src/lib/llm-pipeline.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';
import { isMediaArchiveEnabled, isImageBytes } from '../src/lib/tweet-media-archive.ts';
import { buildAcronymCoverageIndex } from '../src/lib/acronym-coverage.ts';
import { groundedTrialNames } from '../src/lib/comparator-grounding.ts';
import { withholdUngroundedComparators, droppedDiseaseStates } from '../src/lib/comparator-grounding.ts';
import { railEmojiForStudy, PRESENTATION_GLYPH } from '../src/lib/verdict.ts';
import { findCrossDateDuplicates, suppressionSuggestions } from '../src/lib/study-dedup.ts';
import { archivedMediaPath, archiveTweetImages, isGitIgnored } from '../src/lib/tweet-media-archive.ts';
import { renderObsidian, type DigestArtifactForExport } from '../src/lib/obsidian-export.ts';

// v0.59: content_type:presentation — a speaker's talk (slides shared on X).

const SLIDE = 'https://pbs.twimg.com/media/HTtkLdWXwAAEC-X.jpg';

describe('presentation content type', () => {
  it('parses presentation and the words a model uses for a talk', () => {
    expect(parseContentType('presentation')).toBe('presentation');
    expect(parseContentType('Talk')).toBe('presentation');
    expect(parseContentType('slides')).toBe('presentation');
  });

  it('isNonStudyContent covers review and presentation only', () => {
    expect(isNonStudyContent('review')).toBe(true);
    expect(isNonStudyContent('presentation')).toBe(true);
    expect(isNonStudyContent('study_report')).toBe(false);
    expect(isNonStudyContent(undefined)).toBe(false);
  });

  it('strips a presentation verdict post-override, like a review', () => {
    const digest = {
      sites: [
        {
          studies: [
            { content_type: 'presentation' as const, verdict: { soc_implication: 'confirmatory' } as unknown },
            { verdict: { soc_implication: 'confirmatory' } as unknown },
          ],
        },
      ],
    };
    expect(stripReviewVerdicts(digest)).toBe(1);
    expect(digest.sites[0]!.studies[0]!.verdict).toBeUndefined();
    expect(digest.sites[0]!.studies[1]!.verdict).toBeDefined();
  });
});

describe('parsePresentation', () => {
  const summary =
    'Both TARE and SBRT deliver ablative dose to HCC; the talk frames the choice by tumor size, vascular invasion and liver reserve.';

  it('keeps a well-formed block', () => {
    const p = parsePresentation({
      speaker: 'Nina Niu Sanford',
      summary,
      critique: ['The framework rests on retrospective single-institution series with referral bias.'],
    });
    expect(p).toEqual({
      speaker: 'Nina Niu Sanford',
      summary,
      critique: ['The framework rests on retrospective single-institution series with referral bias.'],
    });
  });

  it('drops too-short critique points, dedupes, caps at four', () => {
    const point = (i: number) => `Critique point number ${'x'.repeat(i)} about evidence level.`;
    const p = parsePresentation({
      summary,
      critique: ['short', point(1), point(1).toUpperCase(), point(2), point(3), point(4), point(5)],
    });
    expect(p!.critique).toHaveLength(4);
    expect(p!.critique[0]).toBe(point(1));
  });

  it('abstains when nothing renderable survives', () => {
    expect(parsePresentation(null)).toBeNull();
    expect(parsePresentation([])).toBeNull();
    expect(parsePresentation({ speaker: 'X', summary: 'too short', critique: [] })).toBeNull();
  });
});

describe('groundPresentation', () => {
  const src =
    '@NiuSanford Dr. Nina Niu Sanford\nBoth TARE & SBRT can deliver ablative RT in HCC.\nLC 2y 84% vs 71%, HR .65 (0.48-0.79)\nn=84 patients';
  // The production number check, built from the same source text.
  const check = sourceNumberCheck([{ id: 1, author: null, text: src }]);
  const ground = (p: Parameters<typeof groundPresentation>[0]) => groundPresentation(p, src, check);
  const filler = 'A summary that carries no numbers or names of any kind at all.';

  it('keeps a speaker the sources print, honorific or not', () => {
    expect(ground({ speaker: 'Dr. Nina Niu Sanford', summary: filler, critique: [] }).presentation!.speaker).toBe(
      'Dr. Nina Niu Sanford',
    );
    expect(ground({ speaker: 'Nina Niu Sanford', summary: filler, critique: [] }).presentation!.speaker).toBe(
      'Nina Niu Sanford',
    );
    // An honorific the source never prints is not part of the name.
    expect(ground({ speaker: 'Prof Nina Niu Sanford', summary: filler, critique: [] }).presentation!.speaker).toBe(
      'Prof Nina Niu Sanford',
    );
  });

  it('withholds a speaker the sources never name, a substring match, or a bare surname', () => {
    const r = ground({ speaker: 'Eileen O’Reilly', summary: filler, critique: [] });
    expect(r.presentation!.speaker).toBeNull();
    expect(r.withheld[0]).toMatch(/speaker/);
    // "Ana" inside "analysis" is not a name match.
    expect(speakerGrounded('Ana Lys', 'Survival analysis of SBRT')).toBe(false);
    // One token is never enough on its own.
    expect(speakerGrounded('Sanford', src)).toBe(false);
    expect(speakerGrounded('Dr.', src)).toBe(false);
  });

  it('scrubs a rejected speaker from the prose instead of publishing the name', () => {
    const r = ground({
      speaker: 'Jane Roe',
      summary: 'Jane Roe argues that the two modalities are complementary options.',
      critique: ["Dr. Roe's framework rests on retrospective series throughout."],
    });
    expect(r.presentation!.speaker).toBeNull();
    expect(r.presentation!.summary).toBe('The speaker argues that the two modalities are complementary options.');
    expect(r.presentation!.critique).toEqual(["The speaker's framework rests on retrospective series throughout."]);
  });

  it('a possessive elsewhere in the text does not leak into the replacement', () => {
    expect(scrubSpeakerName('Jane Roe argues for SBRT. The trial’s design is weak.', 'Jane Roe')).toBe(
      'The speaker argues for SBRT. The trial’s design is weak.',
    );
  });

  it('speakerNameRemains catches case, accent and single-token survivors', () => {
    expect(speakerNameRemains(['JANE ROE argues'], 'Jane Roe')).toBe(true);
    expect(speakerNameRemains(['Jose Garcia argues'], 'José García')).toBe(true);
    expect(speakerNameRemains(['Sanford recommends SBRT'], 'Sanford')).toBe(true);
    expect(speakerNameRemains(['The speaker recommends SBRT'], 'Jane Roe, MD')).toBe(false);
  });

  it('a decimal-comma source percentage does not ground a tenfold claim', () => {
    const c = sourceNumberCheck([{ id: 1, author: null, text: 'Toxicity 0,5%.' }]);
    const r = groundPresentation({ speaker: null, summary: 'The speaker reports toxicity of 5% with this treatment.', critique: [] }, 'Toxicity 0,5%.', c);
    expect(r.presentation).toBeNull();
  });

  it('scrubbing matches the name as a name, not token by token', () => {
    expect(scrubSpeakerName('Low-risk disease was excluded; Daniel Low disagrees.', 'Daniel Low')).toBe(
      'Low-risk disease was excluded; the speaker disagrees.',
    );
    expect(scrubSpeakerName('Brian I. Rini will present next.', 'Brian Rini')).toBe('The speaker will present next.');
    expect(scrubSpeakerName('Jane went to see the ROE trial.', 'Jane Roe')).toBe('Jane went to see the ROE trial.');
  });

  it('speaker matching folds possessives, initials, accents and apostrophes', () => {
    expect(speakerGrounded('Jane Roe', 'Jane Roe’s slides from today')).toBe(true);
    expect(speakerGrounded('Brian Rini', 'Brian I. Rini, MD')).toBe(true);
    expect(speakerGrounded('Jose Garcia', 'José García presenting')).toBe(true);
    expect(speakerGrounded("Pat O'Brien", 'Pat O’Brien presenting')).toBe(true);
  });

  it('withholds the one critique point carrying an unsourced number', () => {
    const { presentation, withheld } = ground({
      speaker: null,
      summary: 'Local control was 84% vs 71% at two years across the cited series.',
      critique: [
        'Randomized head-to-head data do not exist; the comparison is across selected cohorts.',
        'A competing series reported 92% local control, which the talk omits.',
      ],
    });
    expect(presentation!.summary).toContain('84%');
    expect(presentation!.critique).toHaveLength(1);
    expect(withheld).toEqual(['critique[1]: "92" not in sources']);
  });

  it('holds leading decimals and CI bounds to the source (HR .65 is not HR 65)', () => {
    expect(check('HR 0.65 favored SBRT')).toBeNull();
    expect(check('HR 65 favored SBRT')).toBe('65');
    expect(check('CI 0.48-0.79')).toBeNull();
    // Both bounds exist in the source, but never as one interval.
    expect(check('CI 0.65-0.79')).not.toBeNull();
  });

  it('a count in the source does not ground a percentage', () => {
    const r = ground({ speaker: null, summary: 'Local control reached 84% in the cited cohort overall.', critique: [] });
    expect(r.presentation!.summary).toContain('84%'); // "84%" IS in the source
    // A source with "84 patients" and no 84%: every percent spelling fails.
    const countOnly = 'n=84 patients treated';
    const c = sourceNumberCheck([{ id: 1, author: null, text: countOnly }]);
    for (const claim of ['Control near 84 percent in one cohort.', 'Control near 84% in one cohort.', 'An 84 percentage-point gain with no comparator.']) {
      expect(groundPresentation({ speaker: null, summary: claim + ' More words to pass the minimum.', critique: [] }, countOnly, c).presentation).toBeNull();
    }
  });

  it('the speaker must be a contiguous name, not scattered tokens', () => {
    expect(speakerGrounded('Mark Lee', 'Lee et al. mark the threshold')).toBe(false);
    expect(speakerGrounded('Mark Lee', 'Talk by Mark Lee at ASTRO')).toBe(true);
  });

  it('relative magnitudes in words are numbers; "third-line" is not', () => {
    const r = ground({
      speaker: null,
      summary: filler,
      critique: [
        'The talk implies SBRT halved toxicity, which no slide shows.',
        'A threefold gain in control is asserted without data.',
        'Third-line patients are outside the framework entirely.',
      ],
    });
    expect(r.presentation!.critique).toEqual(['Third-line patients are outside the framework entirely.']);
  });

  it('a spelled-out magnitude is rejected even when the word is in the source', () => {
    const c = sourceNumberCheck([{ id: 1, author: null, text: 'one hundred patients enrolled' }]);
    const r = groundPresentation(
      { speaker: null, summary: filler, critique: ['The talk extrapolates to nine hundred patients without data.'] },
      'one hundred patients enrolled',
      c,
    );
    expect(r.presentation!.critique).toEqual([]);
  });

  it('leading-decimal percentages match their zero-prefixed spelling', () => {
    const c = sourceNumberCheck([{ id: 1, author: null, text: 'grade 3 toxicity 0.5% overall' }]);
    for (const prose of ['Grade 3 toxicity was .5% overall in the series.', 'Grade 3 toxicity was 0.5% overall in the series.']) {
      const r = groundPresentation({ speaker: null, summary: prose, critique: [] }, 'grade 3 toxicity 0.5% overall', c);
      expect(r.presentation?.summary).toBe(prose);
    }
    const bad = groundPresentation(
      { speaker: null, summary: 'Grade 3 toxicity was 5% overall in the series.', critique: [] },
      'grade 3 toxicity 0.5% overall',
      c,
    );
    expect(bad.presentation).toBeNull();
  });

  it('fractions, frequencies and percentiles do not dodge the gate', () => {
    const r = ground({
      speaker: null,
      summary: filler,
      critique: [
        'The talk implies SBRT cuts toxicity in half without data.',
        'One in ten patients is said to develop liver failure.',
        'A third of patients are said to need retreatment later.',
        'The talk weighs two modalities without randomized comparison between them.',
      ],
    });
    expect(r.presentation!.critique).toEqual(['The talk weighs two modalities without randomized comparison between them.']);
    // Terms, regimens and digit counts are not spelled magnitudes (measured
    // against the corpus: these phrasings are routine in real cards).
    const terms = ground({
      speaker: null,
      summary: filler,
      critique: [
        'No double-blind trial informs the twice-daily or half-life claims.',
        'Twice daily fractionation is assumed rather than compared.',
        'The other half of the question, toxicity, is not addressed.',
        'The percentage of patients with portal-vein invasion is not reported.',
      ],
    });
    expect(terms.presentation!.critique).toHaveLength(4);
    const c = sourceNumberCheck([{ id: 1, author: null, text: 'score at the 84 percentile' }]);
    const pct = groundPresentation({ speaker: null, summary: 'Local control reached 84% in the cited cohort overall.', critique: [] }, 'score at the 84 percentile', c);
    expect(pct.presentation).toBeNull();
  });

  it('a magnitude written in words does not dodge the gate', () => {
    const r = ground({
      speaker: null,
      summary: filler,
      critique: [
        'One series claims ninety-nine percent local control, unverified here.',
        'The talk weighs two modalities without randomized comparison between them.',
      ],
    });
    expect(r.presentation!.critique).toEqual([
      'The talk weighs two modalities without randomized comparison between them.',
    ]);
  });

  it('returns null when neither summary nor critique survives', () => {
    expect(ground({ speaker: null, summary: 'Control reached 99% in the speaker’s own series.', critique: [] }).presentation).toBeNull();
  });
});

describe('parsePresentation length bounds', () => {
  it('cuts an over-long summary at a sentence boundary, never mid-number', () => {
    const sentence = 'The talk argues the case with care and some nuance here. ';
    const long = sentence.repeat(16) + 'Local control reached HR 0.53 in the cited series overall.';
    const p = parsePresentation({ summary: long, critique: [] })!;
    expect(p.summary!.endsWith('.')).toBe(true);
    expect(p.summary).not.toMatch(/HR 0\.5$/);
    expect(parsePresentation({ summary: 'x'.repeat(1000), critique: ['A critique point of ordinary length here.'] })!.summary).toBeNull();
  });

  it('drops an oversize critique point, nulls an oversize speaker', () => {
    const p = parsePresentation({
      speaker: 'x'.repeat(81),
      summary: 'A summary of ordinary length that says nothing numeric.',
      critique: ['y'.repeat(321), 'A critique point of ordinary length about evidence.'],
    })!;
    expect(p.critique).toEqual(['A critique point of ordinary length about evidence.']);
    expect(p.speaker).toBeNull();
  });
});

describe('enforcePresentationInvariants (post-override)', () => {
  it('clears single-result fields an override put back on a presentation, leaves others alone', () => {
    const digest = {
      sites: [
        {
          studies: [
            {
              content_type: 'presentation' as const,
              nct: 'NCT04567890',
              doi: '10.1/x',
              primary_endpoint: { name: 'OS' },
              consort: { randomized: 1 },
              methodology: 'consensus-guideline',
            },
            { nct: 'NCT04567890', methodology: 'phase-3-rct' },
          ],
        },
      ],
    };
    expect(enforcePresentationInvariants(digest)).toBe(1);
    const [pres, report] = digest.sites[0]!.studies as Array<Record<string, unknown>>;
    expect(pres).toMatchObject({ nct: null, doi: null, primary_endpoint: null, consort: null, methodology: null });
    expect(report).toMatchObject({ nct: 'NCT04567890', methodology: 'phase-3-rct' });
  });
});

describe('buildDigest grounds a presentation end to end', () => {
  const run = async (text: string, extra: Record<string, unknown> = {}) => {
    const responses = [
      JSON.stringify({
        studies: [{ slug: 'tare-sbrt', name: 'TARE vs SBRT', disease_site: 'other', content_type: 'presentation', tweet_ids: [1] }],
      }),
      JSON.stringify({
        name: 'TARE vs SBRT',
        tldr: 'Both deliver ablative dose; pick by tumor and liver factors.',
        details: ['Phenotype should determine modality'],
        presentation: {
          speaker: 'Nina Niu Sanford',
          summary: 'The speaker frames TARE and SBRT as complementary ablative options for HCC.',
          critique: ['No randomized comparison between the two modalities is shown.'],
        },
        ...extra,
      }),
      JSON.stringify({ top_line: 'TARE vs SBRT', tldr: 'Talk.', site_meta: [{ disease_site: 'other', intro: null, open_questions: null }] }),
    ];
    const client: LlmClient = { complete: vi.fn(async () => responses.shift()!) };
    const out = await buildDigest(
      [{ id: 1, author: '@NiuSanford', author_name: 'Dr. Nina Niu Sanford', text, image_urls: [] }],
      { conferenceName: '', conferenceDay: '', client },
    );
    return out.sites[0]!.studies[0]!;
  };

  it('a rejected speaker is scrubbed from the TL;DR and bullets, not only the block', async () => {
    const s = await run('Great session on TARE vs SBRT in HCC this morning', {
      tldr: 'Nina Niu Sanford recommends phenotype-driven selection between TARE and SBRT.',
      details: ['Dr. Sanford favors SBRT for anticoagulated patients'],
    });
    expect(s.presentation?.speaker ?? null).toBeNull();
    expect(s.tldr).toBe('The speaker recommends phenotype-driven selection between TARE and SBRT.');
    expect(s.details).toEqual(['The speaker favors SBRT for anticoagulated patients']);
  });

  it('the first-person cue is narrow', () => {
    expect(FIRST_PERSON_TALK.test('Sharing some of my slides below')).toBe(true);
    expect(FIRST_PERSON_TALK.test('I gave a talk on SBRT today')).toBe(true);
    expect(FIRST_PERSON_TALK.test('I gave up on TARE years ago')).toBe(false);
    expect(FIRST_PERSON_TALK.test('I spoke with Dr X about her talk')).toBe(false);
  });

  it('drops the card when a rejected speaker survives scrubbing, before synthesis sees it', async () => {
    const responses = [
      JSON.stringify({
        studies: [{ slug: 'tare-sbrt', name: 'TARE vs SBRT', disease_site: 'other', content_type: 'presentation', tweet_ids: [1] }],
      }),
      JSON.stringify({
        name: 'TARE vs SBRT',
        tldr: 'Sanford recommends phenotype-driven selection between TARE and SBRT.',
        details: ['Phenotype should determine modality'],
        presentation: {
          speaker: 'Sanford',
          summary: 'The speaker frames TARE and SBRT as complementary ablative options for HCC.',
          critique: ['No randomized comparison between the two modalities is shown.'],
        },
      }),
    ];
    const complete = vi.fn(async () => {
      if (responses.length === 0) throw new Error('synthesis must not run');
      return responses.shift()!;
    });
    await expect(
      buildDigest([{ id: 1, author: '@x', text: 'Great session on TARE vs SBRT', image_urls: [] }], {
        conferenceName: '',
        conferenceDay: '',
        client: { complete },
      }),
    ).rejects.toThrow(/All Phase 2 study agents failed/);
    // Phase 1 + Phase 2 only: the dropped card never reached synthesis.
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('does not credit a poster who only photographed someone else\'s talk', async () => {
    const s = await run('Great session on TARE vs SBRT in HCC this morning');
    expect(s.presentation!.speaker).toBeNull();
  });

  it('drops a cited trial the sources never print', async () => {
    const s = await run('Sharing my slides: TARE vs SBRT, BEACON-HCC allocation', {
      discussed_trials: ['BEACON-HCC', 'LEGACY'],
    });
    expect(s.discussed_trials).toEqual(['BEACON-HCC']);
  });

  it('withholds an unsourced critique number and keeps a speaker named only in the author metadata', async () => {
    const tweets = [
      {
        id: 1,
        author: '@NiuSanford',
        author_name: 'Dr. Nina Niu Sanford',
        text: 'Sharing some of my slides on TARE vs SBRT in HCC',
        image_urls: [] as string[],
      },
    ];
    const responses = [
      JSON.stringify({
        studies: [{ slug: 'tare-sbrt', name: 'TARE vs SBRT', disease_site: 'other', content_type: 'presentation', tweet_ids: [1] }],
      }),
      JSON.stringify({
        name: 'TARE vs SBRT',
        tldr: 'Both deliver ablative dose; pick by tumor and liver factors.',
        details: ['Phenotype should determine modality'],
        presentation: {
          speaker: 'Nina Niu Sanford',
          summary: 'The speaker frames TARE and SBRT as complementary ablative options for HCC.',
          critique: [
            'No randomized comparison between the two modalities is shown.',
            'A cited series reported 92% local control without a comparator arm.',
          ],
        },
      }),
      JSON.stringify({ top_line: 'TARE vs SBRT', tldr: 'Talk.', site_meta: [{ disease_site: 'other', intro: null, open_questions: null }] }),
    ];
    const client: LlmClient = { complete: vi.fn(async () => responses.shift()!) };
    const out = await buildDigest(tweets, { conferenceName: '', conferenceDay: '', client });
    const s = out.sites[0]!.studies[0]!;
    expect(s.content_type).toBe('presentation');
    expect(s.presentation!.speaker).toBe('Nina Niu Sanford');
    expect(s.presentation!.critique).toEqual(['No randomized comparison between the two modalities is shown.']);
  });
});

describe('Phase 1/2 parsing of a presentation', () => {
  const tweets = [{ id: 1, author: '@NiuSanford', text: 'Sharing some of my slides', image_urls: [SLIDE] }];

  it('Phase 1 records presentation on the cluster', () => {
    const raw = JSON.stringify({
      studies: [
        { slug: 'tare-vs-sbrt', name: 'TARE vs SBRT in HCC', disease_site: 'hepatobiliary', content_type: 'presentation', tweet_ids: [1] },
      ],
    });
    expect(parseGroupingResponse(raw, tweets)[0]!.content_type).toBe('presentation');
  });

  it('Phase 2 forces the single-result fields off and keeps the talk block', () => {
    const cluster = {
      slug: 'tare-vs-sbrt',
      name: 'TARE vs SBRT in HCC',
      disease_site: 'hepatobiliary',
      tweet_ids: [1],
      content_type: 'presentation' as const,
    };
    const raw = JSON.stringify({
      name: 'TARE vs SBRT in HCC',
      tldr: 'Both deliver ablative dose; choose by tumor size, vascular invasion and liver reserve.',
      details: ['Larger, multifocal tumors favor TARE'],
      nct: 'NCT04567890',
      doi: '10.1000/xyz123',
      verdict: { soc_implication: 'confirmatory', rationale: 'r', audience: null },
      primary_endpoint: { name: 'Local control', klass: 'local-control', stat_value: 'HR 0.5', stat_detail: null },
      consort: { randomized: 100, arms: [{ label: 'A', allocated: 50 }, { label: 'B', allocated: 50 }] },
      discussed_trials: ['STOP-HCC', 'RTOG 1112'],
      methodology: 'consensus-guideline',
      presentation: {
        speaker: 'Nina Niu Sanford',
        summary: 'The talk frames TARE and SBRT as complementary ablative options chosen by tumor and liver factors.',
        critique: ['The decision criteria come from retrospective series, not randomized comparison.'],
      },
    });
    const s = parseStudyAgentResponse(raw, cluster);
    expect(s.content_type).toBe('presentation');
    expect(s.nct).toBeNull();
    expect(s.doi).toBeNull();
    expect(s.verdict).toBeUndefined();
    expect(s.primary_endpoint).toBeNull();
    expect(s.consort).toBeNull();
    expect(s.methodology).toBeNull();
    expect(s.discussed_trials).toEqual(['STOP-HCC', 'RTOG 1112']);
    expect(s.presentation!.critique).toHaveLength(1);
  });

  it('a study report ignores a stray presentation object', () => {
    const cluster = { slug: 'x', name: 'X', disease_site: 'breast', tweet_ids: [1], content_type: 'study_report' as const };
    const raw = JSON.stringify({
      name: 'X',
      tldr: 'y',
      details: [],
      presentation: { summary: 'x'.repeat(60), critique: [] },
    });
    expect(parseStudyAgentResponse(raw, cluster).presentation).toBeUndefined();
  });
});

describe('comparator grounding covers the presentation block', () => {
  it('withholds a critique point attaching a number to an unsourced trial', () => {
    const study = {
      name: 'TARE vs SBRT',
      presentation: {
        summary: 'The talk weighs both modalities for HCC.',
        critique: [
          'Randomized comparison is absent from the evidence base.',
          'The talk omits LEGACY, which reported 88.3% response.',
        ],
      },
    };
    const out = withholdUngroundedComparators(study, 'TARE and SBRT for HCC slides');
    expect(out.map((o) => o.surface)).toEqual(['presentation.critique[1]']);
    expect(study.presentation.critique).toHaveLength(1);
  });

  it('withholds the summary and drops the whole block when nothing survives', () => {
    const study: { name: string; presentation?: { summary: string | null; critique: string[] } | null } = {
      name: 'Talk',
      presentation: {
        summary: 'The talk leans on LEGACY, which reported 88.3% response.',
        critique: ['Unlike EMERALD-X with 91.2% control, no comparator is shown.'],
      },
    };
    const out = withholdUngroundedComparators(study, 'TARE and SBRT slides');
    expect(out.map((o) => o.surface)).toEqual(['presentation.summary', 'presentation.critique[0]']);
    expect(study.presentation).toBeUndefined();
  });

  it('cited-trial names must appear as whole tokens in the source', () => {
    expect(groundedTrialNames(['NRG-GU005', 'STOP', 'LEGACY'], 'nrg gu005 enrolment was stopped early')).toEqual({
      kept: ['NRG-GU005'],
      dropped: ['STOP', 'LEGACY'],
    });
    // No separator between two letters: "HERA" does not ride on "her a".
    expect(groundedTrialNames(['HERA'], 'we gave her a dose').kept).toEqual([]);
    expect(groundedTrialNames(['NRG-GU005', 'PEACE-1'], 'NRG – GU005 and PEACE1').kept).toEqual(['NRG-GU005', 'PEACE-1']);
  });

  it('counts the presentation prose when checking for a dropped disease state', () => {
    const study = {
      name: 'Talk',
      presentation: { summary: 'Framework for mCRPC sequencing.', critique: [] },
    };
    expect(droppedDiseaseStates(study, 'slides on mCRPC')).toEqual([]);
  });
});

describe('surfaces that key on content type', () => {
  it('the rail shows the presentation glyph', () => {
    expect(railEmojiForStudy({ content_type: 'presentation' })).toBe(PRESENTATION_GLYPH);
  });

  it('a presentation never enters the acronym coverage index (no drop offer against cited trials)', () => {
    const idx = buildAcronymCoverageIndex([
      { date: '2026-10-01', digest: { sites: [{ studies: [{ name: 'STAMPEDE', slug: 'talk', content_type: 'presentation' }] }] } },
    ]);
    expect(idx.size).toBe(0);
  });

  it('find:dups never keeps a talk over the trial card, nor suppresses the trial for it', () => {
    const lines = suppressionSuggestions({
      matchKey: 'STOP-HCC',
      reason: 'shared-acronym',
      occurrences: [
        { date: '2026-09-01', slug: 'stop-hcc-results', name: 'STOP-HCC', nct: null, isReview: false },
        { date: '2026-10-01', slug: 'stop-hcc-talk', name: 'STOP-HCC', nct: null, isReview: true },
      ],
    });
    expect(lines.join('\n')).not.toMatch(/--suppress=stop-hcc-results/);
    expect(lines.join('\n')).toMatch(/no suppression/);
  });

  it('a presentation sharing an acronym with a study is flagged as intentional re-coverage', () => {
    const dups = findCrossDateDuplicates([
      { date: '2026-09-01', digest: { sites: [{ studies: [{ slug: 'a', name: 'STOP-HCC', nct: 'NCT01556490' }] }] } },
      {
        date: '2026-10-01',
        digest: {
          sites: [{ studies: [{ slug: 'b', name: 'STOP-HCC', nct: 'NCT01556490', content_type: 'presentation' }] }],
        },
      },
    ]);
    const occ = dups.flatMap((d) => d.occurrences).find((o) => o.slug === 'b');
    expect(occ?.isReview).toBe(true);
  });
});

describe('tweet media archive', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  // ssrfSafeFetchBuffer resolves DNS to refuse private hosts; tests stub it.
  const lookupImpl = async () => [{ address: '151.101.0.1' }];
  const withRoot = async (fn: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), 'oncbrain-media-'));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const fileFor = (root: string) => join(root, 'data/obsidian/media/tweets/2026-10-01/HTtkLdWXwAAEC-X.jpg');

  it('derives a vault path from the media key, including the query form', () => {
    expect(archivedMediaPath('2026-10-01', SLIDE)).toBe('media/tweets/2026-10-01/HTtkLdWXwAAEC-X.jpg');
    expect(archivedMediaPath('2026-10-01', 'https://pbs.twimg.com/media/HTtkLdWXwAAEC-X?format=png&name=large')).toBe(
      'media/tweets/2026-10-01/HTtkLdWXwAAEC-X.png',
    );
  });

  it('refuses unsafe hosts, bad dates and odd basenames', () => {
    expect(archivedMediaPath('2026-10-01', 'https://evil.example/a.jpg')).toBeNull();
    expect(archivedMediaPath('../x', SLIDE)).toBeNull();
    expect(archivedMediaPath('2026-10-01', 'https://pbs.twimg.com/media/..%2Fx.jpg')).toBeNull();
  });

  it('downloads the original once, then skips it', async () => {
    await withRoot(async (root) => {
      const calls: string[] = [];
      const fetchImpl = (async (u: string) => {
        calls.push(u);
        return new Response(JPEG);
      }) as unknown as typeof fetch;
      const opts = { fetchImpl, lookupImpl, root, skipIgnoreCheck: true };
      expect(await archiveTweetImages('2026-10-01', [SLIDE], opts)).toEqual({ saved: 1, existing: 0, skippedMiss: 0, failed: [] });
      expect(calls[0]).toContain('name=orig');
      expect([...readFileSync(fileFor(root))]).toEqual([...JPEG]);
      expect(await archiveTweetImages('2026-10-01', [SLIDE], opts)).toEqual({ saved: 0, existing: 1, skippedMiss: 0, failed: [] });
      expect(calls).toHaveLength(1);
    });
  });

  it('a 403 is retried, not recorded as gone', async () => {
    await withRoot(async (root) => {
      const fetchImpl = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
      await archiveTweetImages('2026-10-01', [SLIDE], { fetchImpl, lookupImpl, root, skipIgnoreCheck: true });
      expect(existsSync(fileFor(root) + '.miss')).toBe(false);
    });
  });

  it('records a permanent miss (404) and never refetches it', async () => {
    await withRoot(async (root) => {
      let n = 0;
      const fetchImpl = (async () => {
        n++;
        return new Response('gone', { status: 404 });
      }) as unknown as typeof fetch;
      const opts = { fetchImpl, lookupImpl, root, skipIgnoreCheck: true };
      const first = await archiveTweetImages('2026-10-01', [SLIDE], opts);
      expect(first.failed[0]).toMatch(/HTTP 404/);
      expect(existsSync(fileFor(root) + '.miss')).toBe(true);
      expect((await archiveTweetImages('2026-10-01', [SLIDE], opts)).skippedMiss).toBe(1);
      expect(n).toBe(1);
    });
    await withRoot(async (root) => {
      const fetchImpl = (async () => new Response('<html>')) as unknown as typeof fetch;
      const r = await archiveTweetImages('2026-10-01', [SLIDE], { fetchImpl, lookupImpl, root, skipIgnoreCheck: true });
      expect(r.failed[0]).toMatch(/not an image/);
      expect(existsSync(fileFor(root))).toBe(false);
      expect(existsSync(fileFor(root) + '.miss')).toBe(false);
    });
  });

  it('a transient failure is reported, leaves nothing behind, and is retried next time', async () => {
    await withRoot(async (root) => {
      const fetchImpl = (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch;
      const r = await archiveTweetImages('2026-10-01', [SLIDE], { fetchImpl, lookupImpl, root, skipIgnoreCheck: true });
      expect(r.failed[0]).toMatch(/boom/);
      expect(existsSync(fileFor(root))).toBe(false);
      expect(existsSync(fileFor(root) + '.miss')).toBe(false);
    });
  });

  it('rejects an oversize body without saving it', async () => {
    await withRoot(async (root) => {
      const fetchImpl = (async () =>
        new Response(JPEG, { headers: { 'content-length': String(16 * 1024 * 1024) } })) as unknown as typeof fetch;
      const r = await archiveTweetImages('2026-10-01', [SLIDE], { fetchImpl, lookupImpl, root, skipIgnoreCheck: true });
      expect(r.failed[0]).toMatch(/too large/);
      expect(existsSync(fileFor(root))).toBe(false);
    });
  });

  it('fails closed outside a checkout that ignores the media dir', async () => {
    await withRoot(async (root) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const r = await archiveTweetImages('2026-10-01', [SLIDE], { fetchImpl, lookupImpl, root });
      expect(r.failed[0]).toMatch(/not git-ignored/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('this repo ignores the media dir (the runtime check passes here)', () => {
    expect(isGitIgnored(process.cwd(), 'data/obsidian/media/tweets/2026-10-01/x.jpg')).toBe(true);
  });

  it('kill switch and magic-byte sniff', () => {
    expect(isMediaArchiveEnabled({})).toBe(true);
    expect(isMediaArchiveEnabled({ TWEET_MEDIA_ARCHIVE: 'OFF' })).toBe(false);
    expect(isMediaArchiveEnabled({ VITEST: 'true' })).toBe(false);
    expect(isImageBytes(Buffer.from(JPEG))).toBe(true);
    expect(isImageBytes(Buffer.from('<html>'))).toBe(false);
  });
});

describe('Obsidian export of a presentation', () => {
  const artifact: DigestArtifactForExport = {
    date: '2026-10-01',
    conference: null,
    generated_at: 1,
    digest: {
      top_line: 't',
      tldr: 't',
      sites: [
        {
          disease_site: 'hepatobiliary',
          intro: null,
          studies: [
            {
              name: 'TARE vs SBRT in HCC',
              tldr: 'Choose by tumor and liver factors.',
              details: [],
              nct: null,
              tweet_ids: [1],
              content_type: 'presentation',
              discussed_trials: ['STOP-HCC'],
              presentation: {
                speaker: 'Nina Niu Sanford',
                summary: 'Both deliver ablative dose.',
                critique: ['Evidence is retrospective.'],
              },
            },
          ],
          open_questions: null,
        },
      ],
    },
    bookmarks: [
      {
        id: 1,
        url: 'https://x.com/NiuSanford/status/2106387579650118109',
        author_handle: '@NiuSanford',
        author_name: 'Dr. Nina Niu Sanford',
        text: 'Sharing some of my slides',
        note: null,
        fetched_via: 'oembed',
        conference_slug: null,
        bookmark_date: '2026-10-01',
        image_urls: [SLIDE],
      },
    ],
  };

  it('renders the summary, the adversarial read, cited trials and the archived slides', () => {
    const md = renderObsidian(artifact);
    expect(md).toContain('> [!abstract] Presentation · Nina Niu Sanford');
    expect(md).toContain('> [!warning] Adversarial read');
    expect(md).toContain('> - Evidence is retrospective.');
    expect(md).toContain('**Trials cited:** STOP-HCC');
    expect(md).toContain('![[media/tweets/2026-10-01/HTtkLdWXwAAEC-X.jpg]]');
  });

  it('a study report with the same source embeds no archived slides and no presentation callouts', () => {
    const report = structuredClone(artifact);
    const st = report.digest.sites[0]!.studies[0]!;
    delete st.content_type;
    const md = renderObsidian(report);
    expect(md).not.toContain('![[media/tweets');
    expect(md).not.toContain('[!abstract] Presentation');
    expect(md).not.toContain('Trials cited');
  });

  it('a critique-only block renders the warning callout without the summary callout', () => {
    const critiqueOnly = structuredClone(artifact);
    critiqueOnly.digest.sites[0]!.studies[0]!.presentation = { speaker: null, summary: null, critique: ['Evidence is retrospective.'] };
    const md = renderObsidian(critiqueOnly);
    expect(md).not.toContain('[!abstract]');
    expect(md).toContain('> [!warning] Adversarial read');
  });
});
