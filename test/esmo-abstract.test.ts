// v0.63: ESMO abstracts. The site blocks server fetches, so the adapter is
// cacheOnly: the curator's browser saves each card (esmo-fetch.ts) and the
// enrichment loop parses the cache.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  adapterForUrl,
  isConferenceAbstractUrl,
  conferenceAbstractHash,
  esmoCacheKey,
  abstractCachePath,
  NotAnAbstractError,
} from '../src/lib/conference-abstract.ts';
import {
  parseEsmoDate,
  listingsFor,
  toCached,
  parseAsideOutput,
  abstractPriority,
  buildAsideScript,
} from '../src/lib/esmo-fetch.ts';
import { openDb, enqueueLocalIngest, releaseLocalIngest, listInboxItemsForEnrichment } from '../src/lib/db.ts';

const FIXTURE = readFileSync('test/fixtures/conference-abstracts/esmo-2613O.json', 'utf8');
const URL_2613O = 'https://cslide.ctimeetingtech.com/esmo2026/attendee/confcal/presentation/list?q=2613O';

describe('ESMO URLs', () => {
  it('recognises an abstract listing link and nothing else on the host', () => {
    expect(adapterForUrl(URL_2613O)?.id).toBe('esmo');
    expect(isConferenceAbstractUrl(URL_2613O.replace('confcal/', 'confcal_2/').replace('2613O', '2756eP'))).toBe(true);
    for (const bad of [
      'https://cslide.ctimeetingtech.com/esmo2026/attendee/confcal/session/list',
      'https://cslide.ctimeetingtech.com/esmo2026/attendee/confcal/presentation/list?q=SARON', // a search, not a number
      'https://cslide.ctimeetingtech.com/esmobreast2026/attendee/confcal/presentation/list?q=12O', // another meeting
      'http://cslide.ctimeetingtech.com/esmo2026/attendee/confcal/presentation/list?q=2613O', // not https
    ]) expect(isConferenceAbstractUrl(bad), bad).toBe(false);
  });

  it('identity is meeting + number, whatever listing or case the link uses', () => {
    const poster = URL_2613O.replace('confcal/', 'confcal_1/');
    expect(conferenceAbstractHash(poster)).toBe(conferenceAbstractHash(URL_2613O));
    expect(conferenceAbstractHash(URL_2613O.replace('2613O', '2613o'))).toBe(conferenceAbstractHash(URL_2613O));
    expect(conferenceAbstractHash(URL_2613O.replace('2613O', '2614O'))).not.toBe(conferenceAbstractHash(URL_2613O));
    expect(esmoCacheKey(new URL(URL_2613O.replace('2613O', '2756EP')))).toBe('esmo2026/2756eP');
    expect(esmoCacheKey(new URL(URL_2613O.replace('2613O', '1234etip')))).toBe('esmo2026/1234eTiP');
    expect(esmoCacheKey(new URL(URL_2613O.replace('2613O', '1343TIP')))).toBe('esmo2026/1343TiP');
    expect(abstractCachePath(URL_2613O)).toBe('data/.cache/conference-abstracts/esmo2026/2613O.json');
  });
});

describe('ESMO cache parse', () => {
  const esmo = adapterForUrl(URL_2613O)!;
  it('builds the paper fields from the cached card', () => {
    const a = esmo.parse(FIXTURE, URL_2613O);
    expect(a.title).toMatch(/^Primary results of SARON/);
    expect(a.number).toBe('2613O');
    expect(a.meeting).toBe('ESMO Congress 2026');
    expect(a.presented_on).toBe('2026-10-25');
    expect(a.session).toBe('Proffered paper 1: NSCLC, metastatic');
    expect(a.nct).toBe('NCT02417662'); // "Clinical trial identification" is a registration cue
    expect(a.abstract).toMatch(/^Background: /);
    expect(a.abstract).toContain('HR=0.64, 95%CI 0.43–0.95, p=0.03');
    expect(a.abstract).not.toMatch(/Disclosure|Funding|Legal entity/);
    expect(esmo.journal!(a.meeting)).toBe('ESMO Congress 2026');
  });
  it('a trial-in-progress keeps its Trial design section', () => {
    const tip = JSON.stringify({
      ...JSON.parse(FIXTURE),
      number: '1343TiP',
      sections: [
        { label: 'Background', text: 'b'.repeat(150) },
        { label: 'Trial design', text: 'Randomised 1:1 to SBRT or observation; primary endpoint PFS. ' + 't'.repeat(150) },
      ],
    });
    expect(esmo.parse(tip, URL_2613O).abstract).toMatch(/\nTrial design: Randomised 1:1/);
  });

  it('refuses a card with no abstract body (an invited talk)', () => {
    const talk = JSON.stringify({ ...JSON.parse(FIXTURE), sections: [] });
    expect(() => esmo.parse(talk, URL_2613O)).toThrow(NotAnAbstractError);
    expect(() => esmo.parse('not json', URL_2613O)).toThrow(NotAnAbstractError);
  });
});

describe('esmo-fetch helpers', () => {
  it('dates, listings, priorities', () => {
    expect(parseEsmoDate('Sun, 25.10.2026')).toBe('2026-10-25');
    expect(parseEsmoDate(null)).toBeNull();
    expect(listingsFor('2756eP')[0]).toBe('confcal_2');
    expect(listingsFor('1546P')[0]).toBe('confcal_1');
    expect(listingsFor('2613O')[0]).toBe('confcal');
    expect(listingsFor('LBA4')).toEqual(['confcal', 'confcal_1', 'confcal_2']);
    expect(['LBA4', '2613O', '545RO', '1546P', '2756eP', '1343TiP', 'CN60'].map(abstractPriority)).toEqual([3, 3, 3, 2, 1, 1, 1]);
  });
  it('turns a browser card into the cache record', () => {
    const c = toCached({
      number: '2613O',
      listing: 'confcal',
      url: URL_2613O,
      title: '2613O - Primary  results of SARON',
      lines: ['Speakers', 'Fiona McDonald (London, United Kingdom)', 'Session Name', 'Proffered paper 1', 'Date', 'Sun, 25.10.2026'],
      sections: [{ label: ' Results ', text: ' 140   patients ' }],
    });
    expect(c).toMatchObject({ title: '2613O - Primary results of SARON', session: 'Proffered paper 1', date: '2026-10-25', speaker: 'Fiona McDonald (London, United Kingdom)' });
    expect(c.sections).toEqual([{ label: 'Results', text: '140 patients' }]);
  });
  it('reads the script output, keeping a run that did not complete honest', () => {
    const out = 'noise\nESMO_CARD={"number":"2613O","listing":"confcal","url":"u","title":"t","lines":[],"sections":[]}\nESMO_MISS=999P\nESMO_CARD={broken\n';
    const r = parseAsideOutput(out);
    expect(r.cards.map((c) => c.number)).toEqual(['2613O']);
    expect(r.missing).toEqual(['999P']);
    expect(r.completed).toBe(false);
    expect(parseAsideOutput(out + 'GSTACK_STEP_OK').completed).toBe(true);
  });
  it('the browser script names each number and its listings', () => {
    const s = buildAsideScript('esmo2026', ['2613O', '2756eP']);
    expect(s).toContain('confcal_2/presentation/list?q=2756eP');
    expect(s).toContain('"number":"2613O"');
  });
});

describe('drip queue: URLs, priority, file date', () => {
  it('releases by priority, then staging order; a URL becomes a plain paper link', () => {
    const db = openDb(':memory:');
    enqueueLocalIngest(db, { path: '/p/old.pdf', kind: 'paper' });
    enqueueLocalIngest(db, { path: 'https://x/poster', kind: 'url', priority: 2 });
    enqueueLocalIngest(db, { path: 'https://x/lba', kind: 'url', priority: 3, fileDate: '2026-10-24' });
    const out = releaseLocalIngest(db, { limit: 2, date: '2026-10-26', chatId: 1 });
    expect(out.map((r) => r.path)).toEqual(['https://x/lba', 'https://x/poster']);
    const inbox = listInboxItemsForEnrichment(db);
    const lba = inbox.find((i) => i.raw_target === 'https://x/lba')!;
    expect(lba.bookmark_date).toBe('2026-10-24'); // file date wins
    expect(JSON.parse(lba.attachments_json!)).toEqual({ quiet: true, drip: true }); // no local_path: not a library PDF
    expect(inbox.find((i) => i.raw_target === 'https://x/poster')!.bookmark_date).toBe('2026-10-26');
  });
  it('re-staging a waiting item updates its priority', () => {
    const db = openDb(':memory:');
    enqueueLocalIngest(db, { path: 'https://x/a', kind: 'url', priority: 1 });
    enqueueLocalIngest(db, { path: 'https://x/b', kind: 'url', priority: 2 });
    enqueueLocalIngest(db, { path: 'https://x/a', kind: 'url', priority: 3 });
    expect(releaseLocalIngest(db, { limit: 1, date: '2026-10-26', chatId: 1 }).map((r) => r.path)).toEqual(['https://x/a']);
  });

  it('rejects a malformed file date', () => {
    expect(() => enqueueLocalIngest(openDb(':memory:'), { path: 'u', kind: 'url', fileDate: '24/10/2026' })).toThrow();
  });
});

describe('a cached ESMO abstract through enrichment', () => {
  const cache = 'data/.cache/conference-abstracts/esmo2037/2613O.json';
  const url = URL_2613O.replace('esmo2026', 'esmo2037');
  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.SOURCE_FACET = 'off';
  });
  afterEach(() => rmSync(dirname(cache), { recursive: true, force: true }));

  it('a drip release ingests from the cache (no network), files on its RELEASE night, tags ESMO', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, FIXTURE.replace('"date": "2026-10-25"', '"date": "2037-10-25"'));
    const db = openDb(':memory:');
    enqueueLocalIngest(db, { path: url, kind: 'url', priority: 3 });
    releaseLocalIngest(db, { limit: 5, date: '2037-10-30', chatId: 1 });
    const { runEnrichmentLoop } = await import('../src/lib/inbox-enrichment.ts');
    const r = await runEnrichmentLoop(db, listInboxItemsForEnrichment(db));
    expect(r.enriched).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const p = db.prepare('SELECT bookmark_date, journal, conference_slug, fetched_via, abstract FROM papers').get() as Record<string, string>;
    // Never backdated: a nightly batch on a past meeting day would rebuild the whole day.
    expect(p.bookmark_date).toBe('2037-10-30');
    expect(p.journal).toBe('ESMO Congress 2037');
    expect(p.conference_slug).toBe('esmo-2037');
    expect(p.fetched_via).toBe('conference_abstract');
    expect(p.abstract).toMatch(/^ESMO Congress 2037 abstract 2613O · Proffered paper 1/);
    fetchSpy.mockRestore();
  });

  it('a forwarded ESMO link (not a drip release) still files on its presentation date', async () => {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, FIXTURE.replace('"date": "2026-10-25"', '"date": "2037-10-25"'));
    const db = openDb(':memory:');
    const { saveInboxItem } = await import('../src/lib/db.ts');
    saveInboxItem(db, { type: 'paper', raw_target: url, raw_message_text: url, telegram_msg_id: 5, bookmark_date: '2037-10-30' });
    const { runEnrichmentLoop } = await import('../src/lib/inbox-enrichment.ts');
    await runEnrichmentLoop(db, listInboxItemsForEnrichment(db));
    expect((db.prepare('SELECT bookmark_date FROM papers').get() as { bookmark_date: string }).bookmark_date).toBe('2037-10-25');
  });

  it('a link with nothing cached fails with the command to run', async () => {
    expect(existsSync(cache)).toBe(false);
    const db = openDb(':memory:');
    enqueueLocalIngest(db, { path: url, kind: 'url' });
    releaseLocalIngest(db, { limit: 5, date: '2037-10-30', chatId: 1 });
    const { runEnrichmentLoop } = await import('../src/lib/inbox-enrichment.ts');
    const r = await runEnrichmentLoop(db, listInboxItemsForEnrichment(db));
    expect(r.failed).toBe(1);
    const row = db.prepare('SELECT enrichment_status, enrichment_error FROM inbox_items').get() as Record<string, string>;
    expect(row.enrichment_status).toBe('failed_permanent');
    expect(row.enrichment_error).toMatch(/conf:abstracts -- --meeting=esmo --fetch/);
  });
});
