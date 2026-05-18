import { describe, it, expect, vi } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadTelegramFile,
  saveSlidePhotoBytes,
  isSafeSlidePath,
  TelegramFileError,
} from '../src/lib/slide-photo-storage.ts';

function makeFetchMock(
  metaResponse: unknown,
  bytesResponse: { body: Buffer | string; ok?: boolean; status?: number } = { body: 'BYTES' },
) {
  let call = 0;
  return vi.fn(async (url: string) => {
    call++;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => metaResponse,
      } as unknown as Response;
    }
    return {
      ok: bytesResponse.ok ?? true,
      status: bytesResponse.status ?? 200,
      arrayBuffer: async () =>
        typeof bytesResponse.body === 'string'
          ? Buffer.from(bytesResponse.body).buffer
          : bytesResponse.body.buffer.slice(
              bytesResponse.body.byteOffset,
              bytesResponse.body.byteOffset + bytesResponse.body.byteLength,
            ),
    } as unknown as Response;
  });
}

describe('downloadTelegramFile', () => {
  it('two-call flow: getFile → file bytes', async () => {
    // Magic bytes for a tiny JPEG (FFD8FF)
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fetchImpl = makeFetchMock(
      { ok: true, result: { file_path: 'photos/file_42.jpg', file_size: 6 } },
      { body: jpegBytes },
    );
    const out = await downloadTelegramFile('AgADBQADr', 'fake-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out.mime_type).toBe('image/jpeg');
    expect(out.ext).toBe('jpg');
    expect(out.buffer.equals(jpegBytes)).toBe(true);
  });

  it('detects PNG by magic bytes (header)', async () => {
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const fetchImpl = makeFetchMock(
      { ok: true, result: { file_path: 'photos/file_42.png', file_size: 12 } },
      { body: pngBytes },
    );
    const out = await downloadTelegramFile('AgADBQADr', 'fake-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.mime_type).toBe('image/png');
    expect(out.ext).toBe('png');
  });

  it('throws auth on missing token', async () => {
    await expect(downloadTelegramFile('AgADBQADr', '')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('throws not_found when getFile result lacks file_path', async () => {
    const fetchImpl = makeFetchMock({ ok: false, description: 'file not found' });
    await expect(
      downloadTelegramFile('bad-id', 'fake-token', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('throws auth on 401 from getFile', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    await expect(
      downloadTelegramFile('AgADBQADr', 'fake-token', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('throws too_large when file_size exceeds cap', async () => {
    const fetchImpl = makeFetchMock({
      ok: true,
      result: { file_path: 'photos/big.jpg', file_size: 50 * 1024 * 1024 },
    });
    await expect(
      downloadTelegramFile('big-id', 'fake-token', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: 'too_large' });
  });
});

describe('saveSlidePhotoBytes', () => {
  it('writes the file under data/slide-photos/<date>/<uuid>.<ext>', () => {
    // Work in a scratch CWD so the test doesn't pollute the repo.
    const scratch = mkdtempSync(join(tmpdir(), 'oncbrain-slide-test-'));
    const prevCwd = process.cwd();
    process.chdir(scratch);
    try {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const result = saveSlidePhotoBytes({
        buffer,
        ext: 'jpg',
        bookmarkDate: '2026-05-18',
      });
      expect(existsSync(result.absPath)).toBe(true);
      expect(result.relPath).toMatch(/^data\/slide-photos\/2026-05-18\/[a-f0-9-]{36}\.jpg$/);
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(result.absPath).equals(buffer)).toBe(true);
    } finally {
      process.chdir(prevCwd);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects unsafe extension (path-traversal attempt)', () => {
    expect(() =>
      saveSlidePhotoBytes({
        buffer: Buffer.alloc(0),
        ext: '../etc',
        bookmarkDate: '2026-05-18',
      }),
    ).toThrow(/unsafe extension/);
  });

  it('rejects malformed bookmark_date', () => {
    expect(() =>
      saveSlidePhotoBytes({
        buffer: Buffer.alloc(0),
        ext: 'jpg',
        bookmarkDate: 'today',
      }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe('isSafeSlidePath', () => {
  it('returns false for paths outside SLIDES_ROOT', () => {
    expect(isSafeSlidePath('/etc/passwd')).toBe(false);
    expect(isSafeSlidePath('../../../etc/passwd')).toBe(false);
  });

  it('returns false for nonexistent files even under SLIDES_ROOT', () => {
    expect(isSafeSlidePath('data/slide-photos/2026-05-18/nonexistent.jpg')).toBe(false);
  });
});
