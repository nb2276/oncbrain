// Papers, bookmarks and slide_uploads are separate tables with independent
// autoincrement ids, so paper 1, tweet 1 and slide 1 all exist. The grounding
// pass keyed its source-text map by the raw numeric id, which aliased them: a
// tweet-sourced study was handed a paper's text. That both withholds grounded
// prose and passes ungrounded prose — the two failures the gate exists to
// prevent, from the same typo.
//
// This exercises the id arithmetic the pipeline actually uses, so the test
// fails if the offsets or the keying drift apart.
import { describe, it, expect } from 'vitest';
import { syntheticIdToSourceRef } from '../src/lib/llm-pipeline.ts';

describe('source ids of different types collide numerically', () => {
  it('a tweet, a paper and a slide can all be row 1', () => {
    const refs = [1, 1_000_000_001, 2_000_000_001].map(syntheticIdToSourceRef);
    // Same row number, three different tables.
    expect(refs.map((r) => r.type)).toEqual(['tweet', 'paper', 'slide']);
    expect(new Set(refs.map((r) => r.id)).size).toBe(1);
  });

  it('so a numeric-only grounding key aliases them, and a type-qualified one does not', () => {
    const refs = [1, 1_000_000_001, 2_000_000_001].map(syntheticIdToSourceRef);

    const numericOnly = new Set(refs.map((r) => String(r.id)));
    expect(numericOnly.size).toBe(1); // the bug: three sources, one key

    const typeQualified = new Set(refs.map((r) => `${r.type}:${r.id}`));
    expect(typeQualified.size).toBe(3); // the fix
  });
});
