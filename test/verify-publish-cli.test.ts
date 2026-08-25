// The CLI is the guard that actually runs in the nightly cron, so exercise it
// against a real git repository rather than mocking git.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'build/verify-publish.ts');

const artifact = (studies: Array<[string, string]>, aliases: string[] = []) =>
  JSON.stringify({
    digest: { sites: [{ studies: studies.map(([slug, name]) => ({ slug, name })) }] },
    slug_aliases: aliases,
  });

describe('verify-publish CLI', () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  // Withheld dates are reported on stderr and the exit code stays 0 (the run
  // should publish the good dates), so both streams have to be captured.
  const run = () => {
    try {
      return execSync(`npx tsx ${JSON.stringify(CLI)} --worktree=${JSON.stringify(repo)} 2>&1`, {
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  };

  const digestPath = (date: string) => join(repo, 'data/digests', `${date}.json`);
  const readDigest = (date: string) => JSON.parse(readFileSync(digestPath(date), 'utf8'));

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'oncbrain-verify-'));
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 'T');
    mkdirSync(join(repo, 'data/digests'), { recursive: true });
    mkdirSync(join(repo, 'data/overrides'), { recursive: true });
    mkdirSync(join(repo, 'data/obsidian'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const commitBaseline = (date: string, studies: Array<[string, string]>) => {
    writeFileSync(digestPath(date), artifact(studies));
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');
  };

  it('withholds a date whose publish would remove a live card, restoring main’s copy', () => {
    commitBaseline('2026-07-08', [['alpha', 'ALPHA'], ['charlie', 'CHARLIE']]);
    // The stale-branch rebuild has never heard of CHARLIE.
    writeFileSync(digestPath('2026-07-08'), artifact([['alpha', 'ALPHA']]));
    git('add', '-A');

    const out = run();
    expect(out).toContain('WITHHELD 2026-07-08');
    expect(out).toContain('CHARLIE');
    // main's version is back on disk — the commit would carry no regression.
    expect(readDigest('2026-07-08').digest.sites[0].studies).toHaveLength(2);
  });

  it('lets an ordinary publish through untouched', () => {
    commitBaseline('2026-07-08', [['alpha', 'ALPHA']]);
    writeFileSync(digestPath('2026-07-08'), artifact([['alpha', 'ALPHA'], ['bravo', 'BRAVO']]));
    git('add', '-A');

    const out = run();
    expect(out).not.toContain('WITHHELD');
    expect(readDigest('2026-07-08').digest.sites[0].studies).toHaveLength(2);
  });

  it('withholds ONLY the bad date, so today still publishes', () => {
    commitBaseline('2026-07-08', [['alpha', 'ALPHA'], ['charlie', 'CHARLIE']]);
    writeFileSync(digestPath('2026-07-08'), artifact([['alpha', 'ALPHA']]));
    writeFileSync(digestPath('2026-08-24'), artifact([['fresh', 'FRESH']]));
    git('add', '-A');

    run();
    expect(readDigest('2026-07-08').digest.sites[0].studies).toHaveLength(2); // restored
    expect(readDigest('2026-08-24').digest.sites[0].studies).toHaveLength(1); // untouched
  });

  it('honours a suppress override as a deliberate removal', () => {
    commitBaseline('2026-07-08', [['alpha', 'ALPHA'], ['bravo', 'BRAVO']]);
    writeFileSync(digestPath('2026-07-08'), artifact([['alpha', 'ALPHA']]));
    writeFileSync(join(repo, 'data/overrides/2026-07-08.json'), JSON.stringify({ suppress: ['bravo'] }));
    git('add', '-A');

    const out = run();
    expect(out).not.toContain('WITHHELD');
    expect(readDigest('2026-07-08').digest.sites[0].studies).toHaveLength(1);
  });

  it('ignores a date main has never published', () => {
    commitBaseline('2026-07-08', [['alpha', 'ALPHA']]);
    writeFileSync(digestPath('2026-08-24'), artifact([['new', 'NEW']]));
    git('add', '-A');
    expect(run()).not.toContain('WITHHELD');
  });
});

// A DATE PUBLISHES AS A SET. The artifact and its Obsidian twin are committed in
// the same push, so reverting only the JSON would ship main's studies next to the
// rejected build's prose — a twin describing cards the artifact does not contain,
// which is worse than either version alone.
describe('verify-publish reverts a withheld date as a unit', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const run = () =>
    execSync(`npx tsx ${JSON.stringify(CLI)} --worktree=${JSON.stringify(repo)} 2>&1`, {
      encoding: 'utf8',
    });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'oncbrain-unit-'));
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 'T');
    mkdirSync(join(repo, 'data/digests'), { recursive: true });
    mkdirSync(join(repo, 'data/obsidian'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('restores the Obsidian twin alongside the artifact', () => {
    writeFileSync(join(repo, 'data/digests/2026-07-08.json'), artifact([['alpha', 'ALPHA'], ['charlie', 'CHARLIE']]));
    writeFileSync(join(repo, 'data/obsidian/2026-07-08.md'), '# published: ALPHA + CHARLIE');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    // The bad rebuild drops CHARLIE from both files.
    writeFileSync(join(repo, 'data/digests/2026-07-08.json'), artifact([['alpha', 'ALPHA']]));
    writeFileSync(join(repo, 'data/obsidian/2026-07-08.md'), '# rebuilt: ALPHA only');
    git('add', '-A');

    expect(run()).toContain('WITHHELD 2026-07-08');
    expect(readFileSync(join(repo, 'data/obsidian/2026-07-08.md'), 'utf8')).toContain('ALPHA + CHARLIE');
    // Nothing about this date is left staged for the commit.
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('restores a conference-suffixed twin too', () => {
    writeFileSync(join(repo, 'data/digests/2026-05-17.json'), artifact([['a', 'A'], ['b', 'B']]));
    writeFileSync(join(repo, 'data/obsidian/2026-05-17-estro-2026.md'), '# published: A + B');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    writeFileSync(join(repo, 'data/digests/2026-05-17.json'), artifact([['a', 'A']]));
    writeFileSync(join(repo, 'data/obsidian/2026-05-17-estro-2026.md'), '# rebuilt: A only');
    git('add', '-A');

    run();
    expect(readFileSync(join(repo, 'data/obsidian/2026-05-17-estro-2026.md'), 'utf8')).toContain('A + B');
  });

  it('unstages a companion HEAD never had, rather than shipping it alone', () => {
    writeFileSync(join(repo, 'data/digests/2026-07-08.json'), artifact([['alpha', 'ALPHA'], ['charlie', 'CHARLIE']]));
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    writeFileSync(join(repo, 'data/digests/2026-07-08.json'), artifact([['alpha', 'ALPHA']]));
    writeFileSync(join(repo, 'data/obsidian/2026-07-08.md'), '# brand new twin for a rejected build');
    git('add', '-A');

    run();
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('leaves another date’s twin alone', () => {
    writeFileSync(join(repo, 'data/digests/2026-07-08.json'), artifact([['a', 'A'], ['c', 'C']]));
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    writeFileSync(join(repo, 'data/digests/2026-07-08.json'), artifact([['a', 'A']]));
    writeFileSync(join(repo, 'data/obsidian/2026-08-24.md'), '# today, fine');
    git('add', '-A');

    run();
    expect(git('diff', '--cached', '--name-only').trim()).toBe('data/obsidian/2026-08-24.md');
  });
});
