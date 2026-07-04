import { describe, it, expect } from 'vitest';
import {
  assertSafeUrl,
  isPrivateIP,
  ssrfSafeFetchText,
  ssrfSafeFetchBuffer,
  SsrfError,
} from '../src/lib/ssrf-fetch.ts';

// A fake DNS lookup so the guard tests don't hit the network. Maps hostnames
// to controlled IPs.
function fakeLookup(map: Record<string, string[]>) {
  return async (host: string, _opts: { all: true }) => {
    const ips = map[host];
    if (!ips) throw new Error('ENOTFOUND');
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

describe('isPrivateIP', () => {
  it('flags loopback, private, link-local v4', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1']) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });
  it('allows public v4', () => {
    for (const ip of ['1.1.1.1', '140.82.112.3', '8.8.8.8']) {
      expect(isPrivateIP(ip), ip).toBe(false);
    }
  });
  it('flags v6 loopback, link-local, unique-local, mapped-private', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::3', '::ffff:10.0.0.1']) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });
  it('flags the full fe80::/10 link-local range, not just fe80 (codex)', () => {
    for (const ip of ['fe90::1', 'fea0::1', 'feb0::1', 'febf::1']) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });
  it('flags hex-encoded IPv4-mapped link-local (::ffff:a9fe:a9fe = 169.254.169.254)', () => {
    expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true); // AWS metadata
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true); // 127.0.0.1
  });
  it('allows public v6', () => {
    expect(isPrivateIP('2606:4700:4700::1111')).toBe(false);
    // fec0::/10 (site-local, deprecated) is not link-local; the regex is scoped
    // to fe80..febf so a public-ish fe00 prefix outside the range isn't flagged.
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false);
  });
  it('treats malformed input as unsafe', () => {
    expect(isPrivateIP('not-an-ip')).toBe(true);
    expect(isPrivateIP('999.1.1.1')).toBe(true);
  });
});

describe('assertSafeUrl (CRITICAL SSRF guard)', () => {
  const lk = fakeLookup({
    'www.nejm.org': ['140.82.112.3'],
    'evil.example.com': ['10.0.0.1'],
    'rebind.example.com': ['1.1.1.1', '127.0.0.1'], // one public, one private → must reject
  });

  it('accepts an https URL resolving to a public IP', async () => {
    await expect(assertSafeUrl('https://www.nejm.org/doi/full/10.1056/x', lk)).resolves.toBeUndefined();
  });

  it('rejects http (non-https)', async () => {
    await expect(assertSafeUrl('http://www.nejm.org/x', lk)).rejects.toThrow(SsrfError);
  });

  it('rejects a host that resolves to a private IP', async () => {
    await expect(assertSafeUrl('https://evil.example.com/x', lk)).rejects.toThrow(/private address/);
  });

  it('rejects if ANY resolved address is private (rebinding defense)', async () => {
    await expect(assertSafeUrl('https://rebind.example.com/x', lk)).rejects.toThrow(/private address/);
  });

  it('rejects IPv4-literal hosts', async () => {
    await expect(assertSafeUrl('https://127.0.0.1/x', lk)).rejects.toThrow(/IP-literal/);
    await expect(assertSafeUrl('https://1.1.1.1/x', lk)).rejects.toThrow(/IP-literal/);
  });

  it('rejects IPv6-literal hosts', async () => {
    await expect(assertSafeUrl('https://[::1]/x', lk)).rejects.toThrow(/IP-literal/);
  });

  it('rejects decimal/hex numeric hosts (encoded IPv4)', async () => {
    // Node's URL parser canonicalizes integer/hex hosts to dotted-decimal
    // (2130706433 → 127.0.0.1), so these trip the IP-literal guard. Either
    // rejection reason is fine — the security property is that they're refused.
    await expect(assertSafeUrl('https://2130706433/x', lk)).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('https://0x7f000001/x', lk)).rejects.toThrow(SsrfError);
  });

  it('rejects a host that does not resolve', async () => {
    await expect(assertSafeUrl('https://nonexistent.example.com/x', lk)).rejects.toThrow(SsrfError);
  });

  it('rejects malformed URLs', async () => {
    await expect(assertSafeUrl('not a url', lk)).rejects.toThrow(SsrfError);
  });
});

describe('ssrfSafeFetchText', () => {
  const lk = fakeLookup({ 'www.nejm.org': ['140.82.112.3'], 'doi.org': ['1.1.1.1'] });

  it('returns body text on a safe 200', async () => {
    const fetchImpl = (async () =>
      new Response('<html>ok</html>', { status: 200 })) as unknown as typeof fetch;
    const out = await ssrfSafeFetchText('https://www.nejm.org/x', { fetchImpl, lookupImpl: lk });
    expect(out).toBe('<html>ok</html>');
  });

  it('follows + revalidates a redirect, then rejects when the hop is unsafe', async () => {
    // doi.org redirects to a private host — the second hop must be caught.
    const lk2 = fakeLookup({ 'doi.org': ['1.1.1.1'], 'internal.example.com': ['10.0.0.1'] });
    const fetchImpl = (async (url: string) => {
      if (url.includes('doi.org')) {
        return new Response('', { status: 302, headers: { location: 'https://internal.example.com/secret' } });
      }
      return new Response('should not reach', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      ssrfSafeFetchText('https://doi.org/10.1/x', { fetchImpl, lookupImpl: lk2 }),
    ).rejects.toThrow(/private address/);
  });

  it('caps an oversized body', async () => {
    const big = 'x'.repeat(100);
    const fetchImpl = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    const out = await ssrfSafeFetchText('https://www.nejm.org/x', {
      fetchImpl,
      lookupImpl: lk,
      maxBodyBytes: 10,
    });
    expect(out.length).toBe(10);
  });
});

describe('ssrfSafeFetchBuffer (v0.24)', () => {
  const lk = fakeLookup({ 'ftp.ncbi.nlm.nih.gov': ['130.14.29.110'] });

  it('returns the body as a Buffer on a safe 200', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
    const buf = await ssrfSafeFetchBuffer('https://ftp.ncbi.nlm.nih.gov/x.tar.gz', {
      fetchImpl,
      lookupImpl: lk,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });

  it('THROWS (not truncates) on an over-cap body — a partial tarball is corrupt', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(100), {
        status: 200,
        headers: { 'content-length': '100' },
      })) as unknown as typeof fetch;
    await expect(
      ssrfSafeFetchBuffer('https://ftp.ncbi.nlm.nih.gov/x', {
        fetchImpl,
        lookupImpl: lk,
        maxBodyBytes: 10,
      }),
    ).rejects.toThrow(/too large/);
  });

  it('applies the same private-IP guard as the text path', async () => {
    const lkPriv = fakeLookup({ 'evil.example.com': ['10.0.0.5'] });
    const fetchImpl = (async () => new Response(new Uint8Array(1), { status: 200 })) as unknown as typeof fetch;
    await expect(
      ssrfSafeFetchBuffer('https://evil.example.com/x', { fetchImpl, lookupImpl: lkPriv }),
    ).rejects.toThrow(/private address/);
  });

  it('enforces an allowlist and re-checks it on redirect (#P1 host-pin)', async () => {
    const lkAll = fakeLookup({
      'ftp.ncbi.nlm.nih.gov': ['130.14.29.110'],
      'evil.com': ['1.2.3.4'], // public, but not on the allowlist
    });
    const fetchImpl = (async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const allow = { allowedHostSuffixes: ['.ncbi.nlm.nih.gov'] };
    // On-allowlist host is fine.
    await expect(
      ssrfSafeFetchBuffer('https://ftp.ncbi.nlm.nih.gov/x', { fetchImpl, lookupImpl: lkAll, ...allow }),
    ).resolves.toBeInstanceOf(Buffer);
    // A public host NOT on the allowlist is refused even though its IP is public.
    await expect(
      ssrfSafeFetchBuffer('https://evil.com/x', { fetchImpl, lookupImpl: lkAll, ...allow }),
    ).rejects.toThrow(/allowlist/);
    // Look-alike host (suffix-appended) must not slip through.
    const lkLookalike = fakeLookup({ 'ftp.ncbi.nlm.nih.gov.evil.com': ['1.2.3.4'] });
    await expect(
      ssrfSafeFetchBuffer('https://ftp.ncbi.nlm.nih.gov.evil.com/x', {
        fetchImpl,
        lookupImpl: lkLookalike,
        ...allow,
      }),
    ).rejects.toThrow(/allowlist/);
  });
});
