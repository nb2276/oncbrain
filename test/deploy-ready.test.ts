import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  digestPageUrl,
  digestOgImageUrl,
  isDatePageDeployed,
  extractBuildStamp,
  servedOgImageUrl,
  waitForDeployedDate,
  type PageProbe,
} from '../src/lib/deploy-ready.ts';

// The live catchall response, reduced to the parts that matter. Verified
// against https://oncbrain.oncologytoolkit.com/2099-01-01/ on 2026-07-30:
// HTTP 200, home-page metadata, default OG card.
const CATCHALL_HTML = `
  <title>onc brain</title>
  <meta name="description" content="Curated AI-summarized digests of oncology updates." />
  <meta property="og:image" content="https://oncbrain.oncologytoolkit.com/og/default.png" />
`;

const STAMP = 1785398602188;  // epoch ms, the artifact's real shape
const OLD_STAMP = 1785312202188;

function deployedHtml(stamp: string | number = STAMP): string {
  return `
    <title>2026-07-29</title>
    <meta name="oncbrain:build" content="${stamp}" />
    <meta property="og:image" content="https://oncbrain.oncologytoolkit.com/og/2026-07-29.png" />
  `;
}

const OK: PageProbe = { html: deployedHtml(), ogImageOk: true };
const NOT_YET: PageProbe = { html: CATCHALL_HTML, ogImageOk: false };

afterEach(() => {
  delete process.env.DEPLOY_WAIT;
  delete process.env.DEPLOY_WAIT_TIMEOUT_MS;
});

describe('URL builders', () => {
  it('builds the announced page URL', () => {
    expect(digestPageUrl('https://oncbrain.oncologytoolkit.com', '2026-07-29')).toBe(
      'https://oncbrain.oncologytoolkit.com/2026-07-29/',
    );
  });

  it('builds the og:image URL Telegram fetches second', () => {
    expect(digestOgImageUrl('https://oncbrain.oncologytoolkit.com', '2026-07-29')).toBe(
      'https://oncbrain.oncologytoolkit.com/og/2026-07-29.png',
    );
  });

  it('tolerates a trailing slash on the site URL', () => {
    expect(digestPageUrl('https://oncbrain.oncologytoolkit.com/', '2026-07-29')).toBe(
      'https://oncbrain.oncologytoolkit.com/2026-07-29/',
    );
    expect(digestOgImageUrl('https://oncbrain.oncologytoolkit.com/', '2026-07-29')).toBe(
      'https://oncbrain.oncologytoolkit.com/og/2026-07-29.png',
    );
  });
});

describe('isDatePageDeployed', () => {
  // The load-bearing case: the catchall returns 200 with real HTML, so any
  // status-based readiness check would pass here. Content is the only signal.
  it('rejects the catchall home page even though it is a valid 200 response', () => {
    expect(isDatePageDeployed(CATCHALL_HTML, '2026-07-29')).toBe(false);
  });

  it('accepts the real date page', () => {
    expect(isDatePageDeployed(deployedHtml(), '2026-07-29')).toBe(true);
  });

  it('rejects a DIFFERENT date page (stale edge serving yesterday)', () => {
    expect(isDatePageDeployed(deployedHtml(), '2026-07-30')).toBe(false);
  });

  it('rejects empty bodies', () => {
    expect(isDatePageDeployed('', '2026-07-29')).toBe(false);
  });

  it('rejects a malformed date rather than matching something odd', () => {
    expect(isDatePageDeployed(deployedHtml(), 'not-a-date')).toBe(false);
  });

  // Build stamp: without it, a re-rendered date is indistinguishable from its
  // previous deploy — the gap the stamp exists to close.
  it('rejects a stale same-date deploy when a build stamp is expected', () => {
    expect(isDatePageDeployed(deployedHtml(OLD_STAMP), '2026-07-29', STAMP)).toBe(false);
  });

  it('accepts when the build stamp matches', () => {
    expect(isDatePageDeployed(deployedHtml(STAMP), '2026-07-29', STAMP)).toBe(true);
  });

  it('falls back to existence-only when no stamp is expected', () => {
    expect(isDatePageDeployed(deployedHtml(OLD_STAMP), '2026-07-29')).toBe(true);
  });

  it('rejects a page with no stamp at all when one is expected', () => {
    const noStamp = `<meta property="og:image" content="/og/2026-07-29.png" />`;
    expect(isDatePageDeployed(noStamp, '2026-07-29', STAMP)).toBe(false);
  });

  // REGRESSION (found by the ship coverage audit, 2026-07-30): the stamp used to
  // be checked with a bare html.includes(stamp) against the whole ~85KB page, so
  // any stamp whose digits appeared anywhere — including a single "1" — passed.
  it('does not accept a stamp that merely appears somewhere in the page', () => {
    expect(isDatePageDeployed(deployedHtml(STAMP), '2026-07-29', 1)).toBe(false);
    expect(isDatePageDeployed(deployedHtml(STAMP), '2026-07-29', 178)).toBe(false);
  });

  it('compares the meta tag value exactly, not as a prefix', () => {
    // A stamp that is a strict prefix of the served one must not pass.
    const served = String(STAMP);
    expect(isDatePageDeployed(deployedHtml(STAMP), '2026-07-29', served.slice(0, -1))).toBe(false);
    expect(isDatePageDeployed(deployedHtml(STAMP), '2026-07-29', served)).toBe(true);
  });

  it('reads the stamp regardless of surrounding markup', () => {
    expect(extractBuildStamp(deployedHtml(STAMP))).toBe(String(STAMP));
    expect(extractBuildStamp(CATCHALL_HTML)).toBeNull();
    expect(extractBuildStamp('')).toBeNull();
  });

  it('reads the stamp with either attribute order', () => {
    expect(extractBuildStamp('<meta name="oncbrain:build" content="42">')).toBe('42');
    expect(extractBuildStamp('<meta content="42" name="oncbrain:build">')).toBe('42');
    // Single quotes and a self-closing slash are both valid emitted forms.
    expect(extractBuildStamp("<meta name='oncbrain:build' content='42' />")).toBe('42');
  });

  it('ignores a stamp-shaped value that is not in the build meta tag', () => {
    const decoy = `<meta name="og:whatever" content="1785398602188">
      <meta property="og:image" content="/og/2026-07-29.png" />`;
    expect(extractBuildStamp(decoy)).toBeNull();
    expect(isDatePageDeployed(decoy, '2026-07-29', STAMP)).toBe(false);
  });
});

describe('servedOgImageUrl', () => {
  // Probing a synthesized /og/<date>.png can pass while Telegram fetches a
  // different asset, if Base.astro's og:image ever changes host/path/query.
  it('reads the og:image the page actually names', () => {
    expect(servedOgImageUrl(deployedHtml())).toBe(
      'https://oncbrain.oncologytoolkit.com/og/2026-07-29.png',
    );
  });

  it('reads the catchall default card too (so the caller can reject it)', () => {
    expect(servedOgImageUrl(CATCHALL_HTML)).toBe(
      'https://oncbrain.oncologytoolkit.com/og/default.png',
    );
  });

  it('returns null when the page names no og:image', () => {
    expect(servedOgImageUrl('<title>x</title>')).toBeNull();
    expect(servedOgImageUrl('')).toBeNull();
  });
});

describe('waitForDeployedDate', () => {
  it('returns once the page and its OG image are both live', async () => {
    const seen: string[] = [];
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      settleMs: 0,
      probe: async (pageUrl, ogUrl) => {
        seen.push(pageUrl, ogUrl);
        return OK;
      },
    });
    expect(res).toMatchObject({ ready: true, reason: 'ready', attempts: 1 });
    expect(seen).toEqual([
      'https://example.test/2026-07-29/',
      'https://example.test/og/2026-07-29.png',
    ]);
  });

  // Regression guard for the ?_deploycheck cache-buster this file used to have:
  // a query param is a DIFFERENT CDN cache key, so probing it proved nothing
  // about the clean URL Telegram actually fetches.
  it('probes the exact clean URL Telegram will fetch, with no query string', async () => {
    const urls: string[] = [];
    await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      settleMs: 0,
      probe: async (pageUrl, ogUrl) => {
        urls.push(pageUrl, ogUrl);
        return OK;
      },
    });
    for (const u of urls) expect(u).not.toContain('?');
    expect(urls[0]).toBe('https://example.test/2026-07-29/');
  });

  // The verified live failure: HTML is up but the OG png still catchalls to
  // text/html. Telegram would render a preview with no card, and cache it.
  it('keeps waiting when the HTML is live but the OG image is not yet an image', async () => {
    let calls = 0;
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      intervalMs: 1,
      settleMs: 0,
      probe: async () => {
        calls += 1;
        return calls < 3 ? { html: deployedHtml(), ogImageOk: false } : OK;
      },
    });
    expect(res.ready).toBe(true);
    expect(res.attempts).toBe(3);
  });

  it('keeps probing while the catchall is served, then succeeds', async () => {
    let calls = 0;
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      intervalMs: 1,
      settleMs: 0,
      probe: async () => {
        calls += 1;
        return calls < 3 ? NOT_YET : OK;
      },
    });
    expect(res.ready).toBe(true);
    expect(res.attempts).toBe(3);
  });

  it('waits out a stale same-date deploy until the new build stamp appears', async () => {
    let calls = 0;
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      expectBuildStamp: STAMP,
      intervalMs: 1,
      settleMs: 0,
      probe: async () => {
        calls += 1;
        return calls < 3
          ? { html: deployedHtml(OLD_STAMP), ogImageOk: true }
          : { html: deployedHtml(STAMP), ogImageOk: true };
      },
    });
    expect(res.ready).toBe(true);
    expect(res.attempts).toBe(3);
  });

  it('gives up after the timeout and reports not-ready instead of hanging', async () => {
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      timeoutMs: 30,
      intervalMs: 5,
      settleMs: 0,
      now: (() => { let t = 0; return () => (t += 4); })(),
      probe: async () => NOT_YET,
      log: () => {},
    });
    expect(res.ready).toBe(false);
    expect(res.reason).toBe('timeout');
    expect(res.attempts).toBeGreaterThan(1);
  });

  // The loop used to quit a full interval BEFORE the deadline, so a deploy
  // landing inside the last interval was missed.
  //
  // Drives a VIRTUAL clock via the injectable `now`, so the assertion doesn't
  // depend on how fast this machine happens to run the loop. An earlier version
  // used real wall-clock margins (40ms budget, 30ms interval) and flaked about
  // 1 run in 9 under parallel load: probe overhead ate the remaining budget and
  // the loop correctly gave up after two probes, which is right behaviour and a
  // wrong test.
  it('still probes at the deadline instead of quitting an interval early', async () => {
    let calls = 0;
    let clock = 0;
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      timeoutMs: 40,
      intervalMs: 30,
      settleMs: 0,
      now: () => clock,
      probe: async () => {
        calls += 1;
        clock += 10; // each probe costs 10 virtual ms
        // Not ready on the first two probes; ready on the third, which only
        // happens if the loop sleeps the REMAINING budget rather than a full
        // interval and then gives up.
        return calls < 3 ? NOT_YET : OK;
      },
      log: () => {},
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(res.ready).toBe(true);
  });

  it('treats a network failure as retryable, not fatal', async () => {
    let calls = 0;
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      intervalMs: 1,
      settleMs: 0,
      probe: async () => {
        calls += 1;
        return calls < 2 ? { html: '', ogImageOk: false } : OK;
      },
    });
    expect(res.ready).toBe(true);
  });

  it('skips the wait entirely when DEPLOY_WAIT=off', async () => {
    process.env.DEPLOY_WAIT = 'off';
    let called = false;
    const res = await waitForDeployedDate('2026-07-29', {
      probe: async () => {
        called = true;
        return NOT_YET;
      },
    });
    expect(res).toMatchObject({ ready: true, reason: 'disabled', attempts: 0 });
    expect(called).toBe(false);
  });

  it('honors DEPLOY_WAIT_TIMEOUT_MS', async () => {
    process.env.DEPLOY_WAIT_TIMEOUT_MS = '20';
    const res = await waitForDeployedDate('2026-07-29', {
      siteUrl: 'https://example.test',
      intervalMs: 5,
      settleMs: 0,
      probe: async () => NOT_YET,
      log: () => {},
    });
    expect(res.ready).toBe(false);
    expect(res.reason).toBe('timeout');
  });

  it('does not probe a malformed date, and lets the caller decide immediately', async () => {
    let called = false;
    const res = await waitForDeployedDate('07-29-2026', {
      probe: async () => {
        called = true;
        return NOT_YET;
      },
    });
    expect(res).toMatchObject({ ready: false, reason: 'invalid-date' });
    expect(called).toBe(false);
  });
});

// The library is well covered above, but the fix is one call in each CLI. If
// those calls are deleted or moved above an early return, every test above
// still passes and the unfurl bug silently returns. Same structural-assertion
// pattern publish-boundary.test.ts uses to pin a guarantee that lives in the
// shape of the source rather than in a return value.
describe('notify CLIs are actually wired to the gate', () => {
  const root = resolve(process.cwd());
  const curator = readFileSync(resolve(root, 'build/notify-curator.ts'), 'utf-8');
  const channel = readFileSync(resolve(root, 'build/notify-channel.ts'), 'utf-8');

  for (const [name, src] of [
    ['notify-curator', curator],
    ['notify-channel', channel],
  ] as const) {
    it(`${name} imports waitForDeployedDate`, () => {
      expect(src).toMatch(/import\s*\{[^}]*waitForDeployedDate[^}]*\}\s*from\s*['"][^'"]*deploy-ready/);
    });

    it(`${name} awaits the gate BEFORE sendMessage`, () => {
      const gate = src.indexOf('waitForDeployedDate(');
      const send = src.indexOf('sendMessage(');
      expect(gate).toBeGreaterThan(-1);
      expect(send).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(send);
    });

    it(`${name} passes the artifact build stamp`, () => {
      expect(src).toContain('expectBuildStamp');
    });
  }

  // The two surfaces deliberately disagree on what a timeout means: the DM is
  // an operational ping (send anyway), the channel post is the product (skip,
  // because posting is what poisons Telegram's preview cache).
  it('notify-channel returns without posting when the page is not confirmed live', () => {
    expect(channel).toMatch(/if\s*\(!ready\.ready\)\s*\{[\s\S]*?return;[\s\S]*?\}/);
  });

  // A skipped post is a missed publication, not a handled error. Exiting 0 would
  // make it invisible in the cron log, which is the failure class this whole
  // change exists to remove.
  it('notify-channel exits non-zero on a skip so the cron log shows a warning', () => {
    expect(channel).toMatch(/process\.exitCode\s*=\s*1/);
  });

  it('notify-curator still sends on a non-ready result (no early return)', () => {
    expect(curator).not.toMatch(/if\s*\(!ready\.ready\)\s*\{[\s\S]{0,400}?return;/);
  });

  // The P0 codex caught at ship: sending the DM with previews ON makes Telegram
  // fetch the not-yet-deployed URL and cache the catchall card — and curator runs
  // BEFORE channel in daily-build.sh, so the DM would poison the very preview the
  // channel is waiting to get right.
  it('notify-curator suppresses the link preview when the page is not confirmed live', () => {
    expect(curator).toMatch(/disableWebPagePreview:\s*!ready\.ready/);
  });
});

// The gate's stale-deploy protection depends on the date page actually EMITTING
// the build stamp. If the meta tag disappears (a Base.astro refactor, a dropped
// prop in [date].astro), isDatePageDeployed silently falls back to existence-only
// — the gate keeps passing and quietly stops catching a stale same-date deploy.
// Nothing else in the suite would notice, so assert it against the real build.
// dist/ is guaranteed by test/global-setup.ts.
describe('date pages emit the build stamp the gate compares', () => {
  const root = resolve(process.cwd());

  it('renders <meta name="oncbrain:build"> with the artifact generated_at', () => {
    const digestDir = resolve(root, 'data/digests');
    const dates = readdirSync(digestDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    const date = dates[dates.length - 1]!;
    const artifact = JSON.parse(readFileSync(resolve(digestDir, `${date}.json`), 'utf-8'));
    const page = resolve(root, `dist/${date}/index.html`);
    if (!existsSync(page)) {
      throw new Error(`expected a built date page at dist/${date}/ — run npm run build`);
    }
    const html = readFileSync(page, 'utf-8');
    expect(html).toContain(`name="oncbrain:build"`);
    expect(html).toContain(String(artifact.generated_at));
    // And the end-to-end contract: the gate accepts this exact page.
    expect(isDatePageDeployed(html, date, artifact.generated_at)).toBe(true);
    // A different stamp must be rejected, or the comparison is doing nothing.
    expect(isDatePageDeployed(html, date, 1)).toBe(false);
  });
});
