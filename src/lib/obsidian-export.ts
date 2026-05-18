// Render a digest artifact as Obsidian-flavored markdown.
//
// What Obsidian gets that the JSON/HTML doesn't:
//   - YAML frontmatter (Obsidian shows in Properties pane, drives queries)
//   - Wikilinks [[NCT04567890]] / [[PMID 12345]] / [[ASCO 2026]] — Obsidian's
//     graph view connects everything
//   - Callouts > [!summary] / > [!info] for visual emphasis
//   - Tags (#oncology/digest etc.) for the tag panel
//
// Output is committed alongside the JSON. User points Obsidian at data/obsidian/
// (open as vault, or symlink into an existing vault).

export type DigestArtifactForExport = {
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
    author_handle: string | null;
    author_name: string | null;
    text: string;
    note: string | null;
    fetched_via: string;
    conference_slug: string | null;
  }>;
};

export type ObsidianRenderOptions = {
  publicSiteUrl?: string; // e.g. https://oncbrain.oncologytoolkit.com
};

export function renderObsidian(
  artifact: DigestArtifactForExport,
  opts: ObsidianRenderOptions = {},
): string {
  return [renderFrontmatter(artifact, opts), renderBody(artifact)].join('\n') + '\n';
}

// Regexes that match the same citation forms as src/lib/extract.ts, but emit
// Obsidian wikilinks `[[NCT04567890]]` instead of <a> tags. Trial numbers and
// PMIDs become standalone notes Obsidian can backlink across digests.
const NCT_RE = /\bNCT\d{8}\b/gi;
const PMID_RE = /\b(?:PMID|PubMed)[:\s]\s*(\d{4,9})\b/gi;
const DOI_RE = /(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,}\/[^\s"<>)]+)/gi;

export function wikilinkify(text: string): string {
  if (!text) return '';
  type Span = { start: number; end: number; label: string };
  const spans: Span[] = [];

  const collect = (re: RegExp, labelFor: (m: RegExpExecArray) => string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0]!.length, label: labelFor(m) });
    }
  };

  collect(new RegExp(NCT_RE.source, 'gi'), (m) => m[0]!.toUpperCase());
  collect(new RegExp(PMID_RE.source, 'gi'), (m) => `PMID ${m[1]!}`);
  collect(new RegExp(DOI_RE.source, 'gi'), (m) => `doi:${m[1]!}`);

  // First-wins on overlap.
  spans.sort((a, b) => a.start - b.start);
  const filtered: Span[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    filtered.push(s);
    cursor = s.end;
  }

  let out = '';
  let last = 0;
  for (const s of filtered) {
    out += text.slice(last, s.start);
    out += `[[${s.label}]]`;
    last = s.end;
  }
  out += text.slice(last);
  return out;
}

function renderFrontmatter(artifact: DigestArtifactForExport, opts: ObsidianRenderOptions): string {
  const tags = ['oncology/digest'];
  if (artifact.conference) {
    const confTag = artifact.conference.slug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-');
    tags.push(`conference/${confTag}`);
  }
  const year = artifact.date.slice(0, 4);
  tags.push(`year/${year}`);

  const url = opts.publicSiteUrl ? `${opts.publicSiteUrl.replace(/\/$/, '')}/${artifact.date}/` : null;

  const lines = ['---', `date: ${artifact.date}`];
  if (artifact.conference) {
    lines.push(`conference: ${quote(artifact.conference.name)}`);
    lines.push(`conference-slug: ${artifact.conference.slug}`);
  }
  lines.push(`source-count: ${artifact.bookmarks.length}`);
  if (url) lines.push(`url: ${url}`);
  lines.push('tags:');
  for (const t of tags) lines.push(`  - ${t}`);
  lines.push('---');
  return lines.join('\n');
}

function renderBody(artifact: DigestArtifactForExport): string {
  const { date, conference, digest, bookmarks } = artifact;
  const bookmarksById = new Map(bookmarks.map((b) => [b.id, b]));
  const titleSuffix = conference ? ` — ${conference.name}` : '';

  const lines: string[] = [];
  lines.push('', `# ${date}${titleSuffix}`, '');

  lines.push('> [!summary] TL;DR');
  for (const line of wikilinkify(digest.tldr).split('\n')) {
    lines.push(`> ${line}`);
  }
  lines.push('');

  for (const cluster of digest.clusters) {
    lines.push(`## ${cluster.topic}`, '');
    lines.push(wikilinkify(cluster.summary), '');

    const sources = cluster.tweet_ids
      .map((id) => bookmarksById.get(id))
      .filter((b): b is NonNullable<typeof b> => Boolean(b));

    if (sources.length > 0) {
      lines.push('### Sources', '');
      for (const b of sources) {
        const who = b.author_name ?? b.author_handle ?? 'unknown';
        const handleSuffix =
          b.author_handle && b.author_name ? ` (${b.author_handle})` : '';
        lines.push(`- [${who}${handleSuffix}](${b.url})`);
        lines.push(`  > ${wikilinkify(b.text).replace(/\n/g, '\n  > ')}`);
        if (b.note) lines.push(`  - 📝 *Curator note:* ${b.note}`);
      }
      lines.push('');
    }
  }

  // See also: link to neighboring dates and (if applicable) the conference note.
  const seeAlso: string[] = [];
  if (conference) seeAlso.push(`[[${conference.name}]]`);
  const prev = shiftDate(date, -1);
  const next = shiftDate(date, +1);
  seeAlso.push(`[[${prev}]]`);
  seeAlso.push(`[[${next}]]`);

  lines.push('---', '', '## See also', '');
  for (const s of seeAlso) lines.push(`- ${s}`);
  lines.push('');

  return lines.join('\n');
}

// Shift a YYYY-MM-DD string by N days (positive or negative). Returns YYYY-MM-DD.
function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10)) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// YAML scalar that contains characters needing quoting (colons, # signs, etc.)
// — wrap in double quotes and escape embedded double quotes.
function quote(s: string): string {
  if (/[:#&*!|>'"%@`]/.test(s) || /^[-?\s]/.test(s) || /\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}
