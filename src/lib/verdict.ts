// SOC-implication verdict taxonomy — the visual vocabulary shared by the study
// card (the pill) and the desktop triage rail (the jump-list marker). One
// source so the emoji/label can't drift between the two surfaces.
// Assignment rules + maturity gates are a voice concern (see VOICE.md).
import type { SocImplication } from './digest-data.ts';

export const VERDICT_META: Record<SocImplication, { emoji: string; label: string }> = {
  'practice-changing': { emoji: '🚀', label: 'Practice-changing' },
  'challenges-soc': { emoji: '↔️', label: 'Challenges SOC' },
  'confirmatory': { emoji: '🔄', label: 'Confirmatory' },
  'early-signal': { emoji: '🧪', label: 'Early signal' },
  'methodologically-limited': { emoji: '⚠️', label: 'Caveats dominate' },
  'unclear': { emoji: '❔', label: 'Unclear' },
};

// Null-safe lookup for studies whose verdict may be absent (older artifacts).
export function verdictMetaFor(
  soc: SocImplication | undefined | null,
): { emoji: string; label: string } | null {
  return soc ? VERDICT_META[soc] ?? null : null;
}

// Light-mode verdict accent hex, lifted here (v0.14 T4) so the build-time OG
// share-image generator can color the verdict label without importing CSS.
// StudyCard.astro mirrors these on `.study.verdict-*` (CSS can't read a TS
// const); keep the two in sync. `confirmatory` + `unclear` map to the theme
// tokens, inlined here to their LIGHT-MODE values: --accent #0a4b8a (Base.astro)
// and --fg-muted #555. The other four are the literal hexes in StudyCard.astro.
export const VERDICT_COLOR: Record<SocImplication, string> = {
  'practice-changing': '#1a5e3a',
  'challenges-soc': '#9a5a1a',
  'confirmatory': '#0a4b8a',
  'early-signal': '#1a6a7a',
  'methodologically-limited': '#8a3a1a',
  'unclear': '#555',
};

export function verdictColorFor(soc: SocImplication | undefined | null): string | null {
  return soc ? VERDICT_COLOR[soc] ?? null : null;
}
