// SSRF-safe HTTP fetch for curator-pasted paper URLs.
//
// Fetching arbitrary URLs is a server-side-request-forgery surface: a URL
// could resolve to a private/internal address and make the build machine
// fetch something it shouldn't. The curator is the single trusted input so
// real-world risk is low, but the guard is cheap and the URL surface is
// genuinely arbitrary (eng-review + codex finding 4).
//
// Guarantees:
//   - https only
//   - hostname resolved via DNS; every resolved IP checked against
//     private/loopback/link-local ranges (v4 + v6) BEFORE connecting
//   - IP-literal hosts blocked (we only fetch named journal hosts)
//   - redirects followed manually, each hop re-validated, max 3 hops
//   - 10s timeout, response body capped
//
// Residual: a true DNS-rebinding attacker who flips the record between our
// lookup and the kernel's connect could still slip a private IP. For a
// single-curator trusted bot that's out of threat model; documented here so
// the next reader knows it's a conscious limit, not an oversight.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Minimal DNS-lookup signature we depend on (all-addresses form). Narrower
// than the full node:dns overload set so test mocks can satisfy it without
// reproducing every overload.
type LookupAllFn = (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;
const defaultLookup: LookupAllFn = (host, opts) => lookup(host, opts);

export class SsrfError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

// Private / loopback / link-local / reserved ranges that must never be the
// target of an outbound fetch.
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // Link-local is fe80::/10 — the first hextet ranges fe80..febf, NOT just
  // fe80. `startsWith('fe80')` missed fe90::/febf:: (codex). Match the /10.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped IPv6, dotted form (::ffff:10.0.0.1) — re-check the v4 tail.
  const mappedDotted = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted && mappedDotted[1]) return isPrivateIPv4(mappedDotted[1]);
  // IPv4-mapped IPv6, HEX form (::ffff:a9fe:a9fe == 169.254.169.254, the AWS
  // metadata link-local). Node's isIP accepts this shape and it can encode a
  // private/link-local v4, so decode the two hextets to dotted-quad and re-check.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateIP(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a valid IP → unsafe
}

// Validate a single URL: https, named host (not an IP literal), and every
// DNS-resolved address is public. Throws SsrfError on any violation.
async function assertSafeUrl(rawUrl: string, lookupImpl: LookupAllFn = defaultLookup): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError('malformed URL', rawUrl);
  }
  if (u.protocol !== 'https:') {
    throw new SsrfError(`refused non-https URL (${u.protocol})`, rawUrl);
  }
  // Reject IP-literal hosts in any form — we only fetch named journal hosts.
  // Strip brackets for IPv6 literals before the check.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    throw new SsrfError('refused IP-literal host', rawUrl);
  }
  // A bare integer or hex host (decimal/octal/hex IPv4 encodings) is never a
  // legitimate journal hostname.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    throw new SsrfError('refused numeric host', rawUrl);
  }
  // Resolve and check EVERY address the host maps to.
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupImpl(host, { all: true });
  } catch {
    throw new SsrfError('DNS resolution failed', rawUrl);
  }
  if (addrs.length === 0) throw new SsrfError('host did not resolve', rawUrl);
  for (const { address } of addrs) {
    if (isPrivateIP(address)) {
      throw new SsrfError(`host resolves to a private address (${address})`, rawUrl);
    }
  }
}

export type SsrfFetchOptions = {
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  headers?: Record<string, string>;
};

// Fetch a curator-pasted URL with SSRF protection + manual redirect
// revalidation. Returns the response body text (capped). Throws SsrfError
// for any safety violation and the underlying error for network failures.
export async function ssrfSafeFetchText(
  url: string,
  opts: SsrfFetchOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookupImpl = opts.lookupImpl ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current, lookupImpl); // re-validate EVERY hop

    const controller = new AbortController();
    // Keep the timer armed across BOTH the fetch AND the body read — a hostile
    // server can dribble bytes under the connect timeout, so the read needs the
    // same deadline. The finally clears it on redirect (continue), error, or
    // success (return).
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, {
        redirect: 'manual', // we follow + revalidate ourselves
        signal: controller.signal,
        headers: { 'User-Agent': 'oncbrain/0.8 (+https://oncbrain.oncologytoolkit.com)', ...opts.headers },
      });

      // Manual redirect handling: resolve Location against the current URL and
      // loop so the next hop gets re-validated.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new SsrfError(`redirect with no Location (${res.status})`, current);
        current = new URL(loc, current).toString();
        continue; // finally clears the timer before the next hop
      }

      if (!res.ok) {
        throw new SsrfError(`HTTP ${res.status}`, current);
      }

      // Reject up front on an oversized Content-Length, but a chunked response
      // (no Content-Length) could stream unbounded bytes, so read the body
      // INCREMENTALLY and stop once we pass the cap rather than buffering the
      // whole thing via res.text() (the old path → OOM on a hostile/huge body).
      const lenHeader = res.headers.get('content-length');
      if (lenHeader && Number(lenHeader) > maxBody) {
        controller.abort();
        throw new SsrfError(`response too large (${lenHeader} bytes)`, current);
      }
      return await readBodyCapped(res, maxBody);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SsrfError(`too many redirects (>${MAX_REDIRECTS})`, url);
}

// Read a response body, stopping once `maxBody` bytes have been seen, so a
// chunked / no-Content-Length response can't buffer unbounded memory. Matches
// the prior truncate-not-throw behavior for an over-cap body. Falls back to
// res.text() when the response has no readable stream (some fetch mocks).
async function readBodyCapped(res: Response, maxBody: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBody ? text.slice(0, maxBody) : text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total > maxBody) {
        await reader.cancel();
        return out.slice(0, maxBody);
      }
    }
  } finally {
    // Release the lock; cancel is a no-op if the stream already ended.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  out += decoder.decode();
  return out.length > maxBody ? out.slice(0, maxBody) : out;
}

// Exposed for unit testing the guard in isolation.
export { assertSafeUrl, isPrivateIP };
