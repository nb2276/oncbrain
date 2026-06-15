import { describe, it, expect } from 'vitest';
import { countStudies, obsidianFilesForDate } from '../build/studio.ts';

// Pure helpers behind studio's "Build + publish a day" option.

describe('obsidianFilesForDate', () => {
  const entries = [
    '2026-06-14.md', // the bare note
    '2026-06-14-asco.md', // conference variant
    '2026-06-13.md', // a different date
    '2026-06-140.md', // prefix false-match trap (no real date is this)
    '2026-06-14.json', // not a markdown note
    'papers', // the gitignored PDF subdir
  ];

  it('matches the bare note and any conference variant for the date', () => {
    expect(obsidianFilesForDate('2026-06-14', entries)).toEqual([
      '2026-06-14.md',
      '2026-06-14-asco.md',
    ]);
  });

  it('does NOT match a different date that shares the prefix (the trailing hyphen guards it)', () => {
    // '2026-06-140.md' starts with '2026-06-14' but not '2026-06-14-'.
    expect(obsidianFilesForDate('2026-06-14', entries)).not.toContain('2026-06-140.md');
  });

  it('excludes non-markdown entries (the JSON digest, the papers/ dir)', () => {
    const out = obsidianFilesForDate('2026-06-14', entries);
    expect(out).not.toContain('2026-06-14.json');
    expect(out).not.toContain('papers');
  });

  it('returns nothing when no file matches the date', () => {
    expect(obsidianFilesForDate('2026-01-01', entries)).toEqual([]);
    expect(obsidianFilesForDate('2026-06-14', [])).toEqual([]);
  });
});

describe('countStudies', () => {
  it('returns 0 for a null artifact (missing digest)', () => {
    expect(countStudies(null)).toBe(0);
  });

  it('returns 0 for a hollow digest (no sites) — the empty-day publish guard', () => {
    expect(countStudies({ digest: { sites: [] } } as never)).toBe(0);
  });

  it('returns 0 when sites exist but carry no studies', () => {
    const art = { digest: { sites: [{ disease_site: 'breast', studies: [] }] } };
    expect(countStudies(art as never)).toBe(0);
  });

  it('sums studies across every site', () => {
    const art = {
      digest: {
        sites: [
          { disease_site: 'breast', studies: [{ name: 'A' }, { name: 'B' }] },
          { disease_site: 'prostate', studies: [{ name: 'C' }] },
        ],
      },
    };
    expect(countStudies(art as never)).toBe(3);
  });
});
