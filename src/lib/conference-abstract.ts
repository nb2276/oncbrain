// v0.60: conference abstracts from a meeting's own portal.
//
// A late-breaking or plenary abstract is often unreadable anywhere else for
// weeks: the journal supplement's DOI is registered with Crossref before its
// abstract text is (the ASTRO 2026 Red Journal DOIs sat abstract-less for 8+
// days while doi_watch re-checked them nightly). The meeting portal carries the
// full abstract, server-rendered, on the day it is presented.
//
// One adapter per portal. Each knows its host, how to recognise an abstract
// page URL, how to parse one, which listings enumerate the meeting's abstracts
// (for confirm-only matching, build/conference-abstracts.ts) and which journal
// supplement its DOIs live in. Only ASTRO's amportal is implemented; a new
// meeting is a new entry in ADAPTERS.
//
// Publication: the parsed abstract goes into papers.abstract, the published
// field, by curator decision (v0.60 review): it is the same text the meeting's
// journal supplement prints, treated like a PubMed/Crossref abstract.

import { createHash } from 'node:crypto';
import { decodeHtmlEntities } from './html-meta.ts';
import { normalizeDoi } from './doi.ts';
import { ownRegistrations } from './extract.ts';

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
  /** Section-labelled body (Purpose/Methods/Results/Conclusion), one label per line. */
  abstract: string;
  nct: string | null;
};

export type ListingEntry = { number: string | null; title: string; url: string };

export type ConferenceAdapter = {
  id: string;
  host: string;
  /** Registrant/prefix of the meeting's journal-supplement DOIs, lowercase. */
  doiPrefix: string;
  /** Listing paths that together enumerate the meeting's abstracts. */
  listingPaths: string[];
  isAbstractUrl(url: URL): boolean;
  parse(html: string, url: string): ConferenceAbstract;
  /** Highest page number a listing's first page links to. */
  lastListingPage(html: string): number;
  parseListing(html: string): ListingEntry[];
};

export class NotAnAbstractError extends Error {}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** An abstract body longer than this is not one abstract: fail closed. */
const MAX_ABSTRACT_CHARS = 8000;
const MIN_ABSTRACT_CHARS = 200;

const stripNonContent = (html: string): string =>
  html.replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, '');

// Visible text of an HTML fragment. Superscripts are KEPT as "^x": in a body
// they carry exponents and units (10^-5, mg/m^2) that the numbers depend on.
const bodyText = (html: string): string =>
  decodeHtmlEntities(html.replace(/<sup[^>]*>([^<]*)<\/sup>/gi, '^$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// Author-block text: there, superscripts are affiliation markers and go.
const authorText = (html: string): string =>
  decodeHtmlEntities(html.replace(/<sup[^>]*>[^<]*<\/sup>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// "2 - Initial Results…", "LBA 03 - SWOG S1827…". Discussant/session pages
// carry no number and are not abstracts.
const NUMBERED_TITLE_RE = /^((?:LBA\s*)?\d+)\s+-\s+(.+)$/i;

// The first section label of an abstract body. Most use Purpose/Objective(s);
// some late-breakers open with Background or Introduction.
const FIRST_LABEL_RE = /Purpose\s*\/\s*Objective|\bBackground\s*:|\bIntroduction\s*:|\bObjectives?\s*:/i;
const LABEL_LINE_RE =
  /\s*(Purpose\s*\/\s*Objective\(s\)|Background|Introduction|Objectives?|Materials\s*\/\s*Methods|Methods|Results|Conclusions?)\s*:/g;

const ASTRO: ConferenceAdapter = {
  id: 'astro',
  host: 'amportal.astro.org',
  doiPrefix: '10.1016/j.ijrobp.',
  listingPaths: ['abstracts', 'posters'],
  // /sessions/<session-code>/<title-slug>-<numeric id>
  isAbstractUrl: (u) => /^\/sessions\/[a-z0-9-]+\/[a-z0-9-]+-\d+\/?$/i.test(u.pathname),

  parse(rawHtml, url) {
    const html = stripNonContent(rawHtml);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!h1 || h1.index === undefined) throw new NotAnAbstractError(`no title on ${url}`);
    const heading = bodyText(h1[1]!);
    const numbered = heading.match(NUMBERED_TITLE_RE);
    const title = numbered ? numbered[2]!.trim() : heading;

    // The body lives AFTER the title (never in <head> metadata), starts at its
    // first section label and ends at the share block. Without both bounds the
    // page is not a single abstract: fail closed rather than publish page chrome.
    const afterTitle = h1.index + h1[0].length;
    const labelRel = html.slice(afterTitle).search(FIRST_LABEL_RE);
    if (labelRel < 0) throw new NotAnAbstractError(`no abstract body on ${url}`);
    const label = afterTitle + labelRel;
    const start = html.lastIndexOf('<', label);
    const share = html.indexOf('session__share', label);
    if (share < 0) throw new NotAnAbstractError(`abstract body has no end marker on ${url}`);
    const end = html.lastIndexOf('<', share);
    const abstract = bodyText(html.slice(start, end))
      .replace(LABEL_LINE_RE, (_m, l: string) => `\n${l.replace(/\s+/g, '')}:`)
      .trim();
    if (abstract.length < MIN_ABSTRACT_CHARS) throw new NotAnAbstractError(`abstract body too short on ${url}`);
    if (abstract.length > MAX_ABSTRACT_CHARS) throw new NotAnAbstractError(`abstract body too long on ${url}`);

    // Author list: the paragraph after the presenter block, up to the
    // affiliations (italic) or the first semicolon. Entities are decoded
    // BEFORE splitting so "Jos&eacute;" can't cut the list at its ';'.
    const presenterBlock = html.indexOf('session__presenter-name', afterTitle);
    let authors: string[] = [];
    let presenter: string | null = null;
    if (presenterBlock >= 0 && presenterBlock < start) {
      const after = html.slice(presenterBlock, start);
      const p = after.match(/<span><a [^>]*>([^<]+)<\/a>/);
      presenter = p ? decodeHtmlEntities(p[1]!).trim() : null;
      const authorP = after.match(/<p>([\s\S]*?)(?:<i>|<br)/i);
      if (authorP) {
        authors = authorText(authorP[1]!)
          .split(';')[0]!
          .split(/,\s*/)
          .map((a) => a.replace(/^and\s+/i, '').trim())
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

    // Only the trial's OWN registration (a cued "Clinical Trial Number:" line),
    // never the first NCT the body mentions: a comparator NCT in the header
    // would read as this abstract's identity.
    const own = ownRegistrations(abstract);
    const nct = own.length === 1 ? own[0]!.slice(3) : undefined;
    return {
      title,
      number: numbered ? numbered[1]!.replace(/\s+/g, ' ').toUpperCase() : null,
      session: session ? decodeHtmlEntities(session) : null,
      presented_on,
      meeting: meeting ? decodeHtmlEntities(meeting) : null,
      presenter,
      authors,
      abstract,
      nct: nct ? `NCT${nct}` : null,
    };
  },

  lastListingPage: (html) =>
    Math.max(1, ...[...html.matchAll(/\/(?:abstracts|posters)\?page=(\d+)/g)].map((m) => Number(m[1]))),

  parseListing(rawHtml) {
    const html = stripNonContent(rawHtml);
    const out: ListingEntry[] = [];
    for (const m of html.matchAll(
      /<a href="(https:\/\/amportal\.astro\.org\/sessions\/[a-z0-9-]+\/[a-z0-9-]+-\d+)"[^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const t = bodyText(m[2]!).match(NUMBERED_TITLE_RE);
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

/**
 * Stable identity for an abstract: host + the page's trailing numeric id.
 * Not the full path: the title slug and session code can change (a title edit,
 * an abstract listed under both an oral and a poster session) while the
 * abstract itself does not.
 */
export function conferenceAbstractHash(raw: string): string {
  const u = new URL(raw);
  const id = u.pathname.replace(/\/$/, '').match(/-(\d+)$/)?.[1] ?? u.pathname;
  return createHash('sha256').update(`conf-abstract:${u.hostname.toLowerCase()}#${id}`).digest('hex');
}

/**
 * The curator's confirm reply, and ONLY that: a message that is exactly one
 * portal abstract link and one bare DOI (in either order), nothing else. A DOI
 * anywhere else (prose, a second link, a URL query string) is never paired:
 * pairing stamps the DOI on the abstract, and savePaper matches on DOI first,
 * so a stray DOI would merge this abstract onto a different paper.
 */
export function pairedPortalDoi(text: string | null | undefined): { url: string; doi: string } | null {
  const tokens = (text ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) return null;
  const urlTok = tokens.find((t) => isConferenceAbstractUrl(t));
  const doiTok = tokens.find((t) => t !== urlTok);
  if (!urlTok || !doiTok || /^https?:/i.test(doiTok)) return null;
  // The WHOLE token must be one bare DOI: normalizeDoi extracts the first DOI
  // from any text, so "10.x/a,10.x/b" would otherwise pair the first and drop
  // the second.
  const doi = normalizeDoi(doiTok);
  if (!doi || doi !== doiTok.toLowerCase()) return null;
  const adapter = adapterForUrl(urlTok)!;
  // The supplement DOI must belong to this meeting's journal.
  if (!doi.startsWith(adapter.doiPrefix)) return null;
  return { url: urlTok, doi };
}

// --- confirm-only matching -------------------------------------------------

const STOP = new Set(
  'a an and of the in for with vs versus or to on by from phase trial results randomized study patients'.split(' '),
);

const tokenList = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const isYear = (t: string): boolean => /^(19|20)\d\d$/.test(t);

/** Tokens plus joined letter+digit neighbours ("a 071801" → "a071801", "40 gy" → "40gy"). */
function tokenSet(s: string): Set<string> {
  const list = tokenList(s);
  const out = new Set(list.filter((t) => t.length > 1 && !STOP.has(t)));
  for (let i = 0; i + 1 < list.length; i++) {
    const [a, b] = [list[i]!, list[i + 1]!];
    if ((/^[a-z]+$/.test(a) && /^\d+$/.test(b)) || (/^\d+$/.test(a) && /^(gy|cgy)$/.test(b))) out.add(a + b);
  }
  return out;
}

/**
 * Rank listing entries against a curator's short label ("NRG-GU003 — 5-year
 * hypofractionated vs conventional PORT"). Trial identifiers and doses count
 * triple, matched as WHOLE tokens ("gu003" never meets "gu0031", "40gy" never
 * meets "140gy"); years never count as identifiers. Returns candidates for the
 * curator to CONFIRM; never an automatic pick.
 */
export function rankListingMatches(label: string, entries: ListingEntry[], limit = 3): Array<ListingEntry & { score: number }> {
  const want = tokenSet(label);
  if (want.size === 0) return [];
  const isId = (t: string) =>
    !isYear(t) && t.length >= 3 && ((/\d/.test(t) && /[a-z]/.test(t)) || /^\d{4,}$/.test(t));
  const scored = entries.map((e) => {
    const have = tokenSet(e.title);
    let score = 0;
    for (const t of want) if (have.has(t)) score += isId(t) ? 3 : 1;
    return { ...e, score };
  });
  return scored
    .filter((e) => e.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// --- nightly notification plan (pure; build/conference-abstracts.ts does I/O) --

export type WatchedDoi = { doi: string; title: string | null };
export type PlannedNotice = { doi: string; label: string; candidate: ListingEntry & { score: number } };

/**
 * Which watched DOIs to DM about tonight. A DOI is considered only when it is
 * in this meeting's journal supplement, has a label to match on, and has no
 * confirm reply already waiting in the inbox. Each (DOI, candidate) pair is
 * offered at most ONCE ever: a ranking that flips between two candidates as
 * the index grows can't re-DM, and a candidate the curator ignored stays
 * ignored.
 */
export function planNotifications(
  adapter: ConferenceAdapter,
  watched: WatchedDoi[],
  entries: ListingEntry[],
  alreadySent: Record<string, string[]>,
  pendingDois: Set<string>,
): PlannedNotice[] {
  const out: PlannedNotice[] = [];
  for (const w of watched) {
    if (!w.doi.toLowerCase().startsWith(adapter.doiPrefix) || !w.title || pendingDois.has(w.doi.toLowerCase())) continue;
    const sent = new Set(alreadySent[w.doi] ?? []);
    const next = rankListingMatches(w.title, entries).find((c) => !sent.has(c.url));
    if (next) out.push({ doi: w.doi, label: w.title, candidate: next });
  }
  return out;
}

/** Watched DOIs this meeting could ever match (gate the crawl on these). */
export function watchedForMeeting(adapter: ConferenceAdapter, watched: WatchedDoi[]): WatchedDoi[] {
  return watched.filter((w) => w.doi.toLowerCase().startsWith(adapter.doiPrefix) && !!w.title);
}
