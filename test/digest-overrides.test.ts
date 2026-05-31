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

// v0.10: tag-field overrides. Curator fixes wrong Phase 2 LLM emissions
// (palliative vs curative, phase-2 vs phase-3) without re-running the LLM.
// Empty/null value clears the LLM emission so the study disappears from
// that namespace's landing page entirely.
describe('applyOverrides — v0.10 tag fields', () => {
  it('sets modality / intent / methodology via the edits map', () => {
    const { digest, summary } = applyOverrides(sampleDigest(), {
      edits: {
        'study-a': {
          modality: 'radiation',
          intent: 'palliative',
          methodology: 'phase-3-rct',
        },
      },
    });
    const a = digest.sites[0]!.studies[0]!;
    expect(a.modality).toBe('radiation');
    expect(a.intent).toBe('palliative');
    expect(a.methodology).toBe('phase-3-rct');
    expect(summary.edited).toEqual(['study-a']);
  });

  it('overrides a wrong LLM emission (palliative → curative)', () => {
    const base = sampleDigest();
    base.sites[0]!.studies[0]!.intent = 'palliative';
    const { digest } = applyOverrides(base, {
      edits: { 'study-a': { intent: 'curative' } },
    });
    expect(digest.sites[0]!.studies[0]!.intent).toBe('curative');
  });

  it('null value clears the LLM emission (study off the modality landing)', () => {
    const base = sampleDigest();
    base.sites[0]!.studies[0]!.modality = 'radiation';
    const { digest } = applyOverrides(base, {
      edits: { 'study-a': { modality: null } },
    });
    expect(digest.sites[0]!.studies[0]!.modality).toBeNull();
  });

  it('does not silently propagate an unknown tag field (whitelist enforced)', () => {
    // A sidecar JSON could contain stale or hand-edited fields. pickEditable
    // only copies whitelisted keys, so a typo or future-removed field can't
    // poison the rendered study.
    const ov = {
      edits: {
        'study-a': { modality: 'radiation', some_future_field: 'leaked' },
      },
    } as unknown as DigestOverrides;
    const { digest } = applyOverrides(sampleDigest(), ov);
    const a = digest.sites[0]!.studies[0]! as Record<string, unknown>;
    expect(a.modality).toBe('radiation');
    expect(a.some_future_field).toBeUndefined();
  });

  it('partial tag edits do not zero out other tag fields', () => {
    const base = sampleDigest();
    base.sites[0]!.studies[0]!.modality = 'radiation';
    base.sites[0]!.studies[0]!.intent = 'curative';
    base.sites[0]!.studies[0]!.methodology = 'phase-3-rct';
    const { digest } = applyOverrides(base, {
      edits: { 'study-a': { intent: 'palliative' } }, // only intent
    });
    const a = digest.sites[0]!.studies[0]!;
    expect(a.modality).toBe('radiation'); // preserved
    expect(a.intent).toBe('palliative'); // overridden
    expect(a.methodology).toBe('phase-3-rct'); // preserved
  });

  it('tag overrides survive across multiple build:day rebuilds (sidecar persistence)', () => {
    // Sidecar is the SAME JSON we load each build; applying it twice should
    // be idempotent and not accumulate "edited" counts in the per-build
    // summary beyond the one slug.
    const ov: DigestOverrides = {
      edits: { 'study-a': { modality: 'surgery', intent: 'palliative' } },
    };
    const first = applyOverrides(sampleDigest(), ov);
    const second = applyOverrides(sampleDigest(), ov);
    expect(first.digest.sites[0]!.studies[0]!.modality).toBe('surgery');
    expect(second.digest.sites[0]!.studies[0]!.modality).toBe('surgery');
    expect(first.summary.edited).toEqual(['study-a']);
    expect(second.summary.edited).toEqual(['study-a']);
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
