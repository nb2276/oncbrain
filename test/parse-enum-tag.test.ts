// v0.10 Phase 2 tag emission parsing. Critical adversarial-review finding:
// the LLM is highly likely to emit capitalized values (the prompt mixes
// lowercase enum SLUGS with capitalized LABELS in the rules block), so
// parseEnumTag MUST lowercase before validating or "Radiation" → drop and
// the study silently disappears from /tags/radiation/.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseEnumTag } from '../src/lib/llm-pipeline.ts';
import { isValidModality, isValidIntent, isValidMethodology } from '../src/lib/tags.ts';

describe('parseEnumTag', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('lowercases before validating (LLM emits "Radiation" → keeps it)', () => {
    expect(parseEnumTag('Radiation', isValidModality, 'modality', 'A')).toBe('radiation');
    expect(parseEnumTag('SURGERY', isValidModality, 'modality', 'B')).toBe('surgery');
    expect(parseEnumTag('Curative', isValidIntent, 'intent', 'C')).toBe('curative');
    // Methodology has hyphens — uppercase variants still match after lowercase
    expect(parseEnumTag('Phase-3-RCT', isValidMethodology, 'methodology', 'D')).toBe('phase-3-rct');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('trims whitespace before validating', () => {
    expect(parseEnumTag('  radiation  ', isValidModality, 'modality', 'A')).toBe('radiation');
    expect(parseEnumTag('\tpalliative\n', isValidIntent, 'intent', 'B')).toBe('palliative');
  });

  it('combines trim + lowercase (mixed-case + whitespace)', () => {
    expect(parseEnumTag(' Palliative ', isValidIntent, 'intent', 'A')).toBe('palliative');
  });

  it('returns null for absent / null / undefined without warning', () => {
    expect(parseEnumTag(null, isValidModality, 'modality', 'A')).toBeNull();
    expect(parseEnumTag(undefined, isValidModality, 'modality', 'A')).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null for non-string input without warning', () => {
    expect(parseEnumTag(42, isValidModality, 'modality', 'A')).toBeNull();
    expect(parseEnumTag(true, isValidModality, 'modality', 'A')).toBeNull();
    expect(parseEnumTag({}, isValidModality, 'modality', 'A')).toBeNull();
    expect(parseEnumTag([], isValidModality, 'modality', 'A')).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null for empty / whitespace-only string without warning', () => {
    expect(parseEnumTag('', isValidModality, 'modality', 'A')).toBeNull();
    expect(parseEnumTag('   ', isValidModality, 'modality', 'A')).toBeNull();
    expect(parseEnumTag('\n\t', isValidModality, 'modality', 'A')).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops out-of-enum value WITH a warning identifying study + namespace', () => {
    expect(parseEnumTag('immunotherapy', isValidModality, 'modality', 'PRESTIGE-PSMA')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]![0]);
    expect(msg).toContain('modality');
    expect(msg).toContain('immunotherapy');
    expect(msg).toContain('PRESTIGE-PSMA');
  });

  it('preserves the ORIGINAL casing in the warning message (curator sees what LLM emitted)', () => {
    parseEnumTag('SomeRandomThing', isValidModality, 'modality', 'X');
    const msg = String(warnSpy.mock.calls[0]![0]);
    expect(msg).toContain('SomeRandomThing'); // original, not lowercased
  });
});
