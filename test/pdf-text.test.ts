import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { extractPdfText, PdfToolError, __test } from '../src/lib/pdf-text.ts';

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
