import { describe, it, expect } from 'vitest';
import { buildCacheKey, readBuildCache, writeBuildCache } from '../src/lib/build-cache.ts';

// v0.30: the resume cache lets a session-limited multi-study rebuild finish across
// windows. These cover the content-addressing contract the resume behaviour relies
// on: stable keys, input-sensitivity, namespace separation, and read/write round-trip.
describe('build resume cache (v0.30)', () => {
  it('same namespace + payload → identical key (stable, so a re-run hits the cache)', () => {
    expect(buildCacheKey('study', { a: 1, b: 'x' })).toBe(buildCacheKey('study', { a: 1, b: 'x' }));
  });

  it('a different payload → different key (a changed source/model invalidates)', () => {
    expect(buildCacheKey('study', { a: 1 })).not.toBe(buildCacheKey('study', { a: 2 }));
  });

  it('the phase namespace is part of the key (group vs study vs synth never collide)', () => {
    const payload = { a: 1 };
    expect(buildCacheKey('group', payload)).not.toBe(buildCacheKey('study', payload));
    expect(buildCacheKey('study', payload)).not.toBe(buildCacheKey('synth', payload));
  });

  it('write then read round-trips the stored value', () => {
    const key = buildCacheKey('study', { test: 'roundtrip-fixed' });
    const value = { name: 'X', tldr: 'y', analysis_sections: [{ label: 'Design', body: 'b' }] };
    writeBuildCache(key, value);
    expect(readBuildCache(key)).toEqual(value);
  });

  it('a missing key reads null (miss → the phase runs normally)', () => {
    expect(readBuildCache('study-0000000000000000000000000000000000000000')).toBeNull();
  });

  it('respects the TTL — an entry older than the window is a miss (scopes to resume, not permanent)', () => {
    const key = buildCacheKey('study', { test: 'ttl' });
    writeBuildCache(key, { x: 1 });
    // default TTL → fresh hit
    expect(readBuildCache(key)).toEqual({ x: 1 });
    // a negative TTL treats every entry as expired → miss, so a next-day / refresh
    // build can never be answered by a stale cache entry.
    expect(readBuildCache(key, -1)).toBeNull();
  });
});
