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

const MAX_STUDIES = 12;

export function formatChannelPost(artifact: ChannelArtifact, siteUrl: string): string {
  const sites = artifact.digest.sites.filter((s) => s.studies.length > 0);
  const url = `${siteUrl.replace(/\/$/, '')}/${artifact.date}/`;
  const conf = artifact.conference?.name ? ` · ${artifact.conference.name}` : '';

  const lines: string[] = [`🧠 oncbrain · ${artifact.date}${conf}`];
  if (artifact.digest.top_line?.trim()) lines.push('', artifact.digest.top_line.trim());

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
  const shown = studyLines.slice(0, MAX_STUDIES);
  if (studyLines.length > MAX_STUDIES) shown.push(`…and ${studyLines.length - MAX_STUDIES} more`);
  if (shown.length) lines.push('', ...shown);

  lines.push('', `Full digest → ${url}`);
  return lines.join('\n');
}
