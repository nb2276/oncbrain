import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPerspective, perspectiveDisplayName } from '../src/lib/llm-pipeline.ts';

const STUDY_AGENT_PROMPT = resolve(__dirname, '../prompts/digest-v5-study-agent.txt');
const SYNTHESIS_PROMPT = resolve(__dirname, '../prompts/digest-v5-synthesis.txt');

describe('loadPerspective', () => {
  it('returns empty string when unset/blank (no specialty bias, current default)', () => {
    expect(loadPerspective(undefined)).toBe('');
    expect(loadPerspective(null)).toBe('');
    expect(loadPerspective('')).toBe('');
    expect(loadPerspective('   ')).toBe('');
  });

  it('loads a shipped profile wrapped in a labelled section', () => {
    const block = loadPerspective('radonc');
    expect(block).toContain('SPECIALTY PERSPECTIVE');
    expect(block.toLowerCase()).toContain('radiation oncology');
    // the lens must instruct surfacing magnitude, the RTOG-0848 gap
    expect(block.toLowerCase()).toContain('magnitude');
    // trailing blank line so the {{PERSPECTIVE}} slot spaces cleanly into DEPTH
    expect(block.endsWith('\n\n')).toBe(true);
  });

  it('is case-insensitive on the profile name', () => {
    expect(loadPerspective('RadOnc')).toBe(loadPerspective('radonc'));
  });

  it('ships a distinct medonc profile to prove swappability', () => {
    const rad = loadPerspective('radonc');
    const med = loadPerspective('medonc');
    expect(med).toContain('medical oncology');
    expect(med).not.toBe(rad);
  });

  it('degrades to empty string for an unknown profile (no throw)', () => {
    expect(loadPerspective('does-not-exist')).toBe('');
  });

  it('rejects path-traversal / unsafe names', () => {
    expect(loadPerspective('../voice')).toBe('');
    expect(loadPerspective('../../VOICE')).toBe('');
    expect(loadPerspective('foo/bar')).toBe('');
    expect(loadPerspective('.')).toBe('');
  });

  it('study-agent (Phase 2) prompt carries the {{PERSPECTIVE}} slot', () => {
    const template = readFileSync(STUDY_AGENT_PROMPT, 'utf-8');
    expect(template).toContain('{{PERSPECTIVE}}');
  });

  it('synthesis (Phase 3) prompt carries the {{PERSPECTIVE}} slot', () => {
    const template = readFileSync(SYNTHESIS_PROMPT, 'utf-8');
    expect(template).toContain('{{PERSPECTIVE}}');
  });

  it('shipped profiles honor the no-em-dash voice rule', () => {
    for (const name of ['radonc', 'medonc']) {
      expect(loadPerspective(name)).not.toContain('—');
    }
  });

  it('study-agent prompt carries the significance field + section (v0.22)', () => {
    const template = readFileSync(STUDY_AGENT_PROMPT, 'utf-8');
    expect(template).toContain('"significance"');
    expect(template).toContain('SIGNIFICANCE');
  });
});

describe('perspectiveDisplayName (v0.22)', () => {
  it('maps known lenses to a curated label', () => {
    expect(perspectiveDisplayName('radonc')).toBe('Radiation oncology');
    expect(perspectiveDisplayName('medonc')).toBe('Medical oncology');
  });

  it('is case-insensitive on the slug', () => {
    expect(perspectiveDisplayName('RadOnc')).toBe('Radiation oncology');
  });

  it('returns null for unset / blank / unsafe slugs', () => {
    expect(perspectiveDisplayName(undefined)).toBeNull();
    expect(perspectiveDisplayName(null)).toBeNull();
    expect(perspectiveDisplayName('  ')).toBeNull();
    expect(perspectiveDisplayName('../voice')).toBeNull();
    expect(perspectiveDisplayName('foo/bar')).toBeNull();
  });

  it('title-cases an unmapped-but-valid slug as a graceful fallback', () => {
    expect(perspectiveDisplayName('gyn-onc')).toBe('Gyn Onc');
    expect(perspectiveDisplayName('neuro_onc')).toBe('Neuro Onc');
  });
});
