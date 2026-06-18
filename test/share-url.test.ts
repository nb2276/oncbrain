import { describe, it, expect } from 'vitest';
import { buildShareUrl } from '../src/lib/share-url.ts';

describe('buildShareUrl', () => {
  it('returns the standalone per-study page /study/{date}-{slug}/ for valid inputs', () => {
    expect(buildShareUrl({ site: 'prostate', date: '2026-05-17', slug: 'prestige-psma' }))
      .toBe('/study/2026-05-17-prestige-psma/');
  });

  it('returns a real page path (not a #fragment that unfurlers strip)', () => {
    const url = buildShareUrl({ site: 'breast', date: '2026-05-20', slug: 'aranote' });
    expect(url).toBe('/study/2026-05-20-aranote/');
    // The whole point of the fix: no fragment, so a link unfurler fetches the
    // study's own page (with its own og:title + og:image) instead of falling
    // back to the site page's card.
    expect(url).not.toContain('#');
  });

  it('returns the same shape across different sites + slugs', () => {
    expect(buildShareUrl({ site: 'gu-other', date: '2026-04-01', slug: 'tiger' }))
      .toBe('/study/2026-04-01-tiger/');
  });

  it('returns undefined when site is empty', () => {
    expect(buildShareUrl({ site: '', date: '2026-05-17', slug: 'x' })).toBeUndefined();
  });

  it('returns undefined when date is empty', () => {
    expect(buildShareUrl({ site: 'prostate', date: '', slug: 'x' })).toBeUndefined();
  });

  it('returns undefined when slug is empty', () => {
    expect(buildShareUrl({ site: 'prostate', date: '2026-05-17', slug: '' })).toBeUndefined();
  });
});
