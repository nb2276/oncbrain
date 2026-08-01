// Shared scaffolding for the notification CLIs (TODOS P3).
//
// The reason this was worth extracting is recorded by the last test in this
// file: v0.39 added an isInvokedAsScript() guard to notify-curator and missed
// notify-channel, which posts to a PUBLIC Telegram channel. That is exactly the
// "change one, miss the other" failure the TODO predicted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseNotifyArgs,
  siteUrlFromEnv,
  loadDigestArtifact,
  isInvokedAsScript,
  runNotifyCli,
  DEFAULT_SITE_URL,
} from '../src/lib/notify-cli.ts';

describe('parseNotifyArgs', () => {
  const argv = (...rest: string[]) => ['node', 'cli.ts', ...rest];

  it('defaults to today with no flags', () => {
    expect(parseNotifyArgs(argv(), '2026-08-01')).toEqual({ date: '2026-08-01', dryRun: false });
  });

  it('reads --date and --dry-run', () => {
    expect(parseNotifyArgs(argv('--date=2026-05-17', '--dry-run'), '2026-08-01')).toEqual({
      date: '2026-05-17',
      dryRun: true,
    });
  });

  it('ignores unknown flags and a valueless --date', () => {
    expect(parseNotifyArgs(argv('--nope', '--date'), '2026-08-01')).toEqual({
      date: '2026-08-01',
      dryRun: false,
    });
  });
});

describe('siteUrlFromEnv', () => {
  it('prefers PUBLIC_SITE_URL', () => {
    expect(siteUrlFromEnv({ PUBLIC_SITE_URL: 'https://example.test' })).toBe('https://example.test');
  });
  it('falls back to the production origin', () => {
    expect(siteUrlFromEnv({})).toBe(DEFAULT_SITE_URL);
  });
});

describe('loadDigestArtifact', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oncbrain-notify-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a digest', () => {
    writeFileSync(join(dir, '2026-05-17.json'), JSON.stringify({ date: '2026-05-17' }));
    expect(loadDigestArtifact<{ date: string }>('2026-05-17', 'x', { root: dir })?.date).toBe('2026-05-17');
  });

  // A missing digest is an ordinary skip: the cron calls these for dates that may
  // never have built. Returning null (not throwing) is what keeps it quiet.
  it('returns null and logs a skip when the date has no digest', () => {
    const lines: string[] = [];
    expect(loadDigestArtifact('1999-01-01', 'notify:test', { root: dir, log: (m) => lines.push(m) })).toBeNull();
    expect(lines[0]).toMatch(/^notify:test: no digest at .*1999-01-01\.json, skipping$/);
  });
});

describe('isInvokedAsScript', () => {
  const self = fileURLToPath(import.meta.url);

  it('is true when argv[1] is this module', () => {
    expect(isInvokedAsScript(import.meta.url, ['node', self])).toBe(true);
  });
  it('is false when another file was run', () => {
    expect(isInvokedAsScript(import.meta.url, ['node', resolve(process.cwd(), 'package.json')])).toBe(false);
  });
  it('is false with no argv[1] (imported, not executed)', () => {
    expect(isInvokedAsScript(import.meta.url, ['node'])).toBe(false);
  });
});

describe('runNotifyCli', () => {
  it('does NOT run main when the module was merely imported', () => {
    const main = vi.fn().mockResolvedValue(undefined);
    runNotifyCli('notify:test', import.meta.url, main); // real argv points at vitest
    expect(main).not.toHaveBeenCalled();
  });

  // Drives the REAL script path by pointing argv[1] at this module, so
  // isInvokedAsScript matches. Without that this asserts nothing: runNotifyCli
  // correctly does nothing when merely imported.
  function asScript(fn: () => void): void {
    const saved = process.argv;
    process.argv = ['node', fileURLToPath(import.meta.url)];
    try { fn(); } finally { process.argv = saved; }
  }

  it('runs main when the module IS the executed script', async () => {
    const main = vi.fn().mockResolvedValue(undefined);
    asScript(() => runNotifyCli('notify:test', import.meta.url, main));
    expect(main).toHaveBeenCalledTimes(1);
  });

  // Fail-soft: daily-build.sh runs these in sequence after the digest is already
  // built, committed and deployed. A notification failure must not abort the run.
  it('swallows a rejected main and logs it with the CLI label', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      asScript(() =>
        runNotifyCli('notify:test', import.meta.url, () => Promise.reject(new Error('kaboom'))),
      );
      await new Promise((r) => setImmediate(r)); // let the catch settle
      expect(log).toHaveBeenCalledWith('notify:test: unexpected error (kaboom), continuing');
    } finally {
      log.mockRestore();
    }
  });

  it('does not rethrow a non-Error rejection', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      asScript(() => runNotifyCli('notify:test', import.meta.url, () => Promise.reject('plain string')));
      await new Promise((r) => setImmediate(r));
      expect(log).toHaveBeenCalledWith('notify:test: unexpected error (plain string), continuing');
    } finally {
      log.mockRestore();
    }
  });
});

// The regression this whole module exists to prevent.
describe('both notification CLIs are script-guarded', () => {
  const files = ['build/notify-curator.ts', 'build/notify-channel.ts'];

  it('neither calls main() unconditionally at import time', () => {
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      // A bare top-level `main()` is the bug: importing the module runs it.
      expect(src, f).not.toMatch(/^main\(\)/m);
      expect(src, f).toContain('runNotifyCli(');
    }
  });

  it('neither re-implements the shared scaffolding', () => {
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      expect(src, f).not.toContain('PUBLIC_SITE_URL');
      expect(src, f).not.toContain('function parseArgs');
      expect(src, f).not.toContain('realpathSync');
    }
  });
});
