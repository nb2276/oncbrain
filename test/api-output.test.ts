import { describe, it, expect } from 'vitest';
import {
  buildDigestsIndex,
  collectStudyOccurrencesBySlug,
  buildStudyPayload,
  sanitizeArtifactForApi,
} from '../src/lib/api-output.ts';
import type { DigestArtifact } from '../src/lib/digest-data.ts';

function artifact(date: string, studyNames: string[]): DigestArtifact {
  return {
    date,
    conference: null,
    generated_at: 1,
    digest: {
      top_line: 't',
      tldr: 'd',
      sites: [
        {
          disease_site: 'prostate',
          intro: null,
          studies: studyNames.map((name) => ({
            name,
            tldr: 'x',
            details: [],
            key_figure_url: null,
            key_figure_caption: null,
            nct: null,
            tweet_ids: [],
          })),
          open_questions: null,
        },
      ],
      meta: { clusters_total: studyNames.length, studies_analyzed: studyNames.length, dropped: [], ocr_available: false },
    },
    bookmarks: [],
  };
}

describe('buildDigestsIndex', () => {
  it('reports per-date study + site counts', () => {
    const idx = buildDigestsIndex([artifact('2026-05-18', ['A', 'B']), artifact('2026-05-17', ['C'])]);
    expect(idx.api_version).toBe('v1');
    expect(idx.count).toBe(2);
    expect(idx.digests[0]).toMatchObject({ date: '2026-05-18', study_count: 2, site_count: 1 });
    expect(idx.digests[1]).toMatchObject({ date: '2026-05-17', study_count: 1 });
  });
});

describe('collectStudyOccurrencesBySlug', () => {
  it('groups the same study across dates under one slug, newest first', () => {
    // listDigests() is date-desc; mirror that ordering here.
    const bySlug = collectStudyOccurrencesBySlug([
      artifact('2026-05-18', ['PRESTIGE-PSMA']),
      artifact('2026-05-10', ['PRESTIGE-PSMA']),
    ]);
    const occ = bySlug.get('prestige-psma');
    expect(occ).toBeDefined();
    expect(occ!.map((o) => o.date)).toEqual(['2026-05-18', '2026-05-10']);
  });
});

describe('buildStudyPayload', () => {
  it('takes the name from the newest occurrence and counts them', () => {
    const bySlug = collectStudyOccurrencesBySlug([artifact('2026-05-18', ['PRESTIGE-PSMA'])]);
    const payload = buildStudyPayload('prestige-psma', bySlug.get('prestige-psma')!);
    expect(payload).toMatchObject({ api_version: 'v1', slug: 'prestige-psma', name: 'PRESTIGE-PSMA', occurrence_count: 1 });
  });
});

describe('sanitizeArtifactForApi (IP allowlist)', () => {
  it('strips pdf_path + any full text from papers, keeping the summary fields', () => {
    const a = artifact('2026-05-18', ['X']);
    // Inject a paper carrying both the local vault path and copyrighted text.
    (a as unknown as { papers: unknown[] }).papers = [
      {
        id: 1,
        pmid: null,
        doi: '10.1056/x',
        pmc_id: null,
        title: 'T',
        authors: ['A'],
        journal: 'J',
        pub_date: '2026',
        abstract: 'public abstract',
        fulltext_excerpt_md: 'SECRET COPYRIGHTED FULL TEXT',
        pdf_path: 'data/obsidian/papers/prostate/t.pdf',
        note: null,
      },
    ];
    const out = sanitizeArtifactForApi(a);
    expect(out.api_version).toBe('v1');
    const p = out.papers![0]!;
    expect(p.title).toBe('T');
    expect(p.abstract).toBe('public abstract');
    expect((p as Record<string, unknown>).pdf_path).toBeUndefined();
    expect((p as Record<string, unknown>).fulltext_excerpt_md).toBeUndefined();
    // Hard guarantee: neither the path nor the full text leaks anywhere.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('SECRET COPYRIGHTED FULL TEXT');
    expect(serialized).not.toContain('papers/prostate/t.pdf');
  });

  it('leaves papers undefined when there are none', () => {
    const out = sanitizeArtifactForApi(artifact('2026-05-18', ['X']));
    expect(out.papers).toBeUndefined();
  });
});
