import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  extractPdfText,
  extractPdfFigureOcr,
  figurePages,
  PdfToolError,
  isUsableTextLayer,
  __test,
} from '../src/lib/pdf-text.ts';

// extractPdfText composes a text-layer attempt with an OCR fallback. We inject
// runText/runOcr so the unit tests never shell out to poppler or Vision.
describe('extractPdfText', () => {
  it('returns the text layer when it has enough words', async () => {
    const runText = vi.fn(async () => Array(40).fill('word').join(' '));
    const runOcr = vi.fn(async () => '');
    const r = await extractPdfText('/x.pdf', { runText, runOcr });
    expect(r.via).toBe('text');
    expect(runOcr).not.toHaveBeenCalled();
  });

  it('falls back to OCR when the text layer is sparse (scanned PDF)', async () => {
    const runText = vi.fn(async () => 'a b c'); // < 30 words
    const runOcr = vi.fn(async () => Array(40).fill('ocr').join(' '));
    const r = await extractPdfText('/x.pdf', { runText, runOcr });
    expect(r.via).toBe('ocr');
    expect(runOcr).toHaveBeenCalledOnce();
  });

  it('throws PdfToolError(empty) when neither the layer nor OCR yields text', async () => {
    const runText = vi.fn(async () => '');
    const runOcr = vi.fn(async () => '   ');
    await expect(extractPdfText('/x.pdf', { runText, runOcr })).rejects.toMatchObject({
      name: 'PdfToolError',
      kind: 'empty',
    });
  });

  it('propagates a PdfToolError from the OCR step (ocr-unavailable)', async () => {
    const runText = vi.fn(async () => '');
    const runOcr = vi.fn(async () => {
      throw new PdfToolError('no vision binary', 'ocr-unavailable');
    });
    await expect(extractPdfText('/x.pdf', { runText, runOcr })).rejects.toMatchObject({
      kind: 'ocr-unavailable',
    });
  });

  it('honors a custom minWords threshold', async () => {
    const runText = vi.fn(async () => 'short five word sample here');
    const runOcr = vi.fn(async () => 'x y z');
    const r = await extractPdfText('/x.pdf', { runText, runOcr, minWords: 5 });
    expect(r.via).toBe('text');
  });

  it('falls back to OCR when the text layer is a per-page watermark repeated (image PDF)', async () => {
    // Wiley/ACS download stamp: same ~20-word line on every page. Word count is
    // high (well over 30) but it is almost all duplicates → must still OCR.
    const stamp =
      '15424863, 2026, 3, Downloaded from https://acsjournals.onlinelibrary.wiley.com/doi/10.3322/x. By A MEDICAL CENTER, Wiley Online Library. See the Terms and Conditions';
    const runText = vi.fn(async () => Array(15).fill(stamp).join('\n\f\n'));
    const runOcr = vi.fn(async () => Array(60).fill('realbody').join(' '));
    const r = await extractPdfText('/x.pdf', { runText, runOcr });
    expect(r.via).toBe('ocr');
    expect(runOcr).toHaveBeenCalledOnce();
  });

  it('folds the rejected watermark layer back in so its DOI survives OCR fallback', async () => {
    // OCR of the page image misses the marginal DOI; it must survive via the
    // rejected text layer so the downstream Crossref rescue can fire.
    const stamp =
      '15424863, 2026, Downloaded from https://acsjournals.onlinelibrary.wiley.com/doi/10.3322/caac.70082 by library';
    const runText = vi.fn(async () => Array(15).fill(stamp).join('\n\f\n'));
    const runOcr = vi.fn(async () => Array(60).fill('realbody').join(' '));
    const r = await extractPdfText('/x.pdf', { runText, runOcr });
    expect(r.via).toBe('ocr');
    expect(r.text).toContain('10.3322/caac.70082');
  });
});

describe('isUsableTextLayer', () => {
  it('accepts a normal article body (mostly distinct lines)', () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `unique sentence ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} bravo charlie here`,
    ).join('\n');
    expect(isUsableTextLayer(body)).toBe(true);
  });

  it('rejects a watermark repeated on every page (high word count, low distinct ratio)', () => {
    const stamp = 'Downloaded from publisher dot com on some date by some institution rules of use apply now';
    expect(isUsableTextLayer(Array(20).fill(stamp).join('\n'))).toBe(false);
  });

  it('rejects a watermark that varies only by page number / date (normalized dedupe)', () => {
    // Stamp differs per page solely in digits (page no., access date). After
    // digit-stripping normalization these collapse to one line → still OCR.
    const lines = Array.from(
      { length: 20 },
      (_, p) =>
        `Downloaded from publisher dot com on 0${p}/05/2026 by some institution rules of use apply page ${p} of 20`,
    );
    expect(isUsableTextLayer(lines.join('\n'))).toBe(false);
  });

  it('accepts a long article even when repeated footers drop the ratio below 0.5', () => {
    const body = Array.from(
      { length: 260 },
      (_, i) =>
        `clinical word${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} alpha beta gamma`,
    ).join('\n');
    const footer = Array(300).fill('shared footer boilerplate text here now').join('\n');
    expect(isUsableTextLayer(`${body}\n${footer}`)).toBe(true);
  });

  it('rejects a watermark when pages are split by a bare form-feed (no surrounding newline)', () => {
    // pdftotext may delimit pages with a lone \f. The repeated stamp must still
    // be split into dedupable lines, or distinct === total reopens the bypass.
    const stamp =
      'Downloaded from publisher dot com on some date by some institution rules of use apply now';
    expect(isUsableTextLayer(Array(20).fill(stamp).join('\f'))).toBe(false);
  });

  it('rejects a near-empty layer', () => {
    expect(isUsableTextLayer('a b c')).toBe(false);
    expect(isUsableTextLayer('')).toBe(false);
  });
});

// runPoppler maps spawn outcomes to typed errors. A fake EventEmitter stands in
// for the child process so we exercise the error mapping without real binaries.
function fakeSpawn(emit: (proc: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }) => void) {
  return (() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => emit(proc));
    return proc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('runPoppler error mapping', () => {
  it('maps ENOENT to poppler-missing', async () => {
    const spawn = fakeSpawn((proc) => {
      const err = new Error('spawn pdftotext ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      proc.emit('error', err);
    });
    await expect(__test.runPoppler('pdftotext', ['-'], 1000, spawn)).rejects.toMatchObject({
      name: 'PdfToolError',
      kind: 'poppler-missing',
    });
  });

  it('resolves stdout on exit 0', async () => {
    const spawn = fakeSpawn((proc) => {
      proc.stdout.emit('data', Buffer.from('hello world'));
      proc.emit('close', 0);
    });
    const out = await __test.runPoppler('pdftotext', ['-'], 1000, spawn);
    expect(out).toBe('hello world');
  });

  it('maps a non-zero exit to extract-failed', async () => {
    const spawn = fakeSpawn((proc) => {
      proc.stderr.emit('data', Buffer.from('boom'));
      proc.emit('close', 1);
    });
    await expect(__test.runPoppler('pdftotext', ['-'], 1000, spawn)).rejects.toMatchObject({
      kind: 'extract-failed',
    });
  });
});

// figurePages parses `pdfimages -list` output to find pages carrying a real
// figure (large raster image), skipping headers, smask companion rows, and
// sub-threshold logos. A canned listing modeled on the RTOG-0848 manuscript.
describe('figurePages', () => {
  const LISTING = [
    'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
    '--------------------------------------------------------------------------------------------',
    '   1     0 image      80    80  rgb     3   8  image  no        12  0   200   200  2.1K 1.0%', // logo: too small
    '  36     2 image    1333  1000  rgb     3   8  image  no       419  0   200   200 85.2K 2.2%', // Fig 2 KM
    '  36     3 smask    1333  1000  gray    1   8  image  no       419  0   200   200 43.5K 3.3%', // companion mask
    '  38   282 image    1333  1000  rgb     3   8  image  no       529  0   200   200 93.2K 2.4%', // Fig 3 forest
    '  39   284 image    1333  1000  rgb     3   8  image  no       534  0   200   200 65.4K 1.7%', // Fig 4 KM
  ].join('\n');

  it('returns the deduped, sorted pages with a large raster image', async () => {
    const spawn = fakeSpawn((proc) => {
      proc.stdout.emit('data', Buffer.from(LISTING));
      proc.emit('close', 0);
    });
    expect(await figurePages('/x.pdf', 1000, spawn)).toEqual([36, 38, 39]);
  });

  it('returns [] when pdfimages is missing (best-effort, no throw)', async () => {
    const spawn = fakeSpawn((proc) => {
      const err = new Error('spawn pdfimages ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      proc.emit('error', err);
    });
    expect(await figurePages('/x.pdf', 1000, spawn)).toEqual([]);
  });
});

// extractPdfFigureOcr layers figure-page OCR on top of the text layer. We inject
// the page-list + per-page OCR seams so it never shells out to poppler/Vision.
describe('extractPdfFigureOcr', () => {
  it('returns "" when OCR is unavailable', async () => {
    const r = await extractPdfFigureOcr('/x.pdf', { ocrAvailable: () => false });
    expect(r).toBe('');
  });

  it('returns "" when there are no figure pages (fully vector PDF)', async () => {
    const r = await extractPdfFigureOcr('/x.pdf', {
      ocrAvailable: () => true,
      pages: async () => [],
      ocrPage: async () => 'should not be called',
    });
    expect(r).toBe('');
  });

  it('OCRs each figure page and page-tags the joined output', async () => {
    const r = await extractPdfFigureOcr('/x.pdf', {
      ocrAvailable: () => true,
      pages: async () => [36, 38],
      ocrPage: async (_p, page) =>
        page === 38 ? 'N0 28.6 vs 48.1' : 'Overall Survival',
    });
    expect(r).toBe('[p.36]\nOverall Survival\n\n[p.38]\nN0 28.6 vs 48.1');
  });

  it('skips a page whose OCR throws, keeping the rest', async () => {
    const r = await extractPdfFigureOcr('/x.pdf', {
      ocrAvailable: () => true,
      pages: async () => [36, 38],
      ocrPage: async (_p, page) => {
        if (page === 36) throw new Error('rasterize failed');
        return 'forest plot';
      },
    });
    expect(r).toBe('[p.38]\nforest plot');
  });

  it('caps the number of figure pages OCRd', async () => {
    const seen: number[] = [];
    await extractPdfFigureOcr('/x.pdf', {
      ocrAvailable: () => true,
      pages: async () => [1, 2, 3, 4, 5],
      ocrPage: async (_p, page) => {
        seen.push(page);
        return `p${page}`;
      },
      maxPages: 2,
    });
    expect(seen).toEqual([1, 2]);
  });

  it('returns "" (no throw) when listing the pages fails', async () => {
    const r = await extractPdfFigureOcr('/x.pdf', {
      ocrAvailable: () => true,
      pages: async () => {
        throw new Error('pdfimages blew up');
      },
    });
    expect(r).toBe('');
  });
});

// ocrSinglePage is the real rasterize+OCR worker behind extractPdfFigureOcr's
// ocrPage seam. We inject a fake spawn that writes a PNG into the temp dir
// (pdftoppm's output prefix is the last arg) and a stub OCR so the temp-dir +
// PNG-glob + join + cleanup path runs without poppler/Vision.
describe('ocrSinglePage', () => {
  function spawnWritingPngs(names: string[]) {
    return ((_bin: string, args: string[]) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      const prefix = args[args.length - 1]; // join(dir, 'page')
      setImmediate(() => {
        for (const n of names) writeFileSync(`${prefix}-${n}`, 'fakepng');
        proc.emit('close', 0);
      });
      return proc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  }
  const okOcr = (text: string) =>
    async () => ({ entry: { text, hash: 'h', version: '' }, status: 'ok' as const });

  it('rasterizes the page, OCRs each PNG, and joins the text', async () => {
    const txt = await __test.ocrSinglePage('/x.pdf', 38, 1000, {
      spawnFn: spawnWritingPngs(['38.png']),
      ocr: okOcr('N0 28.6 (14.9-42.2) 48.1 (33.3-62.9)'),
    });
    expect(txt).toBe('N0 28.6 (14.9-42.2) 48.1 (33.3-62.9)');
  });

  it('skips PNGs whose OCR is blank and joins the rest with blank lines', async () => {
    let call = 0;
    const txt = await __test.ocrSinglePage('/x.pdf', 1, 1000, {
      spawnFn: spawnWritingPngs(['1.png', '2.png']),
      // first PNG empty (skipped), second has text
      ocr: async () => ({ entry: { text: call++ === 0 ? '   ' : 'forest plot', hash: 'h', version: '' }, status: 'ok' as const }),
    });
    expect(txt).toBe('forest plot');
  });
});
