// v0.11 PR-1a: studyDataTags helper.

import { describe, it, expect } from 'vitest';
import { studyDataTags } from '../src/lib/study-data-tags.ts';
import type { DigestStudy } from '../src/lib/digest-data.ts';

function study(overrides: Partial<DigestStudy> = {}): DigestStudy {
  return {
    name: 'Sample',
    tldr: 'Sample TL;DR',
    details: [],
    nct: null,
    tweet_ids: [],
    ...overrides,
  };
}

describe('studyDataTags', () => {
  it('emits namespaced tokens for every valid field (disease-site intentionally omitted)', () => {
    const out = studyDataTags(
      study({
        modality: 'radiation',
        intent: 'curative',
        methodology: 'phase-3-rct',
        verdict: { soc_implication: 'practice-changing', rationale: '', audience: null },
      }),
      'breast',
      'asco-2026',
    );
    const tokens = out.split(' ').sort();
    expect(tokens).toEqual(
      [
        'intent:curative',
        'meeting:asco-2026',
        'methodology:phase-3-rct',
        'modality:radiation',
        'verdict:practice-changing',
      ].sort(),
    );
    // Disease-site explicitly NOT in the data-tags — see helper header
    // comment for the `supportive` slug collision rationale.
    expect(out).not.toMatch(/^site:|\ssite:/);
  });

  it('drops invalid enum values silently (defense against legacy artifacts)', () => {
    // A pre-v0.10 artifact or a hand-edited override could carry a string
    // that looks plausible but is not in the canonical enum. The helper
    // must NOT emit it as a data-tag — the filter logic relies on the
    // attribute set being a subset of the namespace map.
    const out = studyDataTags(
      study({
        modality: 'chemo' as unknown as 'radiation',
        intent: 'curative',
      }),
      'breast',
      null,
    );
    expect(out).not.toContain('modality:chemo');
    expect(out).toContain('intent:curative');
  });

  it('omits the meeting token when conference is null', () => {
    const out = studyDataTags(
      study({ modality: 'radiation' }),
      'breast',
      null,
    );
    expect(out).not.toMatch(/meeting:/);
    expect(out).toContain('modality:radiation');
  });

  it('omits the verdict token when soc_implication is missing', () => {
    const out = studyDataTags(study({ modality: 'radiation' }), 'breast', null);
    expect(out).not.toMatch(/verdict:/);
  });

  it('handles a study with no tag fields by emitting only meeting (when present)', () => {
    const out = studyDataTags(study(), 'breast', 'asco-2026');
    expect(out).toBe('meeting:asco-2026');
  });

  it('returns the empty string when no fields are emit-eligible', () => {
    const out = studyDataTags(study(), '', null);
    expect(out).toBe('');
  });

  it('rejects prototype-pollution lookup on verdict (Object.prototype.hasOwnProperty)', () => {
    const out = studyDataTags(
      study({
        verdict: { soc_implication: 'toString' as never, rationale: '', audience: null },
      }),
      'breast',
      null,
    );
    expect(out).not.toMatch(/verdict:/);
  });
});
