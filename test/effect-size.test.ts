import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseEffectSize,
  markGeometry,
  sharedDomain,
  groupByKlass,
  describeEffect,
  FIXED_DOMAIN,
  type EffectDatum,
} from '../src/lib/effect-size.ts';

const pe = (stat_value: string, stat_detail = '', klass = 'surrogate') => ({
  name: 'x',
  klass,
  stat_value,
  stat_detail,
});

describe('parseEffectSize — shapes that actually occur in the corpus', () => {
  it('reads a bare HR in stat_value with the CI in stat_detail', () => {
    const d = parseEffectSize(pe('HR 0.54', '95% CI 0.41-0.72, p<0.001 (per-protocol, all baskets)'));
    expect(d).toMatchObject({ form: 'ratio', kind: 'HR', point: 0.54, lo: 0.41, hi: 0.72, ciLevel: 95 });
  });

  // The HR is frequently ONLY in the detail, with the value carrying medians.
  it('finds the ratio in stat_detail when stat_value has none', () => {
    const d = parseEffectSize(pe('mDFS 52.7 vs 24.4 mo', 'HR 0.750 (95% CI 0.607-0.928), P=0.008'));
    expect(d).toMatchObject({ point: 0.75, lo: 0.607, hi: 0.928 });
  });

  it('reads an HR embedded after a median in stat_value', () => {
    const d = parseEffectSize(pe('35.8 vs 20.4 mo, HR 0.48', '95% CI 0.25-0.91, p=0.021'));
    expect(d).toMatchObject({ point: 0.48, lo: 0.25, hi: 0.91 });
  });

  // Lancet-style middle-dot decimals. Without normalization this silently
  // abstains on perfectly good data.
  it('handles middle-dot decimal separators', () => {
    const d = parseEffectSize(pe('76% vs 63% at 4y', 'HR 0·62 (80% CI 0·44-0·86), p=0·063'));
    expect(d).toMatchObject({ point: 0.62, lo: 0.44, hi: 0.86, ciLevel: 80 });
  });

  it('records a 90% CI level rather than assuming 95', () => {
    const d = parseEffectSize(pe('HR 1.31', '90% CI 0.84-2.04, P=.037; NI margin 2.12', 'local-control'));
    expect(d).toMatchObject({ point: 1.31, lo: 0.84, hi: 2.04, ciLevel: 90 });
  });

  // A detail can carry the primary estimate AND an adjusted one. The card is
  // reporting the primary, so the first match wins.
  it('takes the primary estimate, not a later adjusted one', () => {
    const d = parseEffectSize(
      pe('15.8 vs 12.3 mo', 'HR 0.77 (90% CI 0.59-1.01), 1-sided P=.06, ns; adjusted HR 0.72, P=.04', 'overall-survival'),
    );
    expect(d?.point).toBe(0.77);
  });

  it('reads an odds ratio and keeps its label', () => {
    const d = parseEffectSize(pe('92% vs 68.3%', 'OR 5.34 (95% CI 2.05-13.88), P=.001'));
    expect(d).toMatchObject({ kind: 'OR', point: 5.34, lo: 2.05, hi: 13.88 });
  });

  it('reads a subdistribution HR', () => {
    const d = parseEffectSize(pe('Sub-HR 0.35', '95% CI 0.21-0.59, p<0.001; favors upfront RT', 'local-control'));
    expect(d).toMatchObject({ kind: 'SHR', point: 0.35, lo: 0.21, hi: 0.59 });
  });

  it('accepts HR= with no space', () => {
    const d = parseEffectSize(pe('61.0% vs 61.8%', 'HR=1.00; 95% CI 0.90-1.10, P=0.967 (ns)', 'overall-survival'));
    expect(d).toMatchObject({ point: 1, lo: 0.9, hi: 1.1 });
  });

  it('keeps a point estimate with no interval at all', () => {
    const d = parseEffectSize(pe('HR 0.81, ns', 'primary endpoint not met'));
    expect(d).toMatchObject({ point: 0.81, lo: null, hi: null });
  });

  it('carries the endpoint class through for the same-class axis guard', () => {
    expect(parseEffectSize(pe('HR 0.85', '95% CI 0.76-0.94', 'overall-survival'))?.klass).toBe(
      'overall-survival',
    );
  });
});

describe('parseEffectSize — abstains', () => {
  it.each([
    ['no ratio, plain proportions', '28% vs 21%', 'PPN-SBRT vs P-SBRT; no difference at 12wk'],
    ['no ratio, medians', '15.8 vs 12.3 mo', 'ns'],
    ['no ratio, NR', 'NR vs 17 mo', 'Surg bed recurrence 1% vs 12%'],
    ['prose, no number', 'Not yet mature', 'Interim: no signal of inferiority'],
    ['prose, explicit null result', 'No between-arm difference', 'No effect size reported in source'],
    ['three-arm proportions with CIs but no ratio', '3.5% vs 3.7% vs 5.5% at 10yr', '95% CI 2.4-5.0 / 2.6-5.3 / 4.1-7.3'],
    ['absolute difference in mm3', '68.9 mm³ more plaque with leuprolide', 'Adjusted for age, statin'],
    ['percentages in parens are not a CI', '1.5% vs 9.8%', '+RT 2/236 (0.3-5.1%) vs -RT 19/272 (5.9-14.9%)'],
  ])('abstains on %s', (_label, value, detail) => {
    expect(parseEffectSize(pe(value, detail))).toBeNull();
  });

  it('abstains on a non-positive ratio (no place on a log axis)', () => {
    expect(parseEffectSize(pe('HR 0', '95% CI 0.1-0.2'))).toBeNull();
  });

  it('abstains on a reversed interval rather than silently swapping it', () => {
    expect(parseEffectSize(pe('HR 0.54', '95% CI 0.72-0.41'))).toBeNull();
  });

  // The load-bearing guard: it catches corrupt data AND, more likely, a CI we
  // paired with the wrong ratio.
  it('abstains when the interval does not contain the point estimate', () => {
    expect(parseEffectSize(pe('HR 0.54', '95% CI 0.80-0.95'))).toBeNull();
    expect(parseEffectSize(pe('HR 2.00', '95% CI 0.80-0.95'))).toBeNull();
  });

  it('abstains on empty, null and undefined input', () => {
    expect(parseEffectSize(null)).toBeNull();
    expect(parseEffectSize(undefined)).toBeNull();
    expect(parseEffectSize(pe('', ''))).toBeNull();
  });

  it('does not treat a bare number as a ratio', () => {
    expect(parseEffectSize(pe('0.54', '95% CI 0.41-0.72'))).toBeNull();
  });

  it('does not match a ratio-like substring inside a longer word', () => {
    expect(parseEffectSize(pe('CHOP 0.54', 'no CI'))).toBeNull();
  });
});

describe('markGeometry', () => {
  const d: EffectDatum = { form: 'ratio', kind: 'HR', point: 0.5, lo: 0.4, hi: 0.8, ciLevel: 95, klass: null };

  it('places the null line at the midpoint of a symmetric domain', () => {
    const g = markGeometry(d, { lo: 0.25, hi: 4 }, 100);
    expect(g.nullX).toBeCloseTo(50, 5);
  });

  it('is a LOG scale, so 0.5 and 2.0 are mirror distances from the null', () => {
    const g1 = markGeometry({ ...d, point: 0.5, lo: null, hi: null }, { lo: 0.25, hi: 4 }, 100);
    const g2 = markGeometry({ ...d, point: 2, lo: null, hi: null }, { lo: 0.25, hi: 4 }, 100);
    expect(50 - g1.pointX).toBeCloseTo(g2.pointX - 50, 5);
  });

  it('orders the interval around the point estimate', () => {
    const g = markGeometry(d, { lo: 0.25, hi: 4 }, 100);
    expect(g.loX!).toBeLessThan(g.pointX);
    expect(g.pointX).toBeLessThan(g.hiX!);
  });

  it('clamps an out-of-range interval and flags it as clipped', () => {
    const wide: EffectDatum = { ...d, point: 3, lo: 0.82, hi: 11.7 };
    const g = markGeometry(wide, { lo: 0.25, hi: 4 }, 100);
    expect(g.clippedHi).toBe(true);
    expect(g.clippedLo).toBe(false);
    expect(g.hiX).toBe(100); // clamped to the plot edge, not drawn past it
  });

  it('flags a low-side clip', () => {
    const g = markGeometry({ ...d, point: 0.3, lo: 0.05, hi: 0.9 }, { lo: 0.25, hi: 4 }, 100);
    expect(g.clippedLo).toBe(true);
    expect(g.loX).toBe(0);
  });

  it('emits three ticks, low to high, with the null labelled 1.0', () => {
    const g = markGeometry(d, { lo: 0.25, hi: 4 }, 100);
    expect(g.ticks.map((t) => t.label)).toEqual(['0.25', '1.0', '4']);
    expect(g.ticks[0]!.x).toBeLessThan(g.ticks[2]!.x);
  });

  it('handles a point-only datum without an interval', () => {
    const g = markGeometry({ ...d, lo: null, hi: null }, FIXED_DOMAIN, 100);
    expect(g.loX).toBeNull();
    expect(g.hiX).toBeNull();
    expect(g.clippedLo).toBe(false);
    expect(g.clippedHi).toBe(false);
  });

  it('never emits a coordinate outside the plot', () => {
    for (const p of [0.001, 0.25, 1, 4, 1000]) {
      const g = markGeometry({ ...d, point: p, lo: null, hi: null }, FIXED_DOMAIN, 100);
      expect(g.pointX).toBeGreaterThanOrEqual(0);
      expect(g.pointX).toBeLessThanOrEqual(100);
    }
  });
});

describe('sharedDomain', () => {
  const mk = (point: number, klass = 'surrogate'): EffectDatum => ({
    form: 'ratio', kind: 'HR', point, lo: null, hi: null, ciLevel: null, klass,
  });

  it('stays symmetric about the null', () => {
    const dom = sharedDomain([mk(0.5), mk(0.8)]);
    expect(Math.log(dom.lo)).toBeCloseTo(-Math.log(dom.hi), 5);
  });

  it('widens to hold the most extreme point estimate', () => {
    const dom = sharedDomain([mk(0.5), mk(3.5)]);
    expect(dom.hi).toBeGreaterThanOrEqual(3.5);
    expect(dom.lo).toBeLessThanOrEqual(1 / 3.5);
  });

  it('never gets tighter than 0.5x-2x, even when every effect is tiny', () => {
    const dom = sharedDomain([mk(1.01), mk(0.99)]);
    expect(dom.lo).toBeLessThanOrEqual(0.5);
    expect(dom.hi).toBeGreaterThanOrEqual(2);
  });

  it('caps at 0.1x-10x so one outlier cannot flatten the page', () => {
    const dom = sharedDomain([mk(0.5), mk(500)]);
    expect(dom.hi).toBeLessThanOrEqual(10);
  });

  it('falls back to the fixed domain with no data', () => {
    expect(sharedDomain([])).toEqual(FIXED_DOMAIN);
  });

  it('groups by endpoint class so one ruler never spans two of them', () => {
    const g = groupByKlass([mk(0.5, 'overall-survival'), mk(2, 'local-control'), mk(0.6, 'overall-survival')]);
    expect(g.get('overall-survival')).toHaveLength(2);
    expect(g.get('local-control')).toHaveLength(1);
  });
});

describe('describeEffect', () => {
  it('renders the estimate and its interval', () => {
    expect(
      describeEffect({ form: 'ratio', kind: 'HR', point: 0.53, lo: 0.38, hi: 0.74, ciLevel: 95, klass: null }),
    ).toBe('HR 0.53, 95% CI 0.38 to 0.74');
  });

  it('omits the interval when there is none', () => {
    expect(
      describeEffect({ form: 'ratio', kind: 'OR', point: 2, lo: null, hi: null, ciLevel: null, klass: null }),
    ).toBe('OR 2');
  });
});

// Corpus pass. Per the eng review this asserts NO counts — those churn every
// time a date is rebuilt, and a test that cries wolf gets muted. It fails only
// on an exception or an unsafe value, and LOGS the coverage so drift is visible
// without being enforced.
describe('corpus pass over every committed digest', () => {
  const dir = resolve(process.cwd(), 'data/digests');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('never throws, and never emits an undrawable datum', () => {
    let withEndpoint = 0;
    let drawn = 0;
    let abstained = 0;
    let clipped = 0;

    for (const f of files) {
      const artifact = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
      for (const site of artifact.digest?.sites ?? []) {
        for (const study of site.studies ?? []) {
          if (!study.primary_endpoint) continue;
          withEndpoint += 1;
          const d = parseEffectSize(study.primary_endpoint);
          if (!d) {
            abstained += 1;
            continue;
          }
          drawn += 1;

          // Anything that reaches the renderer must be drawable.
          expect(Number.isFinite(d.point)).toBe(true);
          expect(d.point).toBeGreaterThan(0);
          if (d.lo != null && d.hi != null) {
            expect(d.lo).toBeGreaterThan(0);
            expect(d.lo).toBeLessThanOrEqual(d.point);
            expect(d.point).toBeLessThanOrEqual(d.hi);
          }

          const g = markGeometry(d, FIXED_DOMAIN, 300);
          for (const v of [g.pointX, g.nullX, g.loX, g.hiX]) {
            if (v == null) continue;
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(300);
          }
          if (g.clippedLo || g.clippedHi) clipped += 1;
        }
      }
    }

    console.log(
      `  [effect-size] corpus: ${drawn} drawn, ${abstained} abstained ` +
        `of ${withEndpoint} studies with a primary endpoint (${clipped} clipped)`,
    );
    expect(files.length).toBeGreaterThan(0);
  });
});

// The eng review's decision (4A): all logic lives in this module as pure
// functions, EffectMark.astro is a dumb renderer, and ONE dist assertion proves
// the component is actually wired into a real page. This repo has no Astro
// component test harness, so this is the established pattern (see
// tag-filter-rail-drawer / publish-boundary). dist/ is guaranteed by
// test/global-setup.ts.
describe('the mark is wired into real date pages', () => {
  const root = resolve(process.cwd(), 'dist');

  function datesWithMarks(): Array<{ date: string; html: string; count: number }> {
    return readdirSync(root)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .map((date) => {
        const f = resolve(root, date, 'index.html');
        let html = '';
        try {
          html = readFileSync(f, 'utf-8');
        } catch {
          return null;
        }
        return { date, html, count: (html.match(/class="emark"/g) ?? []).length };
      })
      .filter((r): r is { date: string; html: string; count: number } => r !== null);
  }

  it('renders marks on the built date pages', () => {
    const pages = datesWithMarks();
    expect(pages.length).toBeGreaterThan(0);
    const total = pages.reduce((n, p) => n + p.count, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('draws every mark neutrally, never in verdict color', () => {
    // StudyCard.astro:1451 keeps valence in the headline number's UNDERLINE so a
    // negative HR never reads as a colored win. A verdict-colored dot on the
    // harm side of the null would contradict the card's own rule.
    const css = readFileSync(resolve(process.cwd(), 'src/components/EffectMark.astro'), 'utf-8');
    expect(css).not.toMatch(/--verdict-color/);
    expect(css).toMatch(/\.emark-point\s*\{\s*fill:\s*var\(--fg\)/);
  });

  it('reserves opacity for the SpecialtyBar by never varying it with the data', () => {
    // Imprecision is drawn as WIDTH. Encoding it as faintness would collide with
    // the specialty dimming, leaving a reader unable to tell "not your field"
    // from "weak evidence".
    const src = readFileSync(resolve(process.cwd(), 'src/components/EffectMark.astro'), 'utf-8');
    const dynamicOpacity = /opacity\s*=\s*\{|opacity:\s*\$\{/.test(src);
    expect(dynamicOpacity).toBe(false);
  });

  it('keeps tick labels at the 11px floor', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/EffectMark.astro'), 'utf-8');
    const m = src.match(/\.emark-tick[\s\S]*?font-size:\s*(\d+)px/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(11);
  });

  it('hides the mark from screen readers (the numbers are already in the text)', () => {
    const pages = datesWithMarks().filter((p) => p.count > 0);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      for (const svg of p.html.match(/<svg class="emark"[\s\S]*?<\/svg>/g) ?? []) {
        expect(svg).toContain('aria-hidden="true"');
      }
    }
  });

  it('leaves the figure column untouched — the mark is inline, not a figure', () => {
    const card = readFileSync(resolve(process.cwd(), 'src/components/StudyCard.astro'), 'utf-8');
    // The mark must sit inside the endpoint block, never in .study-figures, and
    // must not participate in the has-figures two-column grid.
    const markLine = card.split('\n').find((l) => l.includes('<EffectMark'));
    expect(markLine).toBeDefined();
    const idx = card.indexOf('<EffectMark');
    const endpointOpen = card.indexOf('<div class="study-endpoint">');
    const figuresOpen = card.indexOf('<div class="study-figures">');
    expect(endpointOpen).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(endpointOpen);
    if (figuresOpen > -1) expect(idx).toBeLessThan(figuresOpen);
  });

  it('shares one axis per date, and does not leak it to other surfaces', () => {
    const datePage = readFileSync(resolve(process.cwd(), 'src/pages/[date].astro'), 'utf-8');
    expect(datePage).toContain('sharedDomain');
    expect(datePage).toContain('effectDomain=');
    // Site / tag / study pages must NOT pass a domain, or the same study would
    // change size depending on which page you found it on.
    for (const f of ['src/pages/sites/[site].astro', 'src/pages/study/[slug].astro', 'src/pages/tags/[...slug].astro']) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      expect(src).not.toContain('effectDomain');
    }
  });
});
