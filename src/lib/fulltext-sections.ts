// Section-aware full-text excerpting.
//
// THE PROBLEM THIS SOLVES. `fulltext_excerpt_md` used to be `text.slice(0, 8000)`
// — the FIRST 8000 characters of whatever pdftotext returned. For a text-layer
// PDF that is page 1 onward, so the study agent's "Methods/Results excerpt" was
// in fact the title page, the affiliations, the conflict-of-interest block, and
// a truncated abstract. Measured on the local corpus: 30 of 31 filed PDFs were
// truncated, median ~10% of the document seen. BEACON-HCC (74,549 chars) was cut
// mid-word inside the abstract, so the analyst never reached the four tables
// carrying the consensus it was asked to summarize, and correctly reported that
// the allocation rules were "not in source text". They were, on page 27.
//
// THE FIX. Segment the document by its own headings, DROP the sections that
// carry no analytic signal (references, disclosures, front matter), and spend
// the character budget in priority order — tables and figure captions FIRST,
// then Results, then the article body. A guideline's payload is a table in the
// back matter; a trial's is a Results paragraph. Both now fit in a budget the
// naive head-slice spent on author affiliations.
//
// Dropping the reference list is a QUALITY fix, not only a budget one. A
// bibliography is hundreds of trial acronyms and author names with no outcomes
// attached, handed to an agent that is asked to make comparative claims. It is
// the single most inviting place in the document to ground a fabricated "versus
// X" on a bare citation. It should never have been in the window.
//
// SAFETY PROPERTY: never worse than the head-slice. If a document has no
// recognizable headings (a scanned OCR blob, a tweet-length trade page), or if
// segmentation somehow discards nearly everything, composeExcerpt falls back to
// the plain leading slice. A weird PDF degrades to the old behavior rather than
// to nothing.
//
// Pure functions only — no I/O, no LLM. The structure is recoverable by rule
// from `pdftotext -layout` output, so paying a model to find it would be slower,
// costlier, and less repeatable than a regex. See also pmc-oa.ts, which does the
// equivalent job for PMC nxml (where the structure arrives as real markup).

// Default budget for a stored excerpt, ~8k tokens.
//
// NOT measured here, and worth saying plainly: whether a bigger excerpt makes
// the analyst BETTER or merely BIGGER. Everything below is coverage — how much
// of the source reaches the prompt. Past some point more context dilutes
// attention rather than adding grounding, and character counts cannot detect
// that. `npm run quality-eval -- --date=…` at two settings is what settles it;
// until someone runs that, treat anything above 24000 as unproven upside.
//
// The excerpt is a MINORITY of the Phase 2 prompt, which is the fact that
// settles the size question. Fixed cost per study-agent call is ~53,000 chars
// before any paper text: the study-agent template (34,730) plus the VOICE.md
// substituted into it (15,504) plus the perspective profile (2,854). Against
// that, moving the excerpt from 8000 to 24000 raises the call from roughly
// 15,900 to 19,900 tokens — about 25%, not the 3x the excerpt ratio suggests in
// isolation.
//
// On the claude-cli backend (the default), the binding constraint is the rolling
// subscription window rather than dollars. Anchoring on the observed ceiling of
// ~17 study-agents per window, 24000 costs roughly three of them. A normal day
// is 2-3 studies and never approaches the limit; only a mass rebuild does, and
// that is what FULLTEXT_EXCERPT_CHARS=8000 is for.
//
// What the extra budget buys, measured over the 31 filed PDFs: 8000 → 46 table
// blocks, 12000 → 54, 24000 → 63. It PLATEAUS there — 32000, 40000 and 60000 all
// find the same 63, because by 24000 every table that is going to fit has fit.
// What 40000 still buys is fewer CUT tables: 6 table blocks are truncated at
// 24000, only 1 at 40000. That is the argument for going past the plateau, and
// it is a real one on guideline papers whose tail rows are recommendations.
// Everything else above 24000 is prose depth and figure captions.
//
// The ceiling is the papers themselves. After dropping references, disclosures
// and front matter the median filed PDF has 38,826 chars of usable content
// (p25 25,343 / p75 48,006), so a 40000 budget is roughly "the median paper,
// whole" and goes unspent on the smaller half.
//
// The floor is what matters most and it is already met at any of these: at 8000
// the old head-slice reached ZERO tables and ZERO figure captions, because the
// bug was never the size of the window — it was what the window was spent on.
export const DEFAULT_EXCERPT_CHARS = 50_000;

// Don't bother including a section we can only show a sliver of; below this a
// truncated section is more likely to mislead (half a table, a dangling clause)
// than to inform. The budget is left unspent instead.
const MIN_SECTION_CHARS = 600;

// Ceiling on what the table/figure tier may take on its FIRST pass, so a
// table-heavy paper can't spend the entire budget before any prose is reached.
// Measured: without this, at an 8000-char budget 13 of 31 filed PDFs came back
// with tables and figure captions but NOT ONE prose section — the analyst got
// numbers with no design, population, or endpoint context to read them against.
// Any budget the prose tier then declines to use flows back to the remaining
// tables in a third pass, so a genuinely table-only paper (a consensus
// statement whose content IS the grid) still fills the window with tables.
const TABLE_TIER_MAX_FRACTION = 0.6;

// Above this share of the document, the leading unheaded block is the article
// rather than its title page — see segmentDocument for the regression this
// prevents.
const FRONT_MAX_FRACTION = 0.25;

// Below this total size, never classify the leading block as droppable front
// matter — see segmentDocument. Trade-press PDFs run 7-9k chars; a real journal
// article with a genuine title page runs 40k+.
const FRONT_TRUST_MIN_DOC_CHARS = 15_000;

// A -layout block may replace its reading-order twin only if it is within this
// multiple of it. Measured: without the bound, 20 substitutions across 14 of 31
// PDFs ran 3x to 5348x oversize, because in the layout pass a caption is often
// the last recognized heading before a long unheaded stretch, so its "section"
// runs to end-of-file. One delivered excerpt led with 5,779 chars labeled
// "Table 1: Baseline characteristics" that were actually two-column-interleaved
// Discussion prose and Kaplan-Meier axis numbers from three adjacent panels —
// prose entering the excerpt AS a table, which is the one thing the reading-
// order/layout split exists to prevent.
const LAYOUT_MAX_RATIO = 3;

export type SectionKind =
  | 'front' // title page, authors, affiliations, keywords
  | 'abstract'
  | 'intro'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'table' // a "Table N." block — for a guideline, usually the whole point
  | 'figure' // a "Figure N." caption block (the caption text, not the image)
  | 'references'
  | 'disclosures' // COI, funding, acknowledgments, data/code availability
  | 'body'; // a recognized heading we have no specific bucket for

export type Section = {
  kind: SectionKind;
  heading: string | null;
  text: string;
  start: number;
};

// Sections that never earn their place in an analyst's context window.
const DROPPED_KINDS: ReadonlySet<SectionKind> = new Set<SectionKind>([
  'front',
  'references',
  'disclosures',
]);

// Fill order. Tables and figure captions lead by explicit instruction and by
// evidence: they are the densest grounded content in a clinical paper and the
// only place a guideline's recommendations exist in structured form. Prose
// follows in decreasing order of how often it carries a number.
const FILL_ORDER: readonly SectionKind[] = [
  'table',
  'figure',
  'results',
  'body',
  'methods',
  'discussion',
  'intro',
  'abstract',
];

// The two kinds that lead the excerpt and share the TABLE_TIER_MAX_FRACTION cap.
function isTableTier(kind: SectionKind): boolean {
  return kind === 'table' || kind === 'figure';
}

// ────────────────────────────────────────────────────────────────────────────
// Watermark artifacts
// ────────────────────────────────────────────────────────────────────────────

// An "ACCEPTED MANUSCRIPT" / "DRAFT" diagonal watermark is drawn as real text in
// the layer, one or two glyphs per line, scattered through every page. BEACON's
// text layer carries ~200 such fragments ("TE", "D", "CEP", "AC"). They are not
// content, they break heading detection by interrupting a block, and they eat
// budget.
//
// Shape alone CANNOT decide this, and getting it wrong is dangerous in exactly
// one direction. A standalone short all-caps token is also how a table's column
// header extracts — `HR`, `CI`, `OR`, `RR`, `DFS`, `ITT`, `SBRT`, `NCT`. Delete
// those and the numbers beneath them survive with nothing naming what they are,
// which is the "value present, label gone" failure this whole module exists to
// prevent. An allowlist can't fix that: clinical oncology has more abbreviations
// than anyone will enumerate, and the one you forget is the one that breaks.
//
// Frequency alone ISN'T enough either, and this was measured, not guessed. A
// randomised trial prints its arm labels once per KM panel and once per table
// row-group, which lands at 5-30 repeats — squarely inside watermark range. On
// the real corpus a repeats-only gate deleted `ENRT` and `MDT` (both arms of
// PEACE V-STORM), `TNT` and `CRT` (both arms of STELLAR), and `SOC` (the control
// arm of STAMPEDE, while the multi-word experimental arm survived, leaving a
// legend with one of two arms). Exactly the failure described above.
//
// So gate on both: the fragment must REPEAT, and it must be a contiguous
// substring of a word that actually appears in publisher watermarks. "TE", "D",
// "CEP", "AC" are all pieces of ACCEPTED; "ENRT", "TNT", "SOC", "MDT" are pieces
// of nothing. That is a closed set we control, rather than an open set of
// clinical abbreviations we would have to enumerate and would get wrong.
const WATERMARK_FRAGMENT = /^[A-Z]{1,4}\d{0,3}$/;
const WATERMARK_MIN_REPEATS = 5;

// Words publishers stamp diagonally across a proof. A watermark fragment is a
// contiguous slice of one of these; nothing else is treated as furniture.
const WATERMARK_WORDS = [
  'ACCEPTED',
  'MANUSCRIPT',
  'UNCORRECTED',
  'PROOF',
  'DRAFT',
  'CONFIDENTIAL',
  'EMBARGOED',
  'PROVISIONAL',
  'PREPRINT',
  'RETRACTED',
];

const WATERMARK_PIECES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  // Slices start at length 2, NOT 1. At length 1 every individual letter of
  // these ten words becomes a "piece" — 18 of the 26 letters — and because the
  // membership test strips a trailing digit run first, that deleted `G3`/`G4`
  // (toxicity grades), `T1`-`T4`, `N0`/`N1` and `M0`/`M1` (TNM stage rows)
  // straight off the numbers they label. Same failure this gate exists to
  // prevent, one layer down. A single stray glyph is cheap to leave in.
  for (const w of WATERMARK_WORDS) {
    for (let i = 0; i < w.length; i++) {
      for (let n = 2; n <= 4 && i + n <= w.length; n++) out.add(w.slice(i, i + n));
    }
  }
  return out;
})();

// Never strippable regardless of repeat count. Not exhaustive by design — the
// frequency gate is the real protection; this is the belt to its braces.
const WATERMARK_SAFE = new Set([
  'OS', 'PFS', 'DFS', 'EFS', 'MFS', 'RFS', 'DMFS', 'TTP', 'ORR', 'DCR', 'PCR', 'CR', 'PR', 'SD', 'PD',
  'HR', 'OR', 'RR', 'SHR', 'CI', 'SD', 'SE', 'IQR', 'ITT', 'PP', 'AE', 'SAE', 'QOL',
  'RT', 'CT', 'MRI', 'PET', 'SBRT', 'SABR', 'IMRT', 'EBRT', 'VMAT', 'IGRT', 'ADT', 'TACE', 'TARE',
  'RFA', 'MWA', 'LDLT', 'LT', 'NCT', 'PMID', 'DOI', 'HCC', 'AJCC', 'BCLC', 'ECOG', 'PS', 'GTV',
  'CTV', 'PTV', 'ITV', 'IGTV', 'OAR', 'DSC', 'MDA', 'HD', 'AFP', 'PSA', 'IVC', 'LN', 'MVI',
  // Table-cell placeholders. "NA" is a contiguous slice of PROVISIONAL, so the
  // watermark-piece rule alone would delete it and turn every "not applicable"
  // cell into a blank the analyst reads as missing data.
  'NA', 'NR', 'NS', 'NE', 'NC', 'ND',
]);

export function stripWatermarkArtifacts(text: string): string {
  const lines = text.split('\n');

  // Count how often each candidate fragment stands alone on its own line.
  const counts = new Map<string, number>();
  for (const line of lines) {
    const s = line.trim();
    if (s && WATERMARK_FRAGMENT.test(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }

  return lines
    .filter((line) => {
      const s = line.trim();
      if (!s || !WATERMARK_FRAGMENT.test(s)) return true;
      if (WATERMARK_SAFE.has(s)) return true;
      if (!WATERMARK_PIECES.has(s.replace(/\d+$/, ''))) return true;
      return (counts.get(s) ?? 0) < WATERMARK_MIN_REPEATS;
    })
    .join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Heading detection
// ────────────────────────────────────────────────────────────────────────────

// Keyword → kind for a standalone section heading. Ordered longest-intent first
// so "Supplementary Methods" doesn't match bare "Methods" semantics wrongly.
const HEADING_RULES: ReadonlyArray<{ re: RegExp; kind: SectionKind }> = [
  { re: /^(references|bibliography|literature cited)\b/i, kind: 'references' },
  {
    // The wrapped real-world forms matter as much as the tidy ones: JCO sets
    // "AUTHORS' DISCLOSURES OF POTENTIAL CONFLICTS / OF INTEREST" across two
    // lines, and an anchored /^conflicts of interest/ missed it — so the COI
    // block was classified `body` and KEPT, which is the opposite of intent.
    re: /^(conflicts? of interest|competing interests?|(authors'? )?disclosures?|funding|financial support|support|acknowledge?ments?|data (availability|sharing)|data supplement|study protocol|author contributions?|corresponding author|prior presentation|article information|authors info|equal contribution|accompanying content|reprints?|ethics (statement|approval))\b/i,
    kind: 'disclosures',
  },
  { re: /^(abstract|summary|graphical abstract)\b/i, kind: 'abstract' },
  { re: /^(introduction|background)\b/i, kind: 'intro' },
  {
    re: /^(methods?|materials and methods|patients and methods|methodology|study design)\b/i,
    kind: 'methods',
  },
  { re: /^(results?|findings)\b/i, kind: 'results' },
  { re: /^(discussion|conclusions?|interpretation|comment)\b/i, kind: 'discussion' },
];

// A "Table 3." / "Supplementary Figure 2:" block opener. Anchored at line start
// so a prose mention ("detailed in Table 1 and Table 2") is never a heading.
//
// The punctuation is OPTIONAL because plenty of journals set the caption as a
// bare `TABLE 1` with the title on the following line. Requiring `.` or `:`
// there loses the whole block — and if it sits after the reference list, it gets
// swallowed into a section we drop, so the payload table vanishes from a
// perfectly healthy-looking excerpt. The bare form is compensated by
// BARE_LABEL_MAX_CHARS below: `TABLE 1` alone is a caption, but
// "Table 1 shows that the experimental arm did better" is prose.
// `Fig.` is Elsevier house style and `–` is Eur Urol's separator; requiring the
// literal word "figure" and an ASCII delimiter missed ~45% of real captions in
// the corpus, including a head-and-neck contouring paper with ~20 `Fig. N.`
// captions that composed zero figure blocks.
const TABLE_HEADING =
  /^(?:supplementary|supplemental|appendix)?\s*table\s+\d+(?:\.\d+)*[a-z]?\s*(?:[.:–—-]|\(continued\)|$)/i;
const FIGURE_HEADING =
  /^(?:supplementary|supplemental|appendix)?\s*fig(?:ure|\.)?\s*\d+(?:\.\d+)*[a-z]?\s*(?:[.:–—-]|\(continued\)|$)/i;

// A caption with NO delimiter has to stand alone on its line to count.
const BARE_LABEL_MAX_CHARS = 24;

// Captions run long ("Table 1. Baseline demographic and clinical characteristics
// of the intention-to-treat population by randomised arm"), so they get their
// own ceiling rather than the short MAX_HEADING_CHARS used for section names.
const MAX_CAPTION_CHARS = 300;

// Headings are short. A long line that happens to open with "Results" is a
// sentence ("Results were consistent across …"), not a section break.
const MAX_HEADING_CHARS = 90;

// An unenumerated ALL-CAPS section heading. Requires a real word (>=3 letters)
// so a stray initialism row or a lone acronym doesn't split a section, and
// forbids terminal sentence punctuation so a shouted sentence isn't a heading.
const GENERIC_HEADING = /^(?=.*[A-Z]{3})[A-Z][A-Z0-9 ,&/’'()-]*[A-Z0-9)]$/;

// Publisher-website furniture and label-shaped lines that pass GENERIC_HEADING
// but are not sections. Measured on a JCO web-print PDF: `FOLLOW US`,
// `ASCO WEBSITES`, `ORIGINAL REPORTS` and five `MONTH YEAR` headings carrying
// the titles of five OTHER trials with no outcomes attached — ~28% of that
// excerpt, and re-admitting at `body` priority the exact hazard this module
// drops the reference list to avoid. Also rejects registry/protocol IDs
// (`RTOG 0848`, `ADRO 102156`) and measurement labels (`PI-RADS 2`, `DLCO SB`)
// that would split a section on a table row.
const CHROME_HEADING = new RegExp(
  [
    '^(follow us|subscribe|sign in|share|cite this|related articles?|recommended articles?)\\b',
    '^(asco|nejm|jama|elsevier|springer|wiley|lancet)\\b',
    '^(original reports?|original article|review article|editorial|commentary|letters?)\\b',
    // MONTH YEAR — a date, not a section.
    '^(january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d{4}$',
    // A short all-caps token followed by a bare number: a registry ID or a
    // measurement label lifted off a table row.
    '^[A-Z][A-Z0-9-]{1,9}\\s+\\d+(\\s*\\(\\d+\\))?$',
  ].join('|'),
  'i',
);

// Classify one line as a heading, or null if it is body text.
export function classifyHeading(line: string): { kind: SectionKind; heading: string } | null {
  const s = line.trim();
  if (!s) return null;

  // Captions are checked BEFORE the section-name length gate, and against their
  // own longer ceiling — a long caption is still a caption.
  if (s.length <= MAX_CAPTION_CHARS) {
    for (const [re, kind] of [
      [TABLE_HEADING, 'table'],
      [FIGURE_HEADING, 'figure'],
    ] as const) {
      const m = re.exec(s);
      if (!m) continue;
      // Matched without a `.`/`:` delimiter? Then it must be a bare label line,
      // not the opening words of a sentence.
      // Must match the delimiter class the regexes admit. Widening those to
      // accept `–` (Eur Urol) while leaving this testing only `[.:]` rejected an
      // entire publisher house style: "Fig. 1 – Kaplan-Meier curves for overall
      // survival" returned null, and a dash-captioned table sitting after
      // REFERENCES — its normal position — was absorbed into the dropped
      // section and vanished with fellBack:false.
      const delimited = /[.:–—-]\s*$/.test(m[0]);
      if (!delimited && s.length > BARE_LABEL_MAX_CHARS) continue;
      return { kind, heading: s };
    }
  }

  if (s.length > MAX_HEADING_CHARS) return null;

  // A named section heading is either standalone or "Methods:"-style. Require
  // the line to be mostly the heading itself: a numbered heading ("3. Results")
  // is allowed, a sentence starting with the word is not.
  const bare = s.replace(/^\d+(\.\d+)*[.)]?\s*/, '').replace(/[:.]\s*$/, '');
  if (bare.length > 60) return null;
  for (const { re, kind } of HEADING_RULES) {
    if (!re.test(bare)) continue;
    // Guard against "Results and Discussion of the pooled cohort analysis" —
    // allow a couple of extra words (subtitles are common) but not a clause.
    if (bare.split(/\s+/).length > 6) return null;
    return { kind, heading: s };
  }

  // A paper's own named sections ("BEACON-HCC SYSTEM", "TREATMENT ALLOCATION")
  // carry no keyword we can enumerate, and without this rule they get absorbed
  // into whichever standard section precedes them — on BEACON that buried the
  // 20k-char section defining every treatment class inside METHODS, where the
  // budget then truncated it away. A false positive here is cheap: it splits one
  // 'body' section into two, both kept at the same priority. A false negative is
  // expensive, so this leans permissive.
  // Require two-plus words and no terminal period: a single shouted token is an
  // affiliation fragment ("USA.", "NCI") far more often than a section, and
  // every single-word section heading worth having is already a keyword above.
  const words = bare.split(/\s+/).length;
  if (
    GENERIC_HEADING.test(bare) &&
    words >= 2 &&
    words <= 6 &&
    !s.trim().endsWith('.') &&
    !CHROME_HEADING.test(bare)
  ) {
    return { kind: 'body', heading: s };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Segmentation
// ────────────────────────────────────────────────────────────────────────────

// Split a document into labeled sections at its own headings. Text before the
// first recognized heading is 'front' (title page, authors, affiliations).
export function segmentDocument(rawText: string): Section[] {
  const text = stripWatermarkArtifacts(rawText);
  const lines = text.split('\n');

  const sections: Section[] = [];
  let current: Section = { kind: 'front', heading: null, text: '', start: 0 };
  const buf: string[] = [];
  let offset = 0;

  const flush = (): void => {
    current.text = buf.join('\n').trim();
    if (current.text || current.heading) sections.push({ ...current });
    buf.length = 0;
  };

  for (const line of lines) {
    const hit = classifyHeading(line);
    if (hit) {
      flush();
      current = { kind: hit.kind, heading: hit.heading, text: '', start: offset };
      // The heading line itself belongs to the block for a table/figure, whose
      // caption IS content; for a named section it is redundant with `heading`.
      if (hit.kind === 'table' || hit.kind === 'figure') buf.push(line.trim());
    } else {
      buf.push(line);
    }
    offset += line.length + 1;
  }
  flush();

  const found = sections.filter((s) => s.text.length > 0);

  // A leading unheaded block is only FRONT MATTER if it is small. Measured
  // regression: a trade-press PDF whose first recognized heading was "Background
  // and Study Design" put the entire numbers-bearing lede — the DFS HR, the MFS
  // HR, pCR, the grade 3/4 rate — in `front`, which is dropped, and composed a
  // fluent 3,266-char excerpt containing none of them. Strictly worse than the
  // head slice it replaced, and silent. In a real paper the title page is a few
  // percent of the document (BEACON: 6%); when the leading block is a quarter of
  // everything, it is the article, not its cover.
  //
  // The fraction test alone was not enough. A trade-press article whose lede is
  // UNDER 25% still lost it: verified on a UroToday-shaped fixture, both the
  // effect size (HR 0.54) and the NCT disappeared while fellBack stayed false —
  // and losing the NCT also breaks the cross-day coverage index. So add an
  // absolute floor: a SHORT document does not have four pages of front matter,
  // whatever the ratio says. A real paper's title page is a few percent of
  // 60k+ chars; a 8k news item that opens with its own numbers is all body.
  const total = found.reduce((n, s) => n + s.text.length, 0);
  const shortDocument = total < FRONT_TRUST_MIN_DOC_CHARS;
  return found.map((s) =>
    s.kind === 'front' && total > 0 && (shortDocument || s.text.length > total * FRONT_MAX_FRACTION)
      ? { ...s, kind: 'body' as SectionKind }
      : s,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Budgeted composition
// ────────────────────────────────────────────────────────────────────────────

export type ComposeOptions = {
  maxChars?: number;
  // The caller stores `papers.abstract` separately and llm-pipeline sends it as
  // its own labeled block, so re-spending budget on it is pure duplication.
  // Pass true only when no separate abstract was captured.
  includeAbstract?: boolean;
  // The same document from `pdftotext -layout`. Used for TABLE and FIGURE blocks
  // only: reading-order extraction drops a table's column alignment, so a cell
  // ends up orphaned from its row (BEACON's Table 1 emits its nine class
  // definitions, then a loose run of agreement percentages with nothing tying
  // them to a class). Prose stays on the reading-order text, where -layout would
  // interleave a two-column page's columns into nonsense.
  layoutText?: string;
};

export type ComposedExcerpt = {
  text: string;
  // What made it in, in emitted order — for logging and for the backfill CLI's
  // before/after report.
  kept: Array<{
    kind: SectionKind;
    heading: string | null;
    chars: number;
    truncated: boolean;
    // True when this block came from the -layout pass (tables/figures only).
    aligned: boolean;
  }>;
  droppedKinds: SectionKind[];
  // True when segmentation was unusable and we fell back to a head-slice.
  fellBack: boolean;
  sourceChars: number;
};

// Truncate at a paragraph break if there is one reasonably near the end of the
// budget, else at a sentence end, else hard. Keeps a table from ending mid-row.
const TRUNCATION_MARK = '…[section truncated]';

function truncateCleanly(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Reserve room for the marker, or the "never exceeds the budget" property is
  // false by up to the marker's length on any section that actually truncates.
  const head = text.slice(0, Math.max(0, limit - TRUNCATION_MARK.length - 1));
  const para = head.lastIndexOf('\n\n');
  if (para >= limit * 0.6) return `${head.slice(0, para).trimEnd()}\n\n${TRUNCATION_MARK}`;
  const nl = head.lastIndexOf('\n');
  if (nl >= limit * 0.6) return `${head.slice(0, nl).trimEnd()}\n${TRUNCATION_MARK}`;
  const stop = head.lastIndexOf('. ');
  if (stop >= limit * 0.6) return `${head.slice(0, stop + 1)} ${TRUNCATION_MARK}`;
  return `${head.trimEnd()} ${TRUNCATION_MARK}`;
}

// Key a table/figure block by its caption so the same block can be located in
// both extractions. Captions are stable between the two poppler modes; offsets
// are not, which is why this matches on text rather than position.
function captionKey(heading: string | null): string {
  return (heading ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .slice(0, 60);
}

// Does this -layout block actually LOOK like a grid, or is it running prose that
// happens to sit under a caption?
//
// Size alone cannot tell them apart, and both real cases are large. A genuine
// table line carries several column gutters:
//   Retrospective  325       30.6 Gy (22-40)   100 (100)   No    Micaily et al.
// Two-column journal prose in -layout mode carries exactly ONE, between the
// columns:
//   and 1563 (79%) of 1968 had a Gleason score        enzalutamide and to
// So count internal gutters per line, ignoring the leading indent. This is what
// separates a real 6,964-char efficacy table (kept) from 6,944 chars of STAMPEDE
// Results prose captioned "Table 1: Baseline characteristics" (rejected).
const GUTTER = /\S {2,}(?=\S)/g;
const TABULAR_MIN_LINE_FRACTION = 0.25;

function looksTabular(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim().length >= 20);
  if (lines.length < 4) return true; // too small to judge; size guard covers it
  const gridded = lines.filter((l) => (l.trimStart().match(GUTTER) ?? []).length >= 2).length;
  return gridded / lines.length >= TABULAR_MIN_LINE_FRACTION;
}

// Map caption → layout-mode body for every table/figure in the -layout pass.
//
// LONGEST occurrence wins, not first. A caption can legitimately appear more
// than once in a document — a list-of-tables front page, a running header, a
// "continued" stub — and the first hit is often the stub. Taking it would
// replace a real table's rows with a one-line title while still reporting
// `aligned: true`, i.e. silently dropping the payload and looking healthier for
// it. Longest is a crude tiebreak but it is right for the failure that matters:
// a stub is never the longest block.
function layoutBlocks(layoutText: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!layoutText) return map;
  for (const s of segmentDocument(layoutText)) {
    if (s.kind !== 'table' && s.kind !== 'figure') continue;
    const key = captionKey(s.heading);
    if (!key) continue;
    const prior = map.get(key);
    if (prior === undefined || s.text.length > prior.length) map.set(key, s.text);
  }
  return map;
}

function label(section: Section): string {
  if (section.heading) return section.heading.replace(/\s*[:.]\s*$/, '');
  switch (section.kind) {
    case 'body':
      return 'Body';
    default:
      return section.kind.charAt(0).toUpperCase() + section.kind.slice(1);
  }
}

// Compose a budgeted, section-aware excerpt. Emission order follows FILL_ORDER
// (tables and figure captions first), not document order, so the densest
// grounded content leads the block the study agent reads.
export function composeExcerpt(rawText: string, opts: ComposeOptions = {}): ComposedExcerpt {
  const maxChars = opts.maxChars ?? DEFAULT_EXCERPT_CHARS;
  const includeAbstract = opts.includeAbstract ?? false;
  const source = rawText ?? '';
  const naive = source.slice(0, maxChars);

  const fallback = (): ComposedExcerpt => ({
    text: naive,
    kept: [],
    droppedKinds: [],
    fellBack: true,
    sourceChars: source.length,
  });

  if (!source.trim()) return fallback();

  const sections = segmentDocument(source);
  const usable = sections.filter((s) => {
    if (DROPPED_KINDS.has(s.kind)) return false;
    if (s.kind === 'abstract' && !includeAbstract) return false;
    return true;
  });
  if (usable.length === 0) return fallback();

  const kept: ComposedExcerpt['kept'] = [];
  const chunks: string[] = [];
  const droppedKinds = new Set<SectionKind>();
  for (const s of sections) {
    if (DROPPED_KINDS.has(s.kind)) droppedKinds.add(s.kind);
    if (s.kind === 'abstract' && !includeAbstract) droppedKinds.add('abstract');
  }

  const layout = layoutBlocks(opts.layoutText);

  // Three-pass fill. Pass 1 gives tables and figure captions the lead but caps
  // them at TABLE_TIER_MAX_FRACTION so they cannot eat the whole window; pass 2
  // spends the rest on prose; pass 3 returns anything prose declined to the
  // remaining tables. Emission is then re-sorted so the table tier still reads
  // first regardless of which pass placed each block.
  const placed = new Set<Section>();
  const staged: Array<{ section: Section; chunk: string; tier: 0 | 1 }> = [];
  let spent = 0;

  const tryPlace = (s: Section, ceiling: number): void => {
    if (placed.has(s)) return;
    const header = `## ${label(s)}\n`;
    const budget = Math.min(ceiling, maxChars) - spent - header.length;
    if (budget < MIN_SECTION_CHARS) return;
    // Prefer the column-preserving read for tables and figure captions — but
    // only when it is plausibly the SAME block. A layout "section" that ran to
    // end-of-file is not an aligned table, it is the rest of the paper.
    const candidate = isTableTier(s.kind) ? layout.get(captionKey(s.heading)) : undefined;
    const sized =
      candidate !== undefined && candidate.length <= Math.max(s.text.length * LAYOUT_MAX_RATIO, 500)
        ? candidate
        : undefined;

    let aligned = sized;
    let full = aligned ?? s.text;
    let body = truncateCleanly(full, budget);
    // Judge the text that will actually be DELIVERED, not the whole candidate.
    // A runaway layout section can open with two-column prose and only reach
    // real tables further down; scoring the candidate as a whole passes it, and
    // truncation then hands the analyst nothing but the prose head, captioned as
    // a table. STAMPEDE reached the excerpt exactly this way.
    if (aligned !== undefined && !looksTabular(body)) {
      aligned = undefined;
      full = s.text;
      body = truncateCleanly(full, budget);
    }
    // A section truncated below the floor is a header row with no data under it,
    // which reads as a delivered table and is worse than no table at all.
    if (body.length < Math.min(MIN_SECTION_CHARS, full.length)) return;
    placed.add(s);
    staged.push({ section: s, chunk: `${header}${body}`, tier: isTableTier(s.kind) ? 0 : 1 });
    spent += header.length + body.length + 2; // + the joining blank line
    kept.push({
      kind: s.kind,
      heading: s.heading,
      chars: body.length,
      truncated: body.length < full.length,
      aligned: aligned !== undefined,
    });
  };

  const inFillOrder = (predicate: (k: SectionKind) => boolean): Section[] =>
    FILL_ORDER.filter(predicate).flatMap((kind) => usable.filter((s) => s.kind === kind));

  const tierCap = Math.round(maxChars * TABLE_TIER_MAX_FRACTION);
  for (const s of inFillOrder(isTableTier)) tryPlace(s, tierCap);
  for (const s of inFillOrder((k) => !isTableTier(k))) tryPlace(s, maxChars);
  for (const s of inFillOrder(isTableTier)) tryPlace(s, maxChars);

  // Table tier first, document order within each tier.
  staged.sort((a, b) => a.tier - b.tier || a.section.start - b.section.start);
  chunks.push(...staged.map((x) => x.chunk));

  const text = chunks.join('\n\n').trim();

  // Fall back only on evidence that segmentation FAILED: nothing was placed.
  //
  // Deliberately NOT a size test of any kind — neither a ratio against the
  // budget nor an absolute floor. Both punish the change for working. A 90-page
  // guideline whose entire payload is one 3k recommendation table composes
  // correctly, then measures "too small" against a 24k budget and gets thrown
  // away in favour of the head slice, reinstating the front matter and losing
  // the table. A short paper composes to 500 chars and trips an absolute floor
  // for the same bad reason. Discarding 95% of a document is the INTENDED
  // behavior when 95% of it is references and disclosures.
  if (kept.length === 0) return fallback();

  return {
    text,
    kept,
    droppedKinds: [...droppedKinds],
    fellBack: false,
    sourceChars: source.length,
  };
}

export const __test = { truncateCleanly, HEADING_RULES, FILL_ORDER, MIN_SECTION_CHARS };
