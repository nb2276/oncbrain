import { describe, it, expect } from 'vitest';
import { isOcrEntryFresh, isSafeImageUrl, OCR_VERSION } from '../src/lib/vision-ocr.ts';

describe('isOcrEntryFresh', () => {
  it('accepts a fresh entry (version matches current OCR_VERSION)', () => {
    const entry = { text: 'sample', hash: 'abc', version: OCR_VERSION };
    expect(isOcrEntryFresh(entry)).toBe(true);
  });

  it('rejects entry with stale version', () => {
    const entry = { text: 'sample', hash: 'abc', version: 'v0-old-version' };
    expect(isOcrEntryFresh(entry)).toBe(false);
  });

  it('rejects entry with empty version (legacy / migration path)', () => {
    const entry = { text: 'sample', hash: '', version: '' };
    expect(isOcrEntryFresh(entry)).toBe(false);
  });

  it('rejects undefined entry', () => {
    expect(isOcrEntryFresh(undefined)).toBe(false);
  });

  // We do NOT validate empty-text entries as stale — Vision may legitimately
  // return empty text for an image with no recognizable characters (decorative
  // banner, blurred photo, etc.). Re-OCR'ing those wastes cycles for no gain.
  it('accepts a fresh entry whose text is empty (image had no text)', () => {
    const entry = { text: '', hash: 'abc', version: OCR_VERSION };
    expect(isOcrEntryFresh(entry)).toBe(true);
  });

  // Failed OCR is stored with empty version (FAILED_ENTRY sentinel). Codex P1.
  it('rejects an empty-version entry (failed OCR) so the next build retries', () => {
    const entry = { text: '', hash: '', version: '' };
    expect(isOcrEntryFresh(entry)).toBe(false);
  });
});

describe('isSafeImageUrl', () => {
  it('accepts https pbs.twimg.com URLs', () => {
    expect(isSafeImageUrl('https://pbs.twimg.com/media/HIhlE4r.jpg')).toBe(true);
  });

  it('rejects http (non-TLS) variant', () => {
    expect(isSafeImageUrl('http://pbs.twimg.com/media/a.jpg')).toBe(false);
  });

  it('rejects non-allowlisted hosts even on https', () => {
    expect(isSafeImageUrl('https://attacker.example.com/x.jpg')).toBe(false);
    expect(isSafeImageUrl('https://pbs.twimg.com.attacker.example.com/x.jpg')).toBe(false);
    expect(isSafeImageUrl('https://twimg.com/x.jpg')).toBe(false);
  });

  it('rejects javascript: / data: / file: URLs', () => {
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeImageUrl('data:image/png;base64,iVBOR...')).toBe(false);
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects link-local / internal hosts (SSRF surface)', () => {
    expect(isSafeImageUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeImageUrl('http://localhost:11434/api/tags')).toBe(false);
  });

  it('rejects unparseable URLs', () => {
    expect(isSafeImageUrl('not a url')).toBe(false);
    expect(isSafeImageUrl('')).toBe(false);
  });
});
