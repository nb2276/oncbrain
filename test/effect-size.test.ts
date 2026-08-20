import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { domainForMark, listDigests } from '../src/lib/digest-data.ts';
import {
  parseEffectSize,
  parsePairedValues,
  parsePairedFromTable,
  armColumns,
  pairedGeometry,
  effectForStudy,
  markGeometry,
  barSpan,
  sharedDomain,
  corpusDomains,
  axisBucket,
  endpointFamily,
  domainFor,
  describeEffect,
  FIXED_DOMAIN,
  type EffectDatum,
  type PairedDatum,
  type RatioDatum,
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
  const d: EffectDatum = { form: 'ratio', kind: 'HR', point: 0.5, lo: 0.4, hi: 0.8, ciLevel: 95, klass: null, endpointName: null };

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
  const mk = (point: number): RatioDatum => ({
    form: 'ratio', kind: 'HR', point, lo: null, hi: null, ciLevel: null,
    klass: 'surrogate', endpointName: null,
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

  // The old hard 10x cap could produce a domain that did NOT contain a point it
  // was built from; the renderer then silently drew nothing. Containment wins.
  it('always contains every estimate, however extreme', () => {
    for (const extreme of [12, 25, 140, 500]) {
      const dom = sharedDomain([mk(0.5), mk(extreme)]);
      expect(extreme).toBeLessThan(dom.hi);
      expect(0.5).toBeGreaterThan(dom.lo);
    }
  });

  it('falls back to the fixed domain with no data', () => {
    expect(sharedDomain([])).toEqual(FIXED_DOMAIN);
  });
});

describe('barSpan', () => {
  const DOM = { lo: 1 / 3, hi: 3 };
  const mk = (point: number, lo: number | null, hi: number | null): RatioDatum => ({
    form: 'ratio', kind: 'HR', point, lo, hi, ciLevel: 95,
    klass: 'surrogate', endpointName: 'Overall survival',
  });

  it('abstains when the source reported no interval', () => {
    expect(barSpan(markGeometry(mk(0.6, null, null), DOM, 560), 16)).toBeNull();
  });

  it('insets a clipped end to make room for the continuation mark', () => {
    const g = markGeometry(mk(1.4, 0.22, 11.7), DOM, 560);
    const span = barSpan(g, 16)!;
    expect(span.left).toBe(g.loX! + 16);
    expect(span.right).toBe(g.hiX! - 16);
  });

  it('leaves an unclipped end exactly on its bound', () => {
    const g = markGeometry(mk(0.6, 0.5, 0.8), DOM, 560);
    const span = barSpan(g, 16)!;
    expect(span.left).toBe(g.loX);
    expect(span.right).toBe(g.hiX);
  });

  // The regression the affordable-inset rule exists for: a short bar inset by
  // the full chevron width gets drawn to the RIGHT of its own upper bound, which
  // shows a magnitude the data does not support.
  it('never draws the bar outside the interval it represents', () => {
    for (const [point, lo, hi] of [
      [0.34, 0.1, 0.35], [0.35, 0.2, 0.36], [2.9, 2.85, 20], [1.0, 0.3, 3.2],
      [0.4, 0.05, 0.42], [1.4, 0.22, 11.7], [0.6, 0.5, 0.8],
    ] as const) {
      const g = markGeometry(mk(point, lo, hi), DOM, 560);
      const span = barSpan(g, 16)!;
      expect(span.left).toBeGreaterThanOrEqual(g.loX!);
      expect(span.right).toBeLessThanOrEqual(g.hiX!);
      expect(span.left).toBeLessThanOrEqual(span.right);
    }
  });
});

describe('describeEffect', () => {
  it('renders the estimate and its interval', () => {
    expect(
      describeEffect({ form: 'ratio', kind: 'HR', point: 0.53, lo: 0.38, hi: 0.74, ciLevel: 95, klass: null, endpointName: null }),
    ).toBe('HR 0.53, 95% CI 0.38 to 0.74');
  });

  it('omits the interval when there is none', () => {
    expect(
      describeEffect({ form: 'ratio', kind: 'OR', point: 2, lo: null, hi: null, ciLevel: null, klass: null, endpointName: null }),
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
    let paired = 0;
    let abstained = 0;
    let clipped = 0;

    for (const f of files) {
      const artifact = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
      for (const site of artifact.digest?.sites ?? []) {
        for (const study of site.studies ?? []) {
          if (!study.primary_endpoint) continue;
          withEndpoint += 1;
          const tables = (study.details ?? [])
            .filter((x: unknown) => x && typeof x === 'object' && 'table' in (x as object))
            .map((x: { table: unknown }) => x.table);
          const d = effectForStudy(study.primary_endpoint, tables as never[]);
          if (!d) {
            abstained += 1;
            continue;
          }
          drawn += 1;

          if (d.form === 'paired') {
            paired += 1;
            for (const v of [d.a.value, d.b.value]) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
            }
            const pg = pairedGeometry(d, 200);
            for (const v of [pg.aW, pg.bW]) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(200);
            }
            // Labels are all-or-nothing: one named arm and one blank reads as if
            // only one side were identified.
            expect(d.a.label === null).toBe(d.b.label === null);
            continue;
          }

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
      `  [effect-size] corpus: ${drawn} drawn (${drawn - paired} ratio, ${paired} paired), ` +
        `${abstained} abstained of ${withEndpoint} with a primary endpoint (${clipped} clipped)`,
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

  // Slice 3 replaced per-page axes with ONE corpus-wide ruler per class+kind.
  // No page may pass a domain any more: if one did, that page's marks would
  // stop matching the same study everywhere else.
  it('lets no page pass its own axis domain', () => {
    for (const f of [
      'src/pages/[date].astro',
      'src/pages/sites/[site].astro',
      'src/pages/study/[slug].astro',
      'src/pages/tags/[...slug].astro',
      'src/pages/studies.astro',
    ]) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      expect(src).not.toContain('effectDomain');
    }
  });

  // The guarantee the shared helper exists to make: a ruler ALWAYS contains the
  // estimate it is drawn against, so the mark actually draws. The corpus map is
  // keyed by endpoint family, so a first-of-its-kind endpoint has no bucket at
  // all; the OG route had dropped the per-datum fallback and would have rendered
  // nothing for one. Asserted as a property over the whole real corpus plus a
  // novel endpoint, so it cannot go stale as the corpus grows into new buckets.
  it('always yields a ruler that contains the estimate', () => {
    // Deliberately EXTREME: an estimate that already fits the default window
    // would pass under any fallback at all, and prove nothing.
    const novel: RatioDatum = {
      form: 'ratio', kind: 'HR', point: 5.34, lo: 2.05, hi: 13.88, ciLevel: 95,
      klass: 'surrogate', endpointName: 'Some entirely novel endpoint nobody has published',
    };
    const corpus: RatioDatum[] = [];
    for (const artifact of listDigests()) {
      for (const site of artifact.digest.sites) {
        for (const study of site.studies) {
          const d = parseEffectSize(study.primary_endpoint);
          if (d) corpus.push(d);
        }
      }
    }
    expect(corpus.length).toBeGreaterThan(0); // the property must have subjects
    for (const d of [...corpus, novel]) {
      expect(markGeometry(d, domainForMark(d), 100).pointOffScale).toBe(false);
    }
  });

  it('resolves the ruler from the corpus, inside the card', () => {
    const card = readFileSync(resolve(process.cwd(), 'src/components/StudyCard.astro'), 'utf-8');
    expect(card).toContain('domainForMark(');
    // and does NOT resolve the ruler itself: that duplication is what let the
    // OG route drift away from the card.
    expect(card).not.toContain('effectDomains()');
  });
});

// Findings from the ship adversarial pass. All four were real; two would have
// drawn a confidently wrong picture from clinical data.
describe('adversarial regressions', () => {
  // HIGH: a point estimate outside the domain used to be clamped to the axis
  // edge, so a real corpus value (OR 5.34) rendered as if it were 4.0.
  it('flags an off-scale POINT estimate rather than clamping it silently', () => {
    const or: EffectDatum = { form: 'ratio', kind: 'OR', point: 5.34, lo: 2.05, hi: 13.88, ciLevel: 95, klass: null, endpointName: null };
    const g = markGeometry(or, FIXED_DOMAIN, 100);
    expect(g.pointOffScale).toBe(true);
  });

  it('gives a single mark a domain that actually contains its estimate', () => {
    const or: EffectDatum = { form: 'ratio', kind: 'OR', point: 5.34, lo: 2.05, hi: 13.88, ciLevel: 95, klass: null, endpointName: null };
    const dom = domainFor(or);
    expect(or.point).toBeGreaterThan(dom.lo);
    expect(or.point).toBeLessThan(dom.hi);
    expect(markGeometry(or, dom, 100).pointOffScale).toBe(false);
  });

  it('gives the same study the same domain on every non-date surface', () => {
    const d: EffectDatum = { form: 'ratio', kind: 'HR', point: 0.53, lo: 0.38, hi: 0.74, ciLevel: 95, klass: 'x', endpointName: null };
    expect(domainFor(d)).toEqual(domainFor({ ...d }));
  });

  // HIGH: containment alone can't prove association. Here the RATE's CI happens
  // to contain the HR, so pairing them would draw a confidently wrong interval.
  it('refuses a CI it cannot unambiguously associate with the ratio', () => {
    const d = parseEffectSize(
      pe('HR 0.70', '12-mo PFS 0.70 (95% CI 0.60-0.80); HR 95% CI 0.50-0.95'),
    );
    // The estimate is still trustworthy; the interval is not, so it drops to
    // point-only rather than drawing the wrong bar.
    expect(d).toMatchObject({ point: 0.7, lo: null, hi: null });
  });

  it('still accepts an adjacent parenthetical CI when other CIs exist', () => {
    const d = parseEffectSize(
      pe('mDFS 52.7 vs 24.4 mo', 'HR 0.750 (95% CI 0.607-0.928); 3-yr rate 61% (95% CI 55-67)'),
    );
    expect(d).toMatchObject({ point: 0.75, lo: 0.607, hi: 0.928 });
  });

  // LOW: an exported function should not emit NaN because a caller passed junk.
  it('never emits NaN or Infinity on a degenerate domain or width', () => {
    const d: EffectDatum = { form: 'ratio', kind: 'HR', point: 0.5, lo: 0.4, hi: 0.8, ciLevel: 95, klass: null, endpointName: null };
    for (const dom of [{ lo: 0, hi: 4 }, { lo: 4, hi: 0.25 }, { lo: NaN, hi: 4 }, { lo: 1, hi: 1 }]) {
      for (const w of [0, -5, NaN, 100]) {
        const g = markGeometry(d, dom as never, w);
        for (const v of [g.pointX, g.nullX, g.loX, g.hiX]) {
          if (v == null) continue;
          expect(Number.isFinite(v)).toBe(true);
        }
        for (const t of g.ticks) expect(Number.isFinite(t.x)).toBe(true);
      }
    }
  });
});

describe('the axis never pools incomparable quantities', () => {
  it('keys a ruler by endpoint class AND ratio kind', () => {
    // An odds ratio and a hazard ratio are not interchangeable, so sharing a
    // ruler because they describe the same endpoint class would be wrong.
    const src = readFileSync(resolve(process.cwd(), 'src/lib/effect-size.ts'), 'utf-8');
    expect(src).toMatch(/axisBucket[\s\S]{0,300}endpointFamily[\s\S]{0,80}kind/);
  });
});

// ── slice 2 ─────────────────────────────────────────────────────────────────

describe('parsePairedValues — two-value comparisons', () => {
  it.each([
    ['28% vs 21%', 28, 21, '%'],
    ['1.5% vs 9.8%', 1.5, 9.8, '%'],
    ['61.0% vs 28.6%', 61, 28.6, '%'],
    ['19% vs 61%', 19, 61, '%'],
    ['15.8 vs 12.3 mo', 15.8, 12.3, 'mo'],
  ])('reads %s', (v, a, b, unit) => {
    expect(parsePairedValues(pe(v))).toMatchObject({
      form: 'paired', a: { value: a }, b: { value: b }, unit, origin: 'endpoint',
    });
  });

  it('uses arm names when the source states them', () => {
    expect(parsePairedValues(pe('7% vs 7.4% (AHRT vs EHRT)'))).toMatchObject({
      a: { label: 'AHRT', value: 7 }, b: { label: 'EHRT', value: 7.4 },
    });
  });

  // A trailing "(A vs B)" is arm names, not a third arm. Counting every "vs"
  // made this abstain on a perfectly good two-arm study.
  it('does not mistake an arm parenthetical for a third arm', () => {
    expect(parsePairedValues(pe('7% vs 7.4% (AHRT vs EHRT)'))).not.toBeNull();
  });

  // Asymmetric labels read as if only one arm were identified.
  it('drops BOTH labels when only one side is a real name', () => {
    const d = parsePairedValues(pe('8.0% vs 9.4% (40 vs 50Gy)'));
    expect(d).toMatchObject({ a: { value: 8 }, b: { value: 9.4 } });
    expect(d!.a.label).toBeNull();
    expect(d!.b.label).toBeNull();
  });

  it.each([
    ['three arms cannot be two bars', '3.5% vs 3.7% vs 5.5% at 10yr'],
    ['not-reached has no position on a linear axis', 'NR vs 17 mo'],
    ['prose', 'No between-arm difference'],
    ['a single value', '100% at 36, 60, and 84 mo'],
    ['a stated difference, not two values', '68.9 mm³ more plaque with leuprolide vs relugolix'],
  ])('abstains: %s', (_l, v) => {
    expect(parsePairedValues(pe(v))).toBeNull();
  });

  it('abstains when both values are zero (two empty bars carry nothing)', () => {
    expect(parsePairedValues(pe('0% vs 0%'))).toBeNull();
  });
});

describe('armColumns — the positive table gate', () => {
  const t = (columns: string[]) => ({ columns, rows: [] });

  // Every one of these is a REAL header from the corpus and a real two-arm table.
  it.each([
    [['Endpoint', 'Arm A', 'Arm B', 'p']],
    [['Endpoint', 'Sequential (n=1,118)', 'Concurrent (n=1,137)']],
    [['Endpoint (20yr)', 'IM-MS-RT', 'Control', 'HR (95% CI), p']],
    [['Endpoint', 'RT', 'Obs', 'HR (95% CI)']],
    [['Endpoint (2y)', 'Adjuvant RT', 'Observation', 'HR (95% CI), p']],
  ])('accepts a genuine arm table: %j', (cols) => {
    expect(armColumns(t(cols as string[]))).not.toBeNull();
  });

  // Every one of these is a REAL header from the corpus that a SHAPE parser
  // would have drawn as two arms. Each would be a clinically wrong picture.
  it.each([
    ['two different TRIALS', ['Endpoint', 'POP-RT', 'PEACE-2']],
    ['disease-stage cohorts', ['Cohort', 'BCLC-0', 'BCLC-A']],
    ['anatomic sites', ['Setting', 'Lower-limb LE', 'Genital LE']],
    ['subgroups', ['Menopausal status', 'IDFS HR', '95% CI', 'p']],
    ['a study list', ['Study', 'Design', 'Signal']],
    ['a regimen spec', ['Arm', 'Dose / fractionation', 'Boost / technique']],
    ['a modality comparison', ['Modality + reconstruction', 'n', '2-yr CC rate']],
    ['a subgroup slice of one endpoint', ['Endpoint (never/former smokers)', 'A (n=10)', 'B (n=10)']],
  ])('rejects %s', (_label, cols) => {
    expect(armColumns(t(cols as string[]))).toBeNull();
  });

  it('rejects when only statistics remain after dropping stat columns', () => {
    expect(armColumns(t(['Endpoint', 'HR (95% CI)', 'p']))).toBeNull();
  });

  it('requires POSITIVE evidence, not merely the absence of a red flag', () => {
    // Two unfamiliar acronyms could be arms or could be trials. Without an n=,
    // an "Arm X" or a control-like name, we do not guess.
    expect(armColumns(t(['Endpoint', 'FOO-1', 'BAR-2']))).toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    expect(armColumns(null)).toBeNull();
    expect(armColumns(undefined)).toBeNull();
    expect(armColumns({ columns: 'nope' } as never)).toBeNull();
    expect(armColumns({ columns: ['Endpoint'] })).toBeNull();
  });
});

describe('parsePairedFromTable', () => {
  const table = {
    columns: ['Endpoint', 'Sequential (n=1,118)', 'Concurrent (n=1,137)'],
    rows: [['5-yr IBR', '2.1%', '1.9%'], ['5-yr OS', '90%', '91%']],
  };

  it('reads the row matching the study primary endpoint', () => {
    const d = parsePairedFromTable({ name: '5-yr IBR', klass: 'local-control' }, table);
    expect(d).toMatchObject({
      form: 'paired', origin: 'table', unit: '%',
      a: { label: 'Sequential (n=1,118)', value: 2.1 },
      b: { label: 'Concurrent (n=1,137)', value: 1.9 },
    });
  });

  it('returns null when no row matches the endpoint name', () => {
    expect(parsePairedFromTable({ name: 'Distant recurrence' }, table)).toBeNull();
  });

  it('never reads a table the gate rejected', () => {
    const trials = { columns: ['Endpoint', 'POP-RT', 'PEACE-2'], rows: [['bFFS', '50%', '60%']] };
    expect(parsePairedFromTable({ name: 'bFFS' }, trials)).toBeNull();
  });

  it('skips a cell holding a ratio or an interval rather than a plain value', () => {
    const withHr = {
      columns: ['Endpoint', 'Arm A', 'Arm B', 'p'],
      rows: [['OS', 'HR 0.80', '1.0']],
    };
    expect(parsePairedFromTable({ name: 'OS' }, withHr)).toBeNull();
  });
});

describe('pairedGeometry', () => {
  const mk = (a: number, b: number, unit: string | null = '%'): PairedDatum => ({
    form: 'paired', a: { label: null, value: a }, b: { label: null, value: b },
    unit, klass: null, origin: 'endpoint',
  });

  // Anchoring anywhere but zero exaggerates small differences — the classic
  // misleading bar chart.
  it('is anchored at zero, so bar length is proportional to value', () => {
    const g = pairedGeometry(mk(50, 25), 200);
    expect(g.aW / g.bW).toBeCloseTo(2, 5);
  });

  it('scales percentages against 100 so two cards are comparable', () => {
    expect(pairedGeometry(mk(7, 7.4), 200).max).toBe(100);
  });

  it('scales a non-percentage unit to its own peak', () => {
    expect(pairedGeometry(mk(15.8, 12.3, 'mo'), 200).max).toBeCloseTo(15.8 * 1.05, 5);
  });

  it('never emits a negative or over-wide bar', () => {
    for (const w of [0, -10, NaN, 200]) {
      const g = pairedGeometry(mk(120, 0), w);
      for (const v of [g.aW, g.bW]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('effectForStudy precedence', () => {
  it('prefers a ratio, which carries an interval and a null reference', () => {
    const d = effectForStudy(pe('61.0% vs 61.8%', 'HR=1.00; 95% CI 0.90-1.10'));
    expect(d?.form).toBe('ratio');
  });

  it('falls back to paired values when there is no ratio', () => {
    expect(effectForStudy(pe('28% vs 21%'))?.form).toBe('paired');
  });

  it('only reaches a table when the endpoint itself yields nothing', () => {
    const table = {
      columns: ['Endpoint', 'Arm A', 'Arm B', 'p'],
      rows: [['W14 good response', '65%', '88%', '0.004']],
    };
    const d = effectForStudy({ name: 'W14 good response', klass: 'surrogate', stat_value: 'No between-arm difference' }, [table]);
    expect(d).toMatchObject({ form: 'paired', origin: 'table' });
  });

  it('returns null when nothing is drawable', () => {
    expect(effectForStudy(pe('Not yet mature'), [])).toBeNull();
  });
});

describe('paired bars carry no valence', () => {
  it('uses one neutral fill for both bars', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/EffectMark.astro'), 'utf-8');
    // klass cannot tell us direction: local-control covers both "local control
    // 95% vs 88%" (higher better) and "local recurrence 5% vs 12%" (lower
    // better). So neither bar is marked better.
    expect(src).toMatch(/\.emark-bar\s*\{\s*fill:\s*var\(--fg\)/);
    expect(src).not.toMatch(/emark-bar--(good|bad|better|worse|harm)/);
    expect(src).not.toMatch(/--verdict-color/);
  });
});

// Slice 2 adversarial pass. All three were reproduced against the real code
// before fixing; each would have drawn a confidently wrong clinical picture.
describe('slice 2 adversarial regressions', () => {
  // Bare substring matching in both directions: "OS" is inside "Dose", and the
  // unanchored cell regex read "50 Gy" as 50 — so an overall-survival endpoint
  // rendered a RADIOTHERAPY DOSE as its result.
  it('does not match a short endpoint name inside an unrelated row label', () => {
    const t = { columns: ['Endpoint', 'Arm A', 'Arm B', 'p'], rows: [['Dose', '50 Gy', '40 Gy', '0.4']] };
    expect(parsePairedFromTable({ name: 'OS', klass: 'overall-survival' }, t)).toBeNull();
  });

  it('still matches a full endpoint name exactly', () => {
    const t = { columns: ['Endpoint', 'Arm A', 'Arm B', 'p'], rows: [['OS', '60%', '55%', '0.4']] };
    expect(parsePairedFromTable({ name: 'OS' }, t)).toMatchObject({ a: { value: 60 }, b: { value: 55 } });
  });

  it('reads only a whole-cell plain value, never a dose or a compound cell', () => {
    for (const cell of ['50 Gy', '2/236', '61.0% (55-67)', 'HR 0.80', 'n/a']) {
      const t = { columns: ['Endpoint', 'Arm A', 'Arm B', 'p'], rows: [['Overall survival', cell, '40%', 'x']] };
      expect(parsePairedFromTable({ name: 'Overall survival' }, t)).toBeNull();
    }
  });

  // Two trials both report an n, so "(n=...)" alone cannot identify a
  // randomised comparison.
  it('rejects trial-vs-trial even when both columns carry an n', () => {
    expect(armColumns({ columns: ['Endpoint', 'POP-RT (n=500)', 'PEACE-2 (n=600)'], rows: [] })).toBeNull();
  });

  it('still accepts real arm names carrying an n', () => {
    expect(armColumns({ columns: ['Endpoint', 'Sequential (n=1,118)', 'Concurrent (n=1,137)'], rows: [] })).not.toBeNull();
  });

  it('still accepts an acronym arm when the other column is a comparator', () => {
    // IM-MS-RT is acronym-shaped, but "Control" identifies the comparison.
    expect(armColumns({ columns: ['Endpoint (20yr)', 'IM-MS-RT', 'Control', 'HR (95% CI), p'], rows: [] })).not.toBeNull();
  });

  // Two different stated units are not two measurements of one endpoint.
  it('abstains when the two values carry different units', () => {
    expect(parsePairedValues(pe('28% vs 21 mo'))).toBeNull();
    expect(parsePairedValues(pe('15.8 mo vs 12%'))).toBeNull();
  });

  it('still accepts a unit stated on only one side', () => {
    expect(parsePairedValues(pe('15.8 vs 12.3 mo'))).toMatchObject({ unit: 'mo' });
  });
});

// ── slice 3: one corpus-wide ruler per class+kind ───────────────────────────

describe('snapped domains', () => {
  const mk = (point: number, klass = 'surrogate', kind: 'HR' | 'OR' = 'HR'): RatioDatum => ({
    form: 'ratio', kind, point, lo: null, hi: null, ciLevel: null, klass, endpointName: null,
  });

  it('snaps the bound to the ladder, giving readable ticks', () => {
    // Unsnapped this produced bounds like 2.87 and 3.34, which read as noise.
    for (const d of [sharedDomain([mk(1.38)]), sharedDomain([mk(1.55)]), sharedDomain([mk(5.34)])]) {
      expect([1.5, 2, 3, 4, 5, 7, 10]).toContain(d.hi);
    }
  });

  it('stays exactly symmetric about the null', () => {
    const d = sharedDomain([mk(0.35), mk(1.38)]);
    expect(d.lo).toBeCloseTo(1 / d.hi, 12);
  });

  // Stability is the whole point of snapping: without it every new study nudges
  // the domain and silently redraws every older card in its bucket.
  it('does not move when a new study lands inside the current rung', () => {
    const before = sharedDomain([mk(0.5), mk(1.4)]);
    const after = sharedDomain([mk(0.5), mk(1.4), mk(0.9), mk(1.2), mk(0.7)]);
    expect(after).toEqual(before);
  });

  it('does move when a genuinely new extreme crosses a rung', () => {
    const before = sharedDomain([mk(0.5)]);
    const after = sharedDomain([mk(0.5), mk(6.2)]);
    expect(after.hi).toBeGreaterThan(before.hi);
  });

  it('still contains every point estimate it was built from', () => {
    const points = [0.35, 0.48, 1.38, 5.34];
    const d = sharedDomain(points.map((p) => mk(p)));
    for (const p of points) {
      expect(p).toBeGreaterThan(d.lo);
      expect(p).toBeLessThan(d.hi);
    }
  });
});

describe('corpusDomains', () => {
  const mk = (point: number, endpointName: string, kind: 'HR' | 'OR' | 'SHR' = 'HR'): RatioDatum => ({
    form: 'ratio', kind, point, lo: null, hi: null, ciLevel: null, klass: 'surrogate', endpointName,
  });

  it('keys a ruler by endpoint FAMILY and ratio kind', () => {
    const m = corpusDomains([
      mk(0.5, 'Overall survival'),
      mk(5.3, 'Biochemical response', 'OR'),
      mk(0.6, 'Overall survival'),
    ]);
    expect(m.has('os::HR')).toBe(true);
    expect(m.has('biochemical::OR')).toBe(true);
    // An odds ratio must never widen a hazard-ratio ruler.
    expect(m.get('os::HR')!.hi).toBeLessThan(m.get('biochemical::OR')!.hi);
  });

  // The objection this bucketing exists to answer: "surrogate" pooled PFS, MFS
  // and DFS, which share a unit but are not the same quantity.
  it('does not pool MFS, DFS and PFS onto one ruler', () => {
    const m = corpusDomains([
      mk(0.5, 'Metastasis-free survival'),
      mk(0.6, 'Disease-free survival'),
      mk(0.7, 'Progression-free survival'),
    ]);
    expect([...m.keys()].sort()).toEqual(['dfs::HR', 'mfs::HR', 'pfs::HR']);
  });

  // But assessment variants of ONE endpoint do belong together, or the ruler
  // degenerates to one per card and buys nothing.
  it('keeps PFS assessment variants on one ruler', () => {
    const m = corpusDomains([
      mk(0.5, 'Progression-free survival'),
      mk(0.6, 'Imaging-based progression-free survival'),
      mk(0.7, 'Progression-free survival (BICR)'),
      mk(0.8, 'Clinical progression-free survival'),
    ]);
    expect([...m.keys()]).toEqual(['pfs::HR']);
  });

  it('gives every mark in a bucket the same ruler', () => {
    const rows = [mk(0.4, 'Overall survival'), mk(1.2, 'Overall survival'), mk(0.9, 'Overall survival')];
    const m = corpusDomains(rows);
    const domains = rows.map((r) => m.get(axisBucket(r)));
    expect(new Set(domains.map((d) => `${d!.lo}:${d!.hi}`)).size).toBe(1);
  });

  it('returns an empty map for no data rather than throwing', () => {
    expect(corpusDomains([]).size).toBe(0);
  });
});

describe('endpointFamily', () => {
  it.each([
    ['Overall survival', 'os'],
    ['Metastasis-free survival', 'mfs'],
    ['Disease-free survival (co-primary)', 'dfs'],
    ['Progression-free survival (BICR)', 'pfs'],
    ['Imaging-based progression-free survival', 'pfs'],
    ['Intracranial PFS', 'pfs'],
    ['Biochemical failure (Phoenix)', 'biochemical'],
    ['Pathologic complete response', 'response'],
    ['Arm lymphedema at 3 years', 'toxicity'],
  ])('maps %s to %s', (name, family) => {
    expect(endpointFamily(name)).toBe(family);
  });

  // Order matters: a locoregional recurrence endpoint is LOCAL control, and
  // must not fall through to the generic recurrence family.
  it('claims locoregional endpoints before the generic recurrence rule', () => {
    expect(endpointFamily('2-year locoregional recurrence-free survival')).toBe('local');
    expect(endpointFamily('Loco-regional recurrence-free survival')).toBe('local');
    expect(endpointFamily('Ipsilateral breast tumour recurrence')).toBe('recurrence');
  });

  it('falls back rather than guessing', () => {
    expect(endpointFamily('')).toBe('unknown');
    expect(endpointFamily(null)).toBe('unknown');
    expect(endpointFamily('Some entirely novel endpoint')).toBe('other');
  });
});

// The property this slice exists to guarantee, asserted against the real build.
describe('a study renders identically on every surface', () => {
  function marksIn(file: string): Map<string, string> {
    const doc = readFileSync(resolve(process.cwd(), file), 'utf-8');
    const out = new Map<string, string>();
    for (const m of doc.match(/<svg class="emark"[\s\S]*?<\/svg>/g) ?? []) {
      const title = /<title>(.*?)<\/title>/.exec(m)?.[1];
      const cx = /class="emark-point" cx="([\d.]+)"/.exec(m)?.[1];
      const ticks = [...m.matchAll(/class="emark-tick"[^>]*>([^<]*)</g)].map((t) => t[1]).join('/');
      if (title && cx) out.set(title, `${cx}|${ticks}`);
    }
    return out;
  }

  it('draws the same mark at the same position on a date page and a site page', () => {
    const dates = readdirSync(resolve(process.cwd(), 'dist')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const sites = readdirSync(resolve(process.cwd(), 'dist/sites')).filter((d) =>
      existsSync(resolve(process.cwd(), 'dist/sites', d, 'index.html')));
    const siteMarks = new Map<string, string>();
    for (const s of sites) for (const [k, v] of marksIn(`dist/sites/${s}/index.html`)) siteMarks.set(k, v);

    let compared = 0;
    for (const d of dates) {
      const f = `dist/${d}/index.html`;
      if (!existsSync(resolve(process.cwd(), f))) continue;
      for (const [title, render] of marksIn(f)) {
        const onSite = siteMarks.get(title);
        if (!onSite) continue;
        compared += 1;
        // Same numbers, same ruler, same pixel — no "which page am I on?" drift.
        expect(onSite).toBe(render);
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('never pools two ratio kinds onto one ruler in the built output', () => {
    const doc = readFileSync(resolve(process.cwd(), 'dist/sites/prostate/index.html'), 'utf-8');
    const byRuler = new Map<string, Set<string>>();
    for (const m of doc.match(/<svg class="emark"[\s\S]*?<\/svg>/g) ?? []) {
      const title = /<title>(.*?)<\/title>/.exec(m)?.[1] ?? '';
      const kind = /^(HR|OR|RR|SHR)\b/.exec(title)?.[1];
      const ticks = [...m.matchAll(/class="emark-tick"[^>]*>([^<]*)</g)].map((t) => t[1]).join('/');
      if (!kind || !ticks) continue;
      byRuler.set(ticks, (byRuler.get(ticks) ?? new Set()).add(kind));
    }
    expect(byRuler.size).toBeGreaterThan(0);
    for (const kinds of byRuler.values()) expect(kinds.size).toBe(1);
  });
});

// An interval is written both ways, and the "95% CI" label is not always carried
// into a card's stat_detail. NRG-GU005 publishes "adjusted HR 1.40 (0.91-2.13),
// P=.12", which drew a dot with NO error bar — on the one card where the
// interval crossing 1.0 is the finding (SBRT not superior).
describe('unlabelled parenthetical interval', () => {
  const pe = (stat_value: string, stat_detail: string) => ({
    name: 'Disease-free survival at 3 years',
    klass: 'surrogate' as const,
    stat_value,
    stat_detail,
  });

  it('reads the bare bracket that directly follows a ratio', () => {
    const d = parseEffectSize(
      pe('88.6% vs 92.1%', 'SBRT not superior; adjusted HR 1.40 (0.91-2.13), P=.12'),
    );
    expect(d).toMatchObject({ form: 'ratio', kind: 'HR', point: 1.4, lo: 0.91, hi: 2.13 });
  });

  it('leaves ciLevel null — the source never stated one', () => {
    // Inventing "95%" would assert something the paper did not say.
    expect(parseEffectSize(pe('', 'HR 1.40 (0.91-2.13)'))!.ciLevel).toBeNull();
  });

  it('accepts an en-dash range', () => {
    expect(parseEffectSize(pe('', 'HR 1.40 (0.91–2.13)'))).toMatchObject({ lo: 0.91, hi: 2.13 });
  });

  it('does not change a labelled interval', () => {
    const d = parseEffectSize(pe('HR 0.54', '95% CI 0.41-0.72'));
    expect(d).toMatchObject({ point: 0.54, lo: 0.41, hi: 0.72, ciLevel: 95 });
  });

  describe('only in the ADJACENT position', () => {
    // Without the "95% CI" token this is just "two numbers in brackets", which
    // also matches a dose range, an IQR or a date span. Directly after a ratio
    // and containing it, it is unambiguous; anywhere else it is a guess.
    it('ignores a bracket that does not directly follow the ratio', () => {
      const d = parseEffectSize(pe('', 'HR 0.70; 12-mo PFS 0.70 (0.60-0.80)'));
      expect(d).toMatchObject({ point: 0.7, lo: null, hi: null });
    });

    it('ignores a dose range sitting near a ratio', () => {
      const d = parseEffectSize(pe('', 'HR 1.40 for RT (60-70 Gy)'));
      expect(d).toMatchObject({ point: 1.4, lo: null, hi: null });
    });

    it('ignores a parenthetical that is not a numeric range', () => {
      const d = parseEffectSize(pe('', 'HR 1.40 (P=0.12)'));
      expect(d).toMatchObject({ point: 1.4, lo: null, hi: null });
    });
  });

  describe('a failed check means different things labelled vs not', () => {
    it('ABSTAINS entirely when a LABELLED CI cannot contain the estimate', () => {
      // Corrupt or mis-paired data. An estimate whose stated CI makes no sense
      // is worse to draw than nothing.
      expect(parseEffectSize(pe('', 'HR 1.40 (95% CI 2.10-3.20)'))).toBeNull();
      expect(parseEffectSize(pe('', 'HR 1.40 (95% CI 2.13-0.91)'))).toBeNull();
    });

    it('draws the POINT when an unlabelled bracket cannot contain the estimate', () => {
      // That is evidence the bracket was never a confidence interval — not
      // evidence the estimate is bad. A misread bracket must not delete a mark.
      expect(parseEffectSize(pe('', 'HR 1.40 (2.10-3.20)'))).toMatchObject({
        point: 1.4,
        lo: null,
        hi: null,
      });
    });
  });
});

// describeEffect is the mark's accessible label. It used to default an unstated
// confidence level to 95%, which was harmless while every parsed interval
// carried a label — and became a fabrication the moment unlabelled brackets
// became readable. On a site whose premise is that every number is grounded,
// announcing "95% CI" for a paper that never said 95% is the exact failure mode.
describe('describeEffect never invents a confidence level', () => {
  const base = { form: 'ratio' as const, kind: 'HR' as const, klass: null, endpointName: null };

  it('names the level when the source stated it', () => {
    expect(describeEffect({ ...base, point: 0.54, lo: 0.41, hi: 0.72, ciLevel: 95 }))
      .toBe('HR 0.54, 95% CI 0.41 to 0.72');
  });

  it('carries a non-95 level through rather than normalising it', () => {
    expect(describeEffect({ ...base, point: 1.2, lo: 0.84, hi: 2.04, ciLevel: 90 }))
      .toBe('HR 1.2, 90% CI 0.84 to 2.04');
  });

  it('says "interval" when the source stated no level', () => {
    expect(describeEffect({ ...base, point: 1.4, lo: 0.91, hi: 2.13, ciLevel: null }))
      .toBe('HR 1.4, interval 0.91 to 2.13');
  });

  it('omits the interval entirely on a point-only estimate', () => {
    expect(describeEffect({ ...base, point: 1.4, lo: null, hi: null, ciLevel: null }))
      .toBe('HR 1.4');
  });
});
