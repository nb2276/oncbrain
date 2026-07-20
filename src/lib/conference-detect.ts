// Conference auto-detection.
//
// The bot ingest path (pull:telegram → enrich:inbox) historically never set a
// `conference_slug` — only the admin form did. So conference badges (driven by
// dominantConferenceForDate) and the /conferences/<slug> pages were dead for
// anything DM'd to the bot. This module recognizes a major oncology meeting from
// the text/URLs of an ingested source so enrichment can stamp the tag itself.
//
// Three signal tiers, highest-precision first:
//   1. Meeting HASHTAG — `#ASCO26`, `#ESMO2025`, `#GU26`. Year-bearing and
//      meeting-specific, so unambiguous. Highest priority.
//   2. Meeting URL HOST — a meeting-specific host (meetings.asco.org,
//      oncologypro.esmo.org, …). Matched on the PARSED hostname (exact or a true
//      subdomain), never a substring, so `meetings.asco.org.evil.test` can't
//      spoof it — the same discipline as paper-url's trade-press allowlist. The
//      year comes from a delimited 20xx token in the URL, else the source's date.
//   3. PROSE — "ASCO Annual Meeting", "Genitourinary Cancers Symposium", … but
//      ONLY when a 20xx year sits within a small window of the phrase. This keeps
//      "an ASCO guideline" or a bare meeting mention from mis-tagging.
//
// Year handling never auto-strips identity: a hashtag/URL/prose year is taken
// verbatim, and slugs are `<series>-<year>` (asco-2026), so distinct years stay
// distinct conferences (cf. the entity-resolution warning in TODOS.md).

export type ConferenceHit = {
  slug: string; // e.g. 'asco-2026'
  name: string; // e.g. 'ASCO Annual Meeting 2026'
  hashtag: string; // e.g. '#ASCO26' (canonical, two-digit year)
  year: number; // 2026
};

type Series = {
  key: string; // slug stem, e.g. 'asco'
  name: string; // display series name (year appended at hit time)
  acronym: string; // canonical hashtag acronym, e.g. 'ASCO' → '#ASCO26'
  // Year-bearing hashtag forms. Capture group 1 is the year token (2- or 4-digit).
  hashtags: RegExp[];
  // Meeting-specific hostnames (exact, after dropping a leading www.). Empty for
  // subspecialty meetings that share a society's ambiguous host — those are
  // caught by their unambiguous hashtag/prose instead.
  hosts: string[];
  // Distinctive phrases that name THIS meeting. A match counts only when a 20xx
  // year sits within PROSE_WINDOW chars of it.
  prose: RegExp[];
};

// Registry. Flagship annual meetings carry host signals; the ASCO subspecialty
// symposia (GU/GI) are hashtag/prose-only because they share meeting*.asco.org
// with the Annual Meeting and would otherwise mis-tag as the flagship.
const SERIES: Series[] = [
  {
    key: 'asco',
    name: 'ASCO Annual Meeting',
    acronym: 'ASCO',
    hashtags: [/#ASCO(20\d\d|\d{2})\b/i],
    hosts: ['meetings.asco.org', 'meetinglibrary.asco.org', 'conferences.asco.org', 'abstracts.asco.org'],
    prose: [/\bASCO\s+Annual\s+Meeting\b/i],
  },
  {
    key: 'ascogu',
    name: 'ASCO Genitourinary Cancers Symposium',
    acronym: 'GU',
    hashtags: [/#(?:ASCO)?GU(20\d\d|\d{2})\b/i],
    hosts: [],
    prose: [/\bGenitourinary\s+Cancers?\s+Symposium\b/i, /\bASCO\s+GU\b/i],
  },
  {
    key: 'ascogi',
    name: 'ASCO Gastrointestinal Cancers Symposium',
    acronym: 'GI',
    hashtags: [/#(?:ASCO)?GI(20\d\d|\d{2})\b/i],
    hosts: [],
    prose: [/\bGastrointestinal\s+Cancers?\s+Symposium\b/i, /\bASCO\s+GI\b/i],
  },
  {
    key: 'esmo',
    name: 'ESMO Congress',
    acronym: 'ESMO',
    hashtags: [/#ESMO(20\d\d|\d{2})\b/i],
    hosts: ['oncologypro.esmo.org'],
    prose: [/\bESMO\s+(?:Congress|Annual\s+Meeting)\b/i],
  },
  {
    key: 'astro',
    name: 'ASTRO Annual Meeting',
    acronym: 'ASTRO',
    hashtags: [/#ASTRO(20\d\d|\d{2})\b/i],
    hosts: ['meetings.astro.org'],
    // Real abstract/slide text brands the meeting "ASTRO 2025:" far more often
    // than "ASTRO Annual Meeting", so match the acronym+year form too. The
    // required whitespace + trailing year keeps "AUA/ASTRO guidelines" (year, if
    // any, sits BEFORE the acronym) from mis-tagging.
    prose: [/\bASTRO\s+Annual\s+Meeting\b/i, /\bASTRO\s+20[1-3]\d\b/i],
  },
  {
    key: 'estro',
    name: 'ESTRO Congress',
    acronym: 'ESTRO',
    hashtags: [/#ESTRO(20\d\d|\d{2})\b/i],
    // estro.org also hosts society guidelines + working-group pages, so a host
    // match would over-tag; the year-bearing hashtag/prose is unambiguous.
    hosts: [],
    // Brand is "ESTRO <year>" (ESTRO 2026 Stockholm), rarely "ESTRO Congress" in
    // source text. The acronym+year form catches it; the required whitespace +
    // year keeps GEC-ESTRO / ESMO-ESTRO / "(ESTRO) guidelines" (no adjacent
    // year) from mis-tagging as the congress.
    prose: [/\bESTRO\s+Congress\b/i, /\bESTRO\s+20[1-3]\d\b/i],
  },
  {
    key: 'aacr',
    name: 'AACR Annual Meeting',
    acronym: 'AACR',
    hashtags: [/#AACR(20\d\d|\d{2})\b/i],
    hosts: ['meetings.aacr.org'],
    prose: [/\bAACR\s+Annual\s+Meeting\b/i],
  },
  {
    key: 'ash',
    name: 'ASH Annual Meeting',
    acronym: 'ASH',
    hashtags: [/#ASH(20\d\d|\d{2})\b/i],
    hosts: ['ash.confex.com'],
    prose: [/\bASH\s+Annual\s+Meeting\b/i],
  },
  {
    key: 'sabcs',
    name: 'San Antonio Breast Cancer Symposium',
    acronym: 'SABCS',
    hashtags: [/#SABCS(20\d\d|\d{2})\b/i],
    hosts: ['sabcs.org'],
    prose: [/\bSan\s+Antonio\s+Breast\s+Cancer\s+Symposium\b/i],
  },
];

// Signal priority: a specific hashtag outranks a host, which outranks prose.
const PRIORITY = { hashtag: 3, host: 2, prose: 1 } as const;

// How far a year may sit from a prose phrase to still count as that meeting's
// year. Wide enough for "(Chicago, May 31–June 4, 2026)", tight enough to avoid
// grabbing an unrelated year from the next sentence.
const PROSE_WINDOW = 32;

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

// A URL token longer than this is never a real meeting link; capping before the
// trailing-punctuation trim below keeps that trim linear (an unbounded run of
// trim chars mid-token would otherwise backtrack quadratically — a latent ReDoS
// on the unbounded OCR/PDF text paths).
const MAX_URL_LEN = 2048;

// Plausible meeting-year window. The URL and prose year regexes already encode
// this as `20[1-3]\d`; the hashtag path applies it via inMeetingYearRange so all
// three tiers agree (e.g. a stray `#ASCO99` doesn't mint an `asco-2099` row).
const MIN_MEETING_YEAR = 2010;
const MAX_MEETING_YEAR = 2039;
function inMeetingYearRange(year: number): boolean {
  return year >= MIN_MEETING_YEAR && year <= MAX_MEETING_YEAR;
}

// Normalize a hashtag/URL year token to a full year. 4-digit → verbatim;
// 2-digit → 20xx (conference hashtags are modern: #ASCO26 = 2026).
function normalizeYear(token: string): number {
  return token.length === 4 ? Number(token) : 2000 + Number(token);
}

// A 20xx year as a delimited token inside a URL (path segment, query value, …),
// constrained to a plausible meeting range so a random id like /20480/ can't pose
// as a year. Returns null when the URL carries no year.
function yearFromUrl(url: string): number | null {
  const m = url.match(/(?:^|[/_?=&#-])(20[1-3]\d)(?:$|[/_?=&#.-])/);
  return m ? Number(m[1]) : null;
}

function makeHit(s: Series, year: number): ConferenceHit {
  const yy = String(year).slice(2);
  return {
    slug: `${s.key}-${year}`,
    name: `${s.name} ${year}`,
    hashtag: `#${s.acronym}${yy}`,
    year,
  };
}

function hashtagYear(s: Series, text: string): number | null {
  for (const re of s.hashtags) {
    const m = text.match(re);
    if (m && m[1]) {
      const y = normalizeYear(m[1]);
      if (inMeetingYearRange(y)) return y;
    }
  }
  return null;
}

function hostYear(s: Series, urls: Array<{ url: string; host: string }>, defaultYear?: number): number | null {
  if (s.hosts.length === 0) return null;
  for (const { url, host } of urls) {
    if (s.hosts.some((h) => host === h || host.endsWith('.' + h))) {
      const y = yearFromUrl(url) ?? defaultYear;
      if (y) return y;
    }
  }
  return null;
}

function proseYear(s: Series, text: string): number | null {
  for (const re of s.prose) {
    const m = re.exec(text);
    if (!m) continue;
    const phraseStart = m.index;
    const phraseEnd = m.index + m[0].length;
    const start = Math.max(0, phraseStart - PROSE_WINDOW);
    const end = Math.min(text.length, phraseEnd + PROSE_WINDOW);
    // Pick the year NEAREST the phrase, not the first in the window — otherwise
    // "2024 data, 2026 ASCO Annual Meeting" mis-reads as 2024.
    let bestYear: number | null = null;
    let bestDist = Infinity;
    for (const ym of text.slice(start, end).matchAll(/\b(20[1-3]\d)\b/g)) {
      const yStart = start + ym.index;
      const yEnd = yStart + ym[0].length;
      const dist = yStart >= phraseEnd ? yStart - phraseEnd : yEnd <= phraseStart ? phraseStart - yEnd : 0;
      if (dist < bestDist) {
        bestDist = dist;
        bestYear = Number(ym[1]);
      }
    }
    if (bestYear != null) return bestYear;
  }
  return null;
}

// Detect the single best meeting referenced by `text`. `defaultYear` (the
// source's bookmark-date year) supplies the year for a host match that doesn't
// carry one. Returns null when nothing matches.
export function detectConference(
  text: string | null | undefined,
  opts: { defaultYear?: number } = {},
): ConferenceHit | null {
  if (!text) return null;

  // Parse every URL's hostname once, shared across series.
  const urls: Array<{ url: string; host: string }> = [];
  for (const m of text.matchAll(URL_RE)) {
    // Cap before the trim so the trailing-punctuation regex stays linear on
    // adversarial input (see MAX_URL_LEN). The hostname lives at the front, so
    // capping never affects host matching or the year scan.
    const capped = m[0].length > MAX_URL_LEN ? m[0].slice(0, MAX_URL_LEN) : m[0];
    const url = capped.replace(/[.,;)\]]+$/, ''); // trim trailing punctuation
    try {
      urls.push({ url, host: new URL(url).hostname.toLowerCase().replace(/^www\./, '') });
    } catch {
      // not a parseable absolute URL — skip
    }
  }

  // Collect every signal, then pick the highest-priority one. Registry order
  // breaks priority ties (we only replace on a STRICTLY greater priority), which
  // is why a specific subspecialty hashtag, listed first, wins over a flagship.
  const candidates: Array<{ hit: ConferenceHit; priority: number }> = [];
  for (const s of SERIES) {
    const ht = hashtagYear(s, text);
    if (ht != null) candidates.push({ hit: makeHit(s, ht), priority: PRIORITY.hashtag });
    const ho = hostYear(s, urls, opts.defaultYear);
    if (ho != null) candidates.push({ hit: makeHit(s, ho), priority: PRIORITY.host });
    const pr = proseYear(s, text);
    if (pr != null) candidates.push({ hit: makeHit(s, pr), priority: PRIORITY.prose });
  }
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (const c of candidates) {
    if (c.priority > best.priority) best = c;
  }
  return best.hit;
}

// Convenience: detect across several source fields at once (raw target, curator
// message, OCR text, …). Nullish/empty fields are ignored.
export function detectConferenceFromTexts(
  texts: Array<string | null | undefined>,
  opts: { defaultYear?: number } = {},
): ConferenceHit | null {
  const joined = texts.filter((t): t is string => !!t && t.length > 0).join('\n');
  return detectConference(joined, opts);
}
