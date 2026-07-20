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

The unit of the digest. **Triage-first + endpoint-forward** (v0.30): the card rests at a triage layer that leads with the primary endpoint and effect size, and folds its depth behind a tap. Single source: `src/components/StudyCard.astro` (rendered by `[date].astro`, `sites/[site].astro`, `study/[slug].astro`, and the tag pages).

**Glance box (resting layer, always visible), top to bottom:**

1. **Verdict chip** — the standard-of-care triage signal, a **kicker on its own line above the title** (v0.31). It used to sit beside the title; a long trial name that wrapped collided with it, so the chip moved above — robust at any title length. Six buckets, each an emoji plus a short label:
   - 🚀 Practice-changing · ↔️ Challenges SOC · 🔄 Confirmatory · 🧪 Early signal · ⚠️ Caveats dominate · ❔ Unclear
   - Taxonomy lives in `src/lib/verdict.ts` (shared with the triage rail). Assignment rules and maturity gates are a voice concern (see `VOICE.md`). These six emojis are the *visual* vocabulary; do not reuse them elsewhere. The one-line **rationale** now sits in the fold, not beside the chip.
   - **🗞️ press round-up / review (v0.16).** A `content_type: review` study (a trade-press / topic round-up surveying multiple trials) carries NO verdict — there is no single SOC implication to triage. In its place it shows a "🗞️ Reported via {outlet}" provenance line and a plain-text "Trials discussed" acronym list, and the triage rail marks it with 🗞️ where a verdict emoji would sit. `REVIEW_GLYPH` (🗞️) is centralized in `src/lib/verdict.ts` alongside the verdict taxonomy so the rail marker and the card provenance icon can't drift. Reserved for reviews; do not reuse.
2. **Trial name** + NCT link.
3. **Eligible population** — the "For …" line that gates whether the study applies to this reader's patient.
4. **Primary endpoint (v0.30 — the "endpoint-forward" lead).** The card leads with the study's headline endpoint plus effect size verbatim (`primary_endpoint`), so the number a subspecialist triages on is the first content, not buried in prose. An **endpoint-class chip** flags a *caveat class* — surrogate, local-control, or safety — so the reader knows how much weight the endpoint carries; the chip is **dropped for overall-survival** (the gold standard needs no flag). Absent when the source has no clean headline stat.
5. **Description** — the study TL;DR, one line, headline number verbatim.
6. **"Why it matters · {perspective}" callout (v0.22).** The one long-form surface on the card, perspective-framed (`significance` / `significance_perspective`, written by Phase 2 under the active `DIGEST_PERSPECTIVE` lens). It names the subtle additive detail the terse bullets drop and the decision it moves; it abstains when nothing is additive. When a study has no significance, the **Monday-clinic** decision line is promoted into this slot instead, so the slot is rarely empty.
7. **"vs leading data" callout** — comparator (🔗) bullets lifted out of the depth so the reader sees how the result sits against prior evidence at a glance. Rendered here only for cards WITHOUT structured `analysis_sections`; when the card has them, the comparator sits in the fold's "vs leading data" section instead.

**Figures:** their own column on desktop (≥1200px when a card has figures), or stacked under the triage layer on narrower viewports. The first figure is the visual anchor; additional figures fold behind a `+N more figures` summary.

**Depth layer (folded behind `▸ N details`).** For a v0.30 study it renders `analysis_sections` — labeled prose sections in reading order, so the fold reads like a structured brief rather than a bullet dump: **Design · Population & inclusion · Regimen · Radiotherapy · Endpoints · Results · Safety · vs leading data · Applies to · Limitations · Discussion** (only the labels the source supports). Below them come the verdict **Rationale**, the **Monday clinic** decision line, and **Open questions**.

- **De-dup:** the Monday-clinic line is **suppressed when it substantially restates the verdict rationale** (v0.31). Rationale, Limitations, and Monday-clinic sit side by side in the fold; a line that just re-says another adds nothing, so it drops. The Phase 2 prompt also tells the analyst to keep the three distinct.
- **Legacy fallback:** a study without `analysis_sections` (pre-v0.30, or a thin abstract) falls back to routing its bullets by leading emoji prefix from `VOICE.md` — **Methods** (🔍 🔍 💊 + the **CONSORT participant flow** when randomization counts are reported) · **Results** (📊 📐, a 2D comparison → inline table) · **Critique** (⚠️) · **Notes** (any unrecognized-prefix bullet, usually empty) · **Open questions** (❓).
- **Source attribution** — small muted line at the bottom of the fold.

The depth dropdown's summary keeps the `N details` count so the affordance reads the same as before.

**Sources:** a separate collapsible, each linked back, with source-type pills (🐦 tweet · 📄 paper · 🩻 slide; see `VOICE.md`).

### Device behavior

- **Mobile:** depth folds stay collapsed — the 90-second scan reads chip → name → For → endpoint + number → TL;DR → why-it-matters down the page. When a fold IS opened, its left-labeled section grid **collapses to a single column** (the label sits above its prose, not in a cramped left gutter) so the depth uses the full phone width; Open questions stack the same way (v0.31).
- **Desktop (≥1024px):** depth auto-expands (small inline script in `Base.astro`) — there's room, so show everything; re-syncs when crossing the breakpoint.
- **Desktop:** a sticky **triage rail** (`src/components/TriageRail.astro`) parks in the left gutter — one jump-link per study, marked with its verdict emoji. Two variants with different clearance widths because the page's reading column width determines when the gutter fits the rail:
  - **Default (700px reading column — home, sites index, conferences):** clears at **≥1200px**.
  - **Wide variant `triage-rail--wide` (1180px body — study pages `[date].astro` and `sites/[site].astro`):** the wider body needs more page width before the gutter clears, so the rail only shows at **≥1640px**. On common 1280-1440px desktops the rail stays hidden on study pages, and the cards' own figure columns carry the page.
  - Hidden below the matching threshold.

### Specialty filter (v0.31)

A **"Relevant to my specialty"** bar (`src/components/SpecialtyBar.astro`) in the global header lets the reader pick which subspecialties matter: three checkboxes — 🎯 **Radiation** · 💊 **Medical** · 🔪 **Surgical**. Selecting one or more **dims** every card that doesn't carry a selected specialty; OR-logic across selections; the choice persists in `localStorage`. Cards expose the signal via `data-specialties` (from the study's `relevant_specialties`, judged neutrally at build). The bar self-hides when a page has fewer than two tagged cards — nothing to filter.

- **Dim, not hide** is the deliberate call. A hard filter would let a reader miss a cross-disciplinary result (a systemic trial that still moves a radonc decision); dimming keeps the whole day in view and preserves the "I scanned everything" guarantee the digest promises, while the reader's own cards pop.
- **Emoji note:** the chip glyphs (🎯 / 💊) overlap the disease-site set (🎯 oligo-mets) and the bullet vocabulary (💊 regimen). It reads OK because each chip's *text label* carries the meaning and the glyph is decorative inside a labeled header control, not a standalone anchor. If the overlap ever confuses, swap the glyphs before dropping the labels.

## Home page

Built for a returning reader, not a first-time browser:

- **Disease-site nav bar:** the emoji chips fan out across the top; tap to jump to that site's page. The primary wayfinding.
- **Hero TL;DR:** the latest digest's TL;DR in a prominent box directly under the title, so the freshest synthesis is the first thing read.
- **Recent studies feed (v0.14 T3):** the home shows only the latest ~12 studies as a what's-new slice, then a "Browse all N studies →" link to **`/studies`**, the full flat filterable index (where the filter rail lives). The home is the returning-reader's front door, not a 71-row scroll. Both surfaces render the shared `RecentFeed.astro`; the home passes the full corpus id list so the "N new overall" count and the seen-set cover every study, not just the slice (a study added below the slice still counts on the home total and gets its pill on /studies). Two markers ride the feed rows:
  - A 🚀 **practice-changing flag** leads the row for practice-changing studies only. It is the one verdict that survives as a bare glyph in a dense row: the others (🔄 ↔️ ❔) read as UI controls without their pill label, and ⚠️ collides with the safety disease-site anchor (design review 2026-06-10). The card's verdict pill still carries the full verdict for every study.
  - A **NEW text pill** + a "N new overall" total mark studies added since the reader's last visit (client-side, localStorage seen-id set). The pill is text at `.section-label` typography in a NEUTRAL color, never an emoji or a verdict color, so it stays clear of the 3-axis emoji vocabulary.
- **Verdict card border (v0.14):** the study card's left border is colored for the three ATTENTION verdicts only (🚀 practice-changing, ↔️ challenges-SOC, ⚠️ caveats-dominate). Confirmatory / early-signal / unclear keep the neutral border, so a long page reads as a heat-map where the few that demand action pop. `--verdict-color` is defined once on `.study.verdict-*` and shared by the pill text + the border.
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
- **Social preview cards (v0.14 T4).** Every page carries `og:image` + `twitter:card` (summary_large_image) so a shared link renders a branded 1200×630 preview instead of a bare URL. The cards are generated at build time from `src/lib/share-image.ts` (satori → SVG → resvg → PNG) and served from `/og/*.png` (default, per-date, per-site) plus `/og/study/<date>-<slug>.png` (v0.21: per-study card — study name + headline number + verdict pill, the preview a shared study link unfurls to). The card is **synthesized text only** (Newsreader serif on warm `#f7f5f0`: wordmark, date · conference, the curated top-line, a study-count or verdict label, and the curator handle) — never a figure or slide pixel, so it stays inside the publish boundary by construction. The verdict label, when present, uses the shared `VERDICT_COLOR` token (no emoji: satori would need a separate emoji font, and the colored text label reads cleaner). Font: vendored static Newsreader instances (`src/assets/og-fonts/`, OFL) because satori can't read the variable woff2 the site ships.
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
