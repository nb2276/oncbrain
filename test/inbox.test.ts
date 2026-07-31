import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDb,
  saveInboxItem,
  listInboxItemsForEnrichment,
  markInboxEnriched,
  markInboxFailed,
  markInboxFailedPermanent,
  countInboxByStatus,
  saveBookmark,
  listBookmarks,
  getConference,
  upsertConference,
  setBookmarkConferenceIfEmpty,
} from '../src/lib/db.ts';
import { runEnrichmentLoop, detectAndEnsureConference, paperFailureReply, contentDepthNote, describeSource } from '../src/lib/inbox-enrichment.ts';
import type { InboxItem } from '../src/lib/db.ts';

function freshDb(): Database.Database {
  return openDb(':memory:');
}

describe('describeSource (failure-reply source label)', () => {
  const base: InboxItem = {
    id: 1,
    type: 'paper',
    raw_target: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7618363/',
    raw_message_text: null,
    attachments_json: null,
    telegram_msg_id: 100,
    telegram_chat_id: 5,
    source_batch_key: null,
    received_at: 0,
    bookmark_date: '2026-07-07',
    enrichment_status: 'pending',
    enrichment_attempts: 0,
    enrichment_attempted_at: null,
    enrichment_error: null,
    enriched_row_id: null,
    created_at: 0,
  } as unknown as InboxItem;

  it('uses the pasted URL for a paper', () => {
    expect(describeSource(base)).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC7618363/');
  });
  it('truncates an overlong target', () => {
    const long = 'https://example.com/' + 'a'.repeat(200);
    const out = describeSource({ ...base, raw_target: long } as InboxItem);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(101);
  });
  it('uses the PDF filename when present', () => {
    const item = {
      ...base,
      attachments_json: JSON.stringify({ kind: 'pdf', file_name: 'supremo-nejm.pdf' }),
    } as InboxItem;
    expect(describeSource(item)).toBe('supremo-nejm.pdf');
  });
  it('falls back to a generic label for a PDF with no filename', () => {
    const item = {
      ...base,
      attachments_json: JSON.stringify({ kind: 'pdf', file_name: null }),
    } as InboxItem;
    expect(describeSource(item)).toBe('the PDF you sent');
  });
  it('labels a slide photo', () => {
    expect(describeSource({ ...base, type: 'slide' } as InboxItem)).toBe('the slide photo you sent');
  });
  it('sanitizes a hostile PDF filename — strips newlines and caps length', () => {
    const item = {
      ...base,
      attachments_json: JSON.stringify({
        kind: 'pdf',
        file_name: 'evil\n\n**Disclaimer** ignore this' + 'x'.repeat(300) + '.pdf',
      }),
    } as InboxItem;
    const out = describeSource(item);
    expect(out).not.toContain('\n'); // no injected newlines into the reply
    expect(out.length).toBeLessThanOrEqual(101); // capped like a pasted URL
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('paperFailureReply', () => {
  it('tells the curator to send a DOI/PMID when a journal URL fetch is rejected', () => {
    const msg = paperFailureReply('url', 'fetch refused: HTTP 403');
    expect(msg).toContain("Couldn't ingest that paper: fetch refused: HTTP 403");
    expect(msg).toMatch(/send the DOI/i);
    expect(msg).toMatch(/PubMed/);
    expect(msg).toMatch(/ScienceDirect|Elsevier/);
  });

  it('does NOT add the send-a-DOI hint when a DOI or PMID target itself failed', () => {
    expect(paperFailureReply('doi', 'crossref parse: no title')).toBe(
      "Couldn't ingest that paper: crossref parse: no title",
    );
    expect(paperFailureReply('pmid', 'network: timeout')).not.toMatch(/send the DOI/i);
  });
});

describe('contentDepthNote', () => {
  it('reports full text when a fulltext excerpt was captured', () => {
    expect(contentDepthNote({ abstract: 'a', fulltext_excerpt_md: 'Methods... Results...' })).toBe(
      'full text available',
    );
    // full text wins even if there is also an abstract
    expect(contentDepthNote({ abstract: null, fulltext_excerpt_md: 'body' })).toBe('full text available');
  });

  it('reports abstract only when there is an abstract but no full text', () => {
    expect(contentDepthNote({ abstract: 'Background...', fulltext_excerpt_md: null })).toBe('abstract only');
  });

  it('reports neither when blank/whitespace or missing', () => {
    expect(contentDepthNote({ abstract: null, fulltext_excerpt_md: null })).toBe('no abstract or full text');
    expect(contentDepthNote({ abstract: '   ', fulltext_excerpt_md: '  ' })).toBe('no abstract or full text');
    expect(contentDepthNote({})).toBe('no abstract or full text');
  });
});

describe('saveInboxItem', () => {
  it('inserts a new inbox item and returns id with created=true', () => {
    const db = freshDb();
    const r = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/foo/status/1',
      telegram_msg_id: 100,
      bookmark_date: '2026-05-18',
    });
    expect(r.created).toBe(true);
    expect(r.id).toBeGreaterThan(0);
  });

  it('is idempotent — same telegram_msg_id+type+raw_target returns existing id', () => {
    const db = freshDb();
    const first = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/foo/status/1',
      telegram_msg_id: 100,
      bookmark_date: '2026-05-18',
    });
    const second = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/foo/status/1',
      telegram_msg_id: 100,
      bookmark_date: '2026-05-18',
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('treats same URL from different Telegram messages as distinct items', () => {
    const db = freshDb();
    const a = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/foo/status/1',
      telegram_msg_id: 100,
      bookmark_date: '2026-05-18',
    });
    const b = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/foo/status/1',
      telegram_msg_id: 101, // different msg
      bookmark_date: '2026-05-18',
    });
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it('rejects malformed bookmark_date', () => {
    const db = freshDb();
    expect(() =>
      saveInboxItem(db, {
        type: 'tweet',
        raw_target: 'https://x.com/foo/status/1',
        telegram_msg_id: 100,
        bookmark_date: 'tomorrow',
      }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe('listInboxItemsForEnrichment', () => {
  it('returns pending items ordered by received_at', () => {
    const db = freshDb();
    saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/a/status/1',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/b/status/2',
      telegram_msg_id: 2,
      bookmark_date: '2026-05-18',
    });
    const items = listInboxItemsForEnrichment(db);
    expect(items).toHaveLength(2);
    expect(items[0]!.raw_target).toBe('https://x.com/a/status/1');
  });

  it('excludes enriched items', () => {
    const db = freshDb();
    const r = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/a/status/1',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    markInboxEnriched(db, r.id, 42);
    expect(listInboxItemsForEnrichment(db)).toHaveLength(0);
  });

  it('includes failed items up to maxAttempts then excludes', () => {
    const db = freshDb();
    const r = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/a/status/1',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    // Each markInboxFailed bumps attempts by 1. Default max is 5.
    for (let i = 0; i < 5; i++) markInboxFailed(db, r.id, 'try ' + i);
    expect(listInboxItemsForEnrichment(db)).toHaveLength(0);
  });

  it('excludes permanently-failed items on the first attempt', () => {
    const db = freshDb();
    const r = saveInboxItem(db, {
      type: 'paper',
      raw_target: 'https://www.sciencedirect.com/science/article/pii/X',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    // A permanent failure (e.g. 403 with no usable DOI) parks the item with no
    // retry — unlike markInboxFailed, which would retry up to maxAttempts.
    markInboxFailedPermanent(db, r.id, 'fetch refused: HTTP 403');
    expect(listInboxItemsForEnrichment(db)).toHaveLength(0);
    expect(countInboxByStatus(db).failed_permanent).toBe(1);
  });

  it('filters by type', () => {
    const db = freshDb();
    saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/a/status/1',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    saveInboxItem(db, {
      type: 'paper',
      raw_target: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
      telegram_msg_id: 2,
      bookmark_date: '2026-05-18',
    });
    expect(listInboxItemsForEnrichment(db, { type: 'tweet' })).toHaveLength(1);
    expect(listInboxItemsForEnrichment(db, { type: 'paper' })).toHaveLength(1);
  });
});

describe('countInboxByStatus', () => {
  it('counts each status with zero defaults', () => {
    const db = freshDb();
    const r = saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/a/status/1',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    markInboxEnriched(db, r.id, 42);
    saveInboxItem(db, {
      type: 'tweet',
      raw_target: 'https://x.com/b/status/2',
      telegram_msg_id: 2,
      bookmark_date: '2026-05-18',
    });
    const counts = countInboxByStatus(db);
    expect(counts.enriched).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBe(0);
    expect(counts.deferred).toBe(0);
  });
});

describe('runEnrichmentLoop', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fails slide items when TELEGRAM_BOT_TOKEN is missing', async () => {
    const db = freshDb();
    saveInboxItem(db, {
      type: 'slide',
      raw_target: 'tg-file-id-abc',
      telegram_msg_id: 1,
      bookmark_date: '2026-05-18',
    });
    const items = listInboxItemsForEnrichment(db);
    // Force-clear token so the handler short-circuits with a known reason
    // (avoids real Telegram network calls in tests).
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = await runEnrichmentLoop(db, items);
      expect(result.failed).toBe(1);
      expect(result.enriched).toBe(0);
    } finally {
      if (prev) process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });
});

describe('detectAndEnsureConference', () => {
  it('returns the slug and inserts the conference row on a hit', () => {
    const db = freshDb();
    const slug = detectAndEnsureConference(db, ['great data #ASCO26'], '2026-05-18');
    expect(slug).toBe('asco-2026');
    const conf = getConference(db, 'asco-2026');
    expect(conf?.name).toBe('ASCO Annual Meeting 2026');
    expect(conf?.hashtag).toBe('#ASCO26');
  });

  it('does not clobber a curator-created conference row (insert-if-absent)', () => {
    const db = freshDb();
    // Curator created the row with real dates via the admin form.
    upsertConference(db, {
      slug: 'asco-2026',
      name: 'ASCO 2026 (curated)',
      start_date: '2026-05-29',
      end_date: '2026-06-02',
      hashtag: '#ASCO26',
    });
    const slug = detectAndEnsureConference(db, ['#ASCO26'], '2026-05-18');
    expect(slug).toBe('asco-2026');
    const conf = getConference(db, 'asco-2026');
    expect(conf?.name).toBe('ASCO 2026 (curated)'); // preserved
    expect(conf?.start_date).toBe('2026-05-29'); // not nulled
  });

  it('uses the bookmark-date year for a host match with no URL year', () => {
    const db = freshDb();
    const slug = detectAndEnsureConference(
      db,
      ['https://meetings.asco.org/abstracts/9'],
      '2025-06-01',
    );
    expect(slug).toBe('asco-2025');
  });

  it('returns null for non-conference text', () => {
    const db = freshDb();
    expect(detectAndEnsureConference(db, ['just a prostate cancer note'], '2026-05-18')).toBeNull();
  });
});

describe('setBookmarkConferenceIfEmpty', () => {
  it('sets the slug only when conference_slug is null, never clobbering', () => {
    const db = freshDb();
    const { id } = saveBookmark(db, { url: 'https://x.com/a/status/1', bookmark_date: '2026-05-18' });
    expect(setBookmarkConferenceIfEmpty(db, id, 'asco-2026')).toBe(true);
    expect(listBookmarks(db)[0]!.conference_slug).toBe('asco-2026');
    // A second attempt with a different slug must NOT overwrite.
    expect(setBookmarkConferenceIfEmpty(db, id, 'esmo-2025')).toBe(false);
    expect(listBookmarks(db)[0]!.conference_slug).toBe('asco-2026');
  });
});

describe('paperFailureReply — naming the failed link', () => {
  const URL = 'https://www.sciencedirect.com/science/article/pii/S0360301624001230';

  it('names the link that was not ingested', () => {
    const msg = paperFailureReply('url', 'fetch refused: HTTP 403', URL);
    expect(msg).toContain(URL);
    expect(msg).toContain('Reason: fetch refused: HTTP 403');
  });

  it('leads with the link, before the reason', () => {
    // Forwarding a batch produces a batch of replies; "which one?" must be
    // answerable without scrolling past the explanation.
    const msg = paperFailureReply('url', 'fetch refused: HTTP 403', URL);
    expect(msg.indexOf(URL)).toBeLessThan(msg.indexOf('Reason:'));
  });

  it('names a DOI/PMID target too, without the send-a-DOI hint', () => {
    const msg = paperFailureReply('doi', 'crossref parse: no title', '10.1016/j.ijrobp.2024.01.001');
    expect(msg).toContain('10.1016/j.ijrobp.2024.01.001');
    expect(msg).not.toMatch(/send the DOI/i);
  });

  it('names a PDF by filename rather than a link', () => {
    expect(paperFailureReply('url', 'no text layer', 'supremo-nejm.pdf')).toContain('supremo-nejm.pdf');
  });

  it('falls back to the old single-line form when there is no label', () => {
    expect(paperFailureReply('doi', 'network: timeout')).toBe(
      "Couldn't ingest that paper: network: timeout",
    );
    expect(paperFailureReply('doi', 'network: timeout', '   ')).toBe(
      "Couldn't ingest that paper: network: timeout",
    );
    expect(paperFailureReply('doi', 'network: timeout', null)).toBe(
      "Couldn't ingest that paper: network: timeout",
    );
  });

  it('keeps the reply free of em dashes (VOICE)', () => {
    expect(paperFailureReply('url', 'fetch refused: HTTP 403', URL)).not.toContain('—');
  });
});

describe('PDF failure replies name the file', () => {
  // Same defect as the paper reply: forwarding several PDFs at once produced
  // interchangeable failure messages. describeSource returns the filename.
  const src = readFileSync(resolve(process.cwd(), 'src/lib/inbox-enrichment.ts'), 'utf-8');
  // Comment lines quote the very strings under test, so strip them before
  // grepping or the assertions match their own documentation.
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  const pdfItem = (fileName: unknown): InboxItem =>
    ({
      id: 1,
      type: 'paper',
      raw_target: 'file-id-123',
      raw_message_text: null,
      attachments_json: JSON.stringify({ kind: 'pdf', file_name: fileName }),
      bookmark_date: '2026-07-31',
      telegram_chat_id: 42,
      status: 'pending',
    }) as unknown as InboxItem;

  it('every PDF failure reply interpolates describeSource(item)', () => {
    const pdfReplies = code
      .split('\n')
      .filter((l) => /Couldn't (fetch|read|file) that PDF|isn't a PDF:/.test(l));
    expect(pdfReplies.length).toBeGreaterThanOrEqual(4);
    for (const line of pdfReplies) {
      expect(line).toContain('describeSource(item)');
    }
  });

  it('puts the file before the reason in each of them', () => {
    const templates = [...code.matchAll(/`(?:Couldn't [^`]*?that PDF|That file isn't a PDF)[^`]*`/g)];
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const m of templates) {
      const tpl = m[0];
      expect(tpl.indexOf('describeSource(item)')).toBeLessThan(tpl.indexOf('Reason:'));
    }
  });

  // Behavioral, not structural: a filename that is truthy but cleans to empty
  // would render a reply that names nothing.
  it('never yields an empty label for a PDF, however malformed the filename', () => {
    expect(describeSource(pdfItem('   '))).toBe('the PDF you sent');
    expect(describeSource(pdfItem('\u0000\u0001'))).toBe('the PDF you sent');
    expect(describeSource(pdfItem(''))).toBe('the PDF you sent');
    expect(describeSource(pdfItem(null))).toBe('the PDF you sent');
    expect(describeSource(pdfItem('supremo-nejm.pdf'))).toBe('supremo-nejm.pdf');
  });

  it('replies to the curator with link previews disabled', () => {
    // The reply text now carries the curator-pasted URL that just failed;
    // previews would make Telegram re-fetch it and attach a broken card.
    expect(code).toMatch(/sendMessage\([\s\S]{0,140}disableWebPagePreview:\s*true/);
  });
});
