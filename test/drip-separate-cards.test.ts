// v0.62.4: one card per library PDF. On 2026-10-25 Phase 1 merged five skin
// brachytherapy papers from one drip night into a single card.
import { describe, it, expect } from 'vitest';
import { splitDripClusters, buildDigest, paperIdToSyntheticTweetId } from '../src/lib/llm-pipeline.ts';

const P = paperIdToSyntheticTweetId;

describe('splitDripClusters', () => {
  const info = (title: string, extra: { note?: string; site?: string } = {}) => ({ title, note: extra.note ?? null, site: extra.site ?? null });
  const drip = new Map([
    [P(1), info('Surface mould brachytherapy: the BC Cancer experience', { site: 'skin' })],
    [P(2), info('CT-based flap brachytherapy for facial NMSC', { site: 'skin' })],
    [P(3), info('Skin surface brachytherapy dose survey', { site: 'skin' })],
  ]);
  const cluster = (ids: number[], extra: Partial<{ slug: string; content_type: 'study_report' | 'review' | 'presentation'; disease_site: string }> = {}) => ({
    slug: extra.slug ?? 'hdr-skin-brachy-series',
    name: 'HDR skin brachytherapy: surface mould and flap series',
    disease_site: extra.disease_site ?? 'skin',
    tweet_ids: ids,
    content_type: extra.content_type ?? ('study_report' as const),
  });

  it('splits an all-drip cluster into one card per paper, each named from its own title', () => {
    const out = splitDripClusters([cluster([P(1), P(2), P(3)])], drip);
    expect(out.map((c) => c.tweet_ids)).toEqual([[P(1)], [P(2)], [P(3)]]);
    expect(out.map((c) => c.name)).toEqual([...drip.values()].map((d) => d.title)); // no "series" name left
    expect(new Set(out.map((c) => c.slug)).size).toBe(3);
  });

  it('a merged "review" becomes study reports; a review-titled paper stays a review; a talk is a talk', () => {
    const d = new Map([
      [P(1), info('Surface mould series: the BC experience')],
      [P(2), info('Skin brachytherapy: a review of the literature')],
      [P(3), info('Skin brachy talk', { note: 'Slide deck from a talk (presentation), not a study report.' })],
      [P(4), info('GEC-ESTRO ACROP recommendations in skin brachytherapy')],
    ]);
    const out = splitDripClusters([cluster([P(1), P(2), P(3), P(4)], { content_type: 'review' })], d);
    expect(out.map((c) => c.content_type)).toEqual(['study_report', 'review', 'presentation', 'study_report']);
  });

  it('types each paper from its own title, never the parent label', () => {
    const d = new Map([
      [P(1), info('Practice review of skin brachytherapy dose schedules')],
      [P(2), info('Recurrence after RT: a retrospective review of 120 patients')],
      [P(3), info('SBRT for ultra-central lung tumors: a systematic review and meta-analysis')],
      [P(4), info('Systematic literature review and meta-analysis of hypofractionation')],
    ]);
    const out = splitDripClusters([cluster([P(1), P(2), P(3), P(4)], { content_type: 'study_report' })], d);
    expect(out.map((c) => c.content_type)).toEqual(['review', 'study_report', 'study_report', 'study_report']);
  });

  it('files each split paper under its own site', () => {
    const d = new Map([[P(1), info('Breast paper', { site: 'breast' })], [P(2), info('Prostate paper', { site: 'prostate' })]]);
    const out = splitDripClusters([cluster([P(1), P(2)], { disease_site: 'breast' })], d);
    expect(out.map((c) => c.disease_site)).toEqual(['breast', 'prostate']);
  });

  it('leaves a cluster mixing drip papers with tweets or Telegram papers whole', () => {
    const c = cluster([42, P(1), P(9), P(2)]);
    expect(splitDripClusters([c], drip)).toEqual([c]);
  });

  it('leaves clusters with zero or one drip paper alone', () => {
    const cs = [cluster([42, P(9)], { slug: 'a' }), cluster([P(1), 43], { slug: 'b' })];
    expect(splitDripClusters(cs, drip)).toEqual(cs);
  });

  it('a collision suffix never pushes a slug past 64 characters', () => {
    const long = 'A'.repeat(10) + ' ' + 'word '.repeat(20);
    const d = new Map([[P(1), info(long)], [P(2), info(long)]]);
    const out = splitDripClusters([cluster([P(1), P(2)])], d);
    expect(out.every((c) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(c.slug))).toBe(true);
    expect(new Set(out.map((c) => c.slug)).size).toBe(2);
  });
});

describe('buildDigest', () => {
  it('two drip papers Phase 1 merged come out as two cards', async () => {
    const paper = (id: number, title: string) => ({
      source_type: 'paper' as const,
      id,
      pmid: null,
      title,
      abstract: `${title}. 120 patients treated; local control 95%.`,
      local_drip: true,
    });
    const items = [paper(1, 'Surface mould brachytherapy series'), paper(2, 'Flap brachytherapy for facial skin cancer')];
    const study = (name: string) => JSON.stringify({ name, tldr: 'Local control 95% in 120 patients.', details: ['📊 local control 95%'] });
    const responses = [
      JSON.stringify({ studies: [{ slug: 'skin-brachy', name: 'Skin brachy series', disease_site: 'skin', tweet_ids: [P(1), P(2)] }] }),
      study('Surface mould brachytherapy series'),
      study('Flap brachytherapy for facial skin cancer'),
      JSON.stringify({ top_line: 'x', tldr: 'x', site_meta: [{ disease_site: 'skin', intro: null, open_questions: null }] }),
    ];
    const out = await buildDigest(items, { conferenceName: '', conferenceDay: '', client: { complete: async () => responses.shift()! } });
    const studies = out.sites.flatMap((s) => s.studies);
    expect(studies).toHaveLength(2);
    expect(studies.map((s) => s.tweet_ids)).toEqual([[P(1)], [P(2)]]);
  });
});
