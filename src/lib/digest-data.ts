// Read digest artifacts written by build/digest-builder.ts.
// Astro pages use this at build time to enumerate paths and render content.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assignSlugsForDate } from './slug-resolve.ts';

// Detail union (v0.4.0 → v0.4.2):
//   - flat string for single statements
//   - {text, subdetails[]} for 1D nested rows (v0.4.1)
//   - {text, table:{columns, rows}} for 2D matrix comparisons (v0.4.2)
export type DigestTable = { columns: string[]; rows: string[][] };
export type DigestDetail =
  | string
  | { text: string; subdetails: string[] }
  | { text: string; table: DigestTable };

// v0.5+: typed source reference. Resolves to bookmarks/papers/slides
// in the rendered page. Older v0.4 artifacts use tweet_ids only.
export type DigestSourceRef =
  | { type: 'tweet'; id: number }
  | { type: 'paper'; id: number }
  | { type: 'slide'; id: number };

export type DigestStudy = {
  name: string;
  tldr: string;
  details: DigestDetail[];
  // v0.4: optional promoted figure. Both fields are null when the per-study
  // agent abstains or when the post-hoc OCR validator rejects the caption.
  // v0.4.3: caption may also be a DigestTable for comparison-chart figures.
  key_figure_url?: string | null;
  key_figure_caption?: string | DigestTable | null;
  nct: string | null;
  // v0.4: synthetic ids. v0.5+ prefers source_ids for typed refs.
  tweet_ids: number[];
  source_ids?: DigestSourceRef[];
  // v0.6+: stable per-study slug. Older artifacts won't have this — renderers
  // should fall back to deriveSlug(name) from src/lib/slug.ts.
  slug?: string;
  // v0.7+ analyst verdict (see VOICE.md "SOC-implication verdict").
  // Optional — older artifacts won't have it.
  verdict?: StudyVerdict;
  // v0.8.1: per-study open questions (Phase 2). Older artifacts carry these at
  // the site level (DigestSite.open_questions); renderers fall back to that.
  open_questions?: string[] | null;
};

export type SocImplication =
  | 'practice-changing'
  | 'challenges-soc'
  | 'confirmatory'
  | 'early-signal'
  | 'methodologically-limited'
  | 'unclear';

export type StudyVerdict = {
  soc_implication: SocImplication;
  rationale: string;
  audience: string | null;
};

export type DigestArtifactPaper = {
  id: number;
  pmid: string | null;
  doi: string | null;
  pmc_id: string | null;
  title: string;
  authors: string[];
  journal: string | null;
  pub_date: string | null;
  abstract: string | null;
  // fulltext_excerpt_md is intentionally absent from the artifact type: it's
  // not written to data/digests (kept out of git for copyright) and nothing
  // renders it. The build-time LLM reads it from the DB instead.
  pdf_path?: string | null; // v0.8 PR2: local vault path; never rendered on the public site, stripped from the API
  note: string | null;
};

export type DigestArtifactSlide = {
  id: number;
  file_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  source_label: string | null;
  ocr_text: string | null;
  note: string | null;
  source_batch_key: string | null;
};

export type DigestSite = {
  disease_site: string;
  intro: string | null;
  studies: DigestStudy[];
  open_questions: string[] | null;
};

// Disclosure: surfaces incompleteness rather than silently omitting. Older
// (v0.3) artifacts don't carry this field; consumers should treat absence
// as "no disclosure data available."
export type DigestMeta = {
  clusters_total: number;
  studies_analyzed: number;
  dropped: Array<{ slug: string; name: string; reason: string }>;
  ocr_available: boolean;
};

export type DigestArtifact = {
  date: string; // YYYY-MM-DD
  conference: { slug: string; name: string } | null;
  generated_at: number;
  digest: {
    top_line: string;
    tldr: string;
    sites: DigestSite[];
    meta?: DigestMeta; // v0.4+
  };
  bookmarks: Array<{
    id: number;
    url: string;
    bookmark_date: string;
    author_handle: string | null;
    author_name: string | null;
    text: string;
    html: string | null;
    image_urls: string[];
    image_ocr_texts?: string[]; // v0.4+, aligned with image_urls
    note: string | null;
    fetched_via: string;
    conference_slug: string | null;
  }>;
  papers?: DigestArtifactPaper[]; // v0.5+
  slides?: DigestArtifactSlide[]; // v0.5+
};

const DIGEST_ROOT = resolve(process.cwd(), 'data/digests');

// Returns all digest artifacts, newest first. Flat directory layout:
// data/digests/YYYY-MM-DD.json. Filename matches the artifact's date field.
export function listDigests(): DigestArtifact[] {
  if (!existsSync(DIGEST_ROOT)) return [];
  const out: DigestArtifact[] = [];
  let entries: string[];
  try {
    entries = readdirSync(DIGEST_ROOT);
  } catch {
    return [];
  }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(DIGEST_ROOT, file), 'utf-8');
      const parsed = JSON.parse(raw) as DigestArtifact;
      out.push(parsed);
    } catch {
      // Skip malformed files rather than break the entire build.
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function getDigest(date: string): DigestArtifact | null {
  return listDigests().find((d) => d.date === date) ?? null;
}

export type ConferenceSummary = {
  slug: string;
  name: string;
  dates: string[]; // YYYY-MM-DD, newest first
};

// Aggregation by disease site: every study from every digest that's tagged with
// the given site, newest first. Used by /sites/[site]/ pages.
export type SiteStudyOccurrence = {
  date: string; // YYYY-MM-DD
  conference: { slug: string; name: string } | null;
  study: DigestStudy;
  bookmarks: DigestArtifact['bookmarks']; // bookmarks referenced by this study
  papers?: DigestArtifactPaper[]; // v0.5+: papers referenced by this study
  slides?: DigestArtifactSlide[]; // v0.5+: slides referenced by this study
};

export type SiteSummary = {
  disease_site: string;
  occurrences: SiteStudyOccurrence[];
};

export function listSiteSummaries(): SiteSummary[] {
  const bySite = new Map<string, SiteStudyOccurrence[]>();
  for (const artifact of listDigests()) {
    const bookmarkById = new Map(artifact.bookmarks.map((b) => [b.id, b]));
    const papersById = new Map((artifact.papers ?? []).map((p) => [p.id, p]));
    const slidesById = new Map((artifact.slides ?? []).map((s) => [s.id, s]));
    for (const site of artifact.digest.sites) {
      if (!bySite.has(site.disease_site)) bySite.set(site.disease_site, []);
      const list = bySite.get(site.disease_site)!;
      for (const study of site.studies) {
        // v0.5: typed refs preferred; tweet_ids is the back-compat fallback.
        const refs: DigestSourceRef[] = study.source_ids ?? study.tweet_ids.map((id) => ({ type: 'tweet' as const, id }));
        const studyBookmarks = refs
          .filter((r) => r.type === 'tweet')
          .map((r) => bookmarkById.get(r.id))
          .filter((b): b is NonNullable<typeof b> => Boolean(b));
        const studyPapers = refs
          .filter((r) => r.type === 'paper')
          .map((r) => papersById.get(r.id))
          .filter((p): p is DigestArtifactPaper => Boolean(p));
        const studySlides = refs
          .filter((r) => r.type === 'slide')
          .map((r) => slidesById.get(r.id))
          .filter((s): s is DigestArtifactSlide => Boolean(s));
        list.push({
          date: artifact.date,
          conference: artifact.conference,
          study,
          bookmarks: studyBookmarks,
          papers: studyPapers.length > 0 ? studyPapers : undefined,
          slides: studySlides.length > 0 ? studySlides : undefined,
        });
      }
    }
  }
  return Array.from(bySite.entries()).map(([disease_site, occurrences]) => ({
    disease_site,
    occurrences: occurrences.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  }));
}

export type RecentStudy = {
  date: string;
  conference: DigestArtifact['conference'];
  disease_site: string;
  study: DigestStudy;
  // Per-date resolved slug (matches the anchor id on [date].astro). Always
  // populated — falls back to deriveSlug(name) for old artifacts and
  // suffixes -2/-3 for same-day collisions, exactly like the search index.
  slug: string;
};

// Flat list of recently-added studies across all dates. Used by the homepage
// hero strip so a returning reader sees the last N study additions, not a
// list of dates. Iterates listDigests() (date-desc) and emits in render order
// within each date; assignSlugsForDate() makes the slugs match the [date]
// page anchors so /<date>/#<slug> deep-links resolve correctly.
export function listRecentStudies(limit: number): RecentStudy[] {
  const out: RecentStudy[] = [];
  for (const artifact of listDigests()) {
    const allStudiesOnDate = artifact.digest.sites.flatMap((s) => s.studies);
    const slugs = assignSlugsForDate(allStudiesOnDate);
    let i = 0;
    for (const site of artifact.digest.sites) {
      for (const study of site.studies) {
        out.push({
          date: artifact.date,
          conference: artifact.conference,
          disease_site: site.disease_site,
          study,
          slug: slugs[i++]!,
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// Groups all conference-tagged digests by their conference slug.
// Used for the conference index pages and for the homepage badges.
export function listConferenceSummaries(): ConferenceSummary[] {
  const byConf = new Map<string, ConferenceSummary>();
  for (const a of listDigests()) {
    if (!a.conference) continue;
    const key = a.conference.slug;
    if (!byConf.has(key)) {
      byConf.set(key, { slug: key, name: a.conference.name, dates: [] });
    }
    byConf.get(key)!.dates.push(a.date);
  }
  return Array.from(byConf.values()).map((c) => ({
    ...c,
    dates: c.dates.sort((a, b) => (a < b ? 1 : -1)),
  }));
}
