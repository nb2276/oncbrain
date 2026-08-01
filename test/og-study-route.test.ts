// v0.36 slice 4 — review Issue 2: the per-study mark must never be able to take
// down the nightly publish.
//
// `astro build` renders every per-study OG card. A throw in ANY one of them
// fails the whole build, and scripts/daily-build.sh runs that build at 1am, so
// a single malformed study would cost the entire day's digest. The route falls
// back to the markless card that shipped before v0.36.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const renderShareImage = vi.fn();

vi.mock('../src/lib/share-image.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/share-image.ts')>();
  return { ...actual, renderShareImage: (c: unknown) => renderShareImage(c) };
});

const entry = {
  date: '2026-07-31',
  conference: null,
  study: {
    name: 'THROWER',
    slug: 'thrower',
    tldr: 'Overall survival improved.',
    primary_endpoint: { name: 'Overall survival', klass: 'overall-survival', stat_value: 'HR 0.53', stat_detail: '95% CI 0.38-0.74' },
    details: [],
    verdict: null,
  },
};

describe('og/study route: the mark cannot break the nightly build', () => {
  beforeEach(() => renderShareImage.mockReset());

  it('falls back to a markless card when rendering the mark throws', async () => {
    const { GET } = await import('../src/pages/og/study/[slug].png.ts');
    renderShareImage
      .mockImplementationOnce(() => { throw new Error('satori exploded'); })
      .mockResolvedValueOnce(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const res = await GET({ props: { entry } } as never);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(renderShareImage).toHaveBeenCalledTimes(2);
    // First attempt carries the mark; the retry deliberately drops it.
    expect(renderShareImage.mock.calls[0]![0]).toHaveProperty('effect');
    expect(renderShareImage.mock.calls[0]![0].effect).not.toBeNull();
    expect(renderShareImage.mock.calls[1]![0].effect ?? null).toBeNull();
  });

  it('propagates a second throw rather than serving a broken card silently', async () => {
    const { GET } = await import('../src/pages/og/study/[slug].png.ts');
    // Two mockImplementationOnce, not one persistent mockImplementation: a
    // persistent throwing implementation makes vitest surface its own captured
    // error and fail the test even though every assertion below passes. Throwing
    // synchronously (rather than returning a rejected promise) avoids a second
    // artifact from vitest's promise-result tracking. `await` catches both alike.
    renderShareImage
      .mockImplementationOnce(() => { throw new Error('satori still exploded'); })
      .mockImplementationOnce(() => { throw new Error('satori still exploded'); });
    let caught: unknown = null;
    try {
      await GET({ props: { entry } } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/still exploded/);
  });

  it('does not pay the retry cost on the happy path', async () => {
    const { GET } = await import('../src/pages/og/study/[slug].png.ts');
    renderShareImage.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await GET({ props: { entry } } as never);
    expect(renderShareImage).toHaveBeenCalledTimes(1);
  });
});
