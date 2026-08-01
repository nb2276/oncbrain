// The stranded-publish-commit bug (TODOS P2, found by codex during /ship v0.32).
//
// scripts/daily-build.sh announces the dates it published. It derived them from
// the current run's STAGED changes only. When a push fails the announce list is
// cleared — correct, nothing reached DigitalOcean — but the commit stays on local
// main, ahead of origin. The NEXT run stages its own changes, derives only its
// own dates, and pushes: the stranded date deploys inside that push and is never
// announced.
//
// These exercise the SHIPPED shell functions against real git repositories, not
// a reimplementation. Git's own semantics (what "ahead of origin" means after a
// fetch, after a ff-merge, on a fresh clone) are most of what could go wrong.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIB = resolve(process.cwd(), 'scripts/lib/publish-dates.sh');

let root: string;
let origin: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();
}

/**
 * Run one of the shipped shell functions in `repo`, under the SAME shell flags
 * daily-build.sh runs with. Without `set -u` here a missing-variable break in
 * the library would pass the tests and only surface at 1am, unattended.
 */
function sh(fn: string, ...args: string[]): string {
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  return execFileSync('bash', ['-c', `set -uo pipefail; . "${LIB}"; ${fn} ${quoted}`], {
    encoding: 'utf-8',
  }).trim();
}

function commitDigest(repo: string, date: string, body = '{}'): void {
  mkdirSync(join(repo, 'data/digests'), { recursive: true });
  writeFileSync(join(repo, `data/digests/${date}.json`), body);
  git(repo, 'add', 'data');
  git(repo, 'commit', '-m', `auto: ${date}`, '--', 'data');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oncbrain-publish-'));
  origin = join(root, 'origin.git');
  clone = join(root, 'work');
  mkdirSync(origin, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 't@e');
  git(clone, 'config', 'user.name', 'T');
  // Seed so main exists on the remote.
  writeFileSync(join(clone, 'README.md'), 'seed\n');
  git(clone, 'add', 'README.md');
  git(clone, 'commit', '-m', 'seed');
  git(clone, 'push', '-u', 'origin', 'main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('unpushed_digest_dates', () => {
  it('is empty when everything is pushed', () => {
    commitDigest(clone, '2026-05-01');
    git(clone, 'push');
    git(clone, 'fetch', 'origin', 'main');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });

  // The bug: a run whose push failed leaves this commit behind.
  it('reports a date committed but never pushed', () => {
    commitDigest(clone, '2026-05-02');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('2026-05-02');
  });

  it('reports every stranded date across several failed runs', () => {
    commitDigest(clone, '2026-05-02');
    commitDigest(clone, '2026-05-03');
    expect(sh('unpushed_digest_dates', clone, 'origin/main').split('\n')).toEqual([
      '2026-05-02',
      '2026-05-03',
    ]);
  });

  it('ignores unpushed commits that touch no digest', () => {
    writeFileSync(join(clone, 'README.md'), 'edit\n');
    git(clone, 'add', 'README.md');
    git(clone, 'commit', '-m', 'docs');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });

  // Announcing an already-deployed date would re-DM the curator and re-post a
  // weeks-old day to the public channel. Over-reporting is the failure mode to
  // avoid, so a pushed date must never appear.
  it('drops a date once it has actually been pushed', () => {
    commitDigest(clone, '2026-05-04');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('2026-05-04');
    git(clone, 'push');
    git(clone, 'fetch', 'origin', 'main');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });

  // Offline, or a base ref that does not exist yet. Note this passes with or
  // without the explicit rev-parse guard in the function — git itself errors and
  // the stderr is suppressed. The guard is there to make the intent explicit
  // rather than depend on that; this test pins the BEHAVIOUR, not the guard.
  it('degrades to empty on an unknown base ref', () => {
    commitDigest(clone, '2026-05-05');
    expect(sh('unpushed_digest_dates', clone, 'origin/nope')).toBe('');
    expect(sh('unpushed_digest_dates', clone, '')).toBe('');
  });

  it('reads only data/digests, not other data files', () => {
    mkdirSync(join(clone, 'data/overrides'), { recursive: true });
    writeFileSync(join(clone, 'data/overrides/2026-05-06.json'), '{}');
    git(clone, 'add', 'data');
    git(clone, 'commit', '-m', 'override', '--', 'data');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });
});

describe('unpushed_digest_dates — net state, not paths touched', () => {
  // NET effect, not "paths touched". One unpushed commit adds a date, a later
  // one removes it: the deployed tree will not have that page, so announcing it
  // would link a 404. A --name-only walk of the ahead commits reports it.
  it('drops a date that a later unpushed commit deleted', () => {
    commitDigest(clone, '2026-05-07');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('2026-05-07');
    rmSync(join(clone, 'data/digests/2026-05-07.json'));
    git(clone, 'add', '-A', 'data');
    git(clone, 'commit', '-m', 'unpublish', '--', 'data');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });

  // Same shape via revert rather than delete: content ends up identical to the
  // remote, so there is nothing new to announce.
  it('drops a date whose content was reverted back to the remote state', () => {
    commitDigest(clone, '2026-05-08', '{"v":1}');
    git(clone, 'push');
    git(clone, 'fetch', 'origin', 'main');
    commitDigest(clone, '2026-05-08', '{"v":2}');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('2026-05-08');
    commitDigest(clone, '2026-05-08', '{"v":1}'); // back to what is deployed
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });
});

describe('resolve_remote_base', () => {
  it('prefers FETCH_HEAD when the fetch succeeds', () => {
    expect(sh('resolve_remote_base', clone)).toBe('FETCH_HEAD');
  });

  // Measured, not assumed: on the git tested here a failed fetch TRUNCATES
  // .git/FETCH_HEAD to zero bytes (checked for both a missing remote ref and an
  // unreachable host), so the fallback below is produced by git's own behaviour
  // and this test passes with or without the explicit fetch-success check in
  // resolve_remote_base. The check is kept as defence for git versions or
  // failure modes where a stale FETCH_HEAD might survive — comparing against a
  // stale remote would invent a backlog and re-announce a deployed date — but
  // this test pins the BEHAVIOUR, not that check.
  it('falls back to origin/main when the fetch fails', () => {
    expect(sh('resolve_remote_base', clone)).toBe('FETCH_HEAD'); // leaves FETCH_HEAD behind
    git(clone, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    expect(sh('resolve_remote_base', clone)).toBe('origin/main');
  });

  it('prints nothing when there is no remote-tracking ref at all', () => {
    const bare = mkdtempSync(join(root, 'solo-'));
    git(root, 'init', '--initial-branch=main', bare);
    git(bare, 'config', 'user.email', 't@e');
    git(bare, 'config', 'user.name', 'T');
    writeFileSync(join(bare, 'x'), 'x');
    git(bare, 'add', 'x');
    git(bare, 'commit', '-m', 'x');
    expect(sh('resolve_remote_base', bare)).toBe('');
  });
});

describe('staged_digest_dates', () => {
  it('reports staged digests and nothing else', () => {
    mkdirSync(join(clone, 'data/digests'), { recursive: true });
    writeFileSync(join(clone, 'data/digests/2026-06-01.json'), '{}');
    writeFileSync(join(clone, 'README.md'), 'x\n');
    git(clone, 'add', 'data', 'README.md');
    expect(sh('staged_digest_dates', clone)).toBe('2026-06-01');
  });

  it('is empty with nothing staged', () => {
    expect(sh('staged_digest_dates', clone)).toBe('');
  });
});

describe('union_dates', () => {
  it('merges, dedupes and sorts', () => {
    expect(sh('union_dates', '2026-05-02\n2026-05-01', '2026-05-02\n2026-05-03').split('\n')).toEqual([
      '2026-05-01', '2026-05-02', '2026-05-03',
    ]);
  });

  it('handles either side being empty', () => {
    expect(sh('union_dates', '2026-05-01', '')).toBe('2026-05-01');
    expect(sh('union_dates', '', '2026-05-01')).toBe('2026-05-01');
    expect(sh('union_dates', '', '')).toBe('');
  });
});

// End-to-end shape of the actual bug, in one test.
describe('the stranded-publish scenario', () => {
  it('run 2 announces the date run 1 stranded, and only until it is pushed', () => {
    // Run 1: builds a digest, commits, push FAILS (simulated by not pushing).
    commitDigest(clone, '2026-07-01');

    // Run 2: builds another digest and stages it.
    mkdirSync(join(clone, 'data/digests'), { recursive: true });
    writeFileSync(join(clone, 'data/digests/2026-07-02.json'), '{}');
    git(clone, 'add', 'data');

    const staged = sh('staged_digest_dates', clone);
    const backlog = sh('unpushed_digest_dates', clone, 'origin/main');
    const announce = sh('union_dates', staged, backlog);

    expect(staged).toBe('2026-07-02');
    expect(backlog).toBe('2026-07-01');
    // Both, because run 2's push carries both commits to DigitalOcean.
    expect(announce.split('\n')).toEqual(['2026-07-01', '2026-07-02']);

    // After run 2 pushes, nothing is outstanding — no repeat announcement.
    git(clone, 'commit', '-m', 'auto: 2026-07-02', '--', 'data');
    git(clone, 'push');
    git(clone, 'fetch', 'origin', 'main');
    expect(sh('unpushed_digest_dates', clone, 'origin/main')).toBe('');
  });
});
