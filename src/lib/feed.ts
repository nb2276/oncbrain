// RSS 2.0 feed for the digest (v0.8 PR3, E1).
//
// One <item> per recently-added study (newest first), so a reader following
// the feed sees individual study additions rather than whole-day dumps. Each
// item carries the analyst verdict + audience + TL;DR and deep-links into the
// study's card on its date page. Hand-rolled (no @astrojs/rss dependency) —
// the shape is small and XML escaping is the only sharp edge.

import type { RecentStudy } from './digest-data.ts';
import type { SocImplication } from './digest-data.ts';

const VERDICT_LABEL: Record<SocImplication, string> = {
  'practice-changing': 'Practice-changing',
  'challenges-soc': 'Challenges SOC',
  confirmatory: 'Confirmatory',
  'early-signal': 'Early signal',
  'methodologically-limited': 'Caveats dominate',
  unclear: 'Unclear',
};

const FEED_TITLE = 'oncbrain — oncology meeting digest';
const FEED_DESCRIPTION =
  'AI-summarized oncology meeting studies, curated by a subspecialist. One item per study.';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// RFC-822-ish date for <pubDate>. The artifact carries a YYYY-MM-DD; render it
// as UTC midnight so feed readers get a stable, valid timestamp.
function toRfc822(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toUTCString();
}

// Compose the human-readable item body: verdict tag, eligibility audience (when
// the trial is narrow enough to gate), then the TL;DR.
function studyDescription(s: RecentStudy): string {
  const parts: string[] = [];
  const verdict = s.study.verdict;
  if (verdict) {
    parts.push(`[${VERDICT_LABEL[verdict.soc_implication]}]`);
  }
  parts.push(s.study.tldr);
  if (verdict?.audience) parts.push(`Eligible: ${verdict.audience}`);
  return parts.join(' ');
}

export function studiesToRss(studies: RecentStudy[], siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  const items = studies
    .map((s) => {
      const link = `${base}/${s.date}/#${s.slug}`;
      const pub = toRfc822(s.date);
      return [
        '    <item>',
        `      <title>${escapeXml(s.study.name)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        pub ? `      <pubDate>${pub}</pubDate>` : '',
        `      <category>${escapeXml(s.disease_site)}</category>`,
        `      <description>${escapeXml(studyDescription(s))}</description>`,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const lastBuild = studies.length > 0 ? toRfc822(studies[0]!.date) : new Date().toUTCString();

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(FEED_TITLE)}</title>`,
    `    <link>${escapeXml(base)}/</link>`,
    `    <description>${escapeXml(FEED_DESCRIPTION)}</description>`,
    '    <language>en</language>',
    lastBuild ? `    <lastBuildDate>${lastBuild}</lastBuildDate>` : '',
    items,
    '  </channel>',
    '</rss>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}
