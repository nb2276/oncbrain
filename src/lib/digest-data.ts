// Read digest artifacts written by build/digest-builder.ts.
// Astro pages use this at build time to enumerate paths and render content.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export type DigestArtifact = {
  conference: { slug: string; name: string; day: number };
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
    author_handle: string | null;
    author_name: string | null;
    text: string;
    note: string | null;
    fetched_via: string;
  }>;
};

const DIGEST_ROOT = resolve(process.cwd(), 'data/digests');

export function listDigests(): DigestArtifact[] {
  if (!existsSync(DIGEST_ROOT)) return [];
  const out: DigestArtifact[] = [];
  for (const slug of readdirSync(DIGEST_ROOT)) {
    const confDir = join(DIGEST_ROOT, slug);
    let entries: string[];
    try {
      entries = readdirSync(confDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(confDir, file), 'utf-8');
        out.push(JSON.parse(raw) as DigestArtifact);
      } catch {
        // Skip malformed files rather than break the entire build.
      }
    }
  }
  return out;
}

export type ConferenceSummary = {
  slug: string;
  name: string;
  days: number[];
};

export function listConferenceSummaries(): ConferenceSummary[] {
  const byConf = new Map<string, ConferenceSummary>();
  for (const a of listDigests()) {
    const key = a.conference.slug;
    if (!byConf.has(key)) {
      byConf.set(key, { slug: key, name: a.conference.name, days: [] });
    }
    byConf.get(key)!.days.push(a.conference.day);
  }
  return Array.from(byConf.values()).map((c) => ({
    ...c,
    days: c.days.sort((a, b) => a - b),
  }));
}
