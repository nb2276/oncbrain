import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { extractPdfText, PdfToolError, isUsableTextLayer, __test } from '../src/lib/pdf-text.ts';

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
