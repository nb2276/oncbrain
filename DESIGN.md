# DESIGN.md — oncbrain design system

Source-of-truth for visual + voice decisions. The shipped site is authoritative for layout; this file captures the *why* so future changes don't drift.

Read before any change that touches type, color, copy register, or the disease-site emoji set.

## Audience

Oncology subspecialists. Reading on a phone, in 90 seconds, between scans or in a conference hallway. They already know the abbreviations and the comparator trials.

**This shapes everything below.** The reader is busy and well-trained; the digest is dense and assumes context.

## Voice

Subspecialist-to-subspecialist. Peer-review register. Terse.

**Use:**
- Abbreviations: mOS, mPFS, HR, OR, ORR, DCR, AE, IO, ADT, ARSI, SBRT, EBRT, RP, ADC, BCR-FS.
- Arrows: `→`.
- Casual asides where they sharpen the point ("looks promising tho short f/u").

**Don't use:**
- AI vocabulary: *delve, crucial, robust, comprehensive, nuanced, notably, of note, interestingly.*
- Em dashes. Anywhere. Code comments, prose, prompts, commit messages.
- Patient-facing language ("patients" → "pts", or "men/women" when relevant).
- Promotional tone ("game-changing", "practice-changing" without qualifier).
- Fabricated numbers. Effect sizes are verbatim from sources or omitted.

## Emoji vocabulary

Emojis carry semantic load — not decoration. Use the right one or none.

### Per-study bullet anchors (in `details[]`)

| Emoji | Meaning |
|---|---|
| 📊 | Primary results / effect sizes |
| 🔍 | Methodology / trial design |
| 💊 | Systemic / regimen |
| 📐 | Stat detail (CI, p, HR) |
| ⚠️ | Counter / critique / methodological concern |
| 🔗 | Comparison to prior data (recent or historic landmark) |
| ❓ | Open question |

A bullet without an emoji is fine — don't force them.

### Source-type pills (renderer)

| Emoji | Source |
|---|---|
| 🐦 | Tweet |
| 📄 | Paper (PubMed) |
| 🩻 | Slide (curator photo) |

### Disease-site anchors

See [Disease-site emoji set](#disease-site-emoji-set) below. Source: `src/lib/disease-sites.ts` (primary) + `src/lib/obsidian-export.ts` (duplicate map; keep in sync — see the in-file comment for why it's duplicated).

## Typography

- **Body:** Newsreader (Google Fonts). Serif, italic + weight range loaded.
- **Why serif?** Clinical content reads as authoritative in serif. Sans-serif — especially `system-ui` — reads as utility/UI chrome, which is wrong for the content.
- **Why a real face, not `system-ui`?** Branding consistency. `system-ui` changes per platform and OS update; the digest should look the same on a curator's iPhone, an attending's iPad, and the conference projection laptop.

## Color

- **Background:** `#f7f5f0` (warm off-white). Soft on a phone in a dim conference room. Theme color for the eventual PWA manifest also.
- **Foreground:** dark on light, defaults to the user agent's text color cascading from `body`. No custom near-black — let the platform pick the contrast.
- **Accents:** minimal. The disclaimer callout has a left border; everything else is plain prose.

## Layout principles

- **Mobile-first.** 375px is the canonical render target. Tablet and desktop are progressive enhancements, not separate designs.
- **Cards earn their existence.** Don't add a card border, shadow, or chip unless it carries information. A study heading + paragraph is fine.
- **Brevity beats completeness in output.** Depth shows in *which* bullets are included, not in adding more.
- **One column. Always.** Two-column reading on a phone is a footgun.

## Disease-site emoji set

Twenty-two slugs, ordered roughly head-to-toe for solid tumors, then liquid tumors, then cross-cutting categories. The emoji is the per-site visual anchor in the digest header (`[date].astro`) and the sites grid (`sites/index.astro`).

| Slug | Label | Emoji |
|---|---|---|
| cns | CNS | 🧠 |
| head-neck | Head & Neck | 👄 |
| thoracic | Thoracic / Lung | 🫁 |
| breast | Breast | 🎀 |
| upper-gi | Upper GI | 🍽️ |
| hepatobiliary | Hepatobiliary | 🟡 |
| lower-gi | Lower GI | 🌀 |
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
6. **Accept compromise where no good option exists.** Upper GI 🍽️ stays as food-adjacent because there is no stomach/esophagus emoji.

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
- The IMRD/sites schema. Astro pages + Obsidian export + LLM prompts all depend on it.
- Newsreader as the body face.
- The warm off-white background.
- The "subspecialist-to-subspecialist" register. If you find yourself softening the tone for a broader audience, you've drifted off-product.
