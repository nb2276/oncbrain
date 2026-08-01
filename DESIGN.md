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

**Two themes, dark by default (v0.30).** A pre-paint inline script in `Base.astro` reads `localStorage` and stamps `data-theme` on `<html>` before first paint (no flash); with no saved choice it stays dark. Light is an explicit opt-in via the header's sun/moon toggle, persisted per reader. Every surface reads CSS custom properties defined once on `:root` (dark) and overridden on `:root[data-theme='light']` — **never hardcode a hex in a component**, or it will break in one theme.

| Token | Dark (default) | Light |
|---|---|---|
| `--bg` | `#14130f` | `#f7f5f0` |
| `--bg-card` | `#1d1c17` | `#fffdf8` |
| `--fg` | `#ece8de` | `#1a1a1a` |
| `--fg-muted` | `#9d978a` | `#555` |
| `--border` | `#2f2d27` | `#e3ddd0` |
| `--accent` | `#6fb0ff` | `#0a4b8a` |
| `--accent-bg` | `#14253c` | `#e8f1fa` |
| `--citation-bg` | `#23211c` | `#f1ede1` |

- **Why dark by default?** The digest is read early morning and late evening on a phone. The palette is warm-neutral, not blue-black, so the serif still reads like paper rather than a terminal.
- **The warm off-white `#f7f5f0` is still brand color**, not just the light theme's background. It stays fixed on every surface a reader's theme can't follow: the PWA manifest `theme_color` + `background_color`, the maskable app icons (v0.9), and the OG / share-image cards (v0.14 T4), which are always light.
- **Verdict color** is the one accent that carries meaning. `VERDICT_COLOR` (`src/lib/verdict.ts`) is the light-surface palette, shared by the card and the share image. Dark mode lifts four of the six to brighter variants in `StudyCard.astro` (`:root:not([data-theme='light'])`) because the light-surface greens/oranges go muddy on `#1d1c17` — change one and change its pair.
- **Accents otherwise minimal.** The disclaimer callout has a left border; the study card's left border is colored only for the three attention verdicts. Everything else is plain prose.

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

### Global header

Every page shares one header (`Base.astro`), three rows deep and no more:

1. **Top row** — wordmark, the **live search box**, and the **theme toggle** on a single flex line (v0.32). Search used to sit on its own row below the sub-line; it now rides the title row so the first screenful starts with content instead of chrome. On narrow viewports the row wraps and search takes the full width; the toggle never wraps (`flex-shrink: 0`).
2. **Sub-line** — About + curator attribution.
3. **Specialty bar** — the reader's "Focus on your specialty" control (see *Study card → Specialty filter*), below the header rule so it reads as a reader setting, not navigation.

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

### Effect-size mark (v0.33)

A **forest dot on a log axis**, drawn inline directly under the primary endpoint number it visualizes (`src/components/EffectMark.astro`). The second sanctioned information-bearing SVG alongside `Sparkline.astro` — it earns its pixels because a hazard ratio's *magnitude* doesn't register in text: "HR 0.53 (95% CI 0.38-0.74)" is precise but not comparable at a glance across eight studies.

It is a **domain convention, not an invention** — this audience reads forest plots professionally, so it needs no onboarding affordance.

- **Placement: inline, inside `.study-endpoint`.** NOT in the figure column. That column is sized for slide photographs (`clamp(320px, 40%, 470px)`), so a compact mark marooned there reads as broken, and on mobile that slot sits *above* the TL;DR and would push the 90-second scan down. Inline, the mark sits with its own number on every viewport, and a card with a real slide photo still gets the figure column for the photo.
- **Neutral, never verdict color.** Point and interval are `var(--fg)`; axis, null line and ticks are `var(--fg-muted)`. The card already decided this: `StudyCard.astro` keeps valence in the headline number's *underline* so a negative HR never renders as a colored win. A verdict-green dot sitting on the harm side of the null would contradict the card's own rule. **Direction is carried by position** relative to the null, which also survives colorblindness, greyscale and print.
- **Opacity is unavailable.** The SpecialtyBar dims off-specialty cards with opacity, so encoding imprecision as faintness would leave a reader unable to tell "not your field" from "weak evidence". **Imprecision is width** — the interval drawn to scale, which is the honest encoding anyway.
- **Scaffolding: null line + three ticks. No "favors X / favors Y" spine.** The spine needs arm names the artifact doesn't reliably carry, and a guessed arm label is a clinical error, not a flourish. Tick labels have an **11px floor**; drop them before shrinking below it.
- **The axis always contains the estimate.** A hard window would clamp a real corpus value (`OR 5.34`) to the axis edge, where it reads as 4.0 — clamping an *interval* is honest because the arrowhead says "continues", but clamping the *estimate* is a lie. `markGeometry` reports `pointOffScale` so a renderer refuses to draw rather than mislead.
- **ONE ruler per (endpoint FAMILY, ratio kind), computed across the whole corpus** (`effectDomains()` in `digest-data.ts`, memoized per build). An odds ratio and a hazard ratio never share a ruler.
  - **Why corpus-wide rather than per page.** The original model gave date pages their own shared axis. Counting the archive, only **3** date buckets ever hold two comparable marks while **24** hold exactly one — so a per-date axis was identical to a per-mark axis on 89% of dates, and the feature did nothing where it was supposed to. The clusters readers actually compare live on **site** pages: six prostate surrogate-HR trials sit on one page.
  - **What it buys.** Any two comparable cards are comparable *anywhere*, and a study renders **identically on every surface** — no "did the number change or did the ruler?" There is exactly one axis model, not one per page type.
  - **Bounds snap to a ladder** (1.5, 2, 3, 4, 5, 7, 10). Snapping is what makes a corpus-wide axis stable: without it, every new study nudges the domain and silently redraws every older card in its bucket. It also gives readable ticks — `0.33 / 1.0 / 3` rather than `0.43 / 1.0 / 2.3`. The ruler only moves when a genuinely new extreme crosses a rung.
  - **Family, not class.** The endpoint *class* is too coarse to bucket on: `surrogate` covers progression-free survival, clinical PFS, imaging PFS, PFS-by-blinded-review, metastasis-free survival, disease-free survival and recurrence-free survival. Those share a unit but are not the same quantity, and one ruler across them implies a comparison the endpoints don't support. Bucketing by the exact *name* is the opposite failure — 19 rulers for 31 marks, 16 holding a single card, which is per-mark scaling with extra steps. **Families** group assessment variants of one endpoint (all the PFS forms) while keeping PFS, MFS and DFS apart. Vocabulary lives in `ENDPOINT_FAMILIES`; order matters, so `locoregional recurrence-free survival` resolves to `local` before the generic recurrence rule. It buckets *better on both counts*: 10 rulers with 6 holding more than one mark, versus 7 with 3.
  - **Tick labels are always visible**, so when two cards *are* on different rulers (a hazard ratio beside an odds ratio) the reader can see it.
- **The null line at 1.0 is a reference, not a verdict.** Several trials in the corpus are non-inferiority designs whose margin lives in prose the artifact doesn't model. The mark shows the estimate; the verdict chip and prose carry the conclusion.

**Two forms.** A **forest dot** when the study reports a ratio (HR / OR / RR / subdistribution HR), because a ratio has a null reference and an interval. **Paired bars** when it reports two values instead (`28% vs 21%`, `15.8 vs 12.3 mo`) — a linear axis anchored at **zero**, so bar length is proportional to value; percentages scale against 100 so two cards are comparable.

**Paired bars carry no valence, deliberately.** Neither bar is marked better. The endpoint class cannot tell you the direction: `local-control` covers both "local control 95% vs 88%" (higher is better) and "local recurrence 5% vs 12%" (lower is better), and deriving it would mean guessing from the endpoint's name. Same reasoning that cut the favors spine. There is no "harm" form.

**Arm labels are all-or-nothing.** `8.0% vs 9.4% (40 vs 50Gy)` yields one usable name and one number; labelling only one bar reads as if only that arm were identified, so both are dropped.

**Table-sourced marks pass a POSITIVE gate.** A table is only read when it can be identified as endpoint-by-arm: the row axis must be `Endpoint` (with at most a time qualifier), exactly two non-statistic value columns must remain, neither may name a non-arm axis, and at least one must carry positive arm evidence (an `n=`, an `Arm X`, or a control-like name). Shape alone is not enough — of 75 tables in the corpus only **one** says "Arm", while 23 name a Trial, Cohort, Subgroup, Setting or Modality. Drawing `POP-RT vs PEACE-2` as two arms of one trial would be a clinical misrepresentation, and it is the majority shape.

**States:**

| State | What renders |
|---|---|
| Point + interval | Dot, interval to scale, null line, three ticks |
| Point only, no interval | Dot alone, same size. No bar, so it can't read as precise |
| Interval runs off the axis | Arrowhead at the clipped end: "continues", not "ends here" |
| No clean ratio | **Nothing.** No placeholder, no reserved space, no footnote |
| Point estimate off the axis | **Nothing.** Clamping the dot to the edge would misreport its value |

**On inconsistent presence:** a date page where only some cards carry a mark is the expected state, not a defect. Most studies report proportions or medians rather than a ratio, and a missing mark says nothing about the study. Adding a placeholder would invent a signal.

**On the share card.** The per-study OG card (`/og/study/<date>-<slug>.png`, what a shared study link unfurls) carries the **ratio** mark, drawn in satori from the *same* `markGeometry()` the web SVG uses — two renderers for one visual is a drift risk, so only the paint differs, never the math. Fixed light palette, the documented exception to theme-native, because a reader's theme can't follow an image.

**Paired bars are deliberately absent from the share card.** There the headline *is* the TL;DR and already carries both values verbatim ("1.5% with PBI vs 9.8%"), and at the size the card is viewed in a text thread a 1.5% bar is a few pixels. The ratio form earns its space because a dot's position relative to the null isn't something the sentence conveys.

**The Telegram channel post does not carry a mark**, and can't: it links to `/<date>/`, which unfurls the *date* card — a day summary with no single study to draw. The plan's "OG card + Telegram" was one surface, not two.

**Longitudinal magnitude (v0.37, E5).** When the same trial reports a *different* number than the last time the digest covered it, the card says so: a muted `updated from HR 0.92 (95% CI 0.71-1.19) · 2026-05-17` line under the mark, linking back to the earlier card, plus a **hollow** dot at the earlier estimate on the same axis.

**Hollow, not faded.** The prior dot is distinguished by FILL, never by opacity — that channel belongs to SpecialtyBar dimming, and a dimmed card carrying a faded prior would be faint for two unrelated reasons. Never by hue either: the mark stays neutral, so a worsening estimate is never colored as a loss.

**The text carries the meaning; the dot only shows direction of travel.** Two dots alone would read as two treatment arms. The sentence names which is which, and the prior rides the *current* study's axis because two dots on different rulers compare nothing.

**It never fires on an unchanged number.** An identical re-reading is a duplicate card, not news, and drawing a second dot on top of the first would claim something happened. A *tightened interval at the same point estimate* does fire: a CI crossing back over 1.0 changes the conclusion. Endpoint bucket must match too, since an OS hazard ratio is not an update of a PFS one.

**Accessibility:** the mark is `aria-hidden` — the estimate and its interval are already in adjacent text, and a screen reader shouldn't announce them twice.

### Specialty filter (v0.31)

A **"Focus on your specialty"** bar (`src/components/SpecialtyBar.astro`) in the global header lets the reader pick which subspecialties matter: three checkboxes — 🎯 **Radiation** · 💊 **Medical** · 🔪 **Surgical**. Selecting one or more **dims** every card that doesn't carry a selected specialty; OR-logic across selections; the choice persists in `localStorage`. Cards expose the signal via `data-specialties` (from the study's `relevant_specialties`, judged neutrally at build). The bar self-hides when a page has fewer than two tagged cards — nothing to filter.

- **Discoverability (v0.32):** shipped as a muted divider (a tiny uppercase "relevant to my specialty" tag), which read as chrome — readers didn't notice it was theirs to use. Promoted to a distinct accent-edged panel with an action label ("Focus on your specialty") and a one-line helper ("Highlight the studies that matter to you. Saved for next time."), so the control announces itself.
- **Per-specialty analysis (v0.32):** the bar doesn't just emphasize the reader's cards — it reframes the "WHY IT MATTERS" prose to their field. Phase 2 writes a `significance_by_specialty` map (one grounded 2-3 sentence read per relevant specialty, from that reader's decision lens). The card server-renders the default significance-block visible plus one hidden block per specialty variant (`data-sig-for`); on a pick the bar hides `[data-sig-default]` and reveals the matching `[data-sig-for]` (multi-select shows the first by radonc→medonc→surgonc priority the card has a variant for). Old digests without the map just keep the single default (graceful fallback); new daily builds carry it automatically.

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
- **Live search:** lives in the global header's top row (v0.32), so it is one control on every page, not a home-page feature. Filters studies as you type (substring over name / TL;DR / NCT / disease-site label); `/` focuses it, `Esc` clears.

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
