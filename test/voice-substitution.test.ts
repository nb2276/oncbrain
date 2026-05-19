import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadVoice } from '../src/lib/llm-pipeline.ts';

const REPO_ROOT = resolve(__dirname, '..');
const VOICE_PATH = resolve(REPO_ROOT, 'VOICE.md');
const PROMPT_PATHS = {
  grouping: resolve(REPO_ROOT, 'prompts/digest-v5-grouping.txt'),
  studyAgent: resolve(REPO_ROOT, 'prompts/digest-v5-study-agent.txt'),
  synthesis: resolve(REPO_ROOT, 'prompts/digest-v5-synthesis.txt'),
};

describe('VOICE.md + {{VOICE}} substitution', () => {
  it('VOICE.md exists at repo root and is non-trivial', () => {
    const content = readFileSync(VOICE_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(500);
  });

  it('VOICE.md declares the canonical banned-words list', () => {
    const v = loadVoice();
    // Sample of the AI-isms that must never appear in digest output.
    expect(v).toMatch(/delve/);
    expect(v).toMatch(/crucial/);
    expect(v).toMatch(/robust/);
    expect(v).toMatch(/comprehensive/);
    expect(v).toMatch(/nuanced/);
  });

  it('VOICE.md declares the em-dash prohibition', () => {
    expect(loadVoice()).toMatch(/No em dashes/);
  });

  it('VOICE.md declares the effect-size-verbatim rule', () => {
    expect(loadVoice()).toMatch(/no effect size reported in source/i);
  });

  it('VOICE.md carries the per-study bullet emoji vocabulary', () => {
    const v = loadVoice();
    for (const emoji of ['📊', '🔍', '💊', '📐', '⚠️', '🔗', '❓']) {
      expect(v).toContain(emoji);
    }
  });

  it('every Phase prompt declares a {{VOICE}} placeholder', () => {
    for (const [phase, path] of Object.entries(PROMPT_PATHS)) {
      const template = readFileSync(path, 'utf-8');
      expect(template, `${phase} prompt missing {{VOICE}}`).toContain('{{VOICE}}');
    }
  });

  it('substituted prompt embeds the voice content and drops the placeholder', () => {
    const template = readFileSync(PROMPT_PATHS.studyAgent, 'utf-8');
    const out = template.replace('{{VOICE}}', loadVoice());
    expect(out).not.toContain('{{VOICE}}');
    // Banned word from VOICE.md surfaces in the assembled prompt.
    expect(out).toContain('delve');
    // Phase-specific structural marker still present (we only replaced VOICE).
    expect(out).toContain('═══ DEPTH ═══');
  });

  it('VOICE.md itself contains no em dashes (eats its own dogfood)', () => {
    const v = loadVoice();
    // U+2014 em dash. U+2013 en dash is also out — flag both.
    expect(v).not.toMatch(/—/);
    expect(v).not.toMatch(/–/);
  });
});
