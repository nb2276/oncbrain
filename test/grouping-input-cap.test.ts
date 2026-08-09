// Phase 1 (grouping) is the one phase whose input scales with the number of
// SOURCES on a day rather than per study, so it is the phase where a bigger
// per-paper excerpt multiplies. Handing it the full section-composed excerpt put
// ~70,000 chars into a single call on a 5-paper date and would have put
// ~250-300k there once the back catalogue is backfilled — on the claude-cli
// subscription window, which is the binding constraint on this project.
//
// Clustering needs identity: title, journal, abstract, NCT. itemToTweetShape
// emits those before the excerpt, so a head cap keeps everything grouping uses.
import { describe, it, expect } from 'vitest';
import { capForGrouping, GROUPING_TEXT_MAX_CHARS } from '../src/lib/llm-pipeline.ts';

const paperBlock = (excerptChars: number) =>
  [
    '[PAPER doi:10.1000/xyz]',
    'Title: A Randomised Trial of Something (NCT04736199)',
    'Authors: One, A; Two, B',
    'Journal: Journal of Testing (2026-08-09)',
    '',
    'Abstract:',
    'Background. '.repeat(120) + 'The primary endpoint was met, HR 0.54.',
    '',
    'Full-text excerpt (section-selected: tables and figure captions first…):',
    '## Table 1. Class definitions',
    'row '.repeat(excerptChars / 4),
  ].join('\n');

describe('capForGrouping', () => {
  it('leaves a short source untouched', () => {
    const short = '[PAPER ?]\nTitle: A tweet-sized thing';
    expect(capForGrouping(short)).toBe(short);
  });

  it('keeps everything clustering needs: identity, NCT and abstract', () => {
    const capped = capForGrouping(paperBlock(60_000));
    expect(capped).toContain('doi:10.1000/xyz');
    expect(capped).toContain('NCT04736199');
    expect(capped).toContain('Journal of Testing');
    expect(capped).toContain('HR 0.54'); // the abstract's headline survives
  });

  it('bounds the source regardless of how large the excerpt is', () => {
    // The cap is a head bound, not a surgical excision: a table heading that
    // happens to fall inside the first 4,000 chars is kept, and that is fine.
    // What must not survive is the bulk — the 60,000-char tail.
    const capped = capForGrouping(paperBlock(60_000));
    expect(capped.length).toBeLessThanOrEqual(GROUPING_TEXT_MAX_CHARS + 200);
    expect(capped.length).toBeLessThan(paperBlock(60_000).length / 10);
  });

  it('says the excerpt was withheld rather than looking like a short paper', () => {
    // A silent cut would read as "this source has nothing more", which is a
    // different claim from "the study agent gets the rest".
    expect(capForGrouping(paperBlock(60_000))).toContain('omitted for clustering');
  });

  it('bounds a whole day: 6 large papers stay well under a single-call blowout', () => {
    const day = Array.from({ length: 6 }, () => capForGrouping(paperBlock(50_000)));
    const total = day.reduce((n, t) => n + t.length, 0);
    expect(total).toBeLessThan(30_000); // was ~300,000 uncapped
  });
});
