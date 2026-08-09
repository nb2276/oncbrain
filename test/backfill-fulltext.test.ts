// build/backfill-fulltext.ts had no tests. It WRITES to papers.fulltext_excerpt_md,
// so its guards are the ones that decide whether a mass rebuild improves the
// corpus or quietly degrades it. The two that matter:
//   - it must not overwrite a clean excerpt with Vision OCR of a scanned PDF
//     (db.ts savePaper refuses that; this CLI writes the column directly and has
//     to honour the same rule itself), and
//   - its budget must agree with inbox-enrichment's, including rejecting a
//     negative value, because composeExcerpt's fallback does slice(0, maxChars)
//     and a negative end index is SUFFIX semantics — it would store the paper.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { composeExcerpt, DEFAULT_EXCERPT_CHARS } from '../src/lib/fulltext-sections.ts';

const CLI = readFileSync(resolve(process.cwd(), 'build/backfill-fulltext.ts'), 'utf-8');

describe('backfill-fulltext CLI guards', () => {
  it('refuses to touch every paper implicitly', () => {
    expect(CLI).toMatch(/Refusing to touch every paper implicitly/);
    expect(CLI).toMatch(/if \(!all && !dateFilter && !idFilter\)/);
  });

  it('skips a scanned PDF rather than overwriting a clean excerpt with OCR', () => {
    expect(CLI).toMatch(/extracted\.via === 'ocr'/);
    expect(CLI).toMatch(/skippedOcr\+\+/);
    // and the skip happens BEFORE the write
    expect(CLI.indexOf("extracted.via === 'ocr'")).toBeLessThan(CLI.indexOf('update.run(composed.text'));
  });

  it('gates every write behind --dry-run', () => {
    expect(CLI).toMatch(/if \(!dryRun\) update\.run\(composed\.text, r\.id\)/);
  });

  it('parameterises the SQL and never interpolates a caller value', () => {
    expect(CLI).toMatch(/UPDATE papers SET fulltext_excerpt_md = \? WHERE id = \?/);
    expect(CLI).toMatch(/where\.push\('bookmark_date = \?'\)/);
    expect(CLI).toMatch(/where\.push\('id = \?'\)/);
    expect(CLI).not.toMatch(/\$\{(dateFilter|idFilter)\}/);
  });

  it('requires a positive budget, matching inbox-enrichment', () => {
    expect(CLI).toMatch(/Number\.isFinite\(n\) && n > 0/);
  });
});

describe('a negative budget can never reach composeExcerpt', () => {
  it('would be catastrophic if it did, which is why both readers gate on > 0', () => {
    // Documents the hazard the guard exists for: slice(0, -5) is suffix
    // semantics, so a negative budget returns almost the entire document into a
    // column the IP boundary says is local-only.
    const doc = 'x'.repeat(50_000);
    expect(composeExcerpt(doc, { maxChars: -5 }).text.length).toBeGreaterThan(40_000);
    // The shipped default is positive, so the real path is safe.
    expect(DEFAULT_EXCERPT_CHARS).toBeGreaterThan(0);
  });
});
