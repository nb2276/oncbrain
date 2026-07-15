import { describe, it, expect } from 'vitest';
import { buildPriorCoverageLines } from '../src/lib/inbox-enrichment.ts';

const nct = (nct: string, date: string, name: string, slug: string) => ({ nct, date, name, slug });
const acr = (key: string, date: string, name: string, slug: string) => ({ key, date, name, slug });

describe('buildPriorCoverageLines', () => {
  it('formats an NCT hit with a drop line + the NCT tag', () => {
    const lines = buildPriorCoverageLines([nct('NCT03449719', '2026-06-12', 'ARTO', 'arto')], []);
    expect(lines).toEqual([
      '• ARTO — covered 2026-06-12 (NCT03449719)\n   reply "drop 2026-06-12/arto" to suppress that earlier card',
    ]);
  });

  it('formats an acronym hit with a drop line and no tag', () => {
    const lines = buildPriorCoverageLines([], [acr('HYDRA', '2026-07-08', 'HYDRA (MARCAP)', 'hydra-marcap')]);
    expect(lines[0]).toContain('• HYDRA (MARCAP) — covered 2026-07-08');
    expect(lines[0]).toContain('reply "drop 2026-07-08/hydra-marcap"');
    expect(lines[0]).not.toContain('(NCT');
  });

  it('dedups an acronym hit against an NCT hit by dedup KEY, not display name', () => {
    // Same trial covered twice earlier: once with an NCT under a fuller name,
    // once acronym-only. A new source matching both must produce ONE line.
    const lines = buildPriorCoverageLines(
      [nct('NCT12345678', '2026-05-31', 'ENZARAD (ANZUP 1303)', 'enzarad')],
      [acr('ENZARAD', '2026-06-25', 'ENZARAD', 'enzarad-paper')],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ENZARAD (ANZUP 1303)');
  });

  it('keeps distinct trials as separate lines', () => {
    const lines = buildPriorCoverageLines(
      [nct('NCT1', '2026-06-12', 'ARTO', 'arto')],
      [acr('HYDRA', '2026-07-08', 'HYDRA', 'hydra')],
    );
    expect(lines).toHaveLength(2);
  });

  it('omits the drop line when the earlier card has no slug', () => {
    const lines = buildPriorCoverageLines([], [acr('OLDTRIAL', '2026-01-01', 'OLDTRIAL', '')]);
    expect(lines).toEqual(['• OLDTRIAL — covered 2026-01-01']);
  });

  it('returns an empty array when there are no hits', () => {
    expect(buildPriorCoverageLines([], [])).toEqual([]);
  });
});
