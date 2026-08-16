// The LLM half of trial lineage. Everything here is about refusing to coerce:
// a facet this parser invents becomes a verdict that unpublishes a live card, so
// an off-enum or implausible value must land on null rather than a near match.
import { describe, it, expect } from 'vitest';
import { parseSourceFacet, EMPTY_FACET } from '../src/lib/source-facet.ts';

describe('parseSourceFacet', () => {
  it('parses a well-formed response', () => {
    const f = parseSourceFacet(
      JSON.stringify({
        facet: 'quality-of-life',
        maturity: 'conference-abstract',
        followup_months: 24,
        trial_acronyms: ['NRG-GU005'],
      }),
    );
    expect(f).toEqual({
      facet: 'quality-of-life',
      maturity: 'conference-abstract',
      followup_months: 24,
      trial_acronyms: ['NRG-GU005'],
    });
  });

  it('strips code fences', () => {
    const f = parseSourceFacet('```json\n{"facet":"primary-efficacy"}\n```');
    expect(f.facet).toBe('primary-efficacy');
  });

  it('abstains on unparseable output', () => {
    expect(parseSourceFacet('not json')).toEqual(EMPTY_FACET);
    expect(parseSourceFacet('')).toEqual(EMPTY_FACET);
    expect(parseSourceFacet('[1,2,3]')).toEqual(EMPTY_FACET);
    expect(parseSourceFacet('null')).toEqual(EMPTY_FACET);
  });

  it('nulls an off-enum facet rather than snapping it to a near match', () => {
    expect(parseSourceFacet('{"facet":"efficacy"}').facet).toBeNull();
    expect(parseSourceFacet('{"facet":"Quality-of-Life"}').facet).toBeNull();
    expect(parseSourceFacet('{"facet":42}').facet).toBeNull();
  });

  it('nulls an off-enum maturity', () => {
    expect(parseSourceFacet('{"maturity":"preprint"}').maturity).toBeNull();
  });

  it('rejects a follow-up that is out of range or the wrong unit', () => {
    // A model answering in DAYS would report 3650 for a 10-year trial. Read as
    // months that is 304 years, and a bogus large value reads as "longer
    // follow-up" — which would wrongly supersede a live card.
    expect(parseSourceFacet('{"followup_months":3650}').followup_months).toBeNull();
    expect(parseSourceFacet('{"followup_months":-4}').followup_months).toBeNull();
    expect(parseSourceFacet('{"followup_months":"24"}').followup_months).toBeNull();
    expect(parseSourceFacet('{"followup_months":600}').followup_months).toBe(600);
  });

  it('keeps a fractional follow-up to one decimal', () => {
    expect(parseSourceFacet('{"followup_months":61.24}').followup_months).toBe(61.2);
  });

  it('dedupes and cleans trial_acronyms, dropping non-strings', () => {
    const f = parseSourceFacet(
      '{"trial_acronyms":["NRG-GU005"," NRG-GU005 ",42,"",null,"PACE-B"]}',
    );
    expect(f.trial_acronyms).toEqual(['NRG-GU005', 'PACE-B']);
  });

  it('drops an absurdly long acronym', () => {
    const f = parseSourceFacet(JSON.stringify({ trial_acronyms: ['A'.repeat(200)] }));
    expect(f.trial_acronyms).toEqual([]);
  });

  it('treats a missing field as abstention, not as a default', () => {
    expect(parseSourceFacet('{}')).toEqual(EMPTY_FACET);
  });
});
