// v0.60: conference abstracts from a meeting's own portal.
//
// A late-breaking or plenary abstract is often unreadable anywhere else for
// weeks: the journal supplement's DOI is registered with Crossref before its
// abstract text is (the ASTRO 2026 Red Journal DOIs sat abstract-less for 8+
// days while doi_watch re-checked them nightly). The meeting portal carries the
// full abstract, server-rendered, on the day it is presented.
//
// One adapter per portal. Each knows its host, how to recognise an abstract
// page URL, how to parse one, and how to enumerate the meeting's abstract
// listings for confirm-only matching (build/conference-abstracts.ts). Only
// ASTRO's amportal is implemented; a new meeting is a new entry in ADAPTERS.

import { createHash } from 'node:crypto';

export type ConferenceAbstract = {
  title: string;
  /** Presentation number as printed: "2", "LBA 03", "1021". */
  number: string | null;
  /** Session label as printed: "PL 01 - Plenary Session". */
  session: string | null;
  /** ISO date the abstract was presented, when the page states it. */
  presented_on: string | null;
  /** Meeting label from the portal, e.g. "ASTRO 2026". */
  meeting: string | null;
  presenter: string | null;
  authors: string[];
  /** Purpose/Methods/Results/Conclusion body, section labels kept inline. */
  abstract: string;
  nct: string | null;
};

export type ListingEntry = { number: string | null; title: string; url: string };

export type ConferenceAdapter = {
  id: string;
  host: string;
  isAbstractUrl(url: URL): boolean;
  parse(html: string, url: string): ConferenceAbstract;
  /** Server-rendered listing pages that together enumerate the meeting's abstracts. */
  listingUrls(lastPage: number): string[];
  /** Highest page number a listing's first page links to. */
  lastListingPage(html: string): number;
  parseListing(html: string): ListingEntry[];
};

export class NotAnAbstractError extends Error {}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));

const textOf = (html: string): string =>
  decodeEntities(html.replace(/<sup>[^<]*<\/sup>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// "2 - Initial Results…", "LBA 03 - SWOG S1827…". Discussant/session pages
// carry no number and are not abstracts.
const NUMBERED_TITLE_RE = /^((?:LBA\s*)?\d+)\s+-\s+(.+)$/i;

const ASTRO: ConferenceAdapter = {
  id: 'astro',
  host: 'amportal.astro.org',
  // /sessions/<session-code>/<title-slug>-<numeric id>
  isAbstractUrl: (u) => /^\/sessions\/[a-z0-9-]+\/[a-z0-9-]+-\d+\/?$/i.test(u.pathname),

  parse(html, url) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const heading = h1 ? textOf(h1[1]!) : '';
    const numbered = heading.match(NUMBERED_TITLE_RE);
    const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1];
    const title = numbered ? numbered[2]!.trim() : decodeEntities(ogTitle ?? heading).trim();

    // The abstract body: from the first section label to the end of its block.
    // Located by the label TEXT, not its markup: abstracts on the same portal
    // wrap it as <b>…</b>, <strong>…</strong>, inside <i>/<span>, etc.
    const label = html.search(/Purpose\s*\/\s*Objective/i);
    if (label < 0) throw new NotAnAbstractError(`no abstract body on ${url}`);
    const start = html.lastIndexOf('<', label);
    const share = html.indexOf('session__share', start);
    // Cut at the opening tag of the share block, not mid-attribute.
    const end = share > start ? html.lastIndexOf('<', share) : -1;
    const bodyHtml = html.slice(start, end > start ? end : undefined);
    // Keep each section label on its own line so the study agent sees structure.
    const abstract = textOf(bodyHtml)
      .replace(/\s*(Purpose\s*\/\s*Objective\(s\)|Materials\s*\/\s*Methods|Results|Conclusions?)\s*:/g, (_m, l: string) => `\n${l.replace(/\s+/g, '')}:`)
      .trim();
    if (abstract.length < 200) throw new NotAnAbstractError(`abstract body too short on ${url}`);

    // Author list: the paragraph after the presenter block, up to the
    // affiliations (italic) or the first semicolon.
    const presenterBlock = html.indexOf('session__presenter-name');
    let authors: string[] = [];
    let presenter: string | null = null;
    if (presenterBlock >= 0) {
      const after = html.slice(presenterBlock, start);
      const p = after.match(/<span><a [^>]*>([^<]+)<\/a>/);
      presenter = p ? decodeEntities(p[1]!).trim() : null;
      const authorP = after.match(/<p>([\s\S]*?)(?:<i>|;|<br)/i);
      if (authorP) {
        authors = textOf(authorP[1]!)
          .split(/,\s*/)
          .map((a) => a.replace(/\band\s+/i, '').trim())
          .filter((a) => /[A-Za-z]/.test(a) && a.length < 60);
      }
    }

    const session = html.match(/class="session__presentations-sub">([^<]+)</i)?.[1]?.trim() ?? null;
    const meeting = html.match(/<meta property="og:site_name" content="([^"]*)"/i)?.[1]?.trim() ?? null;
    const year = meeting?.match(/\b(20\d\d)\b/)?.[1];
    const dateBlock = html.match(
      /class="session__presentations-date">\s*([A-Za-z]{3})[a-z]*\s*<span class="session__presentations-date-big">(\d{1,2})</i,
    );
    const month = dateBlock ? MONTHS[dateBlock[1]!.toLowerCase()] : undefined;
    const presented_on =
      year && month && dateBlock ? `${year}-${month}-${dateBlock[2]!.padStart(2, '0')}` : null;

    const nct = abstract.match(/\bNCT\s?(\d{8})\b/i)?.[1];
    return {
      title,
      number: numbered ? numbered[1]!.replace(/\s+/g, ' ').toUpperCase() : null,
      session: session ? decodeEntities(session) : null,
      presented_on,
      meeting: meeting ? decodeEntities(meeting) : null,
      presenter,
      authors,
      abstract,
      nct: nct ? `NCT${nct}` : null,
    };
  },

  listingUrls: (lastPage) => {
    const out: string[] = [];
    for (const kind of ['abstracts', 'posters']) {
      for (let p = 1; p <= lastPage; p++) out.push(`https://amportal.astro.org/${kind}${p > 1 ? `?page=${p}` : ''}`);
    }
    return out;
  },

  lastListingPage: (html) =>
    Math.max(1, ...[...html.matchAll(/\/(?:abstracts|posters)\?page=(\d+)/g)].map((m) => Number(m[1]))),

  parseListing(html) {
    const out: ListingEntry[] = [];
    for (const m of html.matchAll(
      /<a href="(https:\/\/amportal\.astro\.org\/sessions\/[a-z0-9-]+\/[a-z0-9-]+-\d+)"[^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const t = textOf(m[2]!).match(NUMBERED_TITLE_RE);
      if (!t) continue; // discussant slots, session links
      out.push({ number: t[1]!.replace(/\s+/g, ' ').toUpperCase(), title: t[2]!.trim(), url: m[1]! });
    }
    return out;
  },
};

export const ADAPTERS: ConferenceAdapter[] = [ASTRO];

export function adapterForUrl(raw: string): ConferenceAdapter | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const a = ADAPTERS.find((x) => x.host === u.hostname.toLowerCase());
  return a && a.isAbstractUrl(u) ? a : null;
}

export function isConferenceAbstractUrl(raw: string): boolean {
  return adapterForUrl(raw) !== null;
}

/** Stable identity for an abstract page: host + path, no query or fragment. */
export function conferenceAbstractHash(raw: string): string {
  const u = new URL(raw);
  const key = `conf-abstract:${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
  return createHash('sha256').update(key).digest('hex');
}

// --- confirm-only matching -------------------------------------------------

const STOP = new Set(
  'a an and of the in for with vs versus or to on by from phase trial results randomized study patients'.split(' '),
);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

/**
 * Rank listing entries against a curator's short label ("NRG-GU003 — 5-year
 * hypofractionated vs conventional PORT"). Trial identifiers count double:
 * "GU003" in a title is near-proof, a shared word like "radiotherapy" is not.
 * Returns candidates for the curator to CONFIRM; never an automatic pick.
 */
export function rankListingMatches(label: string, entries: ListingEntry[], limit = 3): Array<ListingEntry & { score: number }> {
  const want = tokens(label);
  // Identifiers: mixed letter+digit ("gu003", "s1827") or a bare 4+ digit trial
  // number ("9601", "0815"). A dose ("30 Gy") is joined to its unit so it can
  // meet a title that prints "30Gy".
  const ids = [...want].filter((t) => (/\d/.test(t) && /[a-z]/.test(t)) || /^\d{4,}$/.test(t));
  const raw = label.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i + 1 < raw.length; i++) {
    if (/^\d+$/.test(raw[i]!) && /^(gy|cgy|fx|mo|months?|years?|yr)$/.test(raw[i + 1]!)) ids.push(raw[i]! + raw[i + 1]!);
  }
  const scored = entries.map((e) => {
    const have = tokens(e.title);
    let score = 0;
    for (const t of want) if (have.has(t)) score += ids.includes(t) ? 3 : 1;
    // A compact id like "s1827" or "a071801" may appear joined differently.
    const flat = e.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Counted here only when the token loop above didn't already score it.
    for (const id of ids) if (!(want.has(id) && have.has(id)) && flat.includes(id)) score += 3;
    return { ...e, score };
  });
  return scored
    .filter((e) => e.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
