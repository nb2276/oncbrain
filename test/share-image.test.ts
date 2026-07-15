import { describe, it, expect } from 'vitest';
import {
  defaultCard,
  digestCard,
  siteCard,
  studyCard,
  headlineSize,
  renderShareImage,
} from '../src/lib/share-image.ts';

// Read a PNG's IHDR width/height (big-endian uint32 at byte 16 and 20).
function pngSize(buf: Buffer): { width: number; height: number; isPng: boolean } {
  const isPng = buf.length > 24 && buf.slice(1, 4).toString('ascii') === 'PNG';
  return { isPng, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('share-image card builders', () => {
  it('defaultCard: branded tagline + handle, no eyebrow/tag', () => {
    const c = defaultCard('@nb2276');
    expect(c.headline).toMatch(/Curated.*oncology/i);
    expect(c.handle).toBe('@nb2276');
    expect(c.eyebrow).toBeUndefined();
    expect(c.tagLabel).toBeUndefined();
  });

  it('digestCard: date·conf eyebrow, top-line headline, pluralized study tag', () => {
    const c = digestCard({ date: '2026-06-09', topLine: 'FIRESTORM: 5-yr PFS 65.8% vs 38.8%', conference: 'ASCO 2026', studyCount: 3, siteCount: 2, handle: '@nb2276' });
    expect(c.eyebrow).toBe('2026-06-09 · ASCO 2026');
    expect(c.headline).toBe('FIRESTORM: 5-yr PFS 65.8% vs 38.8%');
    expect(c.tagLabel).toBe('3 STUDIES');
  });

  it('digestCard: singular tag, no-conf eyebrow, empty-topline fallback', () => {
    const c = digestCard({ date: '2026-06-09', topLine: '', conference: null, studyCount: 1, siteCount: 1, handle: '@x' });
    expect(c.eyebrow).toBe('2026-06-09');
    expect(c.tagLabel).toBe('1 STUDY');
    expect(c.headline).toBe('1 study across 1 disease site');
  });

  it('siteCard: label·count eyebrow, study-name headline, label fallback', () => {
    expect(siteCard({ label: 'Breast', headline: 'DESTINY-Breast', count: 18, handle: '@x' })).toMatchObject({
      eyebrow: 'Breast · 18 studies',
      headline: 'DESTINY-Breast',
    });
    expect(siteCard({ label: 'Bladder', headline: '', count: 1, handle: '@x' })).toMatchObject({
      eyebrow: 'Bladder · 1 study',
      headline: 'Bladder',
    });
  });

  it('studyCard: date·conf eyebrow, name-led headline, verdict tag in its color', () => {
    const c = studyCard({
      name: 'PRESTIGE-PSMA',
      tldr: 'PRESTIGE-PSMA: mPFS 14.2 vs 9.8 mo, HR 0.62',
      date: '2026-05-17',
      conference: 'ASCO GU',
      verdict: { soc_implication: 'practice-changing', rationale: 'x', audience: null },
      handle: '@nb2276',
    });
    expect(c.eyebrow).toBe('2026-05-17 · ASCO GU');
    // Name leads; the name-prefix is stripped from the restated TL;DR so it
    // isn't duplicated ("PRESTIGE-PSMA: PRESTIGE-PSMA: ...").
    expect(c.headline).toBe('PRESTIGE-PSMA: mPFS 14.2 vs 9.8 mo, HR 0.62');
    expect(c.tagLabel).toBe('PRACTICE-CHANGING');
    expect(c.tagColor).toBe('#1a5e3a');
  });

  it('studyCard: threads the v0.26 figuresSourced flag (E2 OG trust mark)', () => {
    const base = { name: 'TRIAL-9', tldr: 'ORR 42%', date: '2026-01-01', handle: '@x' } as const;
    expect(studyCard({ ...base, figuresSourced: true }).figuresSourced).toBe(true);
    // Absent by default — a card with no figure numbers has nothing to vouch for
    // (absence is not a negative signal).
    expect(studyCard(base).figuresSourced).toBeUndefined();
  });

  it('studyCard: no-conf eyebrow, no verdict → no tag (review path)', () => {
    const c = studyCard({
      name: 'A narrative review of PARP inhibitors',
      tldr: 'Survey of PARP inhibitor trials across solid tumors.',
      date: '2026-06-01',
      conference: null,
      verdict: null,
      handle: '@x',
    });
    expect(c.eyebrow).toBe('2026-06-01');
    expect(c.tagLabel).toBeUndefined();
    expect(c.tagColor).toBeUndefined();
    expect(c.headline).toContain('A narrative review of PARP inhibitors');
  });

  it('studyCard: headline fallbacks — tldr not led by name keeps full tldr; empty tldr → bare name', () => {
    // TL;DR does not restate the name → nothing is stripped, headline = "NAME: <full tldr>".
    expect(
      studyCard({ name: 'TRIAL-7', tldr: 'mPFS 14.2 vs 9.8 mo', date: '2026-01-01', handle: '@x' }).headline,
    ).toBe('TRIAL-7: mPFS 14.2 vs 9.8 mo');
    // Empty/whitespace tldr → headline falls back to the bare name, no dangling colon.
    const nameOnly = studyCard({ name: 'TRIAL-7', tldr: '   ', date: '2026-01-01', handle: '@x' });
    expect(nameOnly.headline).toBe('TRIAL-7');
    expect(nameOnly.headline).not.toContain(':');
  });

  it('headlineSize shrinks as the headline grows', () => {
    expect(headlineSize('short')).toBe(58);
    expect(headlineSize('x'.repeat(60))).toBe(50);
    expect(headlineSize('x'.repeat(100))).toBe(42);
    expect(headlineSize('x'.repeat(160))).toBe(36);
  });

  // Publish boundary: a share card is synthesized TEXT only. The builders take
  // primitives (date, top-line, name, count), never a study's figures/slides,
  // so an image URL can't reach the card by construction. Assert it.
  it('builder output never carries an image URL (publish-safe)', () => {
    const cards = [
      defaultCard('@x'),
      digestCard({ date: '2026-06-09', topLine: 'x', conference: 'ASCO', studyCount: 2, siteCount: 1, handle: '@x' }),
      siteCard({ label: 'Breast', headline: 'y', count: 3, handle: '@x' }),
      studyCard({ name: 'TRIAL-1', tldr: 'TRIAL-1: ORR 42%', date: '2026-06-09', conference: 'ASCO', verdict: { soc_implication: 'early-signal', rationale: 'x', audience: null }, handle: '@x' }),
    ];
    const blob = JSON.stringify(cards);
    expect(blob).not.toMatch(/pbs\.twimg\.com|\/slides\/|\.(png|jpg|jpeg|webp)\b/i);
  });
});

describe('renderShareImage', () => {
  it('renders a valid 1200x630 PNG for a digest card', async () => {
    const png = await renderShareImage(digestCard({ date: '2026-06-09', topLine: 'FIRESTORM dose-escalated RT 5-yr PFS 65.8% vs 38.8%', conference: 'ASCO', studyCount: 3, siteCount: 2, handle: '@nb2276' }));
    const { isPng, width, height } = pngSize(png);
    expect(isPng).toBe(true);
    expect(width).toBe(1200);
    expect(height).toBe(630);
    expect(png.length).toBeGreaterThan(2000);
  });

  it('renders the colored verdict tag path (for the future share button)', async () => {
    const png = await renderShareImage({ headline: 'PRESTIGE-PSMA mPFS 14.2 vs 9.8mo, HR 0.62', tagLabel: 'CAVEATS DOMINATE', tagColor: '#8a3a1a', handle: '@nb2276' });
    expect(pngSize(png).isPng).toBe(true);
    expect(pngSize(png).width).toBe(1200);
  });

  it('a long UNBROKEN headline wraps instead of overflowing the canvas', async () => {
    // No spaces -> must wordBreak, not run off the right edge (codex P2).
    const png = await renderShareImage({ headline: 'A'.repeat(120), handle: '@nb2276' });
    const { isPng, width, height } = pngSize(png);
    expect(isPng).toBe(true);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });
});
