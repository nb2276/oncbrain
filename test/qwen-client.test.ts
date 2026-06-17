import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlaceholderImage, runQwenVision, isQwenAvailable } from '../src/lib/qwen-client.ts';

const dir = mkdtempSync(join(tmpdir(), 'qwen-test-'));
const real = join(dir, 'real.png');
writeFileSync(real, Buffer.alloc(4096, 1)); // 4KB "image"
const stub = join(dir, 'stub.png');
writeFileSync(stub, Buffer.from('\x00\x00\x00\x00')); // 4-byte Dropbox-placeholder

afterEach(() => {
  delete process.env.FIGURE_STRUCTURED;
});

describe('isPlaceholderImage', () => {
  it('flags a 4-byte placeholder stub', () => {
    expect(isPlaceholderImage(stub)).toBe(true);
  });
  it('accepts a real-sized image', () => {
    expect(isPlaceholderImage(real)).toBe(false);
  });
  it('flags a missing file', () => {
    expect(isPlaceholderImage(join(dir, 'nope.png'))).toBe(true);
  });
});

describe('runQwenVision', () => {
  it('skips a placeholder image without calling the model', async () => {
    let called = false;
    const r = await runQwenVision(stub, { fetchImpl: (async () => ((called = true), new Response('{}'))) as unknown as typeof fetch });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/placeholder/);
    expect(called).toBe(false);
  });

  it('skips an oversized image without calling the model', async () => {
    let called = false;
    const r = await runQwenVision(real, {
      maxBytes: 2048, // real.png is 4KB → over this cap
      fetchImpl: (async () => ((called = true), new Response('{}'))) as unknown as typeof fetch,
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('image-too-large');
    expect(called).toBe(false);
  });

  it('returns ok with the model response on success', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ response: 'Panel A: HR 0.62' }), { status: 200 })) as unknown as typeof fetch;
    const r = await runQwenVision(real, { fetchImpl });
    expect(r.status).toBe('ok');
    expect(r.text).toContain('HR 0.62');
  });

  it('fails (not throws) when ollama returns an error body', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'context exceeded' }), { status: 200 })) as unknown as typeof fetch;
    const r = await runQwenVision(real, { fetchImpl });
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/context exceeded/);
  });

  it('fails gracefully when the server is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await runQwenVision(real, { fetchImpl });
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/unreachable/);
  });
});

describe('isQwenAvailable', () => {
  const tags = (names: string[]): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 })) as unknown as typeof fetch;

  it('true when the model family is served', async () => {
    expect(await isQwenAvailable({ fetchImpl: tags(['qwen2.5vl:7b', 'llama3']) })).toBe(true);
  });
  it('false when the model is absent', async () => {
    expect(await isQwenAvailable({ fetchImpl: tags(['llama3']) })).toBe(false);
  });
  it('false when ollama is down', async () => {
    const down = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    expect(await isQwenAvailable({ fetchImpl: down })).toBe(false);
  });
  it('false when FIGURE_STRUCTURED=off (kill switch), without pinging', async () => {
    process.env.FIGURE_STRUCTURED = 'off';
    let called = false;
    const probe = (async () => ((called = true), new Response('{}'))) as unknown as typeof fetch;
    expect(await isQwenAvailable({ fetchImpl: probe })).toBe(false);
    expect(called).toBe(false);
  });
});
