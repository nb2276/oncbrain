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
