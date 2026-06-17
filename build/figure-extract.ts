// CLI: run the figure-OCR pipeline (Vision + Qwen → Opus grounded merge) on one
// figure and print the grounded structured extraction.
//
// Usage:
//   npm run figure-extract -- --image=/path/to/figure.png
//   npm run figure-extract -- --pdf=data/obsidian/papers/<site>/<slug>.pdf --page=6
//   npm run figure-extract -- --image=fig.png --json        # raw JSON
//   npm run figure-extract -- --image=fig.png --model=opus  # override reconcile model
//
// Requires (all local, no network): the Apple Vision binary (`npm run setup:vision`),
// poppler for --pdf (`brew install poppler`), and a running Ollama with the Qwen
// vision model (`ollama serve` + `ollama pull qwen2.5vl:7b`). Any one missing
// degrades gracefully — the pipeline still grounds against whatever read succeeds.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractFigure } from '../src/lib/figure-extract.ts';

type Args = {
  image?: string;
  pdf?: string;
  page?: number;
  dpi: number;
  json: boolean;
  model?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Record<string, string | boolean> = {};
  for (const tok of argv.slice(2)) {
    const m = tok.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]!] = m[2] ?? true;
  }
  return {
    image: typeof a.image === 'string' ? a.image : undefined,
    pdf: typeof a.pdf === 'string' ? a.pdf : undefined,
    page: typeof a.page === 'string' ? Number(a.page) : undefined,
    dpi: typeof a.dpi === 'string' ? Number(a.dpi) : 300,
    json: !!a.json,
    model: typeof a.model === 'string' ? a.model : undefined,
  };
}

// Rasterize one PDF page to a PNG in a temp dir; returns its path. Caller cleans
// the dir. Mirrors the pdftoppm invocation pdf-text.ts uses for figure OCR.
function renderPdfPage(pdfPath: string, page: number, dpi: number, dir: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('pdftoppm', [
      '-png',
      '-r',
      String(dpi),
      '-f',
      String(page),
      '-l',
      String(page),
      pdfPath,
      join(dir, 'page'),
    ]);
    let stderr = '';
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', (e) => reject(new Error(`pdftoppm failed (brew install poppler?): ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`pdftoppm exit ${code}: ${stderr.trim()}`));
      const png = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.png'));
      if (!png) return reject(new Error('pdftoppm produced no PNG'));
      resolvePromise(join(dir, png));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.image && !(args.pdf && args.page)) {
    console.error('Usage: figure-extract --image=<png> | --pdf=<pdf> --page=<n> [--dpi=300] [--json] [--model=...]');
    process.exit(1);
  }

  let imagePath: string;
  let tmpDir: string | undefined;
  if (args.image) {
    imagePath = resolve(args.image);
    if (!existsSync(imagePath)) {
      console.error(`image not found: ${imagePath}`);
      process.exit(1);
    }
  } else {
    const pdfPath = resolve(args.pdf!);
    if (!existsSync(pdfPath)) {
      console.error(`pdf not found: ${pdfPath}`);
      process.exit(1);
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'figure-extract-'));
    imagePath = await renderPdfPage(pdfPath, args.page!, args.dpi, tmpDir);
    console.error(`rendered ${pdfPath} p.${args.page} @ ${args.dpi}dpi → ${imagePath}`);
  }

  try {
    const result = await extractFigure(imagePath, { model: args.model });

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    process.stdout.write(`\n${result.figure_structured_md}\n`);
    process.stdout.write(`\n${'─'.repeat(60)}\n`);
    process.stdout.write(`status: ${result.status}\n`);
    process.stdout.write(`vision OCR: ${result.vision_ocr.length} chars  |  qwen: ${result.qwen_raw.length} chars\n`);
    if (result.ungrounded.length) {
      process.stdout.write(`⚠ UNGROUNDED in factual output (fabrication leak): ${result.ungrounded.join(', ')}\n`);
    } else {
      process.stdout.write('✓ every factual number is grounded in the Vision OCR token stream\n');
    }
    for (const note of result.notes) process.stdout.write(`  note: ${note}\n`);
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
