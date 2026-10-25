// v0.62.4: one card per library PDF. On 2026-10-25 Phase 1 merged five skin
// brachytherapy papers from one drip night into a single card.
import { describe, it, expect } from 'vitest';
import { splitDripClusters, buildDigest, paperIdToSyntheticTweetId } from '../src/lib/llm-pipeline.ts';

const P = paperIdToSyntheticTweetId;

describe('splitDripClusters', () => {
  const drip = new Map([
    [P(1), 'Surface mould brachytherapy: the BC Cancer experience'],
    [P(2), 'CT-based flap brachytherapy for facial NMSC'],
    [P(3), 'Skin surface brachytherapy dose survey'],
  ]);
  const cluster = (ids: number[], slug = 'hdr-skin-brachy') => ({
    slug,
    name: 'HDR skin brachytherapy series',
    disease_site: 'skin',
    tweet_ids: ids,
    content_type: 'study_report' as const,
  });

  it('splits a cluster of drip papers into one cluster each', () => {
    const out = splitDripClusters([cluster([P(1), P(2), P(3)])], drip);
    expect(out.map((c) => c.tweet_ids)).toEqual([[P(1)], [P(2)], [P(3)]]);
    expect(out[1]!.name).toBe('CT-based flap brachytherapy for facial NMSC');
    expect(out.every((c) => c.disease_site === 'skin')).toBe(true);
    expect(new Set(out.map((c) => c.slug)).size).toBe(3);
  });

  it('keeps tweets and Telegram papers with the first drip paper', () => {
    const out = splitDripClusters([cluster([42, P(1), P(9), P(2)])], drip);
    expect(out.map((c) => c.tweet_ids)).toEqual([[42, P(1), P(9)], [P(2)]]);
  });

  it('leaves clusters with zero or one drip paper alone', () => {
    const cs = [cluster([42, P(9)], 'a'), cluster([P(1), 43], 'b')];
    expect(splitDripClusters(cs, drip)).toEqual(cs);
  });

  it('never reuses a slug already on the date', () => {
    const titles = new Map([[P(1), 'Same title'], [P(2), 'Same title']]);
    const out = splitDripClusters([cluster([P(1), P(2)], 'same-title')], titles);
    expect(out.map((c) => c.slug)).toEqual(['same-title', 'same-title-2']);
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
