# Share-study-link button

Per-study share affordance. Web Share API (iOS, Safari macOS, some Chrome) → native share sheet; otherwise → copy link to clipboard with inline confirmation and a recovery path on failure. Ships on StudyCard (per-date + per-site pages) AND the home recent-feed card.

Designed via `/plan-design-review` (2026-05-27). Reviewed + expanded via `/plan-eng-review` + Codex outside voice (2026-05-28).

## Goal

A busy oncologist scrolling the digest taps a small share affordance on any study card — home feed, per-date digest, or per-site index. When the Web Share API is available, the system share sheet opens with the trial name + canonical URL. Otherwise the link copies to the clipboard with brief inline confirmation; on the rare failure, a recovery input appears with the URL pre-selected for manual copy. Zero net-new UI vocabulary on the StudyCard utility row; standard top-right overlay on the home feed.

## Approved decisions

### 1. Placement on StudyCard (D2) — bottom utility row, inline with "▸ N details"

- Share lives on the same horizontal line as the existing `<details class="study-depth"><summary>▸ N details</summary>...</details>`, aligned right.
- Wrap the `<details>` and the new `<button>` in a flex container (`.study-utility-row { display: flex; justify-content: space-between; align-items: baseline; }`). The button is a SIBLING of `<details>`, NOT nested inside `<summary>` (nested interactive elements break keyboard + AT semantics).
- The wrapper renders unconditionally when `shareUrl` is present, even if `hasDepth === false`. In that case the button is alone on the row, right-aligned (`justify-content: flex-end` is implicit because no left child renders).
- Visible in the resting card layer — no fold expansion required to find it.

```
+---------------------------------------------+
|  PRESTIGE-PSMA  NCT04297410                 |
|  For mCRPC patients post-AR-pathway         |
|  [TL;DR box]                                |
|  [PRACTICE-CHANGING verdict pill]           |
|  [vs leading data callout]                  |
|  > 4 details                  Share         |
|  📚 Sources · 🐦 2 · 📄 1                   |
+---------------------------------------------+
```

### 2. Placement on home recent-feed card (E11 + F2-F4) — BOTTOM-right overlay + stopPropagation

The home feed card (`src/pages/index.astro`, line ~142) is currently `<a class="recent-card" href="/{date}/#{slug}">...</a>` wrapping the entire card. A `<button>` cannot be a child of an `<a>` (interactive-in-interactive is invalid HTML and breaks SR), so the share button must be a SIBLING of the `<a>`, absolutely positioned over the wrapper `<li>`.

**Geometry (resolved per F2):** Top-right overlay would collide with `.recent-conf` (the existing conference pill pushed to the right end of the meta row by `margin-left: auto;`). Share button goes to **bottom-right** of the card to avoid that collision.

- `.recent-li { position: relative; }`
- `.recent-card { padding-bottom: 2.2rem; }` — reserves space at the bottom of the link so TL;DR text doesn't run under the absolutely-positioned share button.
- Share button: `position: absolute; bottom: 0.5rem; right: 0.6rem;`, inside the `<li>` but OUTSIDE the `<a>`.
- DOM order (per F4): `<li><a class="recent-card">...</a><button class="recent-share">...</button></li>` — link first, button after. Tab order: link → share → next card's link → next card's share. Both keyboard-accessible.

**Click handler MUST call `event.stopPropagation()`** first so the underlying card link doesn't navigate when the share button is clicked.

**Hover/focus state (resolved per F3):** Existing `.recent-card:hover` selector drops to muted when the cursor moves to the absolutely-positioned share button (cursor is no longer over `<a>`). Fix:

```css
.recent-li:hover .recent-card,
.recent-card:focus-within { border-color: var(--accent); }
```

Card border stays accent whenever cursor is anywhere over the `<li>` OR keyboard focus lands on either the link or the share button.

**Affordance treatment** matches StudyCard's bottom-row share (sans label, muted, adaptive "Share" / "Copy link") — same `var(--font-sans)`, `0.8rem`, `var(--fg-muted)`. No new typography vocabulary. Touch target ≥44×44 px via `padding: 0.5rem 0.4rem` on the button.

```
+----------------------------------+
|  🌰 Prostate · 2026-05-17   ASCO|
|  PRESTIGE-PSMA                   |
|  At interim analysis, 177Lu-PSMA |
|  reduced PSA50 vs SoC by 28%     |
|                            Share |
+----------------------------------+
```

### 3. Affordance — sans text, adaptive label (D3)

- Small muted sans label matching the existing `.study-depth > summary` / `.sources summary` typography (`font-family: var(--font-sans); font-size: 0.8rem; color: var(--fg-muted)`).
- **Adaptive label** (E2): `share-script.ts` runs once per page on `DOMContentLoaded`, queries `button[data-share-url]`, and per button:
  - If neither `'share' in navigator` nor `navigator.clipboard?.writeText` exists → set `display: none` (per E7) on the button.
  - Else if `'share' in navigator` → label stays `Share`.
  - Else → label swaps to `Copy link`.
- Default label in SSG HTML: `Share`. (Even though SSG can't know browser capability, `Share` is the more common reveal target — see decision §6 for the hidden-default treatment.)
- Hover: `color: var(--accent);` (matches existing utility-row hover).
- No icon, no emoji prefix — text alone fits the project voice (sans for UI, serif for content; no decorative iconography; reserves the bullet/source-type emoji vocabulary in VOICE.md).

### 4. Copy feedback — inline label flip + accent flash + separate aria-live region (D4 + E8)

- On successful clipboard write, the visible label flips:
  - `Copy link` → `Copied` for 1500ms with `color: var(--accent)`, then reverts to `Copy link` with `color: var(--fg-muted)`.
- Separate visually-hidden `<span class="sr-share-status" aria-live="polite"></span>` per button is updated with the same text (per E8). Mutating the visible button text inside a `<button>` is unreliable across NVDA/JAWS/VoiceOver; a dedicated live region is the standard pattern.
- No toast/snackbar pattern is introduced.
- iOS share-sheet path is system-owned: no oncbrain-side feedback on dismiss or share completion.

### 5. Canonical share URL — per-site page with date-prefixed anchor, ABSOLUTIZED (D5 + E7)

- Format: `{origin}/sites/{site}/#{date}-{slug}`
  - `site` = the disease-site slug (e.g. `prostate`)
  - `date` = the digest date the study lives in (e.g. `2026-05-17`)
  - `slug` = the per-date study slug (already resolved by `slug-resolve.ts`)
- This URL is the canonical "study in its disease-site context" view. Used regardless of which page the user is currently viewing.
- The card receives a `shareUrl` prop containing the path (`/sites/.../#...`). At click time, the script absolutizes to `new URL(shareUrl, window.location.origin).href` before passing to `navigator.share()` or `clipboard.writeText()`. A relative path pasted in iMessage from a different origin is broken; absolutization fixes this. (Codex critique resolved.)
- If `shareUrl` is absent on a card, no share button is rendered.

### 6. Web Share payload — `{title, url}` only (D6)

- `navigator.share({ title: study.name, url: absoluteShareUrl })`.
- **No `text` field.** `text` pre-fills the iMessage/Mail/Slack message body; including the study TL;DR there would presume the curator's intent.

### 7. Edge cases + accessibility — revised conservative defaults (D7 + E1 + E3 + E7 + E9)

- **SSG default render:** `display: none` (per E7 — `visibility: hidden` reserves layout space, which leaves a visible gap on cards where the API check fails). Button hidden in static HTML; `share-script.ts` reveals (sets `display: ''`) after confirming at least one API is present.
- **Neither API available:** button stays `display: none`. Covers very-old browsers + insecure (non-localhost) contexts.
- **Web Share API rejection chain (E3):**
  - `AbortError` (user dismissed sheet) → silent no-op.
  - Any other rejection (`NotAllowedError`, `DataError`, `InvalidStateError`, etc.) → fall through to `clipboard.writeText()` with the standard flip feedback.
- **Clipboard happy path:** `Copy link` → `Copied` flip for 1500ms with accent color, aria-live announces "Copied".
- **Clipboard failure (revised per E9):** label flips to `Couldn't copy` for 2000ms with accent color, AND a small `<input type="text" readonly>` containing the absolute URL appears inline next to the button with text pre-selected. User does `Cmd+C` (`Ctrl+C`) to copy manually. The input disappears after 10s or on next button click. This resolves Codex's pushback on D7's original "no recovery" choice.
- **Rapid re-click (E5):** each click clears any existing flip-timer via `clearTimeout()` and starts a new one. Per-button timer state is held in a `WeakMap<HTMLButtonElement, number>`.
- **Touch target:** ≥44×44 px on the button. Achieved via padding (`padding: 0.5rem 0.3rem`).
- **Focus ring:** native browser focus ring; do not suppress `outline` on `:focus-visible`.
- **aria-label:** `Share link to {study.name}` (static — state changes are announced via the separate aria-live region per E8).
- **Reduced motion:** label flip is text + color only, no CSS transition; `setTimeout`-based revert respects platform timing. No `prefers-reduced-motion` work needed.
- **Home-feed `stopPropagation`:** the home card's overlay button's click handler must call `event.stopPropagation()` before doing anything else (per E11).

## Architecture

### Script lifecycle (E2)

- Inline `<script>` lives at the bottom of `StudyCard.astro` AND at the bottom of `index.astro`'s recent-feed section. Each is a one-line shim: `import { initShareButtons } from '../lib/share-script.ts'; initShareButtons();`. Astro processes the import; the bundler emits ONE module per page.
- `initShareButtons()` runs once per page on `DOMContentLoaded`. It queries `button[data-share-url]`, performs feature detection per button (writing the chosen label + revealing the button), and wires click handlers.
- Per-button data lives in DOM:
  - `data-share-url="/sites/.../#..."` (relative path; absolutized at click time)
  - `data-share-title="PRESTIGE-PSMA"` (used as `navigator.share.title`)
- No global state; no closures captured at render time.

### Extracted modules (E4)

- `src/lib/share-url.ts` — pure: `buildShareUrl({ site, date, slug })` returns `string` or `undefined` if any input is missing/empty.
- `src/lib/share-script.ts` — DOM: `initShareButtons()` is the entry. Internal pure-ish helpers (state machine for label flip, fallback chain) are also exported for unit testing under vitest's jsdom environment.

### File changes (all)

- `src/lib/share-url.ts` — **NEW.** Pure URL builder.
- `src/lib/share-script.ts` — **NEW.** DOM init + click handler + state machine.
- `src/components/StudyCard.astro` — add the share button, the flex `.study-utility-row` wrapper around `<details class="study-depth">`, the aria-live region span, the inline `<script>` shim that imports + invokes `initShareButtons()`. New optional prop `shareUrl?: string`.
- `src/pages/[date].astro` — when rendering each `StudyCard`, pass `shareUrl={`/sites/${site.disease_site}/#${date}-${slugByStudy.get(study)}`}`. `site.disease_site` is in scope from the outer `digest.sites.map` loop; `date` is `Astro.params.date`.
- `src/pages/sites/[site].astro` — pass `shareUrl={`/sites/${summary.disease_site}/#${anchorByOcc.get(occ)}`}`. The `anchorByOcc` map already yields `${date}-${slug}`.
- `src/pages/index.astro` — add `.recent-li { position: relative; }`, the absolute-positioned share button (with `data-share-url`, `data-share-title`), the aria-live region span, the inline `<script>` shim. Each item's `shareUrl` is `/sites/${r.disease_site}/#${r.date}-${r.slug}` (RecentStudy already exposes these fields).
- `src/layouts/Base.astro` — no changes.
- `test/share-url.test.ts` — **NEW.**
- `test/share-script.test.ts` — **NEW.** (vitest with jsdom environment)

No CSS variables added; reuses `--fg-muted`, `--accent`, `--font-sans`.

## Implementation Tasks

- [ ] **T1 (P1, human: ~10min / CC: ~3min)** — share-url module — `buildShareUrl({ site, date, slug })` pure function
  - Surfaced by: E4 extraction, D5 canonical URL
  - Files: `src/lib/share-url.ts`
  - Verify: returns `/sites/prostate/#2026-05-17-prestige-psma` for valid inputs; returns `undefined` if any of site/date/slug is empty.

- [ ] **T2 (P1, human: ~40min / CC: ~10min)** — share-script module — `initShareButtons()` with full state machine
  - Surfaced by: E1 hidden-by-default, E2 lifecycle, E3 share rejection chain, E5 timer cancel/restart, E7 absolutize + display:none, E8 aria-live, E9 inline URL recovery
  - Files: `src/lib/share-script.ts`
  - Behavior: feature-detect per button; set `display: ''` on reveal (per E7), set label, attach click handler; click handler runs share-first chain (AbortError silent, non-Abort → clipboard), clipboard success → flip + aria-live, clipboard failure → flip + reveal recovery input (pre-selected); per-button WeakMap-backed timer cancel/restart on rapid re-click.
  - Verify: unit tests in T7 cover all branches.

- [ ] **T3 (P1, human: ~30min / CC: ~8min)** — StudyCard — add `.study-utility-row` flex wrapper, share button, aria-live span, script shim
  - Surfaced by: D2 placement, D3 affordance, E2 lifecycle, E8 aria-live, E4 import shim
  - Files: `src/components/StudyCard.astro`
  - Includes: new `shareUrl?: string` prop; button with `data-share-url`, `data-share-title`, `aria-label="Share link to {study.name}"`, `style="display:none"` (per E7); sibling `<span class="sr-share-status" aria-live="polite"></span>`; inline `<script>import { initShareButtons } from '../lib/share-script.ts'; initShareButtons();</script>` at the bottom.
  - Verify: `npm run build` succeeds; render a digest locally, confirm Share label sits right of `▸ N details` on the same line; on a card with no depth, button is alone right-aligned; in DevTools, removing both navigator.share + navigator.clipboard hides the button.

- [ ] **T4 (P1, human: ~15min / CC: ~5min)** — Per-date page — pass `shareUrl` prop
  - Surfaced by: D5 canonical URL
  - Files: `src/pages/[date].astro`
  - Verify: inspect rendered card; `data-share-url` resolves to `/sites/{disease_site}/#{date}-{slug}`.

- [ ] **T5 (P1, human: ~15min / CC: ~5min)** — Per-site page — pass `shareUrl` prop via `anchorByOcc` map
  - Surfaced by: D5 canonical URL
  - Files: `src/pages/sites/[site].astro`
  - Verify: share from per-site page sends `/sites/{site}/#{date}-{slug}` — the same canonical URL as the per-date page would.

- [ ] **T6 (P1, human: ~40min / CC: ~12min)** — Home-feed card — BOTTOM-right overlay share button with stopPropagation + hover/focus fix
  - Surfaced by: E10 home-feed scope, E11 overlay placement, F2 bottom-right placement, F3 hover/focus selector, F4 DOM/tab order
  - Files: `src/pages/index.astro`
  - Includes:
    - `.recent-li { position: relative; }`
    - `.recent-card { padding-bottom: 2.2rem; }` (reserves space so TL;DR doesn't run under the button)
    - Share button: `position: absolute; bottom: 0.5rem; right: 0.6rem;` inside `<li>` but OUTSIDE `<a class="recent-card">`
    - DOM order: `<li><a>...</a><button>...</button></li>` (link first per F4)
    - Click handler calls `event.stopPropagation()` first
    - `data-share-url={`/sites/${r.disease_site}/#${r.date}-${r.slug}`}`, `data-share-title={r.study.name}`
    - aria-live span sibling (per E8)
    - Inline `<script>` shim importing `initShareButtons` from `src/lib/share-script.ts`
    - Updated hover selector: `.recent-li:hover .recent-card, .recent-card:focus-within { border-color: var(--accent); }` (per F3) — replaces existing `.recent-card:hover` rule
  - Verify: clicking the share button does NOT navigate to the per-date page; clicking elsewhere on the card DOES navigate; on cards with a conference pill (ASCO/ESMO), the share button + pill do not visually overlap; hovering anywhere on the card body OR the share button keeps card border accent; keyboard Tab visits link first, then share; `astro check` shows no HTML validation errors.

- [ ] **T7 (P1, human: ~45min / CC: ~15min)** — Vitest — full state-machine coverage
  - Surfaced by: E4 extraction, project's "too many tests > too few" preference
  - Files: `test/share-url.test.ts`, `test/share-script.test.ts` (uses vitest jsdom env)
  - Coverage (all paths from §3 diagram):
    - `share-url.test.ts`: valid inputs → correct path; missing inputs → `undefined`; URL-component sanitization if any.
    - `share-script.test.ts` (jsdom + mock navigator/clipboard):
      1. both APIs present → label is `Share`, button revealed
      2. clipboard only → label is `Copy link`, button revealed
      3. neither → button stays `display: none`
      4. button has correct `data-share-url`, `data-share-title`, `aria-label` after init
      5. click + share resolves → no label change
      6. click + share rejects AbortError → silent (no label change)
      7. click + share rejects NotAllowedError → falls through to clipboard, label flips
      8. click + clipboard resolves → label `Copy link` → `Copied` for 1500ms → revert; aria-live span text set to `Copied`
      9. click + clipboard rejects → label `Couldn't copy` for 2000ms + recovery input appears with absolute URL pre-selected
     10. shareUrl absolutized at click (mock `window.location.origin = 'https://oncbrain.test'`; assert `navigator.share` called with absolute URL)
     11. rapid re-click during flip window cancels prior timeout and restarts (assert `clearTimeout` called)
     12. home-feed click handler calls `event.stopPropagation()` (assert via spy)
  - Verify: `npm test` passes (all 469 prior tests + new); `npx astro check` passes (0 errors).

- [ ] **T8 (P2, human: ~30min / CC: ~10min)** — Manual QA on real devices
  - Surfaced by: D2-D7 + E11 home-feed
  - Files: none
  - Verify: on real iPhone (not DevTools UA) Safari, share sheet opens with trial name + absolute URL; iMessage/Mail/Slack show clean previews with no pre-filled body. On desktop macOS Safari (which DOES have Web Share API), share opens system sheet — NOT clipboard fallback (so the "iPhone = share, desktop = copy" framing is technically wrong; both are feature-detect-driven). On desktop Chrome/Firefox without Web Share, label is `Copy link`, copy works, recovery input appears if clipboard denied (test via Site Settings → Permissions → Clipboard: Block). Home-feed cards: clicking the share button does NOT navigate; clicking elsewhere does.

## NOT in scope

- **Toast/snackbar component** (D4) — rejected to avoid net-new UI vocabulary; inline label flip + aria-live region does the work.
- **Icon-only share button** (D3) — rejected; bottom utility row uses text labels (`▸ details`, `📚 Sources`); icon-only would read as decoration.
- **TL;DR pre-fill in Web Share `text` field** (D6) — rejected to preserve curator's choice of message.
- **Top-right corner icon on StudyCard** (D2) — rejected to keep the card edge clean ("cards earn their existence"). Note: home-feed card DOES use a top-right overlay per E11 — different grammar, different card.
- **Plain `<a href>` permalink with no JS** (Codex challenge) — considered as a fundamental simplification; rejected because the explicit user requirement is "iPhone share sheet + desktop copy with feedback", neither of which a plain anchor provides.
- **Codex's separate live region for visible label** (E8 partial) — we add a separate aria-live region for state announcements but keep the visible button label as the user-facing affordance (not a redundant duplicate).
- **About page / search / TriageRail share** — only the three study-card surfaces (StudyCard, home recent-feed card). Other UI doesn't have study-level addressability.

## What already exists (leverage)

- **Slug system:** `src/lib/slug.ts` + `slug-resolve.ts` already produce stable per-date study slugs. Per-site page already builds `${date}-${slug}` anchors. No new slug logic.
- **Anchor scroll behavior:** `[date].astro`, `sites/[site].astro`, and the home `<a class="recent-card">` all already render correct anchor URLs. Browser-native anchor scroll works today.
- **Utility-row typography:** `.study-depth > summary` + `.sources > summary` already define the muted-sans + accent-on-hover treatment.
- **CSS variables:** `--fg-muted`, `--accent`, `--font-sans` defined in `Base.astro`; auto-adapts to dark mode.
- **Astro inline-script hoisting:** Base.astro's desktop-depth-auto-expand script is exactly the pattern we're following.
- **Vitest + jsdom:** `vitest` ^4.1.6 is installed; project tests run with `npm test`. jsdom is the default test environment in vitest 4 unless overridden.

## Open / deferred design questions

None. All 11 decisions (6 design + 5 eng/codex) resolved interactively.

## Approved Mockups

None generated. ASCII previews in D2 + E11 captured the placement decisions; the surfaces are small enough that PNG mockups would be overkill. If polish is desired before implementation, run `/design-shotgun` on either card type.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run for this plan |
| Codex Review | `/codex review` | Independent 2nd opinion on diff | 0 | — | runs at PR time |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 5 findings, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 2 | CLEAR (FULL) | StudyCard: 0→10/10 (6 decisions); Home-feed: 4→10/10 (3 decisions) |
| Outside Voice | `/codex` plan review | Cross-model challenge | 1 | issues_found | 3 substantive findings, all incorporated |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not applicable (not developer-facing) |

- **CODEX:** Surfaced 3 substantive findings: relative URL bug (fixed via absolutization), visibility:hidden layout reservation (switched to display:none), clipboard-failure recovery gap (inline URL input added). Plus the scope-expansion suggestion (home-feed share) accepted.
- **CROSS-MODEL:** Eng review found 5 architecture issues; Codex outside voice found 3 more the eng review missed. All 8 addressed.
- **DESIGN R2:** Focused pass on home-feed card surfaced 3 home-card-specific issues: pill collision (moved to bottom-right), hover/focus cross-talk (selector update), tab order (link before button). All resolved.
- **UNRESOLVED:** 0 — every decision is locked.
- **VERDICT:** DESIGN (×2) + ENG + OUTSIDE-VOICE CLEARED. Ready to implement.
