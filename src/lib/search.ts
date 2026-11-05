// Study search: what the index carries and how a query matches it.
//
// Shared by the build-time index (src/pages/search-index.json.ts) and the
// client (src/components/SearchBox.astro), so the matching rules are tested
// here once instead of living untested inside a <script> block.
//
// Matching: the query is split into words, and EVERY word must appear
// somewhere on the card (name, TL;DR, NCT, site, or the card's full text),
// in any order. "hypofractionation prostate" finds a prostate card whose
// fractionation discussion sits in an analysis section, not just one whose
// title holds that exact phrase.
//
// Ranking: a word in the study name outweighs one in the TL;DR, which
// outweighs one buried in the card body. Ties keep index order (newest first).

import type { DigestDetail, DigestStudy } from './digest-data.ts';

export type SearchEntry = {
  date: string;
  site: string;
  site_label: string;
  site_emoji: string;
  site_rationale: string;
  name: string;
  slug: string;
  /** Display TL;DR, trimmed for the result row. */
  tldr: string;
  nct: string | null;
  /** Full searchable card text (whitespace-collapsed). Never rendered whole. */
  body: string;
};

export type SearchHit = {
  entry: SearchEntry;
  score: number;
  /** Excerpt of `body` around a match, set only when some query word is
   *  found nowhere the result row already shows (name / TL;DR / NCT / site). */
  snippet: string | null;
};

export type HighlightPart = { text: string; hit: boolean };

const W_NAME = 8;
const W_NCT = 6;
const W_TLDR = 3;
const W_SITE = 2;
const W_BODY = 1;
const SNIPPET_RADIUS = 90;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function detailText(d: DigestDetail): string {
  if (typeof d === 'string') return d;
  const parts = [d.text];
  if ('subdetails' in d && Array.isArray(d.subdetails)) parts.push(...d.subdetails);
  if ('table' in d && d.table) {
    parts.push(d.table.columns.join(' '));
    for (const row of d.table.rows) parts.push(row.join(' '));
  }
  return parts.join(' ');
}

/** Every text surface of a card a reader could want to search. */
export function studySearchBody(study: DigestStudy, meetingName?: string | null): string {
  const parts: string[] = [study.tldr ?? ''];
  for (const d of study.details ?? []) parts.push(detailText(d));
  const pe = study.primary_endpoint;
  if (pe) parts.push(pe.name ?? '', pe.stat_value ?? '', pe.stat_detail ?? '');
  for (const a of study.analysis_sections ?? []) parts.push(a.label, a.body);
  if (study.significance) parts.push(study.significance);
  for (const v of Object.values(study.significance_by_specialty ?? {})) if (v) parts.push(v);
  if (study.presentation) {
    const p = study.presentation;
    parts.push(p.speaker ?? '', p.summary ?? '', ...(p.critique ?? []));
  }
  parts.push(...(study.discussed_trials ?? []));
  if (study.doi) parts.push(study.doi);
  if (meetingName) parts.push(meetingName);
  return collapse(parts.filter(Boolean).join(' '));
}

export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const t of query.toLowerCase().split(/\s+/)) if (t) seen.add(t);
  return [...seen];
}

function makeSnippet(body: string, token: string): string {
  const i = body.toLowerCase().indexOf(token);
  if (i < 0) return '';
  let start = Math.max(0, i - SNIPPET_RADIUS);
  let end = Math.min(body.length, i + token.length + SNIPPET_RADIUS);
  // Snap to word boundaries so the excerpt doesn't open mid-word.
  if (start > 0) {
    const sp = body.indexOf(' ', start);
    if (sp >= 0 && sp < i) start = sp + 1;
  }
  if (end < body.length) {
    const sp = body.lastIndexOf(' ', end);
    if (sp > i + token.length) end = sp;
  }
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

export function searchEntries(query: string, entries: SearchEntry[]): SearchHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const tldr = entry.tldr.toLowerCase();
    const nct = (entry.nct ?? '').toLowerCase();
    const site = entry.site_label.toLowerCase();
    const body = entry.body.toLowerCase();
    let score = 0;
    let bodyOnly: string | null = null;
    let ok = true;
    for (const t of tokens) {
      let s = 0;
      if (name.includes(t)) s += W_NAME;
      if (nct.includes(t)) s += W_NCT;
      if (tldr.includes(t)) s += W_TLDR;
      if (site.includes(t)) s += W_SITE;
      const shown = s > 0;
      if (body.includes(t)) s += W_BODY;
      if (s === 0) {
        ok = false;
        break;
      }
      if (!shown && bodyOnly === null) bodyOnly = t;
      score += s;
    }
    if (!ok) continue;
    // Whole query as a phrase in the name: the strongest signal there is.
    const phrase = tokens.join(' ');
    if (tokens.length > 1 && name.includes(phrase)) score += W_NAME;
    hits.push({ entry, score, snippet: bodyOnly ? makeSnippet(entry.body, bodyOnly) : null });
  }
  // Array.prototype.sort is stable, so equal scores keep newest-first order.
  return hits.sort((a, b) => b.score - a.score);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split text into hit / non-hit runs for highlighting. The caller escapes
 *  each part, so markup is never built from unescaped input. */
export function highlightParts(text: string, tokens: string[]): HighlightPart[] {
  const ts = tokens.filter(Boolean).sort((a, b) => b.length - a.length);
  if (ts.length === 0 || !text) return [{ text, hit: false }];
  const re = new RegExp(ts.map(escapeRegExp).join('|'), 'gi');
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ text: text.slice(last, i), hit: false });
    parts.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
