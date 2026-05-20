import { describe, it, expect } from 'vitest';
import { applyOverrides, formatOverrideSummary, type DigestOverrides } from '../src/lib/digest-overrides.ts';
import { deriveSlug } from '../src/lib/slug.ts';
import type { DigestOutput, DigestStudy } from '../src/lib/llm-pipeline.ts';

function study(name: string, slug: string, extra: Partial<DigestStudy> = {}): DigestStudy {
  return {
    name,
    tldr: `${name} tldr`,
    details: [`${name} bullet`],
    key_figure_url: null,
    key_figure_caption: null,
    nct: null,
    tweet_ids: [],
    slug,
    ...extra,
  };
}

function sampleDigest(): DigestOutput {
  return {
    top_line: 'original top line',
    tldr: 'original tldr',
    sites: [
      {
        disease_site: 'breast',
        intro: null,
        open_questions: null,
        studies: [study('Study A', 'study-a'), study('Study B', 'study-b')],
      },
      {
        disease_site: 'thoracic',
        intro: null,
        open_questions: null,
        studies: [study('Study C', 'study-c')],
      },
    ],
    meta: { clusters_total: 3, studies_analyzed: 3, dropped: [], ocr_available: false },
  };
}

describe('applyOverrides', () => {
  it('suppresses a study and prunes a now-empty site', () => {
    const { digest, summary } = applyOverrides(sampleDigest(), { suppress: ['study-c'] });
    expect(digest.sites.map((s) => s.disease_site)).toEqual(['breast']); // thoracic pruned
    expect(digest.sites.flatMap((s) => s.studies.map((st) => st.slug))).toEqual(['study-a', 'study-b']);
    expect(summary.suppressed).toEqual(['study-c']);
    expect(digest.meta.studies_analyzed).toBe(2);
    expect(digest.meta.dropped).toContainEqual({
      slug: 'study-c',
      name: 'Study C',
      reason: 'suppressed via override',
    });
  });

  it('edits study fields by slug (shallow merge; other fields untouched)', () => {
    const { digest, summary } = applyOverrides(sampleDigest(), {
      edits: { 'study-a': { tldr: 'new tldr', name: 'Study A v2' } },
    });
    const a = digest.sites[0]!.studies[0]!;
    expect(a.tldr).toBe('new tldr');
    expect(a.name).toBe('Study A v2');
    expect(a.details).toEqual(['Study A bullet']); // untouched
    expect(a.slug).toBe('study-a'); // anchor preserved even though name changed
    expect(summary.edited).toEqual(['study-a']);
  });

  it('ignores non-editable keys (slug cannot be overridden)', () => {
    const ov = { edits: { 'study-a': { slug: 'hacked' } } } as unknown as DigestOverrides;
    const { digest } = applyOverrides(sampleDigest(), ov);
    expect(digest.sites[0]!.studies[0]!.slug).toBe('study-a');
  });

  it('overrides digest-level top_line and tldr', () => {
    const { digest, summary } = applyOverrides(sampleDigest(), {
      digest: { top_line: 'NEW', tldr: 'NEW TLDR' },
    });
    expect(digest.top_line).toBe('NEW');
    expect(digest.tldr).toBe('NEW TLDR');
    expect(summary.digestFields).toEqual(['top_line', 'tldr']);
  });

  it('reports requested slugs that match no study', () => {
    const { summary } = applyOverrides(sampleDigest(), {
      suppress: ['nope'],
      edits: { alsonope: { tldr: 'x' } },
    });
    expect(summary.suppressMissing).toEqual(['nope']);
    expect(summary.editMissing).toEqual(['alsonope']);
  });

  it('does not mutate the input digest', () => {
    const input = sampleDigest();
    applyOverrides(input, { suppress: ['study-a'], edits: { 'study-b': { tldr: 'z' } } });
    expect(input.sites[0]!.studies).toHaveLength(2);
    expect(input.sites[0]!.studies[1]!.tldr).toBe('Study B tldr');
  });

  it('falls back to deriveSlug when a study has no slug', () => {
    const d = sampleDigest();
    delete d.sites[0]!.studies[0]!.slug;
    const derived = deriveSlug('Study A');
    const { summary } = applyOverrides(d, { suppress: [derived] });
    expect(summary.suppressed).toEqual([derived]);
  });

  it('is a no-op when overrides are empty', () => {
    const { digest, summary } = applyOverrides(sampleDigest(), {});
    expect(digest.sites.flatMap((s) => s.studies)).toHaveLength(3);
    expect(formatOverrideSummary(summary)).toBe('no-op');
  });
});

describe('formatOverrideSummary', () => {
  it('summarizes applied changes', () => {
    const s = formatOverrideSummary({
      suppressed: ['x'],
      suppressMissing: [],
      edited: ['y'],
      editMissing: [],
      digestFields: ['top_line'],
    });
    expect(s).toContain('suppressed 1');
    expect(s).toContain('edited 1');
    expect(s).toContain('top_line');
  });

  it('flags missing slugs as warnings', () => {
    const s = formatOverrideSummary({
      suppressed: [],
      suppressMissing: ['z'],
      edited: [],
      editMissing: [],
      digestFields: [],
    });
    expect(s).toContain('WARN');
    expect(s).toContain('z');
  });
});
