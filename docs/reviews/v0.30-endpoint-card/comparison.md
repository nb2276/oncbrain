# v0.30 endpoint-forward card — real vs v3-mockup comparison

Review bundle for the endpoint-forward StudyCard redesign. Compares the 3 rebuilt
**real** cards (built by the live pipeline on 2026-05-17) against their **v3 mockups**
(`/tmp/oncbrain-redesign/gen/*-v3.html`), then records the one regression found and its fix.

Screenshots in `./shots/`:

| File | What |
|---|---|
| `REAL-{import-high,peace-2,oligoma}.png` | real cards, light mode, folds expanded |
| `MOCK-{import-high,peace-2,oligoma}.png` | the v3 mockups they target |
| `AFTER-import-high-dark.png` | import-high after the endpoint-chip fix (dark, the shipping default) |
| `AFTER-import-high-light.png` | import-high after the fix (light) |
| `AFTER-oligoma-light.png` | oligoma after the fix — confirms the surrogate chip stays distinct |

## Multipass adversarial comparison — result

All 3 real cards implement every v3 primitive: unified glance wash box, filled verdict
chip, endpoint block (name + class chip + big stat + muted sub-line), "why it matters"
band, left-labeled bold-prose fold, borderless results table, ✓/✕ applies-to markers,
bottom tags footer.

| Card | Verbatim structural match | Notes |
|---|---|---|
| OLIGOMA | ~82% | cleanest; all primitives present + correctly styled |
| IMPORT HIGH | ~77% | one real regression (endpoint chip — now fixed) |
| PEACE-2 | ~65% | dominated by a card-TYPE difference: the real card classified as a **review** (no verdict, no endpoint HR blocks) vs the mock's study-report. Not a CSS defect — a Phase-1 content-type decision. |

**Biggest structural gap (design decision, not a regression):** the mock's high-placed
labeled **"FIGURES"** module (embedded conference-slide/poster + "🖼 SLIDE Photographed at
conference" caption + a collapsible "▸ structured extract (OCR)" table) and the
**"PARTICIPANT FLOW"** colored per-arm allocation boxes are absent or repositioned in every
real card (arm counts now live in the results table instead). Deferred — logged here for a
later call.

**Intended divergences (real matches the newer v3 spec, mock predates it):** richer
section-label vocabulary, bold-keyed prose instead of bullets, ✓ *and* ✕ shown (mock showed
only ✓), tag casing, sources as an expandable toggle.

## The regression + fix — IMPORT HIGH endpoint class chip

**Symptom (from the adversarial pass):** IMPORT HIGH appeared to render a bare giant
"3.7% vs 3.5%" with no endpoint-name label and no class chip, while OLIGOMA/PEACE-2 showed
"Progression-free survival [SURROGATE]".

**Root cause:** not a missing block. The endpoint block *was* fully in the DOM (name
"Ipsilateral breast tumour relapse (10yr)" + `local control` chip). The defect was CSS: only
`.endpoint-class.ec-overall-survival` had a distinct fill; `local-control`, `surrogate`, and
`safety` all fell back to a tiny 0.6rem **muted-grey outline** (`color: --fg-muted`, no
background), which reads as near-invisible in a screenshot — so `local-control` looked absent.

**Fix (`src/components/StudyCard.astro`):** gave every endpoint class a legible, distinct,
theme-safe fill so the endpoint TYPE reads as co-equal with the effect size. Importance
hierarchy, all derived from theme tokens so they invert cleanly dark↔light:

| Class | Chip |
|---|---|
| `overall-survival` (hard) | solid `--fg` fill (strongest) |
| `local-control` | solid `--accent` fill |
| `surrogate` | soft `--accent-bg` tint, accent text |
| `safety` | neutral tint |
| (fallback) | legible neutral fill (was the invisible muted outline) |

**Verified:** see `AFTER-import-high-dark.png` — `LOCAL CONTROL` is now a solid blue pill next
to the endpoint name, co-equal with the "3.7% vs 3.5%" headline. `AFTER-oligoma-light.png`
confirms the `SURROGATE` soft-tint stays legible and visually distinct from local-control.
`npx astro check` 0 errors; full vitest suite green.
