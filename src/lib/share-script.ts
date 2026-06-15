// Client-side share-button wiring for StudyCard + home recent-feed card.
//
// On DOMContentLoaded, queries every button[data-share-url], feature-detects
// once per button, and attaches a click handler that:
//
//   - calls event.stopPropagation() (no-op on StudyCard; required on home
//     feed where the button overlays an <a class="recent-card">),
//   - absolutizes data-share-url against window.location.origin,
//   - calls navigator.share({title, url}) when available,
//     - AbortError (user dismissed sheet) → silent no-op,
//     - other rejections → falls through to clipboard.writeText() with
//       the same flip feedback as the clipboard-only path,
//   - falls back to navigator.clipboard.writeText(url) otherwise,
//     - resolve → icon flips share → checkmark for 1500ms + accent color,
//       aria-live span announces "Copied",
//     - reject → icon flips to alert for 2000ms + accent color, aria-live
//       announces "Couldn't copy", inline recovery <input> reveals with the
//       URL pre-selected and hides again after 10s or on next click.
//
// Per-button state (active timer ids + original icon markup) lives in a
// WeakMap so rapid re-clicks cancel the prior flip-timer and restart cleanly,
// and so the handler stays GC-friendly when buttons are removed from the DOM.
//
// Buttons start hidden (display:none in SSG output); the script reveals them
// only after confirming at least one of the two APIs is present. This avoids
// shipping a non-functional button to insecure contexts and very-old browsers.

interface ShareNav {
  // URL-first share: the link always travels (and link-unfurling apps render the
  // page's OG card as a rich preview). We deliberately do NOT attach image files
  // — many share targets keep the file and drop the URL, leaving the recipient
  // with an image and no link back to the digest.
  share?: (data: { title?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText?: (s: string) => Promise<void> };
}

export interface ShareDeps {
  nav?: ShareNav;
  origin?: string;
  setTimeoutFn?: (cb: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
}

interface ButtonState {
  flipTimer?: number;
  recoveryTimer?: number;
  originalHTML: string;
}

const state = new WeakMap<HTMLButtonElement, ButtonState>();

const FLIP_COPIED_MS = 1500;
const FLIP_FAILED_MS = 2000;
const RECOVERY_VISIBLE_MS = 10_000;

// Inline SVGs kept small (Feather-style 16×16, currentColor). Exported so
// templates and tests can reference the same source-of-truth markup.
export const ICON_SHARE =
  '<svg class="share-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
export const ICON_COPIED =
  '<svg class="share-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
export const ICON_FAILED =
  '<svg class="share-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// Per-button setup. Exported for unit tests so the click handler logic can be
// driven against stub elements + injected globals without a real browser.
export function setupShareButton(
  button: HTMLButtonElement,
  refs: { statusSpan?: HTMLElement | null; recoveryInput?: HTMLInputElement | null } = {},
  deps: ShareDeps = {},
): void {
  const nav: ShareNav = deps.nav ?? (typeof navigator !== 'undefined' ? (navigator as ShareNav) : {});
  const hasShare = typeof nav.share === 'function';
  const hasClipboard = typeof nav.clipboard?.writeText === 'function';

  // Neither API present → leave the button hidden and bail.
  if (!hasShare && !hasClipboard) return;

  // Ensure the rest-state icon is present. The Astro template SSRs the share
  // icon already, but in tests (or if the markup is ever stripped) we re-seed
  // here so the button is never visibly empty.
  if (!button.innerHTML.trim()) button.innerHTML = ICON_SHARE;
  // Reveal after feature detect confirms the button will work. Must be an
  // explicit value (not '') because the CSS default is `display: none` — an
  // empty inline style clears nothing and lets the CSS rule re-apply, leaving
  // the button invisible. inline-flex centers the SVG inside the 44px touch
  // target on both surfaces.
  button.style.display = 'inline-flex';

  state.set(button, { originalHTML: button.innerHTML });

  const setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => (globalThis.setTimeout as unknown as (cb: () => void, ms: number) => number)(cb, ms));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((id: number) => (globalThis.clearTimeout as unknown as (id: number) => void)(id));
  const origin = deps.origin ?? (typeof window !== 'undefined' ? window.location.origin : '');

  button.addEventListener('click', (event) => {
    // Stop the home-feed card link from also firing. Harmless on StudyCard
    // (no ancestor link wraps the button there).
    event.stopPropagation();
    event.preventDefault?.();

    const relativeUrl = button.dataset.shareUrl ?? '';
    if (!relativeUrl) return;
    const absoluteUrl = origin ? new URL(relativeUrl, origin).href : relativeUrl;
    const title = button.dataset.shareTitle ?? '';

    // Cancel any in-flight flip/recovery timer so the next click is a clean
    // fresh action — visible state matches what we just did, not a leftover.
    cancelTimers(button, clearTimeoutFn);
    // Reset visible state to baseline before the new action.
    resetToBaseline(button, refs);

    // The existing URL-share / clipboard path. The image path falls back here.
    function shareUrlOrClipboard(): void {
      if (hasShare) {
        nav.share!({ title, url: absoluteUrl })
          .then(() => { /* shared OK — system handled */ })
          .catch((err: unknown) => {
            const name = (err && typeof err === 'object' && 'name' in err) ? String((err as { name: unknown }).name) : '';
            if (name === 'AbortError') return; // user dismissed sheet — silent
            if (hasClipboard) tryClipboard(button, refs, absoluteUrl, nav, setTimeoutFn, clearTimeoutFn);
          });
      } else if (hasClipboard) {
        tryClipboard(button, refs, absoluteUrl, nav, setTimeoutFn, clearTimeoutFn);
      }
    }

    shareUrlOrClipboard();
  });
}

function tryClipboard(
  button: HTMLButtonElement,
  refs: { statusSpan?: HTMLElement | null; recoveryInput?: HTMLInputElement | null },
  absoluteUrl: string,
  nav: ShareNav,
  setTimeoutFn: (cb: () => void, ms: number) => number,
  clearTimeoutFn: (id: number) => void,
): void {
  nav.clipboard!.writeText!(absoluteUrl)
    .then(() => flipIcon(button, refs, ICON_COPIED, 'Copied', FLIP_COPIED_MS, setTimeoutFn, clearTimeoutFn))
    .catch(() => {
      flipIcon(button, refs, ICON_FAILED, "Couldn't copy", FLIP_FAILED_MS, setTimeoutFn, clearTimeoutFn);
      revealRecoveryInput(button, refs, absoluteUrl, setTimeoutFn, clearTimeoutFn);
    });
}

function flipIcon(
  button: HTMLButtonElement,
  refs: { statusSpan?: HTMLElement | null },
  iconHTML: string,
  status: string,
  ms: number,
  setTimeoutFn: (cb: () => void, ms: number) => number,
  clearTimeoutFn: (id: number) => void,
): void {
  const s = state.get(button);
  if (!s) return;
  if (s.flipTimer !== undefined) clearTimeoutFn(s.flipTimer);

  button.innerHTML = iconHTML;
  button.classList.add('is-flipped');
  if (refs.statusSpan) refs.statusSpan.textContent = status;

  s.flipTimer = setTimeoutFn(() => {
    button.innerHTML = s.originalHTML;
    button.classList.remove('is-flipped');
    if (refs.statusSpan) refs.statusSpan.textContent = '';
    s.flipTimer = undefined;
  }, ms);
}

function revealRecoveryInput(
  button: HTMLButtonElement,
  refs: { recoveryInput?: HTMLInputElement | null },
  absoluteUrl: string,
  setTimeoutFn: (cb: () => void, ms: number) => number,
  clearTimeoutFn: (id: number) => void,
): void {
  const input = refs.recoveryInput;
  if (!input) return;
  const s = state.get(button);
  if (!s) return;
  if (s.recoveryTimer !== undefined) clearTimeoutFn(s.recoveryTimer);

  input.value = absoluteUrl;
  // Explicit display value, NOT '' — see comment on button reveal: clearing
  // the inline style lets the CSS `display: none` rule re-apply, leaving the
  // input invisible. `block` works for both card surfaces.
  input.style.display = 'block';
  // Defer focus + select so platforms that block focus during a rejected
  // promise's microtask still cooperate.
  try {
    input.focus();
    input.select();
  } catch {
    // ignore — focus can throw on detached nodes in tests
  }

  s.recoveryTimer = setTimeoutFn(() => {
    input.style.display = 'none';
    input.value = '';
    s.recoveryTimer = undefined;
  }, RECOVERY_VISIBLE_MS);
}

function cancelTimers(button: HTMLButtonElement, clearTimeoutFn: (id: number) => void): void {
  const s = state.get(button);
  if (!s) return;
  if (s.flipTimer !== undefined) {
    clearTimeoutFn(s.flipTimer);
    s.flipTimer = undefined;
  }
  if (s.recoveryTimer !== undefined) {
    clearTimeoutFn(s.recoveryTimer);
    s.recoveryTimer = undefined;
  }
}

function resetToBaseline(
  button: HTMLButtonElement,
  refs: { statusSpan?: HTMLElement | null; recoveryInput?: HTMLInputElement | null },
): void {
  const s = state.get(button);
  if (s) button.innerHTML = s.originalHTML;
  button.classList.remove('is-flipped');
  if (refs.statusSpan) refs.statusSpan.textContent = '';
  if (refs.recoveryInput) {
    refs.recoveryInput.style.display = 'none';
    refs.recoveryInput.value = '';
  }
}

// Page-level entry point. Idempotent: safe to call more than once (each
// matched button gets fresh state, the WeakMap entry is overwritten).
export function initShareButtons(): void {
  if (typeof document === 'undefined') return;
  const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-share-url]');
  buttons.forEach((button) => {
    const parent = button.parentElement;
    const statusSpan = parent?.querySelector<HTMLElement>('.sr-share-status') ?? null;
    const recoveryInput = parent?.querySelector<HTMLInputElement>('.share-recovery') ?? null;
    setupShareButton(button, { statusSpan, recoveryInput });
  });
}
