// v0.14 T4: build-time social-preview (OG / Twitter card) image generator.
//
// Renders a 1200x630 branded card to PNG with satori (HTML/JSX -> SVG) +
// @resvg/resvg-js (SVG -> PNG), using the vendored static Newsreader instances
// so the card matches the site's serif. The card is ENTIRELY synthesized text
// (wordmark, date, headline, verdict label, handle) and never references a
// figure or slide image, so it stays inside the publish boundary by
// construction (the IP-protected pixels can't leak into a text card). The pure
// card-builders are exported separately from the renderer so the content can be
// unit-tested without rendering, and the renderer can be smoke-tested for a
// valid PNG.
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERDICT_META, VERDICT_COLOR } from './verdict.ts';
import { stripStudyNamePrefix, type StudyVerdict } from './digest-data.ts';
import {
  markGeometry,
  type EffectDatum,
  type AxisDomain,
} from './effect-size.ts';

const W = 1200;
const H = 630;
const BG = '#f7f5f0';
const FG = '#1a1a1a';
const MUTED = '#6b6760';
const BORDER = '#e3ded3';
const SITE = 'oncbrain.oncologytoolkit.com';

// Lazily read + cache the two static Newsreader TTFs (vendored, OFL). satori
// cannot parse the variable woff2 the site ships, hence the static instances.
type SatoriFont = { name: string; data: Buffer; weight: 400 | 700; style: 'normal' };
let _fonts: SatoriFont[] | null = null;
function fonts(): SatoriFont[] {
  if (!_fonts) {
    // These endpoints only run at build time (prerendered), where cwd is the
    // project root. Reading from the SOURCE dir avoids the bundled-module
    // import.meta.url problem (the chunk lands in dist/.prerender/ with no font
    // beside it). The vitest runner also has cwd = project root.
    const dir = resolve(process.cwd(), 'src/assets/og-fonts');
    _fonts = [
      { name: 'Newsreader', data: readFileSync(resolve(dir, 'Newsreader-Regular.ttf')), weight: 400, style: 'normal' },
      { name: 'Newsreader', data: readFileSync(resolve(dir, 'Newsreader-Bold.ttf')), weight: 700, style: 'normal' },
    ];
  }
  return _fonts;
}

export interface ShareCard {
  // Small line above the headline (date · conference, or site · count).
  eyebrow?: string;
  // The big serif headline.
  headline: string;
  // Bottom-left label (verdict in its color, or a study-count tag). Already
  // upper-cased by the builders; the renderer does not transform it.
  tagLabel?: string;
  tagColor?: string;
  // Curator handle for the bottom-right attribution.
  handle?: string;
  // v0.26 (E2): true when the study has ≥1 figure-sourced number (Thread 1). The
  // trust signal on the surface that travels. Absence is NOT a negative signal
  // (a card with no figure numbers simply has nothing to vouch for) — the mark
  // is additive-positive only, matching the DESIGN.md "cards earn their pixels".
  figuresSourced?: boolean;
  // v0.36 slice 4: the effect-size mark, so a shared study link carries its
  // magnitude and not just its name. The ratio form needs its corpus ruler;
  // paired bars scale to themselves.
  effect?: { datum: EffectDatum; domain?: AxisDomain } | null;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Headline point-size shrinks as the text grows so a long top-line still fits
// the card without overflow.
export function headlineSize(s: string): number {
  const n = s.length;
  if (n <= 46) return 58;
  if (n <= 78) return 50;
  if (n <= 118) return 42;
  return 36;
}

// ── pure card builders (no rendering) ──────────────────────────────────────

export function defaultCard(handle: string): ShareCard {
  return {
    headline: 'Curated, AI-summarized oncology meeting research and published studies, by disease site.',
    handle,
  };
}

export function digestCard(opts: {
  date: string;
  topLine: string;
  conference?: string | null;
  studyCount: number;
  siteCount: number;
  handle: string;
}): ShareCard {
  const conf = opts.conference ? ` · ${opts.conference}` : '';
  const studies = `${opts.studyCount} ${opts.studyCount === 1 ? 'study' : 'studies'}`;
  const sites = `${opts.siteCount} disease ${opts.siteCount === 1 ? 'site' : 'sites'}`;
  const headline = opts.topLine?.trim() ? opts.topLine : `${studies} across ${sites}`;
  return {
    eyebrow: `${opts.date}${conf}`,
    headline,
    tagLabel: `${opts.studyCount} ${opts.studyCount === 1 ? 'STUDY' : 'STUDIES'}`,
    handle: opts.handle,
  };
}

export function siteCard(opts: {
  label: string;
  headline: string;
  count: number;
  handle: string;
}): ShareCard {
  return {
    eyebrow: `${opts.label} · ${opts.count} ${opts.count === 1 ? 'study' : 'studies'}`,
    headline: opts.headline?.trim() ? opts.headline : opts.label,
    handle: opts.handle,
  };
}

// Per-study card: the preview a SHARED study link unfurls to. The headline
// leads with the study name and rides the (name-prefix-stripped) TL;DR behind a
// colon so the headline number travels with it — the card has no body slot for
// the TL;DR. The bottom-left tag is the SOC verdict in its own color (so a
// recipient sees "PRACTICE-CHANGING" / "CAVEATS DOMINATE" at a glance); a
// review (no verdict) gets no tag. Takes only primitives + the verdict enum —
// never a figure/slide source — so it stays inside the publish boundary by
// construction (guarded by test/publish-boundary.test.ts).
export function studyCard(opts: {
  name: string;
  tldr: string;
  date: string;
  conference?: string | null;
  verdict?: StudyVerdict | null;
  handle: string;
  figuresSourced?: boolean;
  effect?: { datum: EffectDatum; domain?: AxisDomain } | null;
}): ShareCard {
  const conf = opts.conference ? ` · ${opts.conference}` : '';
  const name = opts.name.trim();
  const stripped = stripStudyNamePrefix(opts.tldr ?? '', name);
  const headline = stripped ? `${name}: ${stripped}` : name || (opts.tldr ?? '').trim();
  const meta = opts.verdict ? VERDICT_META[opts.verdict.soc_implication] ?? null : null;
  const color = opts.verdict ? VERDICT_COLOR[opts.verdict.soc_implication] ?? undefined : undefined;
  return {
    eyebrow: `${opts.date}${conf}`,
    headline,
    tagLabel: meta ? meta.label.toUpperCase() : undefined,
    tagColor: color,
    handle: opts.handle,
    figuresSourced: opts.figuresSourced,
    effect: opts.effect ?? null,
  };
}

// ── renderer ────────────────────────────────────────────────────────────────

// satori requires an explicit display on every div; text leaves are fine.
function div(style: Record<string, unknown>, children: unknown): unknown {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
}

// The mark, composed as absolutely-positioned divs because satori renders a
// subset of HTML rather than arbitrary SVG.
//
// The COORDINATES come from markGeometry() / pairedGeometry() — the exact
// functions the web component uses. That is the whole point: two renderers for
// one visual is a standing drift risk, so only the PAINT differs here, never
// the math. If this file ever computes a position itself, that guarantee is
// gone.
//
// Fixed light palette: OG cards are always light (a reader's theme cannot
// follow an image), which is the one documented exception to theme-native.
const MARK_W = 560;
const MARK_H = 74;

function effectMark(datum: EffectDatum, domain?: AxisDomain): unknown {
  // RATIO ONLY on this surface. The web card draws paired bars too, but here the
  // headline IS the TL;DR and already carries both values verbatim ("1.5% with
  // PBI vs 9.8%"), so bars restate the text — and at the size this card is
  // viewed in a text thread, a 1.5% bar is about seven pixels. The ratio form
  // earns its space because a dot's position relative to the null is not
  // something the sentence conveys. DESIGN.md: cards earn their existence.
  if (datum.form === 'paired') return div({}, '');

  if (!domain) return div({}, '');
  const g = markGeometry(datum, domain, MARK_W);
  // Never paint an estimate that is off the axis — it would sit at the edge and
  // read as the edge's value. Same guard the web component applies.
  if (g.pointOffScale) return div({}, '');

  const axisY = 30;
  const layer: unknown[] = [
    // axis
    div({ position: 'absolute', left: 0, top: axisY, width: MARK_W, height: 2, background: MUTED, opacity: 0.45 }, ''),
    // null reference at 1.0
    div({ position: 'absolute', left: g.nullX - 1, top: axisY - 16, width: 2, height: 26, background: MUTED, opacity: 0.8 }, ''),
  ];
  if (g.loX !== null && g.hiX !== null) {
    layer.push(
      div({ position: 'absolute', left: g.loX, top: axisY - 9, width: Math.max(2, g.hiX - g.loX), height: 6, background: FG, opacity: 0.55, borderRadius: 3 }, ''),
    );
  }
  layer.push(
    div({ position: 'absolute', left: g.pointX - 8, top: axisY - 14, width: 16, height: 16, background: FG, borderRadius: 8 }, ''),
  );
  for (const [i, t] of g.ticks.entries()) {
    const w = 70;
    const left = i === 0 ? 0 : i === g.ticks.length - 1 ? MARK_W - w : g.ticks[i]!.x - w / 2;
    layer.push(
      div({
        position: 'absolute',
        left,
        top: axisY + 10,
        width: w,
        fontSize: 20,
        color: MUTED,
        justifyContent: i === 0 ? 'flex-start' : i === g.ticks.length - 1 ? 'flex-end' : 'center',
      }, t.label),
    );
  }
  return div({ position: 'relative', width: MARK_W, height: MARK_H, marginTop: 20 }, layer);
}

export async function renderShareImage(card: ShareCard): Promise<Buffer> {
  const headline = truncate(card.headline, 170);
  const accent = card.tagColor || BORDER;
  const attribution = card.handle ? `${SITE}  ·  ${card.handle}` : SITE;

  const children: unknown[] = [
    div({ fontSize: 34, fontWeight: 700, letterSpacing: '-0.01em', color: FG }, 'onc brain'),
  ];
  if (card.eyebrow) {
    children.push(div({ fontSize: 24, color: MUTED, marginTop: 6 }, truncate(card.eyebrow, 72)));
  }
  // Headline AND mark share one top-aligned block, so the mark sits directly
  // under the headline it illustrates and the slack falls below both. Putting
  // the mark after a flex:1 headline pushed it to the bottom edge, crowding the
  // verdict label with a lake of dead space above it.
  children.push(
    div(
      { flex: 1, flexDirection: 'column', alignItems: 'flex-start', marginTop: 40, overflow: 'hidden' },
      [
        div(
          // wordBreak so a long UNBROKEN token (no spaces) wraps instead of
          // running off the right edge; overflow hidden as a backstop.
          { fontSize: headlineSize(headline), fontWeight: 700, lineHeight: 1.2, color: FG, wordBreak: 'break-word' },
          headline,
        ),
        card.effect ? effectMark(card.effect.datum, card.effect.domain) : div({}, ''),
      ],
    ),
  );
  children.push(
    div({ justifyContent: 'space-between', alignItems: 'flex-end' }, [
      card.tagLabel
        ? div({ fontSize: 24, fontWeight: 700, letterSpacing: '0.08em', color: card.tagColor || MUTED }, card.tagLabel)
        : div({}, ''),
      // Right column: the figure-sourced mark (v0.26 E2) stacked above the
      // attribution. Non-emoji '†' matches the card's inline citation mark;
      // rendered only when true (absence is not a negative signal).
      div({ flexDirection: 'column', alignItems: 'flex-end' }, [
        card.figuresSourced
          ? div({ fontSize: 20, color: MUTED, marginBottom: 6 }, '† figures sourced')
          : div({}, ''),
        div({ fontSize: 22, color: MUTED }, attribution),
      ]),
    ]),
  );

  const root = div(
    {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      background: BG,
      fontFamily: 'Newsreader',
      padding: '52px 60px',
      borderLeft: `12px solid ${accent}`,
    },
    children,
  );

  const svg = await satori(root as Parameters<typeof satori>[0], { width: W, height: H, fonts: fonts() });
  return Buffer.from(new Resvg(svg, { background: BG }).render().asPng());
}
