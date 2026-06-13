import { describe, it, expect } from 'vitest';
import {
  buildDigestsIndex,
  collectStudyOccurrencesBySlug,
  buildStudyPayload,
  sanitizeArtifactForApi,
} from '../src/lib/api-output.ts';
import type {
  DigestArtifact,
  RelatedTrial,
  RelatedTrialsProvenance,
} from '../src/lib/digest-data.ts';

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
        source_url: 'https://www.urotoday.com/article.html',
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
    // v0.15.3: source_url (a public citation link) IS exposed — it's the link
    // for trade-press papers — while pdf_path + full text stay stripped.
    expect(p.source_url).toBe('https://www.urotoday.com/article.html');
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

// v0.13: related-trials + provenance pass through sanitizeArtifactForApi
// unchanged because the type extension on DigestStudy added optional fields
// that survive the spread. These tests lock that contract so a future
// refactor that picks fields manually can't silently drop them.
describe('sanitizeArtifactForApi (v0.13: related_trials + provenance)', () => {
  function rt(over: Partial<RelatedTrial> & { nct: string; answers_question: string }): RelatedTrial {
    return {
      nct: over.nct,
      brief_title: over.brief_title ?? 'Trial title',
      overall_status: over.overall_status ?? 'RECRUITING',
      phase: over.phase ?? ['PHASE3'],
      enrollment_count: over.enrollment_count ?? 1200,
      primary_completion_date: over.primary_completion_date ?? '2027-03',
      brief_summary: over.brief_summary ?? null,
      conditions: over.conditions ?? [],
      interventions: over.interventions ?? [],
      eligibility_brief: over.eligibility_brief ?? null,
      answers_question: over.answers_question,
      relevance_phrase: over.relevance_phrase ?? 'directly tests the open question',
    };
  }

  function provenance(over: Partial<RelatedTrialsProvenance> = {}): RelatedTrialsProvenance {
    return {
      queries_fired: ['lutetium PSMA cabazitaxel sequencing'],
      queries_failed: [],
      candidates_returned: 18,
      fetched_at: '2026-06-09T00:00:00Z',
      rerank_outcome: 'picked_N',
      ...over,
    };
  }

  it('preserves related_trials on each study through the API serialization', () => {
    const a = artifact('2026-06-09', ['PRESTIGE-PSMA']);
    a.digest.sites[0]!.studies[0]!.open_questions = ['Optimal sequencing vs cabazitaxel'];
    a.digest.sites[0]!.studies[0]!.related_trials = [
      rt({ nct: 'NCT05000001', answers_question: 'Optimal sequencing vs cabazitaxel' }),
    ];
    a.digest.sites[0]!.studies[0]!.related_trials_provenance = provenance();
    const out = sanitizeArtifactForApi(a);
    const study = out.digest.sites[0]!.studies[0]!;
    expect(study.related_trials).toHaveLength(1);
    expect(study.related_trials![0]!.nct).toBe('NCT05000001');
    expect(study.related_trials![0]!.answers_question).toBe('Optimal sequencing vs cabazitaxel');
    expect(study.related_trials![0]!.relevance_phrase).toBe('directly tests the open question');
  });

  it('preserves the provenance block including queries_fired / fetched_at / rerank_outcome', () => {
    const a = artifact('2026-06-09', ['PRESTIGE-PSMA']);
    a.digest.sites[0]!.studies[0]!.related_trials_provenance = provenance({
      queries_fired: ['lutetium PSMA cabazitaxel sequencing', 'PSMA radioligand long-term followup'],
      queries_failed: [{ term: 'failed term', reason: 'empty' }],
      candidates_returned: 25,
      rerank_outcome: 'picked_N',
    });
    const out = sanitizeArtifactForApi(a);
    const prov = out.digest.sites[0]!.studies[0]!.related_trials_provenance!;
    expect(prov.queries_fired).toEqual([
      'lutetium PSMA cabazitaxel sequencing',
      'PSMA radioligand long-term followup',
    ]);
    expect(prov.queries_failed).toEqual([{ term: 'failed term', reason: 'empty' }]);
    expect(prov.candidates_returned).toBe(25);
    expect(prov.fetched_at).toBe('2026-06-09T00:00:00Z');
    expect(prov.rerank_outcome).toBe('picked_N');
  });

  it('serializes cleanly for older artifacts without any related_trials field', () => {
    const a = artifact('2026-05-18', ['X']);
    const out = sanitizeArtifactForApi(a);
    const study = out.digest.sites[0]!.studies[0]!;
    // Per-study property checks instead of a substring search over the
    // serialized JSON; the substring is too coarse (would false-positive
    // on a future unrelated field like related_trials_eligible_count).
    expect(study).not.toHaveProperty('related_trials');
    expect(study).not.toHaveProperty('related_trials_provenance');
  });

  it('serializes a mixed digest (some studies have related_trials, others do not)', () => {
    const a = artifact('2026-06-09', ['PRESTIGE-PSMA', 'OTHER-STUDY']);
    a.digest.sites[0]!.studies[0]!.open_questions = ['q1'];
    a.digest.sites[0]!.studies[0]!.related_trials = [
      rt({ nct: 'NCT05000001', answers_question: 'q1' }),
    ];
    a.digest.sites[0]!.studies[0]!.related_trials_provenance = provenance();
    // studies[1] is left as-is (no related_trials)
    const out = sanitizeArtifactForApi(a);
    expect(out.digest.sites[0]!.studies[0]!.related_trials).toHaveLength(1);
    expect(out.digest.sites[0]!.studies[1]!.related_trials).toBeUndefined();
  });

  it('preserves pinned_by_curator provenance state (PR-3 contract)', () => {
    const a = artifact('2026-06-09', ['PRESTIGE-PSMA']);
    a.digest.sites[0]!.studies[0]!.open_questions = ['q1'];
    a.digest.sites[0]!.studies[0]!.related_trials = [
      rt({ nct: 'NCT05000001', answers_question: 'q1', relevance_phrase: 'curator-vetted' }),
    ];
    a.digest.sites[0]!.studies[0]!.related_trials_provenance = provenance({
      rerank_outcome: 'pinned_by_curator',
    });
    const out = sanitizeArtifactForApi(a);
    expect(
      out.digest.sites[0]!.studies[0]!.related_trials_provenance!.rerank_outcome,
    ).toBe('pinned_by_curator');
  });

  it('preserves null related_trials when the orchestrator returned null (failed / abstained)', () => {
    const a = artifact('2026-06-09', ['PRESTIGE-PSMA']);
    a.digest.sites[0]!.studies[0]!.related_trials = null;
    a.digest.sites[0]!.studies[0]!.related_trials_provenance = provenance({
      rerank_outcome: 'abstained',
    });
    const out = sanitizeArtifactForApi(a);
    expect(out.digest.sites[0]!.studies[0]!.related_trials).toBeNull();
    expect(
      out.digest.sites[0]!.studies[0]!.related_trials_provenance!.rerank_outcome,
    ).toBe('abstained');
  });
});
