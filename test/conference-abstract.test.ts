import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ADAPTERS,
  adapterForUrl,
  isConferenceAbstractUrl,
  conferenceAbstractHash,
  rankListingMatches,
  pairedPortalDoi,
  planNotifications,
  watchedForMeeting,
  NotAnAbstractError,
} from '../src/lib/conference-abstract.ts';
import { extractPaperUrls } from '../src/lib/paper-url.ts';
import { detectConference } from '../src/lib/conference-detect.ts';

const astro = ADAPTERS.find((a) => a.id === 'astro')!;
const fixture = (name: string) => readFileSync(`test/fixtures/conference-abstracts/${name}.html`, 'utf8');
const GI003 =
  'https://amportal.astro.org/sessions/pl-01-22946/initial-results-of-nrg-oncology-nrg-gi003-a-phase-iii-randomized-trial-of-protons-vs-photons-113309';

describe('conference abstract URLs', () => {
  it('recognises an ASTRO portal abstract page and nothing else', () => {
    expect(isConferenceAbstractUrl(GI003)).toBe(true);
    expect(adapterForUrl(GI003)?.id).toBe('astro');
    expect(isConferenceAbstractUrl('https://amportal.astro.org/sessions/pl-01-22946')).toBe(false); // session page
    expect(isConferenceAbstractUrl('https://amportal.astro.org/search?searchtext=x')).toBe(false);
    expect(isConferenceAbstractUrl('http://amportal.astro.org/sessions/a/b-1')).toBe(false); // not https
    expect(isConferenceAbstractUrl('https://evil.example/sessions/a/b-1')).toBe(false);
  });

  it('Telegram link extraction picks the portal link up as a paper source', () => {
    expect(extractPaperUrls(`${GI003} 10.1016/j.ijrobp.2026.06.004`)).toEqual([GI003]);
  });

  it('identity ignores query and fragment', () => {
    expect(conferenceAbstractHash(`${GI003}?utm=x#top`)).toBe(conferenceAbstractHash(GI003));
  });

  it('identity is the trailing abstract id, not the session code or title slug', () => {
    const moved = 'https://amportal.astro.org/sessions/pd-02-22950/retitled-slug-113309';
    expect(conferenceAbstractHash(moved)).toBe(conferenceAbstractHash(GI003));
    expect(conferenceAbstractHash(GI003.replace(/113309$/, '113310'))).not.toBe(conferenceAbstractHash(GI003));
  });

  it('the portal host tags the ASTRO meeting', () => {
    const hit = detectConference(GI003, { defaultYear: 2026 });
    expect(hit?.slug ?? hit).toMatch(/astro/i);
  });
});

describe('ASTRO abstract parser', () => {
  it('parses a plenary abstract: number, session, date, presenter, authors, body, NCT', () => {
    const a = astro.parse(fixture('astro-gi003'), GI003);
    expect(a.title).toMatch(/^Initial Results of NRG Oncology NRG-GI003/);
    expect(a.number).toBe('2');
    expect(a.session).toBe('PL 01 - Plenary Session');
    expect(a.presented_on).toBe('2026-09-28');
    expect(a.meeting).toBe('ASTRO 2026');
    expect(a.presenter).toBe('Theodore Hong, MD');
    expect(a.authors[0]).toBe('T. S. Hong');
    expect(a.authors.length).toBeGreaterThan(10);
    expect(a.abstract).toMatch(/^Purpose\/Objective\(s\):/);
    expect(a.abstract).toMatch(/\nConclusion:/);
    expect(a.abstract).toContain('HR=1.30, 90% CI 0.83-2.04');
    expect(a.abstract).not.toMatch(/<|class=/); // no markup leaks into the source text
    expect(a.nct).toBe('NCT03186898');
  });

  it('parses a late-breaking abstract number', () => {
    const a = astro.parse(fixture('astro-maverick'), 'https://amportal.astro.org/sessions/ct-01-22948/x-114268');
    expect(a.number).toBe('LBA 03');
    expect(a.title).toMatch(/^SWOG S1827\/MAVERICK/);
    expect(a.presented_on).toBe('2026-09-27');
  });

  it('finds the body whatever markup wraps the section labels (<strong> in <i>, not <b>)', () => {
    const a = astro.parse(fixture('astro-soft-preop'), 'https://amportal.astro.org/sessions/lba-01-22916/x-114057');
    expect(a.number).toBe('LBA 08');
    expect(a.abstract).toMatch(/^Purpose\/Objective\(s\):/);
    expect(a.abstract).toMatch(/\nMaterials\/Methods:/);
    expect(a.abstract).toContain('50.4 Gy/28 fractions');
    expect(a.authors[0]).toBe('W. A. Hall');
  });

  it('refuses a page with no abstract body', () => {
    expect(() => astro.parse('<html><h1>Discussant</h1></html>', 'u')).toThrow(NotAnAbstractError);
  });

  it('keeps superscripts as ^x in the body so a p-value exponent survives', () => {
    const a = astro.parse(fixture('astro-gi003'), GI003);
    expect(a.abstract).not.toMatch(/<sup>/);
    expect(a.authors.every((x) => !/\^|<sup>/.test(x))).toBe(true); // affiliation marks stripped from names
  });

  it('fails closed when the page lost its end marker (share block)', () => {
    const html = fixture('astro-gi003').replace(/session__share/g, 'session__gone');
    expect(() => astro.parse(html, GI003)).toThrow(NotAnAbstractError);
  });

  it('a section label in <head> or a script never starts the body', () => {
    const html = `<html><head><meta name="description" content="Purpose/Objective(s): leaked"><script>var x="Background: no";</script></head>
      <body><h1>12 - A Title</h1><p>nothing here</p><div class="session__share"></div></body></html>`;
    expect(() => astro.parse(html, 'u')).toThrow(NotAnAbstractError);
  });

  it('parses a listing page, skipping discussant slots', () => {
    const html = fixture('astro-abstracts-p1');
    const entries = astro.parseListing(html);
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.every((e) => /^(LBA )?\d+$/.test(e.number ?? ''))).toBe(true);
    expect(entries.some((e) => e.number === 'LBA 03' && /MAVERICK/.test(e.title))).toBe(true);
    expect(astro.lastListingPage(html)).toBe(42);
  });
});

describe('confirm-only matching', () => {
  const entries = [
    { number: '7', title: 'Five-Year Results of a Phase 3 Trial of Hypofractionated vs. Conventional Postprostatectomy Radiotherapy: NRG Oncology GU003', url: 'a' },
    { number: '205', title: '30Gy vs 40Gy Consolidative Radiotherapy for Limited-Stage Diffuse Large B cell Lymphoma', url: 'b' },
    { number: 'LBA 03', title: 'SWOG S1827/MAVERICK: A Randomized Phase III Trial of Brain MRI Surveillance', url: 'c' },
    { number: '9', title: 'Six-Year Overall Survival of Nivolumab Following Stereotactic Ablative Radiotherapy', url: 'd' },
  ];

  it('a trial identifier in the label finds its abstract', () => {
    expect(rankListingMatches('NRG-GU003 — 5-year hypofractionated vs conventional PORT', entries)[0]?.number).toBe('7');
    expect(rankListingMatches('SWOG S1827 MAVERICK — MRI surveillance ± PCI, SCLC', entries)[0]?.number).toBe('LBA 03');
  });

  it('a dose written apart in the label meets a joined dose in the title', () => {
    expect(rankListingMatches('CAMS 30 vs 40 Gy, limited-stage DLBCL', entries)[0]?.number).toBe('205');
  });

  it('a weak overlap is not offered at all', () => {
    expect(rankListingMatches('Palliative re-irradiation — prior response predicts response', entries)).toEqual([]);
  });
});

describe('confirm reply pairing', () => {
  const DOI = '10.1016/j.ijrobp.2026.06.004';

  it('pairs exactly one portal link with one bare journal DOI, either order', () => {
    expect(pairedPortalDoi(`${GI003} ${DOI}`)).toEqual({ url: GI003, doi: DOI });
    expect(pairedPortalDoi(`${DOI}\n${GI003}`)).toEqual({ url: GI003, doi: DOI });
  });

  it('never pairs anything looser', () => {
    expect(pairedPortalDoi(GI003)).toBeNull(); // no DOI
    expect(pairedPortalDoi(`${GI003} ${DOI} 10.1016/j.ijrobp.2026.06.005`)).toBeNull(); // two DOIs
    expect(pairedPortalDoi(`${GI003} see ${DOI}`)).toBeNull(); // prose
    expect(pairedPortalDoi(`${GI003} https://doi.org/${DOI}`)).toBeNull(); // DOI as a URL
    expect(pairedPortalDoi(`${GI003} 10.1056/NEJMoa2400001`)).toBeNull(); // another journal
    expect(pairedPortalDoi(`https://amportal.astro.org/sessions/pl-01-22946 ${DOI}`)).toBeNull(); // session page
  });
});

describe('matcher token boundaries', () => {
  const e = (number: string, title: string) => ({ number, title, url: number });

  it('an identifier never matches a longer one that starts with it', () => {
    expect(rankListingMatches('NRG-GU003', [e('1', 'NRG GU0031 something else')])).toEqual([]);
  });

  it('a dose never matches a larger dose ending in it', () => {
    expect(rankListingMatches('40 Gy', [e('1', '140Gy boost')])).toEqual([]);
  });

  it('a shared year is not an identifier', () => {
    expect(rankListingMatches('ASTRO 2026 update', [e('1', 'A 2026 analysis of something')])).toEqual([]);
  });

  it('a listing title is entity-decoded', () => {
    const html = '<a href="https://amportal.astro.org/sessions/pl-01-1/x-5">12 - Dose &ge;60 Gy &amp; PCI</a>';
    expect(astro.parseListing(html)[0]?.title).toBe('Dose ≥60 Gy & PCI');
  });
});

describe('nightly notification plan', () => {
  const entries = [
    { number: '7', title: 'Five-Year Results: NRG Oncology GU003 hypofractionated postprostatectomy', url: 'u7' },
    { number: '8', title: 'NRG GU003 patient-reported outcomes hypofractionated', url: 'u8' },
  ];
  const watched = [
    { doi: '10.1016/j.ijrobp.2026.06.100', title: 'NRG-GU003 hypofractionated PORT' },
    { doi: '10.1056/nejmoa1', title: 'NRG-GU003 hypofractionated PORT' }, // not this meeting's journal
    { doi: '10.1016/j.ijrobp.2026.06.101', title: null }, // nothing to match on
  ];

  it('only this meeting\'s labelled watches gate the crawl', () => {
    expect(watchedForMeeting(astro, watched).map((w) => w.doi)).toEqual(['10.1016/j.ijrobp.2026.06.100']);
  });

  it('offers the best candidate once, then the next one, never a repeat', () => {
    const first = planNotifications(astro, watched, entries, {}, new Set());
    expect(first).toHaveLength(1);
    const sentUrl = first[0]!.candidate.url;
    const second = planNotifications(astro, watched, entries, { [first[0]!.doi]: [sentUrl] }, new Set());
    expect(second[0]?.candidate.url).not.toBe(sentUrl);
    expect(planNotifications(astro, watched, entries, { [first[0]!.doi]: ['u7', 'u8'] }, new Set())).toEqual([]);
  });

  it('skips a DOI whose confirm reply is already waiting in the inbox', () => {
    expect(planNotifications(astro, watched, entries, {}, new Set(['10.1016/j.ijrobp.2026.06.100']))).toEqual([]);
  });
});
