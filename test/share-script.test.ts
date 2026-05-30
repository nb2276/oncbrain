import { describe, it, expect, vi } from 'vitest';
import {
  setupShareButton,
  ICON_SHARE,
  ICON_COPIED,
  ICON_FAILED,
  type ShareDeps,
} from '../src/lib/share-script.ts';

// These tests drive setupShareButton against stub DOM nodes + injected deps,
// so we don't need jsdom. The point is to verify the state machine: feature
// detect, icon adaptation, Web Share happy + abort + non-abort, clipboard
// happy + failure, recovery input reveal, timer cancel-on-rapid-click,
// stopPropagation, and absolute-URL construction at click time.

interface StubButton {
  innerHTML: string;
  dataset: Record<string, string>;
  style: { display: string };
  classList: {
    add: (c: string) => void;
    remove: (c: string) => void;
    contains: (c: string) => boolean;
  };
  _classes: Set<string>;
  _listeners: Map<string, EventListener>;
  click: () => Promise<{ stopPropagation: ReturnType<typeof vi.fn>; preventDefault: ReturnType<typeof vi.fn> }>;
}

function makeButton(overrides: Partial<{ shareUrl: string; shareTitle: string; innerHTML: string }> = {}): StubButton {
  const listeners = new Map<string, EventListener>();
  const classes = new Set<string>();
  return {
    // Match what the Astro template ships server-side: rest-state share icon.
    innerHTML: overrides.innerHTML ?? ICON_SHARE,
    dataset: {
      shareUrl: overrides.shareUrl ?? '/sites/prostate/#2026-05-17-prestige-psma',
      shareTitle: overrides.shareTitle ?? 'PRESTIGE-PSMA',
    },
    style: { display: 'none' },
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
    },
    _classes: classes,
    _listeners: listeners,
    click: async () => {
      const event = {
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
      };
      const handler = listeners.get('click');
      if (handler) handler(event as unknown as Event);
      // Let any microtasks (resolved/rejected promises) flush.
      await Promise.resolve();
      await Promise.resolve();
      return event;
    },
  };
}

// Monkey-patch addEventListener into the stub at call time. Sets up the
// listener map so .click() can dispatch. Returns the SAME stub object so
// tests can keep their StubButton typing for ._classes / ._listeners reads.
function attachListenerAPI(b: StubButton): StubButton {
  (b as unknown as { addEventListener: HTMLButtonElement['addEventListener'] }).addEventListener =
    ((type: string, fn: EventListener) => {
      b._listeners.set(type, fn);
    }) as HTMLButtonElement['addEventListener'];
  return b;
}

// Cast helper for passing the stub to setupShareButton's strict signature.
function asButton(b: StubButton): HTMLButtonElement {
  return b as unknown as HTMLButtonElement;
}

function makeStatusSpan(): { textContent: string } {
  return { textContent: '' };
}
function makeRecoveryInput(): {
  value: string;
  style: { display: string };
  focus: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
} {
  return {
    value: '',
    style: { display: 'none' },
    focus: vi.fn(),
    select: vi.fn(),
  };
}

function makeDeps(opts: {
  hasShare?: boolean;
  hasClipboard?: boolean;
  shareReject?: Error;
  clipboardReject?: Error;
  origin?: string;
} = {}): { deps: ShareDeps; shareFn?: ReturnType<typeof vi.fn>; writeTextFn?: ReturnType<typeof vi.fn>; timeouts: Map<number, () => void> } {
  const timeouts = new Map<number, () => void>();
  let nextTimerId = 1;

  const shareFn = opts.hasShare
    ? vi.fn((_data: { title?: string; url: string }) =>
        opts.shareReject ? Promise.reject(opts.shareReject) : Promise.resolve(),
      )
    : undefined;
  const writeTextFn = opts.hasClipboard
    ? vi.fn((_s: string) =>
        opts.clipboardReject ? Promise.reject(opts.clipboardReject) : Promise.resolve(),
      )
    : undefined;

  const deps: ShareDeps = {
    nav: {
      share: shareFn,
      clipboard: writeTextFn ? { writeText: writeTextFn } : undefined,
    },
    origin: opts.origin ?? 'https://oncbrain.test',
    setTimeoutFn: ((cb: () => void, _ms: number) => {
      const id = nextTimerId++;
      timeouts.set(id, cb);
      return id;
    }) as ShareDeps['setTimeoutFn'],
    clearTimeoutFn: ((id: number) => {
      timeouts.delete(id);
    }) as ShareDeps['clearTimeoutFn'],
  };

  return { deps, shareFn, writeTextFn, timeouts };
}

// Helper to fire whatever pending timeout is registered. Tests only care
// about *whether* the timeout fired with the right side-effects, not the
// scheduled delay; our stub setTimeoutFn ignores the ms argument.
function fireAllTimeouts(timeouts: Map<number, () => void>): void {
  const callbacks = Array.from(timeouts.values());
  timeouts.clear();
  for (const cb of callbacks) cb();
}

describe('setupShareButton — feature detect + reveal', () => {
  it('both APIs present: share icon preserved, button revealed', () => {
    const b = attachListenerAPI(makeButton());
    const { deps } = makeDeps({ hasShare: true, hasClipboard: true });
    setupShareButton(asButton(b), {}, deps);
    expect(b.innerHTML).toBe(ICON_SHARE);
    expect(b.style.display).toBe('inline-flex');
  });

  it('clipboard only: share icon preserved (universal label), button revealed', () => {
    const b = attachListenerAPI(makeButton());
    const { deps } = makeDeps({ hasShare: false, hasClipboard: true });
    setupShareButton(asButton(b), {}, deps);
    expect(b.innerHTML).toBe(ICON_SHARE);
    expect(b.style.display).toBe('inline-flex');
  });

  it('empty button: re-seeds the share icon as a safety net', () => {
    const b = attachListenerAPI(makeButton({ innerHTML: '' }));
    const { deps } = makeDeps({ hasShare: true });
    setupShareButton(asButton(b), {}, deps);
    expect(b.innerHTML).toBe(ICON_SHARE);
  });

  it('neither API: button stays hidden (no reveal)', () => {
    const b = attachListenerAPI(makeButton({ innerHTML: '' }));
    const { deps } = makeDeps({ hasShare: false, hasClipboard: false });
    setupShareButton(asButton(b), {}, deps);
    expect(b.innerHTML).toBe(''); // never re-seeded
    expect(b.style.display).toBe('none');
  });
});

describe('setupShareButton — Web Share click path', () => {
  it('share resolves: no icon change', async () => {
    const b = attachListenerAPI(makeButton());
    const { deps, shareFn } = makeDeps({ hasShare: true });
    setupShareButton(asButton(b), {}, deps);
    const ev = await b.click();
    expect(shareFn).toHaveBeenCalledOnce();
    expect(b.innerHTML).toBe(ICON_SHARE); // unchanged
    expect(ev.stopPropagation).toHaveBeenCalledOnce();
  });

  it('share rejects AbortError: silent (no icon change, no clipboard fallback)', async () => {
    const b = attachListenerAPI(makeButton());
    const abortErr = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const { deps, shareFn, writeTextFn } = makeDeps({
      hasShare: true,
      hasClipboard: true,
      shareReject: abortErr,
    });
    setupShareButton(asButton(b), {}, deps);
    await b.click();
    expect(shareFn).toHaveBeenCalledOnce();
    expect(writeTextFn).not.toHaveBeenCalled();
    expect(b.innerHTML).toBe(ICON_SHARE);
  });

  it('share rejects non-AbortError: falls through to clipboard.writeText', async () => {
    const b = attachListenerAPI(makeButton());
    const status = makeStatusSpan();
    const recovery = makeRecoveryInput();
    const notAllowed = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { deps, shareFn, writeTextFn, timeouts } = makeDeps({
      hasShare: true,
      hasClipboard: true,
      shareReject: notAllowed,
    });
    setupShareButton(asButton(b), { statusSpan: status as unknown as HTMLElement, recoveryInput: recovery as unknown as HTMLInputElement }, deps);
    await b.click();
    expect(shareFn).toHaveBeenCalledOnce();
    expect(writeTextFn).toHaveBeenCalledOnce();
    expect(b.innerHTML).toBe(ICON_COPIED);
    expect(b._classes.has('is-flipped')).toBe(true);
    expect(status.textContent).toBe('Copied');
    // Fire the revert timer — icon restores.
    fireAllTimeouts(timeouts);
    expect(b.innerHTML).toBe(ICON_SHARE); // back to original
    expect(b._classes.has('is-flipped')).toBe(false);
    expect(status.textContent).toBe('');
  });
});

describe('setupShareButton — clipboard click path', () => {
  it('clipboard resolves: icon flips share → check for one window, aria-live announces Copied', async () => {
    const b = attachListenerAPI(makeButton());
    const status = makeStatusSpan();
    const { deps, writeTextFn, timeouts } = makeDeps({ hasClipboard: true });
    setupShareButton(asButton(b), { statusSpan: status as unknown as HTMLElement }, deps);
    await b.click();
    expect(writeTextFn).toHaveBeenCalledOnce();
    expect(b.innerHTML).toBe(ICON_COPIED);
    expect(b._classes.has('is-flipped')).toBe(true);
    expect(status.textContent).toBe('Copied');
    fireAllTimeouts(timeouts);
    expect(b.innerHTML).toBe(ICON_SHARE);
    expect(status.textContent).toBe('');
  });

  it('clipboard rejects: icon flips to alert, status announces "Couldn\'t copy", recovery input revealed + pre-selected', async () => {
    const b = attachListenerAPI(makeButton());
    const status = makeStatusSpan();
    const recovery = makeRecoveryInput();
    const { deps } = makeDeps({
      hasClipboard: true,
      clipboardReject: new Error('blocked'),
    });
    setupShareButton(asButton(b), { statusSpan: status as unknown as HTMLElement, recoveryInput: recovery as unknown as HTMLInputElement }, deps);
    await b.click();
    expect(b.innerHTML).toBe(ICON_FAILED);
    expect(b._classes.has('is-flipped')).toBe(true);
    expect(status.textContent).toBe("Couldn't copy");
    expect(recovery.value).toBe('https://oncbrain.test/sites/prostate/#2026-05-17-prestige-psma');
    expect(recovery.style.display).toBe('block');
    expect(recovery.focus).toHaveBeenCalled();
    expect(recovery.select).toHaveBeenCalled();
  });
});

describe('setupShareButton — URL absolutization', () => {
  it('passes absolute URL to navigator.share (origin + relative path)', async () => {
    const b = attachListenerAPI(makeButton({ shareUrl: '/sites/breast/#2026-04-01-trial' }));
    const { deps, shareFn } = makeDeps({ hasShare: true, origin: 'https://oncbrain.example' });
    setupShareButton(asButton(b), {}, deps);
    await b.click();
    expect(shareFn).toHaveBeenCalledWith({
      title: 'PRESTIGE-PSMA',
      url: 'https://oncbrain.example/sites/breast/#2026-04-01-trial',
    });
  });

  it('passes absolute URL to clipboard.writeText', async () => {
    const b = attachListenerAPI(makeButton({ shareUrl: '/sites/breast/#2026-04-01-trial' }));
    const { deps, writeTextFn } = makeDeps({ hasClipboard: true, origin: 'https://oncbrain.example' });
    setupShareButton(asButton(b), {}, deps);
    await b.click();
    expect(writeTextFn).toHaveBeenCalledWith('https://oncbrain.example/sites/breast/#2026-04-01-trial');
  });
});

describe('setupShareButton — rapid re-click', () => {
  it('cancels prior flip timer when clicked again during the window', async () => {
    const b = attachListenerAPI(makeButton());
    const { deps, timeouts } = makeDeps({ hasClipboard: true });
    setupShareButton(asButton(b), {}, deps);
    await b.click();
    expect(timeouts.size).toBe(1); // first flip timer registered
    const firstTimerKeys = Array.from(timeouts.keys());
    await b.click();
    // Second click clears the prior timer and registers a fresh one.
    expect(timeouts.size).toBe(1);
    const secondTimerKeys = Array.from(timeouts.keys());
    expect(secondTimerKeys).not.toEqual(firstTimerKeys);
  });
});

describe('setupShareButton — stopPropagation + edge cases', () => {
  it('stopPropagation called on every click (home-feed link suppression)', async () => {
    const b = attachListenerAPI(makeButton());
    const { deps } = makeDeps({ hasShare: true });
    setupShareButton(asButton(b), {}, deps);
    const ev = await b.click();
    expect(ev.stopPropagation).toHaveBeenCalledOnce();
  });

  it('handler is no-op when data-share-url is empty', async () => {
    const b = attachListenerAPI(makeButton({ shareUrl: '' }));
    const { deps, shareFn } = makeDeps({ hasShare: true });
    setupShareButton(asButton(b), {}, deps);
    await b.click();
    expect(shareFn).not.toHaveBeenCalled();
  });
});
