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
//     - resolve → label flips Copy link → Copied for 1500ms + accent color,
//       aria-live span announces "Copied",
//     - reject → label flips to Couldn't copy for 2000ms + accent color,
//       inline recovery <input> reveals with the URL pre-selected and
//       hides again after 10s or on next click.
//
// Per-button state (active timer ids + original label) lives in a WeakMap so
// rapid re-clicks cancel the prior flip-timer and restart cleanly, and so the
// handler stays GC-friendly when buttons are removed from the DOM.
//
// Buttons start hidden (display:none in SSG output); the script reveals them
// only after confirming at least one of the two APIs is present. This avoids
// shipping a non-functional button to insecure contexts and very-old browsers.

interface ShareNav {
  share?: (data: { title?: string; url: string }) => Promise<void>;
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
  originalLabel: string;
}

const state = new WeakMap<HTMLButtonElement, ButtonState>();

const FLIP_COPIED_MS = 1500;
const FLIP_FAILED_MS = 2000;
const RECOVERY_VISIBLE_MS = 10_000;

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

  // Pick the label that matches what will actually happen on click.
  button.textContent = hasShare ? 'Share' : 'Copy link';
  // Reveal after feature detect confirms the button will work. Must be an
  // explicit value (not '') because the CSS default is `display: none` — an
  // empty inline style clears nothing and lets the CSS rule re-apply, leaving
  // the button invisible. inline-block works for both the StudyCard flex row
  // and the home-feed absolute overlay.
  button.style.display = 'inline-block';

  state.set(button, { originalLabel: button.textContent });

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

    if (hasShare) {
      nav.share!({ title, url: absoluteUrl })
        .then(() => { /* shared OK — system handled */ })
        .catch((err: unknown) => {
          const name = (err && typeof err === 'object' && 'name' in err) ? String((err as { name: unknown }).name) : '';
          if (name === 'AbortError') return; // user dismissed sheet — silent
          // Non-Abort rejection → fall through to clipboard.
          if (hasClipboard) {
            tryClipboard(button, refs, absoluteUrl, nav, setTimeoutFn, clearTimeoutFn);
          }
        });
    } else if (hasClipboard) {
      tryClipboard(button, refs, absoluteUrl, nav, setTimeoutFn, clearTimeoutFn);
    }
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
    .then(() => flipLabel(button, refs, 'Copied', FLIP_COPIED_MS, setTimeoutFn, clearTimeoutFn))
    .catch(() => {
      flipLabel(button, refs, "Couldn't copy", FLIP_FAILED_MS, setTimeoutFn, clearTimeoutFn);
      revealRecoveryInput(button, refs, absoluteUrl, setTimeoutFn, clearTimeoutFn);
    });
}

function flipLabel(
  button: HTMLButtonElement,
  refs: { statusSpan?: HTMLElement | null },
  newLabel: string,
  ms: number,
  setTimeoutFn: (cb: () => void, ms: number) => number,
  clearTimeoutFn: (id: number) => void,
): void {
  const s = state.get(button);
  if (!s) return;
  if (s.flipTimer !== undefined) clearTimeoutFn(s.flipTimer);

  button.textContent = newLabel;
  button.classList.add('is-flipped');
  if (refs.statusSpan) refs.statusSpan.textContent = newLabel;

  s.flipTimer = setTimeoutFn(() => {
    button.textContent = s.originalLabel;
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
  input.style.display = '';
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
  if (s) button.textContent = s.originalLabel;
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
