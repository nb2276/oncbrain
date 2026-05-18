// Read digest artifacts written by build/digest-builder.ts.
// Astro pages use this at build time to enumerate paths and render content.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export type DigestArtifact = {
  date: string; // YYYY-MM-DD
  conference: { slug: string; name: string } | null;
  generated_at: number;
  digest: {
    tldr: string;
    clusters: Array<{
      topic: string;
      summary: string;
      tweet_ids: number[];
    }>;
  };
  bookmarks: Array<{
    id: number;
    url: string;
    bookmark_date: string;
    author_handle: string | null;
    author_name: string | null;
    text: string;
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
