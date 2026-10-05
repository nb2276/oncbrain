// npm run watch:doi -- --add-file=<path>            # bulk-add from a citation list
// npm run watch:doi -- --add --doi=<doi> [--title=..] [--note=..]  # add one
// npm run watch:doi -- --list                        # show unresolved entries
// npm run watch:doi -- --check [--dry-run]           # re-check every entry
// npm run watch:doi -- --remove=<doi>                # drop a watch (gave up)
//
// A DOI that resolves via Crossref but carries no abstract has nothing for the
// study agent to analyze — a title alone. This is the common case for an
// Elsevier/Red Journal conference-abstract supplement (ASTRO's IJROBP
// supplement, e.g.): those publishers don't submit abstract text to Crossref at
// all, and Crossref is resolveFromDoi's ONLY source (it never falls back to
// fetching the publisher page — that's deliberate, to stay immune to
// Elsevier's bot-blocking). Rather than publish an empty stub, `--check`
// re-tries nightly for the SAME doi's Crossref record gaining an abstract, and
// promotes it into a normal inbox_items row when it does — `enrich:inbox` does
// the actual fetch+save through the SAME tested path a live Telegram
// submission uses. This script only DECIDES when it's time, never resolves
// the paper itself.
//
// HONEST CAVEAT: for an Elsevier abstract supplement specifically, this may be
// a long shot rather than a lag — withholding abstract text from Crossref for
// that content class reads as Elsevier's standing editorial practice, not a
// temporary indexing delay, so it may never arrive no matter how long this
// waits. Still worth having for the general case (a real transient Crossref
// gap, a different publisher backfilling later), and it costs nothing to also
// watch the unlikely case.
//
// title-search (paper-suggest.ts, matching the SAME abstract to a separately
// MEDLINE-indexed PMID) was tried and CUT from auto-promotion: measured
// against these 22 real ASTRO26 entries, it fuzzy-matched 7 of 9 hits to a
// plainly wrong, unrelated paper (a 1996 Radiother Oncol classic on the SAME
// generic topic, a 2017 Blood paper on unrelated DLBCL biology, etc.) — a
// curator's short trial-name shorthand ("GETUG P05 — brachy vs EBRT boost")
// has too few distinctive tokens for the overlap gate paper-suggest.ts was
// calibrated for (a page's own recovered title). A real hit still gets a
// curator DM to confirm (the exact suggest-and-forward flow paper-suggest.ts
// already uses for a blocked page) rather than auto-publishing a guess — the
// worst failure mode here is a wrong trial's numbers under the right trial's
// name.
//
// `--add-file` format: paragraphs separated by a blank line, each with a
// title/trial-name line followed by a line containing the paper's URL or bare
// DOI (optionally with a trailing hashtag, e.g. "#ASTRO26" — kept verbatim in
// the stored note so conference auto-tagging still fires once promoted). A
// paragraph with no DOI (a header/description line) is skipped, not an error.
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  saveInboxItem,
  getCuratorChatId,
  addDoiWatch,
  listDoiWatch,
  markDoiWatchChecked,
  resolveDoiWatch,
  removeDoiWatch,
  type DoiWatchEntry,
  SYNTHETIC_TELEGRAM_MSG_ID,
} from '../src/lib/db.ts';
import { extractPaperDois, extractPaperUrls, firstDoiInUrl } from '../src/lib/paper-url.ts';
import { normalizeDoi } from '../src/lib/doi.ts';
import { fetchCrossrefPaper } from '../src/lib/crossref-client.ts';
import { suggestAccessibleSource, formatSuggestionReply, type Suggestion } from '../src/lib/paper-suggest.ts';
import { sendMessage } from '../src/lib/telegram-ingest.ts';

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// One paragraph → one candidate watch entry. Returns null when the paragraph
// carries no DOI (the file's own header line, e.g.) — skip, not an error.
// A DOI-bearing line is either a full URL ("https://doi.org/10.xxx", parsed the
// same way extractPaperUrls' own callers would via firstDoiInUrl) or a bare DOI
// (extractPaperDois) — try both, reusing paper-url.ts's own extractors rather
// than a third regex.
export function parseWatchFileBlock(
  block: string,
): { doi: string; title: string | null; note: string } | null {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const urls = extractPaperUrls(block);
  const found =
    urls.map(firstDoiInUrl).find((d): d is string => d !== null) ?? extractPaperDois(block)[0];
  if (!found) return null;
  // The title is the first line that isn't itself DOI/URL-shaped (a bare DOI
  // with no scheme is excluded here too, not just a full URL) — null when the
  // block is nothing but an identifier.
  const title =
    lines.find((l) => extractPaperUrls(l).length === 0 && extractPaperDois(l).length === 0) ?? null;
  return { doi: found, title, note: block.trim() };
}

export function parseWatchFile(
  content: string,
): { doi: string; title: string | null; note: string }[] {
  return content
    .split(/\n\s*\n/)
    .map(parseWatchFileBlock)
    .filter((e): e is { doi: string; title: string | null; note: string } => e !== null);
}

function cmdAddFile(db: ReturnType<typeof openDb>, path: string): void {
  const content = readFileSync(path, 'utf8');
  const entries = parseWatchFile(content);
  if (entries.length === 0) {
    console.log(`watch:doi — found no DOI in ${path}`);
    return;
  }
  for (const e of entries) {
    addDoiWatch(db, e);
    console.log(`  watching ${e.doi}${e.title ? ` — ${e.title}` : ''}`);
  }
  console.log(`watch:doi — added ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${path}`);
}

function cmdAdd(db: ReturnType<typeof openDb>, doi: string, title?: string, note?: string): void {
  const normalized = addDoiWatch(db, { doi, title: title ?? null, note: note ?? null });
  if (!normalized) {
    console.error(`watch:doi — "${doi}" doesn't look like a DOI`);
    process.exitCode = 2;
    return;
  }
  console.log(`watch:doi — watching ${normalized}`);
}

function cmdList(db: ReturnType<typeof openDb>): void {
  const entries = listDoiWatch(db);
  if (entries.length === 0) {
    console.log('watch:doi — nothing watched');
    return;
  }
  for (const e of entries) {
    const age = Math.floor((Date.now() - e.added_at) / 86_400_000);
    const checked = e.last_checked_at
      ? `checked ${Math.floor((Date.now() - e.last_checked_at) / 86_400_000)}d ago, ${e.attempts}x`
      : 'never checked';
    console.log(`  ${e.doi} (added ${age}d ago, ${checked})${e.title ? `\n    ${e.title}` : ''}`);
  }
  console.log(`watch:doi — ${entries.length} unresolved`);
}

function cmdRemove(db: ReturnType<typeof openDb>, doi: string): void {
  const normalized = normalizeDoi(doi) ?? doi;
  removeDoiWatch(db, normalized);
  console.log(`watch:doi — removed ${normalized}`);
}

// Negative and fixed on purpose: real Telegram message ids are always
// positive, so this is never mistaken for one, and every consumer here keys
// on (type, raw_target) anyway — the UNIQUE index's third column — which is
// unique per paper regardless of what telegram_msg_id says.
const SYNTHETIC_MSG_ID = SYNTHETIC_TELEGRAM_MSG_ID;

async function cmdCheck(db: ReturnType<typeof openDb>, dryRun: boolean): Promise<void> {
  const entries = listDoiWatch(db);
  if (entries.length === 0) {
    console.log('watch:doi --check — nothing watched');
    return;
  }
  const chatId = getCuratorChatId(db);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  let promoted = 0;
  let suggested = 0;
  for (const e of entries) {
    const result = await checkOne(e);
    if (!dryRun) markDoiWatchChecked(db, e.doi);
    if (result.kind === 'waiting') {
      console.log(`  ${e.doi}: still no abstract`);
      continue;
    }
    if (result.kind === 'promote') {
      promoted++;
      console.log(`  ${e.doi}: Crossref now has an abstract — auto-promoting`);
      if (dryRun) continue;
      const r = saveInboxItem(db, {
        type: 'paper',
        raw_target: e.doi,
        raw_message_text: e.note,
        telegram_msg_id: SYNTHETIC_MSG_ID,
        telegram_chat_id: chatId,
        bookmark_date: new Date().toLocaleDateString('en-CA'), // en-CA → YYYY-MM-DD, matches unixToLocalDate
      });
      resolveDoiWatch(db, e.doi, 'crossref', r.id);
      continue;
    }
    // kind === 'suggest': a title-search hit. NEVER auto-published — DM'd to
    // the curator via the exact same suggest-and-forward flow a blocked
    // publisher page already uses, then removed from active watch so it
    // doesn't re-suggest the same (possibly wrong) match every night.
    suggested++;
    console.log(
      `  ${e.doi}: possible match via ${result.suggestion.source} (${result.suggestion.identifier}, score ${result.suggestion.score.toFixed(2)}) — DM'd to curator to confirm`,
    );
    if (dryRun) continue;
    if (token && chatId != null) {
      try {
        await sendMessage(
          token,
          chatId,
          formatSuggestionReply(`watched DOI ${e.doi} still has no abstract`, result.suggestion, e.title),
          { disableWebPagePreview: true },
        );
      } catch (err) {
        console.warn(`  failed to DM suggestion for ${e.doi}: ${(err as Error).message}`);
      }
    }
    resolveDoiWatch(db, e.doi, 'suggested', null);
  }
  console.log(
    `watch:doi --check — ${entries.length} checked, ${promoted} promoted, ${suggested} suggested to curator` +
      (dryRun ? ' [dry-run, nothing written]' : ''),
  );
}

export type CheckResult =
  | { kind: 'waiting' }
  | { kind: 'promote' }
  | { kind: 'suggest'; suggestion: Suggestion };

export type CheckOneDeps = {
  fetchCrossrefPaper?: typeof fetchCrossrefPaper;
  suggestAccessibleSource?: typeof suggestAccessibleSource;
};

// Best-effort: any lookup failure here just means "still waiting", not a
// crash — the same DOI stays watched and tries again on the next --check.
export async function checkOne(e: DoiWatchEntry, deps: CheckOneDeps = {}): Promise<CheckResult> {
  const doFetchCrossref = deps.fetchCrossrefPaper ?? fetchCrossrefPaper;
  const doSuggest = deps.suggestAccessibleSource ?? suggestAccessibleSource;
  let realTitle = e.title;
  try {
    const cr = await doFetchCrossref(e.doi);
    if (cr.abstract && cr.abstract.trim()) return { kind: 'promote' };
    // The Crossref record's OWN title, when present, is what actually gets
    // searched below — a curator's short trial-name note ("GETUG P05 — brachy
    // vs EBRT boost") is missing the specific tokens a title-overlap gate
    // needs and false-matched 7 of 9 real entries to an unrelated paper in
    // testing; the real title is calibrated the way paper-suggest.ts expects
    // (it was built to search on a page's own recovered title).
    if (cr.title) realTitle = cr.title;
  } catch {
    // Crossref hiccup — fall through to the title search on whatever title we
    // already had rather than give up this round; --check runs again tomorrow.
  }
  if (!realTitle) return { kind: 'waiting' };
  try {
    const suggestion = await doSuggest({ pageTitle: realTitle });
    if (!suggestion) return { kind: 'waiting' };
    // A Crossref-by-title hit that's just the SAME record we already watch
    // (no abstract either way) isn't new information.
    if (suggestion.source === 'crossref' && suggestion.identifier === e.doi) return { kind: 'waiting' };
    return { kind: 'suggest', suggestion };
  } catch {
    return { kind: 'waiting' };
  }
}

async function main(): Promise<void> {
  const db = openDb();
  const dryRun = hasFlag('dry-run');
  const addFile = argValue('add-file');
  const remove = argValue('remove');
  if (addFile) {
    cmdAddFile(db, addFile);
  } else if (hasFlag('add')) {
    const doi = argValue('doi');
    if (!doi) {
      console.error('watch:doi --add requires --doi=<doi>');
      process.exitCode = 2;
      return;
    }
    cmdAdd(db, doi, argValue('title'), argValue('note'));
  } else if (hasFlag('list')) {
    cmdList(db);
  } else if (hasFlag('check')) {
    await cmdCheck(db, dryRun);
  } else if (remove) {
    cmdRemove(db, remove);
  } else {
    console.log(
      'Usage: npm run watch:doi -- --add-file=<path> | --add --doi=<doi> | --list | --check [--dry-run] | --remove=<doi>',
    );
  }
}

// Importing this module must never touch the DB or the network — same guard
// as every other CLI in build/ (rebuild-queued.ts's comment explains why: the
// project lives under a Dropbox symlink, so argv[1] and import.meta.url
// disagree unless both sides are resolved).
function isInvokedAsScript(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isInvokedAsScript()) main();
