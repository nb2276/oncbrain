// JSON API payload shapers (v0.8 PR3, E1).
//
// Pure functions over the digest artifacts so they're testable without an
// Astro request context. The route files in src/pages/api/v1/ are thin
// wrappers that call these and JSON-serialize the result. The /api/v1/
// namespace is a published contract — additive changes only.

import type { DigestArtifact, DigestStudy } from './digest-data.ts';
import { assignSlugsForDate } from './slug-resolve.ts';

export const API_VERSION = 'v1';

export type DigestIndexEntry = {
  date: string;
  conference: { slug: string; name: string } | null;
  study_count: number;
  site_count: number;
};

export type DigestsIndex = {
  api_version: string;
  generated_at: number;
  count: number;
  digests: DigestIndexEntry[];
};

// GET /api/v1/digests.json — the list of published days with counts.
export function buildDigestsIndex(artifacts: DigestArtifact[]): DigestsIndex {
  const digests = artifacts.map((a) => ({
    date: a.date,
    conference: a.conference,
    study_count: a.digest.sites.reduce((n, s) => n + s.studies.length, 0),
    site_count: a.digest.sites.length,
  }));
  return {
    api_version: API_VERSION,
    generated_at: Date.now(),
    count: digests.length,
    digests,
  };
}

// GET /api/v1/digest/<date>.json serves the artifact, but the artifact's
// papers must NOT leak copyrighted full text or local vault paths. Allowlist
// the public-safe paper fields (drops pdf_path + any historical
// fulltext_excerpt_md). Bookmarks (public tweets) and slides (served via
// public/slides) are already public, so they pass through unchanged.
export type ApiPaper = {
  id: number;
  pmid: string | null;
  doi: string | null;
  pmc_id: string | null;
  title: string;
  authors: string[];
  journal: string | null;
  pub_date: string | null;
  abstract: string | null;
  source_url: string | null; // v0.15.3: public article URL (the link for trade-press papers); safe to expose, unlike pdf_path/fulltext
  note: string | null;
};

export function sanitizeArtifactForApi(
  artifact: DigestArtifact,
): Omit<DigestArtifact, 'papers'> & { api_version: string; papers?: ApiPaper[] } {
  const papers: ApiPaper[] = (artifact.papers ?? []).map((p) => ({
    id: p.id,
    pmid: p.pmid,
    doi: p.doi,
    pmc_id: p.pmc_id,
    title: p.title,
    authors: p.authors,
    journal: p.journal,
    pub_date: p.pub_date,
    abstract: p.abstract,
    source_url: p.source_url ?? null,
    note: p.note,
  }));
  return {
    api_version: API_VERSION,
    ...artifact,
    papers: papers.length > 0 ? papers : undefined,
  };
}

export type StudyOccurrence = {
  date: string;
  conference: { slug: string; name: string } | null;
  disease_site: string;
  study: DigestStudy;
};

// Group every study across every date by its per-date-resolved slug (the same
// slug the [date] page anchors and search index use). One slug → all the dates
// it appeared on, newest first. Used for getStaticPaths AND the per-study
// payload so /api/v1/study/<slug>.json resolves cross-date.
export function collectStudyOccurrencesBySlug(
  artifacts: DigestArtifact[],
): Map<string, StudyOccurrence[]> {
  const bySlug = new Map<string, StudyOccurrence[]>();
  for (const a of artifacts) {
    const allStudiesOnDate = a.digest.sites.flatMap((s) => s.studies);
    const slugs = assignSlugsForDate(allStudiesOnDate);
    let i = 0;
    for (const site of a.digest.sites) {
      for (const study of site.studies) {
        const slug = slugs[i++]!;
        const occ: StudyOccurrence = {
          date: a.date,
          conference: a.conference,
          disease_site: site.disease_site,
          study,
        };
        const list = bySlug.get(slug);
        if (list) list.push(occ);
        else bySlug.set(slug, [occ]);
      }
    }
  }
  return bySlug;
}

export type StudyPayload = {
  api_version: string;
  slug: string;
  name: string;
  occurrence_count: number;
  occurrences: StudyOccurrence[];
};

// GET /api/v1/study/<slug>.json — one study, every date it was covered.
// occurrences are newest-first (artifacts are date-desc); name comes from the
// most recent occurrence.
export function buildStudyPayload(slug: string, occurrences: StudyOccurrence[]): StudyPayload {
  return {
    api_version: API_VERSION,
    slug,
    name: occurrences[0]?.study.name ?? slug,
    occurrence_count: occurrences.length,
    occurrences,
  };
}
