import { describe, it, expect } from 'vitest';
import { studiesToRss, escapeXml } from '../src/lib/feed.ts';
import type { RecentStudy } from '../src/lib/digest-data.ts';

function study(over: Partial<RecentStudy> = {}): RecentStudy {
  const base: RecentStudy = {
    date: '2026-05-18',
    conference: null,
    disease_site: 'prostate',
    slug: 'prestige-psma',
    study: {
      name: 'PRESTIGE-PSMA',
      tldr: 'OS HR 0.62.',
      details: [],
      key_figure_url: null,
      key_figure_caption: null,
      nct: 'NCT04567890',
      tweet_ids: [1],
      verdict: {
        soc_implication: 'practice-changing',
        rationale: 'large OS benefit',
        audience: 'mCRPC, post-ARPI',
      },
    },
  };
  return { ...base, ...over };
}

describe('escapeXml', () => {
  it('escapes the five XML entities', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('studiesToRss', () => {
  it('emits an RSS 2.0 channel with one item per study', () => {
    const second = study({
      slug: 'aranote',
      study: { ...study().study, name: 'ARANOTE', nct: null },
    });
    const xml = studiesToRss([study(), second], 'https://oncbrain.example.com');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('<title>PRESTIGE-PSMA</title>');
    expect(xml).toContain('<title>ARANOTE</title>');
    expect((xml.match(/<item>/g) ?? []).length).toBe(2);
  });

  it('deep-links each item to /<date>/#<slug> (trailing slash on site normalized)', () => {
    const xml = studiesToRss([study()], 'https://oncbrain.example.com/');
    expect(xml).toContain('<link>https://oncbrain.example.com/2026-05-18/#prestige-psma</link>');
  });

  it('includes the verdict label + audience in the description', () => {
    const xml = studiesToRss([study()], 'https://x.example.com');
    expect(xml).toContain('[Practice-changing]');
    expect(xml).toContain('Eligible: mCRPC, post-ARPI');
  });

  it('escapes special characters in study names', () => {
    const xml = studiesToRss(
      [study({ study: { ...study().study, name: 'A & B <trial>' } })],
      'https://x.example.com',
    );
    expect(xml).toContain('<title>A &amp; B &lt;trial&gt;</title>');
  });

  it('handles an empty study list (channel, no items)', () => {
    const xml = studiesToRss([], 'https://x.example.com');
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });
});
