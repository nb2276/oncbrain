// v0.63: fetching ESMO abstracts through the curator's browser.
//
// ESMO's presentation site (cslide.ctimeetingtech.com) answers a server fetch
// with an AWS WAF JavaScript challenge, so a plain HTTP client never sees an
// abstract. The curator's real browser does: conf:abstracts --fetch drives it
// through Aside (`aside repl`), reads each abstract's card once, and saves it
// as JSON under data/.cache/conference-abstracts/. The ESMO adapter
// (conference-abstract.ts, cacheOnly) parses that cache at enrichment, so the
// 1am cron never touches the site.
//
// Everything here except buildAsideScript's output is pure, so it is tested
// without a browser.

import type { EsmoCached } from './conference-abstract.ts';

export const ESMO_BASE = 'https://cslide.ctimeetingtech.com';

/** "Sun, 25.10.2026" → "2026-10-25". */
export function parseEsmoDate(raw: string | null | undefined): string | null {
  const m = (raw ?? '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

/**
 * Which listings to try, most likely first. ESMO files orals/LBAs under
 * confcal, posters under confcal_1, ePosters under confcal_2; the suffix says
 * which, the others are fallbacks.
 */
export function listingsFor(number: string): string[] {
  const n = number.toUpperCase();
  const first = /EP$/.test(n) ? 'confcal_2' : /(?:\d|TI)P$/.test(n) ? 'confcal_1' : 'confcal';
  return [first, ...['confcal', 'confcal_1', 'confcal_2'].filter((c) => c !== first)];
}

export function listingUrl(edition: string, listing: string, number: string): string {
  return `${ESMO_BASE}/${edition}/attendee/${listing}/presentation/list?q=${encodeURIComponent(number)}`;
}

/** What the browser script reports for one card. */
export type RawCard = {
  number: string;
  listing: string;
  url: string;
  title: string;
  lines: string[];
  sections: Array<{ label: string; text: string }>;
};

/** The value on the line after `label` in a card's text ("Session Name\nProffered paper 1"). */
function after(lines: string[], label: string): string | null {
  const i = lines.findIndex((l) => l.trim().toLowerCase() === label.toLowerCase());
  const v = i >= 0 ? lines[i + 1]?.trim() : undefined;
  return v ? v : null;
}

export function toCached(raw: RawCard): EsmoCached {
  return {
    number: raw.number,
    title: raw.title.replace(/\s+/g, ' ').trim(),
    session: after(raw.lines, 'Session Name'),
    date: parseEsmoDate(after(raw.lines, 'Date')),
    speaker: after(raw.lines, 'Speakers'),
    sections: raw.sections.map((s) => ({ label: s.label.trim(), text: s.text.replace(/\s+/g, ' ').trim() })),
    url: raw.url,
  };
}

/**
 * The `aside repl` script for a batch of abstract numbers. For each number it
 * tries the listings in order and keeps the card whose title starts with
 * "<number> - " (a search also returns discussant slots and near matches).
 * Output, one line per number: ESMO_CARD=<json RawCard> or ESMO_MISS=<number>.
 */
export function buildAsideScript(edition: string, numbers: string[], delayMs = 1500): string {
  const jobs = numbers.map((n) => ({ number: n, urls: listingsFor(n).map((l) => [l, listingUrl(edition, l, n)]) }));
  return `
const jobs = ${JSON.stringify(jobs)};
const pg = await openTab("about:blank");
for (const job of jobs) {
  let found = null;
  for (const [listing, url] of job.urls) {
    await pg.goto(url);
    await sleep(${delayMs});
    found = await pg.evaluate((num) => {
      const cards = [...document.querySelectorAll(".card.presentation")];
      const card = cards.find((c) => {
        const t = (c.querySelector(".card-title")?.textContent || "").replace(/\\s+/g, " ").trim();
        return t.toUpperCase().startsWith(num.toUpperCase() + " - ");
      });
      if (!card) return null;
      const sections = [...card.querySelectorAll(".abstract-section")].map((s) => {
        const label = (s.querySelector(".section-title")?.textContent || "").trim();
        const clone = s.cloneNode(true); clone.querySelector(".section-title")?.remove();
        return { label, text: clone.textContent || "" };
      });
      return { title: card.querySelector(".card-title").textContent, lines: card.innerText.split("\\n"), sections };
    }, job.number);
    if (found) { found = { number: job.number, listing, url, ...found }; break; }
  }
  console.log(found ? "ESMO_CARD=" + JSON.stringify(found) : "ESMO_MISS=" + job.number);
}
await closeTab(pg);
console.log("GSTACK_STEP_OK");
`;
}

/** Parse the script's stdout. */
export function parseAsideOutput(stdout: string): { cards: RawCard[]; missing: string[]; completed: boolean } {
  const cards: RawCard[] = [];
  const missing: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('ESMO_CARD=')) {
      try {
        cards.push(JSON.parse(line.slice('ESMO_CARD='.length)) as RawCard);
      } catch {
        // a truncated line: the number is retried on the next run
      }
    } else if (line.startsWith('ESMO_MISS=')) missing.push(line.slice('ESMO_MISS='.length).trim());
  }
  return { cards, missing, completed: /\bGSTACK_STEP_OK\b/.test(stdout) };
}

/**
 * Drip priority for an abstract (higher releases first; the PDF library is 0):
 * late-breakers and orals 3, posters 2, ePosters / trials in progress / nursing 1.
 */
export function abstractPriority(number: string): number {
  const n = number.toUpperCase();
  if (/^LBA/.test(n) || /\d(?:O|RO|MO|PD|YO)$/.test(n)) return 3;
  if (/\dP$/.test(n) && !/EP$/.test(n) && !/TIP$/.test(n)) return 2;
  return 1;
}
