import { describe, it, expect } from 'vitest';
import { buildPriorCoverageLines, buildPriorCoverageMessage } from '../src/lib/inbox-enrichment.ts';

const nct = (nct: string, date: string, name: string, slug: string) => ({ nct, date, name, slug });
const acr = (key: string, date: string, name: string, slug: string) => ({ key, date, name, slug });
// The drop offer is opt-in. These older cases assert the OFFER, so they clear it
// explicitly; the gating itself is covered in its own describe block below.
const ok = (...refs: string[]) => new Map(refs.map((r) => [r, { droppable: true }]));

describe('buildPriorCoverageLines', () => {
  it('formats an NCT hit with a drop line + the NCT tag', () => {
    const lines = buildPriorCoverageLines([nct('NCT03449719', '2026-06-12', 'ARTO', 'arto')], [], ok('2026-06-12/arto'));
    expect(lines).toEqual([
      '• ARTO — covered 2026-06-12 (NCT03449719)\n   reply "drop 2026-06-12/arto" to suppress that earlier card',
    ]);
  });

  it('formats an acronym hit with a drop line and no tag', () => {
    const lines = buildPriorCoverageLines([], [acr('HYDRA', '2026-07-08', 'HYDRA (MARCAP)', 'hydra-marcap')], ok('2026-07-08/hydra-marcap'));
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
      ok('2026-05-31/enzarad'),
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

// The enrich-time twin of the build-time DM's structured `droppable` flag.
// executeDedupDrop applies the structural guards but deliberately NOT the
// evidence gate, so a removal we PROPOSE is a removal the curator can act on —
// and this DM used to propose one for every raw NCT/acronym hit.
describe('the drop offer is opt-in', () => {
  const hit = [nct('NCT1', '2026-06-12', 'ARTO', 'arto')];

  it('withholds the token when nothing cleared the prior', () => {
    const [line] = buildPriorCoverageLines(hit, []);
    expect(line).toContain('• ARTO — covered 2026-06-12');
    expect(line).not.toContain('drop 2026-06-12/arto');
    expect(line).toContain('both will publish');
  });

  it('names a facet mismatch as the reason', () => {
    const [line] = buildPriorCoverageLines(hit, [], new Map([
      ['2026-06-12/arto', { droppable: false, reason: 'different objectives (primary-efficacy vs quality-of-life)' }],
    ]));
    expect(line).toContain('different objectives (primary-efficacy vs quality-of-life)');
    expect(line).not.toContain('drop 2026-06-12/arto');
  });

  it('offers the token only for a cleared prior', () => {
    const [line] = buildPriorCoverageLines(hit, [], ok('2026-06-12/arto'));
    expect(line).toContain('reply "drop 2026-06-12/arto"');
  });

  it('decides per prior, not per message', () => {
    const lines = buildPriorCoverageLines(
      [nct('NCT1', '2026-06-12', 'ARTO', 'arto')],
      [acr('HYDRA', '2026-07-08', 'HYDRA', 'hydra')],
      ok('2026-06-12/arto'),
    );
    expect(lines[0]).toContain('reply "drop 2026-06-12/arto"');
    expect(lines[1]).not.toContain('drop 2026-07-08/hydra');
  });
});

// The header is part of the offer. Gating only the per-prior lines left the
// invitation standing: every line prints its own date and slug, so a curator
// reading "unless you drop one" can hand-write the command from the line itself,
// and executeDedupDrop honours any well-formed command without the evidence gate.
describe('buildPriorCoverageMessage gates the header too', () => {
  const hit = [nct('NCT1', '2026-06-12', 'ARTO', 'arto')];

  it('proposes no removal when nothing cleared', () => {
    const msg = buildPriorCoverageMessage(hit, [], new Map([
      ['2026-06-12/arto', { droppable: false, reason: 'different objectives (primary-efficacy vs quality-of-life)' }],
    ]))!;
    expect(msg).not.toContain('unless you drop one');
    expect(msg).toContain('nothing here looks like a duplicate to drop');
    expect(msg).not.toContain('reply "drop');
  });

  it('keeps the invitation when at least one prior cleared', () => {
    const msg = buildPriorCoverageMessage(hit, [], ok('2026-06-12/arto'))!;
    expect(msg).toContain('unless you drop one');
    expect(msg).toContain('reply "drop 2026-06-12/arto"');
  });

  it('invites when ANY of several cleared, and only that one carries a token', () => {
    const msg = buildPriorCoverageMessage(
      [nct('NCT1', '2026-06-12', 'ARTO', 'arto')],
      [acr('HYDRA', '2026-07-08', 'HYDRA', 'hydra')],
      ok('2026-06-12/arto'),
    )!;
    expect(msg).toContain('unless you drop one');
    expect(msg).toContain('reply "drop 2026-06-12/arto"');
    expect(msg).not.toContain('reply "drop 2026-07-08/hydra"');
  });

  it('defaults to proposing nothing when no decisions are supplied', () => {
    const msg = buildPriorCoverageMessage(hit, [])!;
    expect(msg).not.toContain('unless you drop one');
  });

  it('returns null when there is nothing to report', () => {
    expect(buildPriorCoverageMessage([], [])).toBeNull();
  });
});
