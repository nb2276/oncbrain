// v0.60 review: a portal abstract files on its PRESENTATION date. The prior-
// coverage nudge must measure "prior" from that date, or the card the abstract
// joins looks like an earlier, separate card and the curator is offered a
// one-reply drop of it (executeDedupDrop does not consult the evidence gate).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb, saveInboxItem, listInboxItemsForEnrichment } from '../src/lib/db.ts';

const digests = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../src/lib/digest-data.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/digest-data.ts')>();
  return { ...orig, listDigests: () => digests.list };
});
vi.mock('../src/lib/ssrf-fetch.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/ssrf-fetch.ts')>();
  return { ...orig, ssrfSafeFetchText: vi.fn() };
});
vi.mock('../src/lib/telegram-ingest.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/telegram-ingest.ts')>();
  return { ...orig, sendMessage: vi.fn(async () => undefined) };
});

import { runEnrichmentLoop } from '../src/lib/inbox-enrichment.ts';
import { ssrfSafeFetchText } from '../src/lib/ssrf-fetch.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';

const GI003 =
  'https://amportal.astro.org/sessions/pl-01-22946/initial-results-of-nrg-oncology-nrg-gi003-a-phase-iii-randomized-trial-of-protons-vs-photons-113309';

const card = (date: string) => ({
  date,
  digest: {
    generated_at: `${date}T09:00:00Z`,
    top_line: 'x',
    tldr: 'x',
    sites: [
      {
        disease_site: 'hepatobiliary',
        intro: null,
        open_questions: null,
        studies: [{ name: 'NRG-GI003', slug: 'nrg-gi003', tldr: 'x', details: [], nct: 'NCT03186898', tweet_ids: [] }],
      },
    ],
  },
});

async function enrichOnOct4() {
  const db = openDb(':memory:');
  saveInboxItem(db, {
    type: 'paper',
    raw_target: GI003,
    raw_message_text: GI003,
    telegram_msg_id: 1,
    telegram_chat_id: 42,
    bookmark_date: '2026-10-04',
  });
  await runEnrichmentLoop(db, listInboxItemsForEnrichment(db));
}

const nudges = () =>
  vi.mocked(sendMessage).mock.calls.map((c) => String(c[2])).filter((t) => t.startsWith('Heads up'));

describe('prior-coverage nudge for a backdated portal abstract', () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
    vi.mocked(ssrfSafeFetchText).mockResolvedValue(
      readFileSync('test/fixtures/conference-abstracts/astro-gi003.html', 'utf8'),
    );
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.SOURCE_FACET = 'off';
  });

  it('does not offer the card for its own presentation date as an earlier duplicate', async () => {
    digests.list = [card('2026-09-28')];
    await enrichOnOct4();
    expect(nudges()).toEqual([]);
  });

  it('still nudges about a genuinely earlier card', async () => {
    digests.list = [card('2026-09-20')];
    await enrichOnOct4();
    expect(nudges().join('\n')).toMatch(/2026-09-20/);
  });
});
