import { describe, it, expect } from 'vitest';
import { parseOpenQuestions } from '../src/lib/llm-pipeline.ts';
import { renderObsidian, type DigestArtifactForExport } from '../src/lib/obsidian-export.ts';

describe('parseOpenQuestions (v0.8.1)', () => {
  it('keeps a trimmed, non-empty list', () => {
    expect(parseOpenQuestions(['  Sequencing vs taxanes  ', 'Durability beyond 2y'])).toEqual([
      'Sequencing vs taxanes',
      'Durability beyond 2y',
    ]);
  });

  it('drops empties and caps at 5', () => {
    expect(parseOpenQuestions(['a', '', '  ', 'b'])).toEqual(['a', 'b']);
    expect(parseOpenQuestions(['1', '2', '3', '4', '5', '6'])).toHaveLength(5);
  });

  it('returns null for non-array, empty, or all-blank input', () => {
    expect(parseOpenQuestions(undefined)).toBeNull();
    expect(parseOpenQuestions('a question')).toBeNull();
    expect(parseOpenQuestions([])).toBeNull();
    expect(parseOpenQuestions(['  ', ''])).toBeNull();
  });
});

// Minimal artifact with one site + one study; siteOQ + studyOQ are toggles.
function artifact(opts: {
  studyOQ?: string[] | null;
  siteOQ?: string[] | null;
}): DigestArtifactForExport {
  return {
    date: '2026-05-19',
    conference: null,
    generated_at: 1,
    digest: {
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'prostate',
          intro: null,
          studies: [
            {
              name: 'PRESTIGE-PSMA',
              tldr: 't',
              details: [],
              nct: null,
              tweet_ids: [],
              open_questions: opts.studyOQ ?? null,
            },
          ],
          open_questions: opts.siteOQ ?? null,
        },
      ],
    },
    bookmarks: [],
  };
}

describe('renderObsidian — open questions (v0.8.1)', () => {
  it('renders per-study open questions under the study', () => {
    const md = renderObsidian(artifact({ studyOQ: ['Optimal sequencing vs cabazitaxel'] }));
    expect(md).toContain('> [!question] Open questions');
    expect(md).toContain('> - Optimal sequencing vs cabazitaxel');
  });

  it('suppresses the site-level list when a study has its own', () => {
    const md = renderObsidian(
      artifact({ studyOQ: ['Per-study Q'], siteOQ: ['Site-level Q'] }),
    );
    expect(md).toContain('Per-study Q');
    expect(md).not.toContain('Site-level Q'); // back-compat fallback suppressed
  });

  it('falls back to the site-level list for older artifacts (no per-study)', () => {
    const md = renderObsidian(artifact({ studyOQ: null, siteOQ: ['Legacy site Q'] }));
    expect(md).toContain('> - Legacy site Q');
  });
});
