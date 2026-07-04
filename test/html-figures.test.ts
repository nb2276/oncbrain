import { describe, it, expect, afterEach } from 'vitest';
import {
  registrableDomain,
  extractFigureImageUrls,
  enrichHtmlFigures,
  isHtmlFigureOcrEnabled,
} from '../src/lib/html-figures.ts';

describe('registrableDomain (v0.25 #2)', () => {
  it('takes the last two labels for a normal host', () => {
    expect(registrableDomain('www.urotoday.com')).toBe('urotoday.com');
    expect(registrableDomain('media.cdn.urotoday.com')).toBe('urotoday.com');
    expect(registrableDomain('urotoday.com')).toBe('urotoday.com');
  });
  it('returns null for a multi-part public suffix (#P1 host-pin safety)', () => {
    expect(registrableDomain('www.journal.co.uk')).toBeNull();
    expect(registrableDomain('mja.com.au')).toBeNull();
    expect(registrableDomain('evil.co.uk')).toBeNull();
  });
  it('returns null for a single-label host', () => {
    expect(registrableDomain('localhost')).toBeNull();
  });
});

describe('extractFigureImageUrls (v0.25 #2)', () => {
  const pageUrl = 'https://www.urotoday.com/conference/x/article';
  const html = `
    <img src="https://www.urotoday.com/img/figure-km.jpg" alt="Kaplan-Meier curve" width="600" height="400">
    <img src="/media/site-logo.png" alt="site logo">
    <img src="https://cdn.other-tracker.com/figure.jpg" alt="figure" width="500">
    <img src="https://www.urotoday.com/icons/share.svg" alt="share">
    <img data-src="https://media.urotoday.com/forest-plot.png" alt="forest plot" width="500">
    <img src="data:image/png;base64,AAAA" alt="inline">
    <img src="https://www.urotoday.com/photo-of-room.jpg" alt="conference room">
  `;

  it('keeps only same-domain raster figures with a positive figure signal', () => {
    const urls = extractFigureImageUrls(html, pageUrl);
    expect(urls).toContain('https://www.urotoday.com/img/figure-km.jpg');
    expect(urls).toContain('https://media.urotoday.com/forest-plot.png'); // lazy data-src, same registrable domain
    expect(urls.some((u) => u.includes('site-logo'))).toBe(false); // NON_FIGURE_HINT
    expect(urls.some((u) => u.includes('other-tracker'))).toBe(false); // cross-domain
    expect(urls.some((u) => u.endsWith('.svg'))).toBe(false); // not OCRable
    expect(urls.some((u) => u.startsWith('data:'))).toBe(false);
    // no figure keyword AND no large dimension → not enqueued (positive-signal req)
    expect(urls.some((u) => u.includes('photo-of-room'))).toBe(false);
  });

  it('refuses a page on a multi-part public suffix (#P1)', () => {
    const h = `<img src="https://evil.journal.co.uk/figure.jpg" alt="figure" width="600">`;
    expect(extractFigureImageUrls(h, 'https://good.journal.co.uk/article')).toEqual([]);
  });

  it('picks the largest srcset candidate and caps the count', () => {
    const many = Array.from(
      { length: 20 },
      (_, i) =>
        `<img srcset="https://www.urotoday.com/f${i}-320.jpg 320w, https://www.urotoday.com/f${i}-1200.jpg 1200w" alt="figure ${i}">`,
    ).join('\n');
    const urls = extractFigureImageUrls(many, pageUrl);
    expect(urls.length).toBeLessThanOrEqual(5);
    expect(urls[0]).toContain('-1200.jpg'); // largest width descriptor wins
  });

  it('returns [] for a malformed page URL', () => {
    expect(extractFigureImageUrls(html, 'not a url')).toEqual([]);
  });
});

describe('enrichHtmlFigures (v0.25 #2, grounded-only)', () => {
  afterEach(() => {
    delete process.env.HTML_FIGURE_OCR;
  });
  const pageUrl = 'https://www.urotoday.com/conference/x';
  const html = `<img src="https://www.urotoday.com/figure-km.jpg" alt="Kaplan-Meier" width="600">`;
  const bigImg = Buffer.alloc(20 * 1024, 1); // ≥ MIN_IMAGE_BYTES
  const okDeps = {
    fetchBuffer: async () => bigImg,
    extract: async () => ({ figure_structured_md: '### KM\n- mOS 14.2 vs 9.8, HR 0.62', status: 'ok' as const }),
    ocrAvailable: () => true,
    qwenAvailable: async () => true,
  };

  it('is disabled by default (opt-in) → nulls, never fetches', async () => {
    let fetched = false;
    const r = await enrichHtmlFigures(html, pageUrl, {
      ...okDeps,
      fetchBuffer: async () => {
        fetched = true;
        return bigImg;
      },
    });
    expect(isHtmlFigureOcrEnabled()).toBe(false);
    expect(r).toEqual({ figure_ocr_md: null, figure_structured_md: null });
    expect(fetched).toBe(false);
  });

  it('emits ONLY the grounded structured extract, pinned to the article domain', async () => {
    process.env.HTML_FIGURE_OCR = 'on';
    let pinnedTo: string[] = [];
    const r = await enrichHtmlFigures(html, pageUrl, {
      ...okDeps,
      fetchBuffer: async (_u, allowed) => {
        pinnedTo = allowed;
        return bigImg;
      },
    });
    expect(r.figure_ocr_md).toBeNull(); // never raw OCR for a copyrighted source
    expect(r.figure_structured_md).toContain('HR 0.62');
    expect(pinnedTo).toEqual(['.urotoday.com']);
  });

  it('drops a NON-grounded (degraded) extract — no raw OCR reaches the digest (#P1)', async () => {
    process.env.HTML_FIGURE_OCR = 'on';
    const r = await enrichHtmlFigures(html, pageUrl, {
      ...okDeps,
      extract: async () => ({ figure_structured_md: '## Figure (unreconciled — raw OCR)\ncopyrighted text', status: 'degraded' as const }),
    });
    expect(r.figure_structured_md).toBeNull();
  });

  it('does nothing without the Qwen reconciliation stack (grounded-only)', async () => {
    process.env.HTML_FIGURE_OCR = 'on';
    let fetched = false;
    const r = await enrichHtmlFigures(html, pageUrl, {
      ...okDeps,
      qwenAvailable: async () => false,
      fetchBuffer: async () => {
        fetched = true;
        return bigImg;
      },
    });
    expect(r.figure_structured_md).toBeNull();
    expect(fetched).toBe(false);
  });

  it('skips an icon-sized image (below MIN_IMAGE_BYTES)', async () => {
    process.env.HTML_FIGURE_OCR = 'on';
    const r = await enrichHtmlFigures(html, pageUrl, { ...okDeps, fetchBuffer: async () => Buffer.alloc(500, 1) });
    expect(r.figure_structured_md).toBeNull();
  });

  it('returns nulls when Vision is unavailable', async () => {
    process.env.HTML_FIGURE_OCR = 'on';
    const r = await enrichHtmlFigures(html, pageUrl, { ...okDeps, ocrAvailable: () => false });
    expect(r.figure_structured_md).toBeNull();
  });
});
