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
    top_line: string;
    tldr: string;
    sites: Array<{
      disease_site: string;
      intro: string | null;
      studies: Array<{
        name: string;
        tldr: string;
        details: Array<
          | string
          | { text: string; subdetails: string[] }
          | { text: string; table: { columns: string[]; rows: string[][] } }
        >;
        key_figure_url?: string | null;
        key_figure_caption?: string | null;
        nct: string | null;
        tweet_ids: number[];
      }>;
      open_questions: string[] | null;
    }>;
    meta?: {
      clusters_total: number;
      studies_analyzed: number;
      dropped: Array<{ slug: string; name: string; reason: string }>;
      ocr_available: boolean;
    };
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

// Disease-site label/emoji map. Duplicated from disease-sites.ts to keep
// obsidian-export.ts importable in test/runtime contexts without pulling the
// full Astro graph; the source of truth is src/lib/disease-sites.ts and these
// strings should match it.
const SITE_LABEL: Record<string, { label: string; emoji: string }> = {
  cns: { label: 'CNS', emoji: '🧠' },
  'head-neck': { label: 'Head & Neck', emoji: '🦷' },
  thoracic: { label: 'Thoracic / Lung', emoji: '🫁' },
  breast: { label: 'Breast', emoji: '🌸' },
  'upper-gi': { label: 'Upper GI', emoji: '🍽️' },
  hepatobiliary: { label: 'Hepatobiliary', emoji: '🍷' },
  'lower-gi': { label: 'Lower GI', emoji: '🌽' },
  gyn: { label: 'Gynecologic', emoji: '🌷' },
  prostate: { label: 'Prostate', emoji: '🍇' },
  bladder: { label: 'Bladder', emoji: '💧' },
  kidney: { label: 'Kidney', emoji: '🥑' },
  'gu-other': { label: 'Germ Cell / Other GU', emoji: '🍒' },
  skin: { label: 'Skin / Melanoma', emoji: '🌞' },
  sarcoma: { label: 'Sarcoma', emoji: '🦴' },
  leukemia: { label: 'Leukemia', emoji: '🩸' },
  lymphoma: { label: 'Lymphoma', emoji: '🪷' },
  myeloma: { label: 'Myeloma / Plasma Cell', emoji: '🩹' },
  'oligo-mets': { label: 'Oligometastatic / Mets', emoji: '🎯' },
  supportive: { label: 'Supportive / QoL', emoji: '🤝' },
  safety: { label: 'Safety / Regulatory', emoji: '⚠️' },
  'multi-site': { label: 'Cross-cutting', emoji: '📊' },
  other: { label: 'Other', emoji: '📋' },
};

function siteHeader(slug: string): { label: string; emoji: string } {
  return SITE_LABEL[slug] ?? SITE_LABEL['other']!;
}

function renderBody(artifact: DigestArtifactForExport): string {
  const { date, conference, digest, bookmarks } = artifact;
  const bookmarksById = new Map(bookmarks.map((b) => [b.id, b]));
  const titleSuffix = conference ? ` — ${conference.name}` : '';

  const lines: string[] = [];
  lines.push('', `# ${date}${titleSuffix}`, '');

  if (digest.top_line) {
    lines.push(`**${wikilinkify(digest.top_line)}**`, '');
  }

  lines.push('> [!summary] TL;DR');
  for (const line of wikilinkify(digest.tldr).split('\n')) {
    lines.push(`> ${line}`);
  }
  lines.push('');

  for (const site of digest.sites) {
    const header = siteHeader(site.disease_site);
    lines.push(`## ${header.emoji} ${header.label}`, '');

    if (site.intro) {
      lines.push(wikilinkify(site.intro), '');
    }

    for (const study of site.studies) {
      const nctSuffix = study.nct ? ` · [[${study.nct}]]` : '';
      lines.push(`### ${study.name}${nctSuffix}`, '');
      lines.push(`> ${wikilinkify(study.tldr)}`, '');

      if (study.key_figure_url) {
        const alt = study.key_figure_caption ?? study.name;
        lines.push(`![${alt}](${study.key_figure_url})`);
        if (study.key_figure_caption) {
          lines.push(`*${study.key_figure_caption}*`);
        }
        lines.push('');
      }

      if (study.details.length > 0) {
        for (const d of study.details) {
          if (typeof d === 'string') {
            lines.push(`- ${wikilinkify(d)}`);
          } else if ('table' in d) {
            lines.push(`- ${wikilinkify(d.text)}`);
            // Markdown table — Obsidian and standard markdown viewers both render.
            // Header row + separator + data rows. Cell text is wikilinkified.
            const escapeCell = (c: string) => wikilinkify(c).replace(/\|/g, '\\|');
            lines.push('');
            lines.push(`  | ${d.table.columns.map(escapeCell).join(' | ')} |`);
            lines.push(`  |${d.table.columns.map(() => '---').join('|')}|`);
            for (const row of d.table.rows) {
              lines.push(`  | ${row.map(escapeCell).join(' | ')} |`);
            }
            lines.push('');
          } else {
            lines.push(`- ${wikilinkify(d.text)}`);
            for (const sub of d.subdetails) {
              lines.push(`  - ${wikilinkify(sub)}`);
            }
          }
        }
        lines.push('');
      }

      const sources = study.tweet_ids
        .map((id) => bookmarksById.get(id))
        .filter((b): b is NonNullable<typeof b> => Boolean(b));
      if (sources.length > 0) {
        lines.push('**Sources:**');
        for (const b of sources) {
          const who = b.author_name ?? b.author_handle ?? 'unknown';
          const handleSuffix = b.author_handle && b.author_name ? ` (${b.author_handle})` : '';
          lines.push(`- [${who}${handleSuffix}](${b.url})`);
          lines.push(`  > ${wikilinkify(b.text).replace(/\n/g, '\n  > ')}`);
          if (b.note) lines.push(`  - 📝 *Curator note:* ${b.note}`);
        }
        lines.push('');
      }
    }

    if (site.open_questions && site.open_questions.length > 0) {
      lines.push(`> [!question] Open questions`);
      for (const q of site.open_questions) lines.push(`> - ${wikilinkify(q)}`);
      lines.push('');
    }
  }

  const seeAlso: string[] = [];
  if (conference) seeAlso.push(`[[${conference.name}]]`);
  const prev = shiftDate(date, -1);
  const next = shiftDate(date, +1);
  seeAlso.push(`[[${prev}]]`);
  seeAlso.push(`[[${next}]]`);

  // v0.4: surface build disclosures (dropped clusters, OCR availability) so
  // the reader can audit what was excluded rather than silently inferring
  // completeness.
  if (digest.meta && (digest.meta.dropped.length > 0 || !digest.meta.ocr_available)) {
    lines.push('---', '', '## Build disclosures', '');
    lines.push(
      `${digest.meta.studies_analyzed}/${digest.meta.clusters_total} study cluster${digest.meta.clusters_total === 1 ? '' : 's'} analyzed successfully.`,
    );
    if (!digest.meta.ocr_available) {
      lines.push('On-device OCR was unavailable — figure captions omitted.');
    }
    if (digest.meta.dropped.length > 0) {
      lines.push('', '**Dropped clusters:**', '');
      for (const d of digest.meta.dropped) {
        lines.push(`- **${d.name}** (\`${d.slug}\`): ${d.reason}`);
      }
    }
    lines.push('');
  }

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
