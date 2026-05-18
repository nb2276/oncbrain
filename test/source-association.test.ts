import { describe, it, expect } from 'vitest';
import { buildAssociationGraph, renderGroupsForPrompt } from '../src/lib/source-association.ts';
import type { DigestInputItem } from '../src/lib/llm-pipeline.ts';

describe('buildAssociationGraph', () => {
  it('groups items sharing an NCT id with strength 10', () => {
    const items: DigestInputItem[] = [
      { source_type: 'tweet', id: 1, author: '@x', text: 'NCT04567890 OS HR 0.62' },
      {
        source_type: 'paper',
        id: 5,
        pmid: '42139645',
        title: 'Lu-PSMA in mCRPC',
        abstract: 'NCT04567890 phase III...',
      },
    ];
    const groups = buildAssociationGraph(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.strength).toBe(10);
    expect(groups[0]!.reason).toContain('NCT04567890');
    // Synthetic ids: tweet stays as 1, paper becomes 1_000_000_000 + 5
    expect(groups[0]!.item_ids).toEqual([1, 1_000_000_005]);
  });

  it('groups items sharing a trial acronym with strength 3', () => {
    const items: DigestInputItem[] = [
      { source_type: 'tweet', id: 1, author: null, text: 'PRESTIGE-PSMA mPFS 14.2 mo' },
      { source_type: 'tweet', id: 2, author: null, text: 'Discussant on PRESTIGE-PSMA — practice-changing' },
    ];
    const groups = buildAssociationGraph(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.strength).toBe(3);
    expect(groups[0]!.reason).toContain('PRESTIGE-PSMA');
  });

  it('skips single-occurrence acronyms (no false groups)', () => {
    const items: DigestInputItem[] = [
      { source_type: 'tweet', id: 1, author: null, text: 'PRESTIGE-PSMA was discussed.' },
      { source_type: 'tweet', id: 2, author: null, text: 'unrelated tweet about something else' },
    ];
    expect(buildAssociationGraph(items)).toHaveLength(0);
  });

  it('blacklists common endpoints/genes (no over-merge)', () => {
    const items: DigestInputItem[] = [
      { source_type: 'tweet', id: 1, author: null, text: 'OS HR 0.62 PFS HR 0.58' },
      { source_type: 'tweet', id: 2, author: null, text: 'OS not significant for HER2 subgroup' },
    ];
    // OS, HR, PFS, HER2 are all blacklisted. Expect no spurious group.
    expect(buildAssociationGraph(items)).toHaveLength(0);
  });

  it('does not duplicate a group when NCT and acronym both match', () => {
    const items: DigestInputItem[] = [
      { source_type: 'tweet', id: 1, author: null, text: 'PRESTIGE-PSMA / NCT04567890 mPFS 14.2' },
      { source_type: 'tweet', id: 2, author: null, text: 'PRESTIGE-PSMA NCT04567890 commentary' },
    ];
    const groups = buildAssociationGraph(items);
    // NCT match wins; acronym group is subsumed (same item set)
    expect(groups).toHaveLength(1);
    expect(groups[0]!.strength).toBe(10);
  });

  it('produces multiple groups when items split across different NCTs', () => {
    const items: DigestInputItem[] = [
      { source_type: 'tweet', id: 1, author: null, text: 'NCT04567890 ...' },
      { source_type: 'tweet', id: 2, author: null, text: 'NCT04567890 ...' },
      { source_type: 'tweet', id: 3, author: null, text: 'NCT05111111 different trial' },
      { source_type: 'tweet', id: 4, author: null, text: 'NCT05111111 also different' },
    ];
    const groups = buildAssociationGraph(items);
    expect(groups).toHaveLength(2);
  });
});

describe('renderGroupsForPrompt', () => {
  it('returns a friendly message when no groups exist', () => {
    expect(renderGroupsForPrompt([])).toContain('No pre-computed');
  });

  it('labels strong vs medium groups', () => {
    const out = renderGroupsForPrompt([
      { group_id: 'nct04567890', item_ids: [1, 2], reason: 'shared NCT04567890', strength: 10 },
      { group_id: 'prestige-psma', item_ids: [3, 4], reason: 'shared acronym PRESTIGE-PSMA', strength: 3 },
    ]);
    expect(out).toContain('STRONG');
    expect(out).toContain('medium');
    expect(out).toContain('NCT04567890');
    expect(out).toContain('PRESTIGE-PSMA');
  });
});
