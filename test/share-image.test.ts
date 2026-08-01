import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defaultCard,
  digestCard,
  siteCard,
  studyCard,
  headlineSize,
  renderShareImage,
  renderShareSvg,
} from '../src/lib/share-image.ts';
import { Resvg } from '@resvg/resvg-js';
import { markGeometry } from '../src/lib/effect-size.ts';

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

// ── pixel probes ───────────────────────────────────────────────────────────
// satori rasterizes text to paths and drops off-canvas elements silently, so
// neither the SVG source nor a PNG byte count can tell you whether a piece of
// the mark actually got PAINTED. These read the final RGBA and look.

type Probe = {
  ink(x: number, y: number): boolean;
  /** Ink count inside a box, x0/y0 inclusive, x1/y1 exclusive. */
  count(x0: number, x1: number, y0: number, y1: number): number;
  /** The mark's axis rule: a 560px horizontal run nothing else on the card makes. */
  axis: { y: number; x0: number } | null;
};

async function probe(card: Parameters<typeof renderShareSvg>[0]): Promise<Probe> {
  const img = new Resvg(await renderShareSvg(card), { background: '#f7f5f0' }).render();
  const { pixels } = img;
  const W = img.width;
  // Anything meaningfully darker than the warm off-white background.
  const ink = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return pixels[i]! < 210 || pixels[i + 1]! < 205 || pixels[i + 2]! < 200;
  };
  const count = (x0: number, x1: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ink(x, y)) n++;
    return n;
  };
  // Scan bottom-up: a wide confidence interval also makes a long run, and it
  // sits ABOVE the axis, so the lowest such row is the axis itself.
  const MIN_RUN = 400;
  let axis: Probe['axis'] = null;
  for (let y = img.height - 1; y >= 0 && !axis; y--) {
    let run = 0;
    let start = 0;
    for (let x = 0; x < W; x++) {
      if (ink(x, y)) {
        if (run === 0) start = x;
        run++;
        if (run >= MIN_RUN) { axis = { y, x0: start }; break; }
      } else run = 0;
    }
  }
  return { ink, count, axis };
}

// v0.36 slice 4: the effect-size mark on the card a shared study link unfurls.
describe('share-image effect mark', () => {
  const ratio = {
    form: 'ratio' as const, kind: 'HR' as const, point: 0.53,
    lo: 0.38, hi: 0.74, ciLevel: 95, klass: 'surrogate', endpointName: 'Progression-free survival',
  };
  const paired = {
    form: 'paired' as const,
    a: { label: null, value: 1.5 }, b: { label: null, value: 9.8 },
    unit: '%', klass: 'local-control', origin: 'endpoint' as const,
  };

  it('carries the mark through studyCard', () => {
    const card = studyCard({
      name: 'X', tldr: 'y', date: '2026-07-31', handle: '@h',
      effect: { datum: ratio, domain: { lo: 1 / 3, hi: 3 } },
    });
    expect(card.effect?.datum).toBe(ratio);
  });

  it('renders a valid PNG with a mark', async () => {
    const png = await renderShareImage(studyCard({
      name: 'PRESTIGE', tldr: 'MFS improved', date: '2026-07-31', handle: '@h',
      effect: { datum: ratio, domain: { lo: 1 / 3, hi: 3 } },
    }));
    expect(png.length).toBeGreaterThan(1000);
    // PNG magic bytes — a real image, not an error page.
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('renders without a mark just as happily', async () => {
    const png = await renderShareImage(studyCard({
      name: 'PRESTIGE', tldr: 'no ratio here', date: '2026-07-31', handle: '@h',
    }));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  // The eng review's condition for accepting a SECOND renderer: both must use
  // the same geometry function, so only the paint can differ, never the math.
  // If this file ever computes a coordinate itself, that guarantee is gone.
  it('takes its coordinates from markGeometry, and computes none itself', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/share-image.ts'), 'utf-8');
    expect(src).toContain('markGeometry');
    // No local log-scale math: that would be a second implementation.
    expect(src).not.toMatch(/Math\.log\(/);
  });

  it('draws nothing for the paired form on this surface', async () => {
    // The headline IS the TL;DR and already carries both values verbatim, and a
    // 1.5% bar is a few pixels at the size this card is viewed.
    const withPaired = await renderShareImage(studyCard({
      name: 'X', tldr: 'same text', date: '2026-07-31', handle: '@h',
      effect: { datum: paired },
    }));
    const without = await renderShareImage(studyCard({
      name: 'X', tldr: 'same text', date: '2026-07-31', handle: '@h',
    }));
    expect(withPaired.length).toBe(without.length);
  });

  it('draws nothing when the estimate would fall off the axis', async () => {
    // Same guard as the web component: a clamped dot would read as the edge value.
    const off = await renderShareImage(studyCard({
      name: 'X', tldr: 'same text', date: '2026-07-31', handle: '@h',
      effect: { datum: { ...ratio, point: 50, lo: null, hi: null }, domain: { lo: 1 / 3, hi: 3 } },
    }));
    const without = await renderShareImage(studyCard({
      name: 'X', tldr: 'same text', date: '2026-07-31', handle: '@h',
    }));
    expect(off.length).toBe(without.length);
  });

  // The mark lives inside an `overflow: hidden` flex block that it SHARES with
  // the headline, so a headline long enough to eat the block's height would clip
  // the mark away silently. A byte-count assertion cannot see that (a clipped
  // render is still a valid, differently-sized PNG), so this looks at pixels.
  //
  // The mark's axis is a 560px horizontal rule. Nothing else on the card draws a
  // long horizontal run, which makes it a clean signature to search for.
  it('still paints the mark under a MAX-length headline', async () => {
    const withMark = studyCard({
      // Longer than the 170-char truncate, at the smallest headline size.
      name: 'MAXIMUS',
      tldr: 'Median overall survival improved substantially in the experimental arm across every prespecified stratum evaluated, with a consistent direction of effect and no new safety signals reported anywhere in the trial population.',
      date: '2026-07-31', handle: '@h',
      effect: { datum: ratio, domain: { lo: 1 / 3, hi: 3 } },
    });
    expect((await probe(withMark)).axis).not.toBeNull();
    // Negative control: without the mark there is no such rule, which is what
    // makes the positive assertion mean "the mark", not "some pixels".
    expect((await probe({ ...withMark, effect: undefined })).axis).toBeNull();
  });

  // A clipped interval MUST show that it continues, or a truncated CI reads as
  // bounded, which is a different clinical claim from the same geometry.
  //
  // Regression: the first version placed the low-side chevron at loX - 20. At a
  // low clip loX is 0, so it landed at a negative x and satori dropped it —
  // leaving a bar that stopped dead at the axis edge and looked precise. The PNG
  // was still valid and still a different size, so only pixels catch this.
  it('marks BOTH ends of an interval that runs off the axis', async () => {
    const clipped = studyCard({
      name: 'C', tldr: 'x', date: '2026-07-31', handle: '@h',
      effect: {
        datum: { ...ratio, point: 1.4, lo: 0.22, hi: 11.7 },
        domain: { lo: 1 / 3, hi: 3 },
      },
    });
    // Same domain, interval comfortably inside it: no continuation to show.
    const inside = studyCard({
      name: 'C', tldr: 'x', date: '2026-07-31', handle: '@h',
      effect: { datum: { ...ratio, point: 1.4, lo: 0.9, hi: 2.0 }, domain: { lo: 1 / 3, hi: 3 } },
    });

    const MARK_W = 560;
    const END = 16; // the width each chevron is given at the axis end
    for (const [card, expected] of [[clipped, true], [inside, false]] as const) {
      const p = await probe(card);
      expect(p.axis).not.toBeNull();
      const { y, x0 } = p.axis!;
      // A band strictly ABOVE the interval bar (whose top edge is axis - 9), at
      // each far end. Overlapping the bar would make this vacuous: the buggy
      // build drew a full-width bar right there and "passed".
      const band = [y - 19, y - 10] as const;
      const lo = p.count(x0, x0 + END, band[0], band[1]);
      const hi = p.count(x0 + MARK_W - END, x0 + MARK_W, band[0], band[1]);
      expect(lo > 0).toBe(expected);
      expect(hi > 0).toBe(expected);
    }
  });

  // Two renderers, one ruler. The OG route used to resolve the domain with its
  // own copy of the expression and had already dropped the fallback, so a datum
  // whose bucket is missing from the corpus map drew a mark on the site and
  // nothing on the share image. Both now call one function.
  // A bare "HR 0.62" with no interval is ordinary in a conference tweet, which
  // is a primary source type here. parseEffectSize returns lo/hi null for it, so
  // this branch is live even though today's corpus happens to have no instance.
  // The dot must still draw: the estimate is the point of the mark.
  //
  // This also carries the load for the whole "two renderers, one geometry"
  // guarantee. The source-grep test below is weak on its own: a renderer could
  // keep an unused markGeometry import and paint a WRONG linear position without
  // ever calling Math.log, and the grep would still pass. Here the painted dot's
  // measured centre is compared against markGeometry's computed pointX, so the
  // paint is pinned to the math rather than to the import list.
  it('paints the estimate at markGeometry pointX, with no interval to lean on', async () => {
    const datum = { ...ratio, point: 0.62, lo: null, hi: null, ciLevel: null };
    const domain = { lo: 1 / 3, hi: 3 };
    const p = await probe(studyCard({
      name: 'C', tldr: 'x', date: '2026-07-31', handle: '@h', effect: { datum, domain },
    }));
    expect(p.axis).not.toBeNull();
    const { y, x0 } = p.axis!;

    // Row through the dot's middle. With no CI there is no interval bar here,
    // so the only wide run is the dot itself (the null reference is 2px).
    const row = y - 6;
    const runs: Array<{ start: number; end: number }> = [];
    let start = -1;
    for (let x = x0; x <= x0 + 560; x++) {
      if (p.ink(x, row)) { if (start < 0) start = x; }
      else if (start >= 0) { runs.push({ start, end: x - 1 }); start = -1; }
    }
    const dot = runs.find((r) => r.end - r.start >= 10);
    expect(dot, 'no dot painted — the card showed an empty ruler').toBeDefined();

    const expected = markGeometry(datum, domain, 560).pointX;
    const measured = (dot!.start + dot!.end) / 2 - x0;
    expect(Math.abs(measured - expected)).toBeLessThanOrEqual(2);
  });

  // domain is optional on ShareCard.effect. The OG route always supplies one for
  // a ratio, so this is the guard for any other caller: abstain rather than
  // invent a ruler, because a mark drawn against a guessed axis is a wrong
  // magnitude, not a cosmetic bug.
  it('abstains for a ratio with no domain rather than inventing a ruler', async () => {
    const noDomain = await renderShareImage(studyCard({
      name: 'C', tldr: 'x', date: '2026-07-31', handle: '@h',
      effect: { datum: ratio },
    }));
    const bare = await renderShareImage(studyCard({
      name: 'C', tldr: 'x', date: '2026-07-31', handle: '@h',
    }));
    expect(noDomain.length).toBe(bare.length);
  });

  it('uses the same corpus ruler as the web card', () => {
    const route = readFileSync(resolve(process.cwd(), 'src/pages/og/study/[slug].png.ts'), 'utf-8');
    expect(route).toContain('domainForMark(');
    expect(route).toContain('effectForStudy(');
    // No local re-derivation: that is exactly how the two drifted apart.
    expect(route).not.toContain('effectDomains()');
    expect(route).not.toContain('axisBucket(');
  });
});
