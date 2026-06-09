// v0.10 backfill smoke test (eng-review T16.5 rearchitecture).
//
// `npm run build:day -- --backfill` regenerates every digest in the corpus by
// re-reading bookmarks + papers + slides from SQLite and re-calling the LLM
// pipeline. That's how the v0.10 tag fields (modality/intent/methodology)
// reach the existing 9 days of artifacts.
//
// The original test design — compare existing JSON to regenerated JSON — is
// wrong because the LLM is non-deterministic; content drift is expected.
// What MUST stay stable is structural identity:
//   (a) per-date study count + slugs match what the LLM clustered (so the
//       slug-only /tags/<slug>/ URLs don't shift under readers)
//   (b) source refs survive across {bookmarks, papers, slide_uploads}
//       (so /api/v1/digest/<date>.json keeps the back-link to citations)
//   (c) every study carries the typed tag fields the prompt was extended to
//       emit (so backfill actually populates the v0.10 surface)
//
// Implementation: in-memory SQLite + mock LlmClient + tmpdir out paths, then
// drive the exported buildOneDate end-to-end per date.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  openDb,
  saveBookmark,
  savePaper,
  saveSlideUpload,
} from '../src/lib/db.ts';
import { buildOneDate } from '../build/digest-builder.ts';
import {
  paperIdToSyntheticTweetId,
  slideIdToSyntheticTweetId,
} from '../src/lib/llm-pipeline.ts';
import type {
  LlmClient,
  LlmMessage,
  LlmContentBlock,
  LlmTextBlock,
} from '../src/lib/llm-client.ts';

/**
 * Build a content-addressed mock LlmClient. Phase 2 runs studies concurrently
 * (default 4 at once), so a queue-ordered mock is fragile against any future
 * change to cluster ordering or pre-`complete` awaits. Instead we dispatch by
 * inspecting the rendered prompt:
 *   - the Phase 1 (grouping) prompt is the only one that doesn't carry a
 *     study-slug heading from Phase 2 / the lede-and-tldr heading from Phase 3
 *   - each Phase 2 prompt carries `[[STUDY]] <slug>` (from the prompt template);
 *     we route by substring match against the slug
 *   - Phase 3 carries the lede heading
 *
 * Falls back to the queue order only for the catch-all path.
 */
type MockRoutes = {
  grouping: string;
  studies: Record<string, string>; // slug → response
  synthesis: string;
  // v0.13: optional rerank-trials route. The orchestrator fires a rerank
  // LLM call when a Phase 2 response includes a non-null `related_search`
  // field with at least one valid query. When the existing fixtures here
  // don't emit related_search (the default), this route is unused and the
  // mock never sees a rerank prompt. When future fixtures add
  // related_search, set this to a JSON-shaped picks response (or '{"picks":[]}'
  // to exercise the abstain path).
  rerankTrials?: string;
};

function flattenPromptText(messages: LlmMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') parts.push(c);
    else
      for (const b of c as LlmContentBlock[]) {
        if (b.type === 'text') parts.push((b as LlmTextBlock).text);
      }
  }
  return parts.join('\n');
}

function mockClient(routes: MockRoutes): { client: LlmClient; calls: () => number } {
  let n = 0;
  const complete = vi.fn(async (messages: LlmMessage[]) => {
    n += 1;
    const text = flattenPromptText(messages);
    // Phase-specific anchors are unique strings in the rendered prompt
    // templates (prompts/digest-v5-*.txt). Routing by these is robust to
    // Phase 2 concurrency reordering AND to future per-phase prompt edits
    // because anchors are short and intrinsic to the phase's identity.
    if (text.includes('Phase 1 of 3')) return routes.grouping;
    if (text.includes('Phase 3 of 3')) return routes.synthesis;
    if (text.includes('Phase 2 of 3')) {
      for (const [slug, response] of Object.entries(routes.studies)) {
        // Phase 2 puts `Slug: <slug>` in the rendered user message.
        if (text.includes(`Slug: ${slug}`)) return response;
      }
      throw new Error(
        `mock Phase 2 received unknown study; prompt contained no known slug. Available: ${Object.keys(routes.studies).join(', ')}`,
      );
    }
    // v0.13: rerank-trials auxiliary phase. Anchor 'Per-study auxiliary phase'
    // is unique to prompts/digest-v5-rerank-trials.txt. Return the configured
    // route or fall back to safe abstain so legacy fixtures never break.
    if (text.includes('Per-study auxiliary phase')) {
      return routes.rerankTrials ?? '{"picks":[]}';
    }
    throw new Error('mock client could not identify phase from prompt');
  });
  return { client: { complete }, calls: () => n };
}

const SAMPLE_PAPER_TITLE = 'Sample Paper for Smoke Test';
const SAMPLE_SLIDE_PATH = 'data/slide-photos/2026-05-21/smoke-test-fixture.png';

describe('backfill smoke (v0.10 T16.5)', () => {
  let tmpRoot: string;
  let outDir: string;
  let obsidianDir: string;
  let overridesDir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'oncbrain-backfill-smoke-'));
    outDir = join(tmpRoot, 'digests');
    obsidianDir = join(tmpRoot, 'obsidian');
    overridesDir = join(tmpRoot, 'overrides');
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function args() {
    return {
      backfill: true,
      dryRun: false,
      skipFetch: true,
      outDir,
      obsidianDir,
      overridesDir,
    } as const;
  }

  function readArtifact(date: string) {
    const path = resolve(outDir, `${date}.json`);
    expect(existsSync(path), `expected artifact at ${path}`).toBe(true);
    return JSON.parse(readFileSync(path, 'utf-8')) as {
      date: string;
      bookmarks: Array<{ id: number }>;
      papers?: Array<{ id: number }>;
      slides?: Array<{ id: number }>;
      digest: {
        sites: Array<{
          studies: Array<{
            slug?: string;
            name: string;
            modality?: string | null;
            intent?: string | null;
            methodology?: string | null;
            tweet_ids: number[];
            source_ids?: Array<{ type: 'tweet' | 'paper' | 'slide'; id: number }>;
          }>;
        }>;
      };
    };
  }

  it('preserves study identity, source refs, and tag fields across a fixture backfill', async () => {
    const dateA = '2026-05-21';
    const dateB = '2026-05-22';

    // Seed two dates spanning all three source types.
    const bA1 = saveBookmark(db, {
      url: 'https://x.com/drfoo/status/1001',
      bookmark_date: dateA,
      author_handle: '@drfoo',
      author_name: 'Dr Foo',
      tweet_text: 'PRESTIGE-PSMA: OS HR 0.62 in mCRPC, primary endpoint met.',
      fetched_via: 'oembed',
    });
    const pA1 = savePaper(db, {
      pmid: '12345678',
      title: SAMPLE_PAPER_TITLE,
      bookmark_date: dateA,
      abstract: 'Companion paper to the prostate trial.',
      fetched_via: 'pubmed_efetch',
    });
    const sA1 = saveSlideUpload(db, {
      file_path: SAMPLE_SLIDE_PATH,
      file_hash: 'sha256-fixture',
      mime_type: 'image/png',
      ocr_text: 'KM curve, OS benefit.',
      bookmark_date: dateA,
    });
    const bB1 = saveBookmark(db, {
      url: 'https://x.com/drbar/status/2001',
      bookmark_date: dateB,
      author_handle: '@drbar',
      author_name: 'Dr Bar',
      tweet_text: 'Datopotamab in 2L TNBC: ORR 41%, durable.',
      fetched_via: 'oembed',
    });
    const bB2 = saveBookmark(db, {
      url: 'https://x.com/drbaz/status/2002',
      bookmark_date: dateB,
      author_handle: '@drbaz',
      author_name: 'Dr Baz',
      tweet_text: 'SABR oligomet: 2-yr PFS 38%.',
      fetched_via: 'oembed',
    });

    // Date A — one cluster covering tweet + paper + slide; one study.
    const groupingA = JSON.stringify({
      studies: [
        {
          slug: 'prestige-psma',
          name: 'PRESTIGE-PSMA',
          disease_site: 'prostate',
          tweet_ids: [
            bA1.id,
            paperIdToSyntheticTweetId(pA1.id),
            slideIdToSyntheticTweetId(sA1.id),
          ],
        },
      ],
    });
    const studyAgentA = JSON.stringify({
      name: 'PRESTIGE-PSMA',
      tldr: 'PRESTIGE-PSMA: OS HR 0.62 in mCRPC.',
      details: ['HR 0.62 (95% CI 0.45-0.85)'],
      nct: 'NCT04567890',
      modality: 'systemic',
      intent: 'palliative',
      methodology: 'phase-3-rct',
      verdict: {
        soc_implication: 'practice-changing',
        rationale: 'Phase 3 OS hit in mCRPC moves the standard.',
        audience: 'medical oncology',
      },
    });
    const synthesisA = JSON.stringify({
      top_line: 'PRESTIGE-PSMA reshapes 2L mCRPC.',
      tldr: 'Prostate Lu-PSMA OS positive.',
      site_meta: [
        { disease_site: 'prostate', intro: 'One pivotal prostate trial.', open_questions: null },
      ],
    });

    // Date B — two clusters, one for each tweet.
    const groupingB = JSON.stringify({
      studies: [
        {
          slug: 'datopotamab-tnbc',
          name: 'Datopotamab 2L TNBC',
          disease_site: 'breast',
          tweet_ids: [bB1.id],
        },
        {
          slug: 'sabr-oligomet',
          name: 'SABR Oligomet',
          disease_site: 'oligometastatic',
          tweet_ids: [bB2.id],
        },
      ],
    });
    const studyAgentB1 = JSON.stringify({
      name: 'Datopotamab 2L TNBC',
      tldr: 'Dato-DXd: ORR 41%.',
      details: ['ORR 41%, durable'],
      nct: null,
      modality: 'systemic',
      intent: 'palliative',
      methodology: 'phase-2-trial',
    });
    const studyAgentB2 = JSON.stringify({
      name: 'SABR Oligomet',
      tldr: 'SABR: 2-yr PFS 38%.',
      details: ['2-yr PFS 38%'],
      nct: null,
      modality: 'radiation',
      intent: 'curative',
      methodology: 'phase-3-rct',
    });
    const synthesisB = JSON.stringify({
      top_line: 'TROP2 + SABR momentum.',
      tldr: 'TNBC ADC and oligomet SABR.',
      site_meta: [
        { disease_site: 'breast', intro: null, open_questions: null },
        { disease_site: 'oligometastatic', intro: null, open_questions: null },
      ],
    });

    const { client: clientA } = mockClient({
      grouping: groupingA,
      studies: { 'prestige-psma': studyAgentA },
      synthesis: synthesisA,
    });
    await buildOneDate(args(), db, dateA, { client: clientA });
    const { client: clientB, calls: callsB } = mockClient({
      grouping: groupingB,
      studies: { 'datopotamab-tnbc': studyAgentB1, 'sabr-oligomet': studyAgentB2 },
      synthesis: synthesisB,
    });
    await buildOneDate(args(), db, dateB, { client: clientB });
    // 1 grouping + 2 study agents + 1 synthesis = 4 calls for Date B.
    expect(callsB()).toBe(4);

    // ─── (a) Per-date study identity ───────────────────────────────────────
    const artA = readArtifact(dateA);
    const artB = readArtifact(dateB);

    const studiesA = artA.digest.sites.flatMap((s) => s.studies);
    expect(studiesA).toHaveLength(1);
    expect(studiesA[0]!.slug).toBe('prestige-psma');

    const studiesB = artB.digest.sites.flatMap((s) => s.studies);
    expect(studiesB).toHaveLength(2);
    const slugsB = new Set(studiesB.map((s) => s.slug));
    expect(slugsB).toEqual(new Set(['datopotamab-tnbc', 'sabr-oligomet']));

    // ─── (b) Source refs preserved across all three source types ──────────
    const bookmarkIdsA = artA.bookmarks.map((b) => b.id);
    expect(bookmarkIdsA).toContain(bA1.id);
    const paperIdsA = (artA.papers ?? []).map((p) => p.id);
    expect(paperIdsA).toContain(pA1.id);
    const slideIdsA = (artA.slides ?? []).map((s) => s.id);
    expect(slideIdsA).toContain(sA1.id);

    // Phase 2 should propagate the synthetic IDs onto the study so consumers
    // (search index, RSS, Obsidian export) can back-link to citations.
    const allTweetIdsA = studiesA[0]!.tweet_ids;
    expect(allTweetIdsA).toEqual(
      expect.arrayContaining([
        bA1.id,
        paperIdToSyntheticTweetId(pA1.id),
        slideIdToSyntheticTweetId(sA1.id),
      ]),
    );

    // v0.5 invariant: typed source_ids decoded back from the synthetic tweet
    // ids. attachSourceIds runs at the end of buildDigest; a regression that
    // dropped one type would still pass the tweet_ids check above, so assert
    // the decoded refs explicitly.
    const sourceIdsA = studiesA[0]!.source_ids ?? [];
    expect(sourceIdsA).toEqual(
      expect.arrayContaining([
        { type: 'tweet', id: bA1.id },
        { type: 'paper', id: pA1.id },
        { type: 'slide', id: sA1.id },
      ]),
    );

    const bookmarkIdsB = artB.bookmarks.map((b) => b.id);
    expect(bookmarkIdsB).toEqual(expect.arrayContaining([bB1.id, bB2.id]));

    // ─── (c) Tag fields populated on every study ──────────────────────────
    for (const study of [...studiesA, ...studiesB]) {
      expect(study.modality, `${study.name}: modality missing`).toBeTruthy();
      expect(study.intent, `${study.name}: intent missing`).toBeTruthy();
      expect(study.methodology, `${study.name}: methodology missing`).toBeTruthy();
    }
    // And explicitly: SABR should land on radiation/curative, not the systemic
    // defaults, so a future prompt regression that collapses all studies to a
    // single modality would fail loudly.
    const sabr = studiesB.find((s) => s.slug === 'sabr-oligomet')!;
    expect(sabr.modality).toBe('radiation');
    expect(sabr.intent).toBe('curative');
  });

  it('still preserves source refs and tag fields when a date carries only papers (no tweets)', async () => {
    // v0.5+ multi-source: a day can have papers/slides only. The backfill
    // path must still emit a digest with the paper as the source ref.
    const date = '2026-05-23';
    const paper = savePaper(db, {
      pmid: '99887766',
      title: 'Lone paper day',
      bookmark_date: date,
      abstract: 'Single paper, no tweets.',
      fetched_via: 'pubmed_efetch',
    });

    const grouping = JSON.stringify({
      studies: [
        {
          slug: 'lone-paper-study',
          name: 'Lone Paper Study',
          disease_site: 'breast',
          tweet_ids: [paperIdToSyntheticTweetId(paper.id)],
        },
      ],
    });
    const studyAgent = JSON.stringify({
      name: 'Lone Paper Study',
      tldr: 'Lone paper TL;DR.',
      details: ['Single endpoint.'],
      nct: null,
      modality: 'systemic',
      intent: 'curative',
      methodology: 'phase-3-rct',
    });
    const synthesis = JSON.stringify({
      top_line: 'One paper, one study.',
      tldr: 'No cross-site synthesis needed.',
      site_meta: [{ disease_site: 'breast', intro: null, open_questions: null }],
    });

    const { client } = mockClient({
      grouping,
      studies: { 'lone-paper-study': studyAgent },
      synthesis,
    });
    await buildOneDate(args(), db, date, { client });

    const art = readArtifact(date);
    expect(art.bookmarks).toEqual([]);
    const paperIds = (art.papers ?? []).map((p) => p.id);
    expect(paperIds).toEqual([paper.id]);
    const studies = art.digest.sites.flatMap((s) => s.studies);
    expect(studies).toHaveLength(1);
    expect(studies[0]!.slug).toBe('lone-paper-study');
    expect(studies[0]!.modality).toBe('systemic');
    expect(studies[0]!.source_ids).toEqual(
      expect.arrayContaining([{ type: 'paper', id: paper.id }]),
    );
  });

  it('skips a date with zero sources without writing an artifact', async () => {
    const date = '2026-05-24';
    const { client, calls } = mockClient({ grouping: '', studies: {}, synthesis: '' });
    await buildOneDate(args(), db, date, { client });
    expect(existsSync(resolve(outDir, `${date}.json`))).toBe(false);
    expect(calls()).toBe(0); // never called the LLM
  });
});
