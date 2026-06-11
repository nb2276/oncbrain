// v0.14.8: iOS "Add to Home Screen" discoverability hint.
//
// iOS Safari has no `beforeinstallprompt` event, so the browser-native install
// affordance never fires there — and the audience is iPhone-heavy. Without a
// nudge, iOS readers have no way to discover they can install the PWA (which is
// fully built: manifest + offline precache). This module is the pure decision
// of WHEN to show the hint; the component (A2hsHint.astro) renders it.

// iOS Safari specifically. The Share -> Add to Home Screen flow is a Safari
// affordance; Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS), Opera (OPiOS), and
// the Google app (GSA) on iOS don't offer it the same way, so don't nudge there.
export function isIosSafari(ua: string): boolean {
  const isIos = /\b(?:iPhone|iPad|iPod)\b/.test(ua);
  if (!isIos) return false;
  const isOtherIosBrowser = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS|GSA|Mercury)\b/.test(ua);
  return !isOtherIosBrowser;
}

// Show the hint only on iOS Safari, only when not already installed
// (standalone), and only if the reader hasn't dismissed it before.
export function shouldShowA2hs(opts: {
  ua: string;
  standalone: boolean;
  dismissed: boolean;
}): boolean {
  if (opts.standalone) return false;
  if (opts.dismissed) return false;
  return isIosSafari(opts.ua);
}
