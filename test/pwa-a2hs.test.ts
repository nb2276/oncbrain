import { describe, it, expect } from 'vitest';
import { isIosSafari, shouldShowA2hs } from '../src/lib/pwa-a2hs.ts';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const DESKTOP_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

describe('isIosSafari', () => {
  it('true for iPhone and iPad Safari', () => {
    expect(isIosSafari(IPHONE_SAFARI)).toBe(true);
    expect(isIosSafari(IPAD_SAFARI)).toBe(true);
  });
  it('false for non-Safari iOS browsers (Chrome/Firefox/etc. lack the same flow)', () => {
    expect(isIosSafari(IOS_CHROME)).toBe(false);
    expect(isIosSafari(IPHONE_SAFARI.replace('Safari/604.1', 'FxiOS/120.0 Safari/604.1'))).toBe(false);
  });
  it('false for Android and desktop', () => {
    expect(isIosSafari(ANDROID_CHROME)).toBe(false);
    expect(isIosSafari(DESKTOP_SAFARI)).toBe(false);
  });
});

describe('shouldShowA2hs', () => {
  it('shows on iOS Safari when not installed and not dismissed', () => {
    expect(shouldShowA2hs({ ua: IPHONE_SAFARI, standalone: false, dismissed: false })).toBe(true);
  });
  it('hides when already installed (standalone)', () => {
    expect(shouldShowA2hs({ ua: IPHONE_SAFARI, standalone: true, dismissed: false })).toBe(false);
  });
  it('hides once dismissed', () => {
    expect(shouldShowA2hs({ ua: IPHONE_SAFARI, standalone: false, dismissed: true })).toBe(false);
  });
  it('never shows off iOS Safari', () => {
    expect(shouldShowA2hs({ ua: ANDROID_CHROME, standalone: false, dismissed: false })).toBe(false);
    expect(shouldShowA2hs({ ua: DESKTOP_SAFARI, standalone: false, dismissed: false })).toBe(false);
    expect(shouldShowA2hs({ ua: IOS_CHROME, standalone: false, dismissed: false })).toBe(false);
  });
});
