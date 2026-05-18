// Read digest artifacts written by build/digest-builder.ts.
// Astro pages use this at build time to enumerate paths and render content.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export type DigestStudy = {
  name: string;
  tldr: string;
  details: string[];
  nct: string | null;
  tweet_ids: number[];
};

export type DigestSite = {
  disease_site: string;
  intro: string | null;
  studies: DigestStudy[];
  open_questions: string[] | null;
};

export type DigestArtifact = {
  date: string; // YYYY-MM-DD
  conference: { slug: string; name: string } | null;
  generated_at: number;
  digest: {
    top_line: string;
    tldr: string;
    sites: DigestSite[];
  };
  bookmarks: Array<{
    id: number;
    url: string;
    bookmark_date: string;
    author_handle: string | null;
    author_name: string | null;
    text: string;
    html: string | null;
    note: string | null;
    fetched_via: string;
    conference_slug: string | null;
  }>;
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
  bookmarks: DigestArtifact['bookmarks']; // bookmarks referenced by this study's tweet_ids
};

export type SiteSummary = {
  disease_site: string;
  occurrences: SiteStudyOccurrence[];
};

export function listSiteSummaries(): SiteSummary[] {
  const bySite = new Map<string, SiteStudyOccurrence[]>();
  for (const artifact of listDigests()) {
    const bookmarkById = new Map(artifact.bookmarks.map((b) => [b.id, b]));
    for (const site of artifact.digest.sites) {
      if (!bySite.has(site.disease_site)) bySite.set(site.disease_site, []);
      const list = bySite.get(site.disease_site)!;
      for (const study of site.studies) {
        const studyBookmarks = study.tweet_ids
          .map((id) => bookmarkById.get(id))
          .filter((b): b is NonNullable<typeof b> => Boolean(b));
        list.push({
          date: artifact.date,
          conference: artifact.conference,
          study,
          bookmarks: studyBookmarks,
        });
      }
    }
  }
  return Array.from(bySite.entries()).map(([disease_site, occurrences]) => ({
    disease_site,
    occurrences: occurrences.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  }));
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
