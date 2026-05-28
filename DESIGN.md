# DESIGN.md — oncbrain visual design system

Source-of-truth for visual decisions: typography, color, layout, disease-site emoji anchors. The shipped site is authoritative for live state; this file captures the *why* so changes don't drift.

For **voice + framing rules** (audience, register, banned vocab, em-dash ban, per-study bullet emoji vocabulary, source-type pills, framing principles), see **`VOICE.md`**. Both Claude Code and the build-time analyst LLM read VOICE.md as the single source of truth.

Read this file before any change that touches type, color, layout, or the disease-site emoji set.

## Audience

Oncology subspecialists. Reading on a phone, in 60-90 seconds, between cases or in a conference hallway. They already know the abbreviations and the comparator trials.

**This shapes everything below.** The reader is busy and well-trained; the design is dense and assumes context.

## Disease-site emoji anchors

The per-site visual anchor in the digest header (`[date].astro`), the sites grid (`sites/index.astro`), and the home nav bar. Source: `src/lib/disease-sites.ts` (primary, includes `rationale` field for the hover tooltip) + `src/lib/obsidian-export.ts` (duplicate map kept in sync — see in-file comment for the duplication rationale).

See the [full emoji set + selection principles](#disease-site-emoji-set) below.

(Per-study bullet emojis 📊 🔍 💊 📐 ⚠️ 🔗 ❓ and source-type pills 🐦 📄 🩻 are voice concerns — see `VOICE.md`.)

## Typography

- **Body:** Newsreader, **self-hosted** via `@fontsource-variable/newsreader` (latin subset, optical-size + weight axes, italic). Serif. Self-hosted (not the Google Fonts CDN) so the PWA service worker precaches it for offline fidelity, with no third-party round-trip. The family name is `Newsreader Variable` (see `--font-serif` in `Base.astro`).
- **Why serif?** Clinical content reads as authoritative in serif. Sans-serif — especially `system-ui` — reads as utility/UI chrome, which is wrong for the content.
- **Why a real face, not `system-ui`?** Branding consistency. `system-ui` changes per platform and OS update; the digest should look the same on a curator's iPhone, an attending's iPad, and the conference projection laptop.

## Color

- **Background:** `#f7f5f0` (warm off-white). Soft on a phone in a dim conference room. Also the PWA manifest `theme_color` + `background_color`, and the opaque background of the maskable app icons (shipped v0.9).
- **Foreground:** dark on light, defaults to the user agent's text color cascading from `body`. No custom near-black — let the platform pick the contrast.
- **Accents:** minimal. The disclaimer callout has a left border; everything else is plain prose.

## App icon (PWA)

A dedicated home-screen mark, distinct from the old favicon "A": a **brain outline**
(two hemispheres, single dividing line) in `#1a1a1a` stroke. Matches the product
name ("onc brain") and reads at small sizes.

- `public/favicon.svg` — transparent background, dark stroke (browser tab).
- `public/icon-192.png`, `public/icon-512.png` — any-purpose, brain on `#f7f5f0`.
- `public/icon-192-maskable.png`, `public/icon-512-maskable.png` — opaque `#f7f5f0`
  background + safe-zone padding so the OS mask (circle/squircle) doesn't clip it.
- `public/apple-touch-icon.png` — iOS home screen.

When changing the mark, regenerate all five so the tab, home-screen, and maskable
forms stay consistent.

## Layout principles

- **Design for both desktop and mobile.** Both are first-class views, not mobile-only. Mobile (375px) is the dense 90-second scan; desktop uses its width (see *Study card → Device behavior*). Verify both widths on every layout change.
- **Cards earn their existence.** Don't add a card border, shadow, or chip unless it carries information. A study heading + paragraph is fine.
- **Brevity beats completeness in output.** Depth shows in *which* bullets are included, not in adding more.
- **One reading column.** The body is a single ~700px reading column, centered on desktop (`src/layouts/Base.astro`). No two-column *reading* of prose; desktop adds a navigation rail in the gutter, not a second column.

## Study card

The unit of the digest. **Triage-first**: the card rests at a triage layer and folds its depth behind a tap. Single source: `src/components/StudyCard.astro` (rendered by both `[date].astro` and `sites/[site].astro`).

**Resting layer (always visible), top to bottom:**

1. **Trial name** + NCT link.
2. **Eligible population** — the "For …" line that gates whether the study applies to this reader's patient.
3. **Description** — the study TL;DR, one line, headline number verbatim.
4. **Verdict pill** — the standard-of-care triage signal, six buckets, each an emoji plus a short label:
   - 🚀 Practice-changing · ↔️ Challenges SOC · 🔄 Confirmatory · 🧪 Early signal · ⚠️ Caveats dominate · ❔ Unclear
   - Carries a one-line rationale. Taxonomy lives in `src/lib/verdict.ts` (shared with the triage rail). Assignment rules and maturity gates are a voice concern (see `VOICE.md`). These six emojis are the *visual* vocabulary; do not reuse them elsewhere.
5. **"vs leading data" callout** — comparator (🔗) bullets lifted out of the depth, so the reader sees how the result sits against prior evidence at a glance.

**Figures:** their own column on desktop (≥1200px when a card has figures), or stacked under the triage layer on narrower viewports. The first figure is the visual anchor; additional figures fold behind a `+N more figures` summary.

**Depth layer (folded behind `▸ N details`),** flows like a scientific paper. Bullets are routed into labeled sections by their leading emoji prefix from `VOICE.md`:

- **Methods** — design / regimen bullets (🔍 🔍 💊) plus the **CONSORT participant flow** (when randomization counts are reported).
- **Results** — effect sizes and outcome tables (📊 📐). A 2D comparison renders as an inline table.
- **Critique** — methodological caveats (⚠️).
- **Notes** — any bullet without a recognized emoji prefix; usually empty. Catches what `VOICE.md` allows ("a bullet without an emoji is fine") instead of dropping it.
- **Open questions** — `❓` items the study leaves unresolved for the field.
- **Source attribution** — small muted line at the bottom of the fold.

The depth dropdown's summary keeps the existing `N details` count so the affordance reads the same as before.

**Sources:** a separate collapsible, each linked back, with source-type pills (🐦 tweet · 📄 paper · 🩻 slide; see `VOICE.md`).

### Device behavior

- **Mobile:** depth folds stay collapsed — the 90-second scan reads name + description + verdict + comparator down the page.
- **Desktop (≥1024px):** depth auto-expands (small inline script in `Base.astro`) — there's room, so show everything; re-syncs when crossing the breakpoint.
- **Desktop:** a sticky **triage rail** (`src/components/TriageRail.astro`) parks in the left gutter — one jump-link per study, marked with its verdict emoji. Two variants with different clearance widths because the page's reading column width determines when the gutter fits the rail:
  - **Default (700px reading column — home, sites index, conferences):** clears at **≥1200px**.
  - **Wide variant `triage-rail--wide` (1180px body — study pages `[date].astro` and `sites/[site].astro`):** the wider body needs more page width before the gutter clears, so the rail only shows at **≥1640px**. On common 1280-1440px desktops the rail stays hidden on study pages, and the cards' own figure columns carry the page.
  - Hidden below the matching threshold.

## Home page

Built for a returning reader, not a first-time browser:

- **Disease-site nav bar:** the emoji chips fan out across the top; tap to jump to that site's page. The primary wayfinding.
- **Hero TL;DR:** the latest digest's TL;DR in a prominent box directly under the title, so the freshest synthesis is the first thing read.
- **Recent studies feed:** the last ~10 studies as a flat feed (not grouped by date), newest first, so a returning reader sees what is new at a glance.
- **Live search:** a single box below the nav that filters studies as you type (substring over name / TL;DR / NCT / disease-site label). `/` focuses it, `Esc` clears.

## Disease-site emoji set

Twenty-two slugs, ordered roughly head-to-toe for solid tumors, then liquid tumors, then cross-cutting categories. The emoji is the per-site visual anchor in the digest header (`[date].astro`) and the sites grid (`sites/index.astro`).

| Slug | Label | Emoji |
|---|---|---|
| cns | CNS | 🧠 |
| head-neck | Head & Neck | 👄 |
| thoracic | Thoracic / Lung | 🫁 |
| breast | Breast | 🎀 |
| upper-gi | GI Upper | 🍽️ |
| hepatobiliary | Hepatobiliary | 🟡 |
| lower-gi | GI Lower | 🌀 |
| gyn | Gynecologic | 🌷 |
| prostate | Prostate | 🌰 |
| bladder | Bladder | 💧 |
| kidney | Kidney | 🫘 |
| gu-other | Germ Cell / Other GU | ♂️ |
| skin | Skin / Melanoma | 🌞 |
| sarcoma | Sarcoma | 🦴 |
| leukemia | Leukemia | 🩸 |
| lymphoma | Lymphoma | 🌐 |
| myeloma | Myeloma / Plasma Cell | 🩹 |
| oligo-mets | Oligometastatic / Mets | 🎯 |
| supportive | Supportive / QoL | 🤝 |
| safety | Safety / Regulatory | ⚠️ |
| multi-site | Cross-cutting | 📊 |
| other | Other | 📋 |

### Selection principles (apply when proposing a new slug or swapping an emoji)

1. **No food-as-organ.** Food emojis (corn, grapes, cherries, wine, plate) read juvenile or imply an etiology that's misleading. Prefer anatomical or symbolic.
2. **No confusable pairs.** Two flowers used to share the field (🌸 breast, 🌷 gyn). The breast 🎀 ribbon resolved it.
3. **Clinical signal over etiology.** Hepatobiliary 🟡 (jaundice signal) beats 🍷 (wine implies alcoholic liver, excludes HCC of other causes).
4. **Canonical analogies.** Prostate 🌰 (chestnut ≈ the walnut-size description used clinically). Kidney 🫘 (literally named "kidney bean").
5. **Awareness symbols when canonical.** Breast 🎀 (pink ribbon).
6. **Accept compromise where no good option exists.** GI Upper 🍽️ stays as food-adjacent because there is no stomach/esophagus emoji.

## Embeds & third-party

- **Twitter/X widget.** `platform.twitter.com/widgets.js` is loaded once in `Base.astro`. Source-card blockquotes become native X cards (images served from Twitter CDN — no IP cost to us). If the widget fails or the user is offline, the blockquote fallback is graceful.
- **Footer disclaimer.** Always present. Marks the site as AI-generated summary, not medical advice. Required for the audience and the legal posture.

## What to fix vs. leave alone

When in doubt about a visual change:

**Fix:**
- Anything that reads juvenile in clinical context.
- Anything that obscures or competes with a clinical number.
- Anything that breaks on a phone.
- Anything that gives an emoji or icon a meaning inconsistent with the vocabulary above.

**Leave alone:**
- The study-card + disease-site schema (DigestStudy / DigestSite). Astro pages, Obsidian export, and the LLM prompts all depend on its shape.
- Newsreader as the body face.
- The warm off-white background.
- The subspecialist register (defined in `VOICE.md`). If you find yourself softening tone for a broader audience, you've drifted off-product.
