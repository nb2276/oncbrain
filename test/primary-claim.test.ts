// v0.62.3: "1° EP" / "primary endpoint" only when the sources say which
// endpoint was primary. Cases are lifted from published cards.
import { describe, it, expect } from 'vitest';
import { sourceStatesPrimary, stripPrimaryLabels, stripUngroundedPrimaryClaims } from '../src/lib/primary-claim.ts';

describe('sourceStatesPrimary', () => {
  it('recognises the ways a source names its primary', () => {
    for (const s of [
      'The primary endpoint was rPFS.',
      'Primary Endpoint:\nCognitive Failure Free Survival',
      'co-primary endpoints of PFS and OS',
      'The primary end point was met',
      'primary objective: acute toxicity',
    ]) expect(sourceStatesPrimary(s), s).toBe(true);
  });
  it('does not take an unrelated "primary" as an endpoint statement', () => {
    for (const s of ['primary tumour volume', 'primary RT to the prostate', 'median rPFS NR vs 22.4mo. HR 0.55'])
      expect(sourceStatesPrimary(s), s).toBe(false);
  });
});

describe('stripPrimaryLabels', () => {
  it('drops the label and keeps the content', () => {
    expect(stripPrimaryLabels('📊 1° EP imaging-based rPFS: median NC vs 45.8mo')).toBe('📊 imaging-based rPFS: median NC vs 45.8mo');
    expect(stripPrimaryLabels('📊 1° EP: rPFS HR 0.55')).toBe('📊 rPFS HR 0.55');
    expect(stripPrimaryLabels('Original primary endpoint was 3-yr PFS.')).toBe('Original endpoint was 3-yr PFS.');
    expect(stripPrimaryLabels('**Primary:** acute toxicity by T-score')).toBe('acute toxicity by T-score');
    expect(stripPrimaryLabels('Primary outcome: distant metastasis')).toBe('Outcome: distant metastasis');
  });
  it('leaves an honest hedge alone (stripping it would say something false)', () => {
    for (const s of [
      'No primary endpoint stated in source.',
      'None of these was the trial\'s registered primary endpoint.',
      'The source does not state whether this was the prespecified primary endpoint.',
    ]) expect(stripPrimaryLabels(s)).toBe(s);
  });
  it('round-trips text with no label byte for byte, line breaks included', () => {
    const s = 'Line one.\n\nLine two;  spaced.';
    expect(stripPrimaryLabels(s)).toBe(s);
  });
  it('only rewrites the unhedged sentence', () => {
    expect(stripPrimaryLabels('1° EP PFS: ns. No primary endpoint for OS is stated.')).toBe('PFS: ns. No primary endpoint for OS is stated.');
  });
});

describe('stripUngroundedPrimaryClaims', () => {
  const card = () => ({
    name: 'ARANOTE',
    details: ['📊 1° EP rPFS: HR 0.55', { text: '🔍 Primary endpoint rPFS', subdetails: ['1° EP rPFS by BICR'] }],
    analysis_sections: [{ label: 'Endpoints', body: 'Primary endpoint rPFS; OS immature.' }],
    interpretation: '1° EP rPFS met.',
    verdict: { rationale: 'Primary endpoint met with HR 0.55.' },
  });
  it('strips every surface when the sources never state a primary', () => {
    const c = card();
    const changed = stripUngroundedPrimaryClaims(c, 'ARANOTE: enzalutamide + ADT in mHSPC shows median rPFS NR vs 22.4mo. HR 0.55.');
    expect(changed).toEqual(['details[0]', 'details[1]', 'details[1].0', 'section:Endpoints', 'interpretation', 'verdict.rationale']);
    expect(JSON.stringify(c)).not.toMatch(/1°|[Pp]rimary/);
    expect(c.details[0]).toBe('📊 rPFS: HR 0.55');
  });
  it('touches nothing when the sources do state the primary', () => {
    const c = card();
    expect(stripUngroundedPrimaryClaims(c, 'The primary endpoint was rPFS.')).toEqual([]);
    expect(c).toEqual(card());
  });
});

describe('buildDigest runs the check (the eval and production share it)', () => {
  it('a tweet that never names a primary loses the "1° EP" label on the card', async () => {
    const { buildDigest } = await import('../src/lib/llm-pipeline.ts');
    const tweets = [{ id: 1, author: '@x', text: 'ARANOTE: enzalutamide + ADT in mHSPC shows median rPFS NR vs 22.4mo for placebo + ADT. HR 0.55.', image_urls: [] as string[] }];
    const responses = [
      JSON.stringify({ studies: [{ slug: 'aranote', name: 'ARANOTE', disease_site: 'prostate', tweet_ids: [1] }] }),
      JSON.stringify({
        name: 'ARANOTE',
        tldr: 'rPFS HR 0.55 favoring enzalutamide + ADT in mHSPC.',
        details: ['📊 1° EP rPFS: median NR vs 22.4mo, HR 0.55'],
        analysis_sections: [{ label: 'Endpoints', body: 'Primary endpoint rPFS.' }],
      }),
      JSON.stringify({ top_line: 'ARANOTE', tldr: 'x', site_meta: [{ disease_site: 'prostate', intro: null, open_questions: null }] }),
    ];
    const out = await buildDigest(tweets, {
      conferenceName: '',
      conferenceDay: '',
      client: { complete: async () => responses.shift()! },
    });
    const s = out.sites[0]!.studies[0]!;
    expect(s.details).toEqual(['📊 rPFS: median NR vs 22.4mo, HR 0.55']);
    expect(JSON.stringify(s)).not.toMatch(/1° ?EP|[Pp]rimary endpoint/);
  });
});

describe('hedges vs results (corpus regressions)', () => {
  it('a result that happens to contain "no" or "not" is still relabelled', () => {
    expect(stripPrimaryLabels('📊 1° EP PFS: no significant difference between arms')).toBe('📊 PFS: no significant difference between arms');
    expect(stripPrimaryLabels('📊 1° EP not met: mean T-score ratio 1.1')).toBe('📊 endpoint not met: mean T-score ratio 1.1');
  });
  it('a statement that the primary is unstated is kept', () => {
    for (const s of [
      'No single stated primary endpoint for this long-term analysis.',
      'Phase, randomization, and primary endpoint not stated in source tweet.',
      'The primary endpoint of this biomarker analysis is not stated.',
    ]) expect(stripPrimaryLabels(s), s).toBe(s);
  });
});
