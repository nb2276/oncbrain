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
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — extract the v4 tail and re-check.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && mapped[1]) return isPrivateIPv4(mapped[1]);
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: 'manual', // we follow + revalidate ourselves
        signal: controller.signal,
        headers: { 'User-Agent': 'oncbrain/0.8 (+https://oncbrain.oncologytoolkit.com)', ...opts.headers },
      });
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling: resolve Location against the current URL and
    // loop so the next hop gets re-validated.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SsrfError(`redirect with no Location (${res.status})`, current);
      current = new URL(loc, current).toString();
      continue;
    }

    if (!res.ok) {
      throw new SsrfError(`HTTP ${res.status}`, current);
    }

    // Cap the body. Read as text but bail if it's absurdly large.
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > maxBody) {
      throw new SsrfError(`response too large (${lenHeader} bytes)`, current);
    }
    const text = await res.text();
    if (text.length > maxBody) {
      return text.slice(0, maxBody);
    }
    return text;
  }
  throw new SsrfError(`too many redirects (>${MAX_REDIRECTS})`, url);
}

// Exposed for unit testing the guard in isolation.
export { assertSafeUrl, isPrivateIP };
