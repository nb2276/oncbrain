import { describe, it, expect } from 'vitest';
import { buildShareUrl } from '../src/lib/share-url.ts';

describe('buildShareUrl', () => {
  it('returns /sites/{site}/#{date}-{slug} for valid inputs', () => {
    expect(buildShareUrl({ site: 'prostate', date: '2026-05-17', slug: 'prestige-psma' }))
      .toBe('/sites/prostate/#2026-05-17-prestige-psma');
  });

  it('returns the same shape across different sites + slugs', () => {
    expect(buildShareUrl({ site: 'breast', date: '2026-05-20', slug: 'aranote' }))
      .toBe('/sites/breast/#2026-05-20-aranote');
    expect(buildShareUrl({ site: 'gu-other', date: '2026-04-01', slug: 'tiger' }))
      .toBe('/sites/gu-other/#2026-04-01-tiger');
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
