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
  it('emits namespaced tokens for every valid field including site', () => {
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
        'site:breast',
        'verdict:practice-changing',
      ].sort(),
    );
  });

  it('site:supportive and intent:supportive coexist unambiguously in the DOM', () => {
    // The intent enum value `supportive` collides with the disease-site
    // slug `supportive` at the slug-only URL layer (v0.10 invariant only
    // covers the 5 /tags/ namespaces, not /sites/). At the DOM data-tags
    // layer, namespacing makes them distinct — both must coexist when
    // the same study somehow has intent:supportive AND site:supportive.
    const out = studyDataTags(
      study({ intent: 'supportive' }),
      'supportive',
      null,
    );
    expect(out).toContain('intent:supportive');
    expect(out).toContain('site:supportive');
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
    expect(out).toContain('site:breast');
  });

  it('returns the SAME tokens regardless of which page called the helper (cross-page consistency)', () => {
    // Adversarial review (Claude P1) caught a footgun: home page reads
    // r.conference from RecentStudy, /<date>/ from page-level conference,
    // /sites/<site>/ from per-occurrence conference, /tags/<slug>/ from
    // per-occurrence conference. As long as each caller resolves to the
    // SAME conference slug for a logical study, data-tags must match.
    // Pin the contract: identical inputs → identical output bytes.
    const s = study({
      modality: 'radiation',
      intent: 'curative',
      methodology: 'phase-3-rct',
    });
    const fromHome = studyDataTags(s, 'breast', 'asco-2026');
    const fromDate = studyDataTags(s, 'breast', 'asco-2026');
    const fromSite = studyDataTags(s, 'breast', 'asco-2026');
    const fromTag = studyDataTags(s, 'breast', 'asco-2026');
    expect(fromHome).toBe(fromDate);
    expect(fromDate).toBe(fromSite);
    expect(fromSite).toBe(fromTag);
  });

  it('empty data-tags string for an untagged study: filter contract is "always renders" (PR-2 must not hide them)', () => {
    // Pinning the semantic for PR-2: a study with no emit-eligible
    // fields returns ''. Callers (StudyCard, recent-li) use
    // `data-tags={dataTags || undefined}` to drop the attribute. PR-2
    // queries `[data-tags]` to find filterable cards; cards without
    // the attribute fall outside the filter set and stay rendered.
    // If a future change ever made these cards filterable, the empty-
    // string semantic must be tested too.
    expect(studyDataTags(study(), '', null)).toBe('');
  });

  it('omits the verdict token when soc_implication is missing', () => {
    const out = studyDataTags(study({ modality: 'radiation' }), 'breast', null);
    expect(out).not.toMatch(/verdict:/);
  });

  it('handles a study with no tag fields by emitting site (and meeting if present)', () => {
    const out = studyDataTags(study(), 'breast', 'asco-2026');
    expect(out).toBe('meeting:asco-2026 site:breast');
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
