import { describe, it, expect } from 'vitest';
import {
  applyOverrides,
  formatOverrideSummary,
  parseTagFlag,
  type DigestOverrides,
} from '../src/lib/digest-overrides.ts';
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

// v0.10 CLI flag parser. Shared with build/manage-overrides.ts and tested
// here so the CLI's case-normalization, bareword guard, whitespace-typo guard,
// and enum validation can't regress without a test failure.
describe('parseTagFlag', () => {
  it('accepts a valid enum value', () => {
    expect(parseTagFlag('modality', 'radiation')).toEqual({ ok: true, value: 'radiation' });
    expect(parseTagFlag('intent', 'palliative')).toEqual({ ok: true, value: 'palliative' });
    expect(parseTagFlag('methodology', 'phase-3-rct')).toEqual({ ok: true, value: 'phase-3-rct' });
  });

  it('lowercases before validating (curator types "Radiation")', () => {
    // Adversarial-review fix: PR #2 surfaced this exact bug in parseEnumTag
    // (LLM emits "Radiation" → silent drop). The CLI re-introduced it; this
    // test locks the fix.
    expect(parseTagFlag('modality', 'Radiation')).toEqual({ ok: true, value: 'radiation' });
    expect(parseTagFlag('modality', 'RADIATION')).toEqual({ ok: true, value: 'radiation' });
    expect(parseTagFlag('methodology', 'Phase-3-RCT')).toEqual({ ok: true, value: 'phase-3-rct' });
  });

  it('explicit empty string clears to null', () => {
    expect(parseTagFlag('modality', '')).toEqual({ ok: true, value: null });
  });

  it('bareword flag (boolean true from parseArgs) errors with hint', () => {
    const r = parseTagFlag('modality', true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/requires a value/);
      expect(r.error).toMatch(/--modality=/);
    }
  });

  it('whitespace-only value errors (NOT silently treated as clear)', () => {
    const r = parseTagFlag('modality', '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/whitespace-only/);
      expect(r.error).toMatch(/--modality= \(empty\)/);
    }
  });

  it('rejects out-of-enum values with the allowed list', () => {
    const r = parseTagFlag('modality', 'immunotherapy');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/invalid --modality/);
      expect(r.error).toMatch(/radiation/);
      expect(r.error).toMatch(/surgery/);
    }
  });

  it('rejects non-string values (defense against weird argv)', () => {
    expect(parseTagFlag('modality', 42).ok).toBe(false);
    expect(parseTagFlag('modality', null).ok).toBe(false);
    expect(parseTagFlag('modality', undefined).ok).toBe(false);
    expect(parseTagFlag('modality', {}).ok).toBe(false);
  });

  it('per-field validators: intent enum is independent of modality enum', () => {
    // 'radiation' is a valid modality but NOT a valid intent.
    expect(parseTagFlag('intent', 'radiation').ok).toBe(false);
    // 'palliative' is a valid intent but NOT a valid modality.
    expect(parseTagFlag('modality', 'palliative').ok).toBe(false);
  });
});

// v0.10 sidecar-bypass guard. The CLI gates the input, but the JSON file
// is a separate trust boundary — a hand-edited or stale-on-disk override
// could carry an invalid value. applyOverrides must drop it (not silently
// publish) and surface a warning. Codex P2 finding.
describe('applyOverrides — sidecar tag validation (bypass guard)', () => {
  it('drops an invalid modality value (sidecar hand-edit bypass) and warns', () => {
    const ov = {
      edits: { 'study-a': { modality: 'immunotherapy' } },
    } as unknown as DigestOverrides;
    const { digest, summary } = applyOverrides(sampleDigest(), ov);
    const a = digest.sites[0]!.studies[0]! as Record<string, unknown>;
    expect(a.modality).toBeUndefined(); // NOT silently set to 'immunotherapy'
    expect(summary.tagWarnings).toHaveLength(1);
    expect(summary.tagWarnings[0]!).toMatch(/invalid modality/);
    expect(summary.tagWarnings[0]!).toMatch(/immunotherapy/);
  });

  it('drops uppercase sidecar values (CLI lowercases but sidecar might not)', () => {
    // Symmetric with parseTagFlag's case-normalization: even if a curator
    // hand-edits the JSON with "Radiation" instead of "radiation", the
    // sidecar layer rejects it. (Alternative would be to lowercase here too;
    // we keep the JSON shape strict so the file matches what the CLI writes.)
    const ov = {
      edits: { 'study-a': { modality: 'Radiation' } },
    } as unknown as DigestOverrides;
    const { digest, summary } = applyOverrides(sampleDigest(), ov);
    const a = digest.sites[0]!.studies[0]! as Record<string, unknown>;
    expect(a.modality).toBeUndefined();
    expect(summary.tagWarnings[0]!).toMatch(/invalid modality/);
  });

  it('drops non-string sidecar values (e.g. a typo that left a number)', () => {
    const ov = {
      edits: { 'study-a': { methodology: 3 } },
    } as unknown as DigestOverrides;
    const { digest, summary } = applyOverrides(sampleDigest(), ov);
    const a = digest.sites[0]!.studies[0]! as Record<string, unknown>;
    expect(a.methodology).toBeUndefined();
    expect(summary.tagWarnings[0]!).toMatch(/invalid methodology type/);
  });

  it('passes through valid sidecar values', () => {
    const ov: DigestOverrides = {
      edits: { 'study-a': { modality: 'radiation', intent: 'palliative' } },
    };
    const { digest, summary } = applyOverrides(sampleDigest(), ov);
    expect(digest.sites[0]!.studies[0]!.modality).toBe('radiation');
    expect(digest.sites[0]!.studies[0]!.intent).toBe('palliative');
    expect(summary.tagWarnings).toEqual([]);
  });

  it('formatOverrideSummary surfaces tag warnings in the WARN section', () => {
    const ov = {
      edits: { 'study-a': { modality: 'unknown-value' } },
    } as unknown as DigestOverrides;
    const { summary } = applyOverrides(sampleDigest(), ov);
    const formatted = formatOverrideSummary(summary);
    expect(formatted).toMatch(/WARN/);
    expect(formatted).toMatch(/unknown-value/);
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
      tagWarnings: [],
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
      tagWarnings: [],
    });
    expect(s).toContain('WARN');
    expect(s).toContain('z');
  });
});
