// Figure-OCR pipeline: Vision (recall) + Qwen (structure) → Opus (grounded merge).
//
// Reads the numbers printed inside a clinical-trial figure (Kaplan-Meier,
// cumulative-incidence, forest plot, image-rendered table) and emits a clean
// per-panel structured extraction in which EVERY published number is grounded
// against the Apple Vision OCR token stream. Established by the 2026-06-17 spike:
//   - Apple Vision OCR  → high recall, noisy unordered tokens (captures every
//                         printed p-value, the full number-at-risk tables).
//   - Qwen2.5-VL (local)→ high precision, clean per-panel structure, faithful to
//                         an unusual CI label (80%), says "not legible" not a guess.
//   - Opus reconcile    → merges the two; the GROUNDING RULE keeps a number only
//                         if it appears in the Vision tokens.
//
// On top of the LLM grounding instruction, this module applies a DETERMINISTIC
// grounding gate (groundNumbersAgainstOcr) as a final, testable guard: every
// number ANYWHERE in the merged output must appear in the Vision OCR token stream.
// If any doesn't, the whole merge is WITHHELD and we fall back to the raw OCR
// (a literal transcription), so a fabricated magnitude can never reach Phase 2.
// That pure gate is the no-fabrication backstop and the most heavily tested unit.
//
// Grounding is ROLE-AWARE for the one role where a real magnitude reused wrongly
// does harm: a percentage/CI label. A "95% CI" claim must match a printed "95%"
// in the OCR, so a "95" that exists only as a number-at-risk count can't ground a
// fabricated "95% CI". Plain magnitudes (HR, CI bounds, p, n) ground by value
// membership. The percent check relaxes to magnitude membership when the OCR
// captured no percent tokens (scrambled "%"), to avoid false-withholding a real
// figure. See auditReconciledOutput.
//
// IP boundary: same as the rest of the figure-OCR path — the figure image is
// processed locally (Vision on-device, Qwen on a local Ollama), and the structured
// output is summary numbers only, never the source PDF/excerpt.
//
// Never throws: a missing Vision binary, a downed Ollama, or a failed reconcile
// call each degrade to a status:'degraded' result with the partial reads + a note.

import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLlmClient, type LlmClient } from './llm-client.ts';
import { ocrFile } from './vision-ocr.ts';
import { runQwenVision, type RunQwenOptions } from './qwen-client.ts';
import { figurePages, rasterizePageToPngs } from './pdf-text.ts';

// Bound the (Opus-bearing) per-page cost on a supplement-heavy PDF. A paper's
// result figures rarely exceed a handful; this caps reconcile calls per paper.
export const MAX_STRUCTURED_FIGURE_PAGES = 4;
// Stored figure_structured_md cap (mirrors MAX_FIGURE_OCR_CHARS) so it can't
// crowd the body excerpt in the Phase 2 prompt.
export const MAX_FIGURE_STRUCTURED_CHARS = 6000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECONCILE_PROMPT_PATH = resolve(__dirname, '../../prompts/figure-reconcile-v1.txt');
const RECONCILE_MAX_TOKENS = 1800;

// ────────────────────────────────────────────────────────────────────────────
// Deterministic grounding gate (pure — the no-fabrication backstop).
// ────────────────────────────────────────────────────────────────────────────

// Canonicalize a numeric blob so the two reads compare cleanly: Lancet-style
// middle dots become periods, the various unicode minus/dash glyphs become a
// plain hyphen, and thousands separators are dropped. This is the ONLY place
// figure typography is normalized, so Vision's "0·62" and Qwen's "0.62" match.
export function normalizeNumericText(text: string): string {
  return text
    .replace(/[·•∙]/g, '.') // middle dot → decimal point
    .replace(/[−–—]/g, '-') // minus / en-dash / em-dash → hyphen
    .replace(/(\d),(?=\d{3}\b)/g, '$1'); // 1,234 → 1234
}

// Pull number-like cores from a (normalized) blob. A "core" is the bare numeric
// value — sign, %, and CI/range punctuation are stripped, so "0.44-0.86" yields
// two cores and "p=0.014" yields one. Returns both the parsed values (so 0.80
// matches 0.8) and the raw core strings (so a leading-zero oddity still matches).
export function extractNumericCores(text: string): { values: Set<string>; raws: Set<string> } {
  const norm = normalizeNumericText(text);
  const values = new Set<string>();
  const raws = new Set<string>();
  const add = (raw: string): void => {
    raws.add(raw);
    const v = Number.parseFloat(raw);
    if (Number.isFinite(v)) values.add(String(v));
  };
  for (const m of norm.matchAll(/\d+(?:\.\d+)?/g)) add(m[0]!);
  // OCR decimal-recovery: Apple Vision sometimes reads a Lancet middle-dot
  // decimal (0·86) as a hyphen (0-86), splitting one printed number into two.
  // Admit the decimal reading ONLY when the leading group is a SINGLE digit
  // (0-86 → 0.86, 0-0047 → 0.0047): HR/CI/p magnitudes are <10 so they read as
  // one digit before the separator, whereas real ranges (number-at-risk "12-34",
  // CI "12-15") have multi-digit groups and must NOT be reinterpreted — otherwise
  // a fabricated "12.34" would falsely ground against the printed range "12-34".
  for (const m of norm.matchAll(/(?<![\d.])(\d)-(\d+)(?![\d.])/g)) {
    add(`${m[1]}.${m[2]}`);
  }
  return { values, raws };
}

// Ground a set of claimed numbers against an OCR token stream. A claimed number
// is grounded iff its parsed value OR its raw string appears in the OCR cores.
// Returns the partition. This is the gate that guarantees we never publish a
// figure number the literal OCR didn't see.
export function groundNumbersAgainstOcr(
  claimed: string[],
  ocrText: string,
): { grounded: string[]; ungrounded: string[] } {
  const ocr = extractNumericCores(ocrText);
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  for (const raw of claimed) {
    const core = raw.trim();
    const v = Number.parseFloat(normalizeNumericText(core));
    const hit =
      (Number.isFinite(v) && ocr.values.has(String(v))) || ocr.raws.has(normalizeNumericText(core));
    (hit ? grounded : ungrounded).push(core);
  }
  return { grounded, ungrounded };
}

// Percentage values printed in a blob, as a value-string set (80% → "80"). A
// CI/percentage label is the one role where a real magnitude reused in a wrong
// role does harm (a "95" number-at-risk count fabricated into a "95% CI"), so
// percent claims get role-aware grounding (see auditReconciledOutput).
export function extractPercentValues(text: string): Set<string> {
  const norm = normalizeNumericText(text);
  const out = new Set<string>();
  for (const m of norm.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    const v = Number.parseFloat(m[1]!);
    if (Number.isFinite(v)) out.add(String(v));
  }
  return out;
}

// Audit the reconciled output: which numbers ANYWHERE in it are not grounded in
// the Vision OCR token stream? We audit the WHOLE text — deliberately NOT carving
// out a "trusted" section by heading, because the heading text is Opus-chosen and
// a figure caption ("Unverified exploratory endpoint") could spoof a boundary and
// hide fabricated numbers below it. The prompt tells Opus to OMIT anything it
// can't ground, so a non-empty result here means Opus disobeyed and the whole
// merge is untrustworthy.
//
// Two grounding modes by ROLE:
//   - Percentage claims ("80%", "95% CI"): role-aware. The same percentage must
//     be printed as a percent in the OCR — catches a count magnitude (95) reused
//     as a fabricated "95% CI". Enforced ONLY when the OCR actually captured
//     percent tokens; if Vision scrambled the "%" away from its number (no OCR
//     percents at all) we fall back to magnitude membership rather than
//     false-withhold a legitimate figure.
//   - Plain magnitudes (HR, CI bounds, p-values, n-at-risk): value membership
//     (with the middle-dot decimal recovery in extractNumericCores).
export function auditReconciledOutput(
  reconciledMd: string,
  ocrText: string,
): { grounded: string[]; ungrounded: string[] } {
  const ocr = extractNumericCores(ocrText);
  const ocrPercents = extractPercentValues(ocrText);
  const norm = normalizeNumericText(reconciledMd);
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  const isPlainHit = (raw: string, v: string): boolean => ocr.values.has(v) || ocr.raws.has(raw);
  // Tokenize once, capturing whether each number carried a trailing % (its role).
  for (const m of norm.matchAll(/(\d+(?:\.\d+)?)(\s*%)?/g)) {
    const raw = m[1]!;
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    const key = String(v);
    if (m[2]) {
      // Percent-roled claim. Strict against OCR percents when any exist; else
      // fall back to magnitude membership so scrambled-OCR figures aren't rejected.
      const hit = ocrPercents.size > 0 ? ocrPercents.has(key) : isPlainHit(raw, key);
      (hit ? grounded : ungrounded).push(`${raw}%`);
    } else {
      (isPlainHit(raw, key) ? grounded : ungrounded).push(raw);
    }
  }
  return { grounded, ungrounded };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator.
// ────────────────────────────────────────────────────────────────────────────

export type FigureExtraction = {
  // The grounded per-panel markdown — the useful output for the study agent.
  figure_structured_md: string;
  vision_ocr: string; // provenance: raw Vision OCR tokens
  qwen_raw: string; // provenance: Qwen structured read ('' if unavailable)
  // Numbers in the factual output NOT found in the OCR stream. Empty in the happy
  // path; a non-empty list is a fabrication-leak warning, surfaced not swallowed.
  ungrounded: string[];
  status: 'ok' | 'degraded';
  notes: string[];
};

export type ExtractFigureOptions = {
  client?: LlmClient;
  model?: string;
  // Injection seams for tests / alternate backends.
  runVision?: (imagePath: string) => Promise<string>;
  runQwen?: (imagePath: string, opts?: RunQwenOptions) => Promise<string>;
  qwenOptions?: RunQwenOptions;
  reconcilePromptPath?: string;
};

// Resolve the reconcile model. Opus by default (the merge is judgment-heavy), with
// the right alias per backend; override with FIGURE_RECONCILE_MODEL. The reconcile
// call is TEXT-only (Qwen + Vision strings), so it runs on either backend — no
// image plumbing, no per-token cost on claude-cli.
export function resolveReconcileModel(): string {
  const override = process.env.FIGURE_RECONCILE_MODEL;
  if (override && override.trim()) return override.trim();
  const backend = process.env.LLM_BACKEND === 'claude-cli' ? 'claude-cli' : 'api';
  return backend === 'claude-cli' ? 'opus' : 'claude-opus-4-8';
}

// Extract a figure's printed numbers from a local image into grounded structured
// markdown. Never throws; degrades to status:'degraded' with whatever reads
// succeeded. The deterministic grounding gate runs regardless of the LLM.
export async function extractFigure(
  imagePath: string,
  opts: ExtractFigureOptions = {},
): Promise<FigureExtraction> {
  const client = opts.client ?? createLlmClient();
  const runVision = opts.runVision ?? (async (p: string) => (await ocrFile(p)).entry.text.trim());
  const runQwen =
    opts.runQwen ?? (async (p: string, o?: RunQwenOptions) => (await runQwenVision(p, o)).text.trim());
  const notes: string[] = [];

  const [visionRaw, qwenRaw] = await Promise.all([
    runVision(imagePath).catch((e) => {
      notes.push(`vision failed: ${(e as Error).message}`);
      return '';
    }),
    runQwen(imagePath, opts.qwenOptions).catch((e) => {
      notes.push(`qwen failed: ${(e as Error).message}`);
      return '';
    }),
  ]);

  const visionOcr = visionRaw ?? '';
  const qwen = qwenRaw ?? '';

  // No Vision tokens → nothing to ground against. The grounding rule means we
  // cannot certify any number, so we refuse to emit figure numbers (honest > guess).
  if (!visionOcr) {
    notes.push('no Vision OCR tokens — cannot ground; emitting no figure numbers');
    return {
      figure_structured_md: qwen
        ? '_OCR token stream empty — Qwen read is unverified and withheld._'
        : '',
      vision_ocr: '',
      qwen_raw: qwen,
      ungrounded: [],
      status: 'degraded',
      notes,
    };
  }

  // Reconcile via the LLM (Opus by default). Text-only call, so it works on any
  // backend. On failure, degrade to the Vision tokens themselves (already grounded
  // by definition) so the study agent still gets the numbers.
  let reconciled: string;
  try {
    const template = readFileSync(opts.reconcilePromptPath ?? RECONCILE_PROMPT_PATH, 'utf-8');
    // Function replacers: a literal $ in the figure text (cost figures, "$&",
    // "$1") must NOT be interpreted as a String.replace special pattern, which
    // would silently corrupt the assembled prompt.
    const prompt = template
      .replace('{{VISION_OCR}}', () => visionOcr)
      .replace('{{QWEN_STRUCTURED}}', () => qwen || '(Qwen read unavailable)');
    const reconcileModel = opts.model ?? resolveReconcileModel();
    if (!process.env.VITEST) {
      console.log(`  [figure:reconcile] ${reconcileModel} merging Vision + Qwen for ${imagePath}`);
    }
    reconciled = (
      await client.complete([{ role: 'user', content: prompt }], {
        model: reconcileModel,
        maxTokens: RECONCILE_MAX_TOKENS,
        temperature: 0,
      })
    ).trim();
  } catch (e) {
    notes.push(`reconcile failed: ${(e as Error).message} — falling back to raw Vision tokens`);
    return {
      figure_structured_md: `## Figure (unreconciled — raw OCR)\n${visionOcr}`,
      vision_ocr: visionOcr,
      qwen_raw: qwen,
      ungrounded: [],
      status: 'degraded',
      notes,
    };
  }

  // Final deterministic guard: every number in the merged output must appear in
  // the Vision OCR token stream. If ANY doesn't, Opus disobeyed the grounding rule
  // and the whole merge is untrustworthy — WITHHOLD it entirely and fall back to
  // the raw OCR tokens (a literal transcription, grounded by definition). We do
  // NOT keep the merged prose with a warning appended: downstream keeps only
  // figure_structured_md (status/notes/ungrounded are discarded) and Phase 2 is
  // told this is the preferred figure source, so a fabricated factual line would
  // be published. Withholding is the only safe response in a no-fabrication path.
  const audit = auditReconciledOutput(reconciled, visionOcr);
  if (!process.env.VITEST) {
    console.log(
      audit.ungrounded.length > 0
        ? `  [figure:reconcile] grounding gate WITHHELD merge (${audit.ungrounded.length} ungrounded number(s)) → raw OCR fallback`
        : `  [figure:reconcile] grounded merge accepted`,
    );
  }
  if (audit.ungrounded.length > 0) {
    notes.push(
      `grounding gate REJECTED the merge — ${audit.ungrounded.length} number(s) absent from the OCR: ${audit.ungrounded.join(', ')}; withholding the reconciled output, falling back to raw OCR`,
    );
    return {
      figure_structured_md: `## Figure (reconciliation withheld — the model emitted ${audit.ungrounded.length} number(s) not found in the OCR; raw transcription only)\n\n${visionOcr}`,
      vision_ocr: visionOcr,
      qwen_raw: qwen,
      ungrounded: audit.ungrounded,
      status: 'degraded',
      notes,
    };
  }
  if (!qwen) notes.push('qwen unavailable — reconciled from Vision OCR alone');

  return {
    figure_structured_md: reconciled,
    vision_ocr: visionOcr,
    qwen_raw: qwen,
    ungrounded: [],
    status: 'ok',
    notes,
  };
}

export type ExtractPdfFigureStructuredOptions = ExtractFigureOptions & {
  // Injection seams + bounds for tests / cost control.
  pages?: (absPath: string) => Promise<number[]>;
  rasterize?: (absPath: string, page: number) => Promise<{ dir: string; pngs: string[] }>;
  maxPages?: number;
  dpi?: number;
};

// Run the Vision+Qwen→Opus grounded extraction over a PDF's figure pages and join
// the per-page structured markdown (page-tagged). '' when no figure pages exist or
// every page degrades to nothing. NEVER throws — additive context, the same
// contract as extractPdfFigureOcr. Each page is grounded against ITS OWN Vision
// OCR, so a number can only survive if that page's literal OCR saw it.
export async function extractPdfFigureStructured(
  absPath: string,
  opts: ExtractPdfFigureStructuredOptions = {},
): Promise<string> {
  const listPages = opts.pages ?? ((p: string) => figurePages(p));
  const dpi = opts.dpi ?? 200;
  const rasterize =
    opts.rasterize ?? ((p: string, page: number) => rasterizePageToPngs(p, page, { dpi }));
  const maxPages = opts.maxPages ?? MAX_STRUCTURED_FIGURE_PAGES;

  let pages: number[];
  try {
    pages = await listPages(absPath);
  } catch {
    return '';
  }
  if (pages.length === 0) return '';

  const parts: string[] = [];
  let used = 0; // accumulated chars; cap at WHOLE-page granularity (see below)
  for (const page of pages.slice(0, maxPages)) {
    let dir: string | undefined;
    try {
      const { dir: d, pngs } = await rasterize(absPath, page);
      dir = d;
      for (const png of pngs) {
        const res = await extractFigure(png, opts);
        const md = res.figure_structured_md.trim();
        if (!md) continue;
        const block = `[p.${page}]\n${md}`;
        // Cap at a whole-page boundary so a downstream hard char-slice can never
        // store a figure claim cut mid-line. Always keep at least the first page.
        if (parts.length > 0 && used + block.length + 2 > MAX_FIGURE_STRUCTURED_CHARS) {
          return parts.join('\n\n');
        }
        parts.push(block);
        used += block.length + 2;
      }
    } catch {
      // skip this page; one bad page shouldn't lose the rest
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort; the startup sweep self-heals leftover temp dirs
        }
      }
    }
  }
  return parts.join('\n\n');
}
