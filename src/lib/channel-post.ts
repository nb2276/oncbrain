// v0.14.7 (T5): the reader-facing Telegram channel announcement for a day's
// digest. Distribution "cheap proof" — push the digest to a channel instead of
// waiting for a visit. Plain text (Telegram auto-links the URL and renders the
// /<date>/ OG card from T4 as the link preview); plain text also dodges the
// Markdown-escaping pitfalls in trial names like "FIRESTORM (BOOG 2010-03)".
import { getDiseaseSite } from './disease-sites.ts';
import { VERDICT_META } from './verdict.ts';
import type { SocImplication } from './digest-data.ts';

export type ChannelArtifact = {
  date: string;
  conference?: { name: string } | null;
  digest: {
    top_line?: string;
    sites: Array<{
      disease_site: string;
      studies: Array<{
        name: string;
        verdict?: { soc_implication: SocImplication } | null;
        is_preprint?: boolean;
      }>;
    }>;
  };
};

// Telegram collapses a long message behind "Show more", and the link preview
// sits BELOW the text — so a long body pushes the card out of view, which is the
// one thing a scrolling reader actually looks at. 8 keeps the post inside the
// fold on a phone; the corpus reaches 18 studies on its busiest day, so the
// overflow line is load-bearing, not theoretical.
const MAX_STUDIES = 8;

export function formatChannelPost(artifact: ChannelArtifact, siteUrl: string): string {
  const sites = artifact.digest.sites.filter((s) => s.studies.length > 0);
  const url = `${siteUrl.replace(/\/$/, '')}/${artifact.date}/`;
  const conf = artifact.conference?.name ? ` · ${artifact.conference.name}` : '';

  const lines: string[] = [`🧠 oncbrain · ${artifact.date}${conf}`];

  // top_line is DELIBERATELY absent here. The OG card renders it as its
  // headline, and Telegram shows that card directly beneath this text, so
  // including it prints the same sentence twice in one post. The two surfaces
  // own different jobs: the CARD carries the clinical takeaway (it is also the
  // only thing a reader sees when the URL is shared anywhere else, so it has to
  // stand alone), and the BODY carries the inventory and the link.

  // One scannable line per study: verdict emoji · name — site (preprint flag).
  const studyLines: string[] = [];
  for (const site of sites) {
    const meta = getDiseaseSite(site.disease_site);
    for (const study of site.studies) {
      const emoji = study.verdict ? VERDICT_META[study.verdict.soc_implication]?.emoji ?? '•' : '•';
      const pre = study.is_preprint ? ' (preprint)' : '';
      studyLines.push(`${emoji} ${study.name} — ${meta.label}${pre}`);
    }
  }

  if (studyLines.length === 1) {
    // A single-study day is the case the curator flagged: the card headline
    // already names that trial, so repeating its full name here is a third
    // printing of one fact. Keep only what the card does NOT carry — the
    // disease site and the SOC verdict.
    const site = sites[0]!;
    const study = site.studies[0]!;
    const meta = getDiseaseSite(site.disease_site);
    const v = study.verdict ? VERDICT_META[study.verdict.soc_implication] : null;
    const verdict = v ? ` · ${v.emoji} ${v.label.toLowerCase()}` : '';
    const pre = study.is_preprint ? ' · preprint' : '';
    lines.push('', `1 study · ${meta.label}${verdict}${pre}`);
  } else if (studyLines.length > 1) {
    const shown = studyLines.slice(0, MAX_STUDIES);
    if (studyLines.length > MAX_STUDIES) shown.push(`…and ${studyLines.length - MAX_STUDIES} more`);
    lines.push('', ...shown);
  }

  lines.push('', `Full digest → ${url}`);
  return lines.join('\n');
}
