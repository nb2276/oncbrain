// A failed nightly build must not strand its date.
//
// scripts/daily-build.sh builds only today and yesterday. When one of those
// builds failed (TORPEdO, 2026-09-09: the claude-cli session limit), the run
// logged it and moved on, the window left the date behind, and rebuild_queue was
// empty — enrichment queues a date for richer data or an out-of-window source,
// never for a build that broke. The paper sat unpublished for five days.
//
// The shell tests run the SHIPPED function bodies out of daily-build.sh, under
// the same shell flags, with npm stubbed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, listRebuildQueue } from '../src/lib/db.ts';

const SCRIPT = resolve(process.cwd(), 'scripts/daily-build.sh');
const TSX = resolve(process.cwd(), 'node_modules/.bin/tsx');
const CLI = resolve(process.cwd(), 'build/queue-rebuild.ts');

function shellFunction(source: string, name: string): string {
  const m = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  if (!m) throw new Error(`${name}() not found in daily-build.sh`);
  return m[0];
}

describe('daily-build.sh build_day', () => {
  const source = readFileSync(SCRIPT, 'utf-8');

  // npm stub: build:day fails for any date listed in $FAIL_DATES.
  function run(failDates: string): Record<string, string> {
    const script = [
      'set -uo pipefail',
      'FAILED=0; DIGEST_FAILED=0; FAILED_BUILD_DATES=""',
      'npm() { for a in "$@"; do case "$a" in --date=*) case " $FAIL_DATES " in *" ${a#--date=} "*) return 3;; esac;; esac; done; return 0; }',
      shellFunction(source, 'critical_digest'),
      shellFunction(source, 'build_day'),
      'build_day 2026-09-09',
      'build_day 2026-09-10',
      'echo "FAILED=$FAILED"; echo "DIGEST_FAILED=$DIGEST_FAILED"; echo "DATES=$(echo $FAILED_BUILD_DATES)"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, FAIL_DATES: failDates },
    });
    return Object.fromEntries(
      out
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  }

  it('records nothing when every build succeeds', () => {
    expect(run('')).toEqual({ FAILED: '0', DIGEST_FAILED: '0', DATES: '' });
  });

  it('records the failed date and still gates the publish', () => {
    expect(run('2026-09-09')).toEqual({ FAILED: '1', DIGEST_FAILED: '1', DATES: '2026-09-09' });
  });

  it('records both dates when both fail', () => {
    expect(run('2026-09-09 2026-09-10').DATES).toBe('2026-09-09 2026-09-10');
  });

  it('queues failed dates after the drain, not before it', () => {
    // Before the drain, queuedAfterBuild fails open on the missing artifact and
    // the drain retries in the same run, into the limit that just failed it.
    const drain = source.indexOf('npm run rebuild:queued');
    const queue = source.indexOf('npm run queue:rebuild');
    expect(drain).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(drain);
    expect(source).toMatch(/for d in \$FAILED_BUILD_DATES/);
  });
});

describe('queue:rebuild CLI', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oncbrain-queue-rebuild-'));
    dbPath = join(dir, 'test.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function cli(...args: string[]) {
    return spawnSync(TSX, [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, DB_PATH: dbPath },
    });
  }

  it('queues the date with its reason', () => {
    const res = cli('--date=2026-09-09', '--reason=nightly build:day failed');
    expect(res.status).toBe(0);
    const db = openDb(dbPath);
    const queued = listRebuildQueue(db);
    db.close();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      bookmark_date: '2026-09-09',
      reason: 'nightly build:day failed',
      attempts: 0,
    });
  });

  it('refuses a missing or malformed date without touching the DB', () => {
    for (const args of [[], ['--date=2026-9-9'], ['--date=yesterday']]) {
      const res = cli(...args);
      expect(res.status).toBe(2);
    }
    const db = openDb(dbPath);
    expect(listRebuildQueue(db)).toEqual([]);
    db.close();
  });

  it('is import-safe', async () => {
    // Run on import, main() would find no --date in vitest's argv and set exit 2.
    const before = process.exitCode;
    await import('../build/queue-rebuild.ts');
    expect(process.exitCode).toBe(before);
  });
});
