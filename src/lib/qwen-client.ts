// Qwen2.5-VL via a local Ollama HTTP server (figure-OCR pipeline).
//
// A vision pass that READS the numbers printed inside a figure (Kaplan-Meier
// curves, forest plots, cumulative-incidence plots, image-rendered tables) into
// clean, per-panel structured text. It complements vision-ocr.ts rather than
// replacing it: Apple Vision OCR is high-recall but emits a noisy unordered
// token stream; Qwen is high-precision and structures the output, and — when
// prompted — returns "not legible" instead of inventing a value. figure-extract.ts
// reconciles the two and grounds every number against the Vision tokens.
//
// Local-only + free: runs against `ollama serve` on the curator's Mac
// (qwen2.5vl:7b, ~6GB), so there is no per-call token cost and the figure image
// never leaves the machine — same IP boundary as the rest of the figure-OCR path.
//
// Graceful degradation (mirrors vision-ocr.ts): returns a typed QwenResult with a
// status + reason when Ollama is down, the model is missing, or the image file is
// a placeholder. It NEVER throws — figure structuring is additive context, and a
// missing Qwen just means we fall back to the Vision OCR token stream.
//
// Spike-derived guards (2026-06-17):
//   - Image files under MIN_IMAGE_BYTES are treated as placeholders and skipped.
//     A Dropbox online-only stub is 4 bytes; fed to the model it confabulates a
//     plausible-but-fabricated answer, which is exactly what we must not publish.
//   - The HTTP API (not the `ollama run` CLI) is used: the CLI parses any '/' in
//     the prompt as a filename and breaks on a normal sentence.
//   - num_ctx is raised above Ollama's 4096 default: a 300-dpi journal page
//     tokenizes to ~4200 vision tokens and a smaller window 400s the request.

import { statSync, readFileSync } from 'node:fs';

// A real figure PNG is tens-to-hundreds of KB. Anything smaller is a truncated
// download or a cloud-storage placeholder stub — never a figure worth reading.
export const MIN_IMAGE_BYTES = 1024;
// Upper bound: the image is base64-inflated (~1.33x) and held in a JSON body.
// pdftoppm at a bounded DPI never approaches this, but the CLI accepts an
// arbitrary --image, so cap it rather than let a giant file balloon memory.
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// A 300-dpi journal page is ~4200 vision tokens; 8192 leaves headroom for the
// prompt + answer. Ollama's default 4096 rejects the request outright.
export const QWEN_NUM_CTX = 8192;
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_QWEN_MODEL = 'qwen2.5vl:7b';
const DEFAULT_TIMEOUT_MS = 120_000;

// The extraction contract. The no-fabrication rule is FIRST and explicit because
// a VLM's failure mode here is a confident wrong number, not a blank — and the
// curator's whole pipeline forbids publishing an ungrounded magnitude.
export const QWEN_FIGURE_PROMPT = [
  'You are extracting printed text from a clinical-trial figure (Kaplan-Meier,',
  'cumulative-incidence, forest plot, or an image-rendered table) for an oncology',
  'digest. Hard rules:',
  '- Report ONLY values actually printed in the image.',
  '- Do NOT infer, round, or "correct" anything. In particular, do NOT assume a',
  '  confidence interval is 95%: report the exact CI label shown (it may be 80%).',
  '- If a value is not clearly legible, write "not legible" — never guess.',
  '- Do not read a value off the curve geometry; only transcribe printed numbers.',
  'For each panel (label them A, B, C, D… if multi-panel), give, on its own line:',
  'the hazard ratio with its exact CI label and bounds, the p-value, and the first',
  'number-at-risk row for each arm. Then list any other printed numeric annotations',
  '(medians, n, percentages). Be terse. Plain text, one fact per line.',
].join('\n');

export type QwenResult = {
  text: string;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
};

export type RunQwenOptions = {
  host?: string;
  model?: string;
  prompt?: string;
  numCtx?: number;
  timeoutMs?: number;
  maxBytes?: number; // upper image-size bound; defaults to MAX_IMAGE_BYTES
  // Injection seam for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

// True when the file is missing or too small to be a real image (a truncated
// download or a cloud-storage placeholder stub). Pure size check — the caller
// uses it to skip the model rather than feed it garbage that it will confabulate.
export function isPlaceholderImage(filePath: string, minBytes = MIN_IMAGE_BYTES): boolean {
  try {
    return statSync(filePath).size < minBytes;
  } catch {
    return true; // missing / unreadable → treat as placeholder
  }
}

// Read a figure image and ask Qwen to transcribe its printed numbers. Returns a
// QwenResult; never throws. status:'skipped' for a placeholder/missing file,
// status:'failed' (with reason) when Ollama is unreachable or errors.
export async function runQwenVision(imagePath: string, opts: RunQwenOptions = {}): Promise<QwenResult> {
  if (isPlaceholderImage(imagePath)) {
    return { text: '', status: 'skipped', reason: 'placeholder-or-missing-image' };
  }
  try {
    if (statSync(imagePath).size > (opts.maxBytes ?? MAX_IMAGE_BYTES)) {
      return { text: '', status: 'skipped', reason: 'image-too-large' };
    }
  } catch {
    return { text: '', status: 'skipped', reason: 'placeholder-or-missing-image' };
  }

  const host = (opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
  const model = opts.model ?? process.env.QWEN_MODEL ?? DEFAULT_QWEN_MODEL;
  if (!process.env.VITEST) {
    console.log(`  [figure:qwen] ${model} (via ${host}) on ${imagePath}`);
  }
  const prompt = opts.prompt ?? QWEN_FIGURE_PROMPT;
  const numCtx = opts.numCtx ?? QWEN_NUM_CTX;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let imageB64: string;
  try {
    imageB64 = readFileSync(imagePath).toString('base64');
  } catch (err) {
    return { text: '', status: 'failed', reason: `read image: ${(err as Error).message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images: [imageB64],
        stream: false,
        options: { num_ctx: numCtx, temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await safeText(res);
      return { text: '', status: 'failed', reason: `ollama HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { response?: string; error?: string };
    if (json.error) {
      return { text: '', status: 'failed', reason: `ollama error: ${json.error}` };
    }
    const text = (json.response ?? '').trim();
    if (!text) return { text: '', status: 'failed', reason: 'empty response' };
    return { text, status: 'ok' };
  } catch (err) {
    const reason =
      (err as Error).name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : `ollama unreachable: ${(err as Error).message}`;
    return { text: '', status: 'failed', reason };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Cheap reachability probe: is an Ollama server up AND serving the vision model?
// Used to GATE the (Opus-bearing) structured figure pass at enrichment time — no
// point spending reconcile calls if the Qwen value-add can't run. Returns false
// fast (short timeout) when Ollama is down, so a missing server never stalls
// enrichment. A blank/`off` QWEN-disable env also returns false.
export async function isQwenAvailable(
  opts: { host?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  if (process.env.FIGURE_STRUCTURED === 'off') return false;
  const host = (opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
  const model = opts.model ?? process.env.QWEN_MODEL ?? DEFAULT_QWEN_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: controller.signal });
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: { name?: string }[] };
    const names = (json.models ?? []).map((m) => m.name ?? '');
    // Match the family (e.g. "qwen2.5vl:7b" satisfies a "qwen2.5vl" request).
    const base = model.split(':')[0]!;
    return names.some((n) => n === model || n.startsWith(base));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
