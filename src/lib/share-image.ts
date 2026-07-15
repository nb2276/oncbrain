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
    headline: 'Curated, AI-summarized oncology meeting research, by disease site.',
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
  };
}

// ── renderer ────────────────────────────────────────────────────────────────

// satori requires an explicit display on every div; text leaves are fine.
function div(style: Record<string, unknown>, children: unknown): unknown {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
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
  children.push(
    div(
      // Top-align (not center): the headline reads top-down from the eyebrow
      // instead of floating as an island with dead space above AND below.
      // wordBreak so a long UNBROKEN token (no spaces) wraps instead of running
      // off the right edge of the canvas; overflow hidden as a backstop.
      { flex: 1, alignItems: 'flex-start', fontSize: headlineSize(headline), fontWeight: 700, lineHeight: 1.2, color: FG, marginTop: 40, wordBreak: 'break-word', overflow: 'hidden' },
      headline,
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
