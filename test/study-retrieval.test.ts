import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDossierAliases,
  stripFrontmatter,
  loadStudyContext,
  isSafeSlug,
  resetAliasIndexCache,
} from '../src/lib/study-retrieval.ts';

describe('parseDossierAliases', () => {
  it('parses the flow form', () => {
    const c = '---\naliases: [prestige-psma, prestige-psma-2, prestige]\n---\nbody';
    expect(parseDossierAliases(c)).toEqual(['prestige-psma', 'prestige-psma-2', 'prestige']);
  });

  it('parses the block form', () => {
    const c = '---\naliases:\n  - prestige-psma\n  - prestige\n---\nbody';
    expect(parseDossierAliases(c)).toEqual(['prestige-psma', 'prestige']);
  });

  it('drops invalid aliases (uppercase, slashes, path traversal) and dedupes', () => {
    const c = '---\naliases: [Good-One, ../evil, has/slash, good-one, ok2]\n---\nx';
    // "Good-One" is uppercase (invalid), ../evil + has/slash have slashes,
    // "good-one" is valid, ok2 is valid.
    expect(parseDossierAliases(c)).toEqual(['good-one', 'ok2']);
  });

  it('strips surrounding quotes in the block form', () => {
    const c = "---\naliases:\n  - 'quoted-slug'\n  - \"other-slug\"\n---\ny";
    expect(parseDossierAliases(c)).toEqual(['quoted-slug', 'other-slug']);
  });

  it('returns [] when there is no frontmatter or no aliases key', () => {
    expect(parseDossierAliases('no frontmatter here')).toEqual([]);
    expect(parseDossierAliases('---\ntitle: X\n---\nbody')).toEqual([]);
    expect(parseDossierAliases('')).toEqual([]);
  });

  it('ends the block list at the first non-list line', () => {
    const c = '---\naliases:\n  - a\n  - b\ntitle: X\n  - c\n---\nbody';
    expect(parseDossierAliases(c)).toEqual(['a', 'b']); // c is after title, not part of the list
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading frontmatter block', () => {
    expect(stripFrontmatter('---\naliases: [a]\n---\nthe body')).toBe('the body');
  });

  it('leaves frontmatter-free content untouched (trimmed)', () => {
    expect(stripFrontmatter('  just a note  ')).toBe('just a note');
  });

  it('handles CRLF and trailing spaces on the closing fence', () => {
    expect(stripFrontmatter('---\r\naliases: [a]\r\n--- \r\nbody')).toBe('body');
  });

  it('does not treat a mid-document --- as frontmatter', () => {
    expect(stripFrontmatter('intro\n---\nnot frontmatter')).toBe('intro\n---\nnot frontmatter');
  });
});

describe('loadStudyContext', () => {
  let root: string;
  const write = (slug: string, content: string) => writeFileSync(join(root, `${slug}.md`), content);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oncbrain-studies-'));
    resetAliasIndexCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetAliasIndexCache();
  });

  it('returns an exact-slug dossier body with frontmatter stripped', () => {
    write('prestige-psma', '---\naliases: [prestige]\n---\nWatch the control-arm crossover.');
    expect(loadStudyContext('prestige-psma', root)).toBe('Watch the control-arm crossover.');
  });

  it('resolves a slug declared as an alias of another dossier', () => {
    write('prestige-psma', '---\naliases: [prestige-psma-2, prestige]\n---\nAnchor note.');
    expect(loadStudyContext('prestige-psma-2', root)).toBe('Anchor note.');
    expect(loadStudyContext('prestige', root)).toBe('Anchor note.');
  });

  it('prefers an exact dossier over an alias claim', () => {
    write('a-trial', '---\naliases: []\n---\nExact A.');
    write('b-trial', '---\naliases: [a-trial]\n---\nB claims A.');
    expect(loadStudyContext('a-trial', root)).toBe('Exact A.'); // exact wins
  });

  it('returns null for an unknown slug and for an unsafe slug', () => {
    write('real', 'body');
    expect(loadStudyContext('missing', root)).toBeNull();
    expect(loadStudyContext('../etc/passwd', root)).toBeNull();
    expect(loadStudyContext('UPPER', root)).toBeNull();
  });

  it('returns null for an empty or whitespace-only dossier', () => {
    write('blank', '---\naliases: [x]\n---\n   \n');
    expect(loadStudyContext('blank', root)).toBeNull();
    expect(loadStudyContext('x', root)).toBeNull(); // alias of an empty dossier is still empty
  });

  it('is unaffected by a frontmatter-free dossier (back-compat)', () => {
    write('legacy', 'Plain note, no frontmatter.');
    expect(loadStudyContext('legacy', root)).toBe('Plain note, no frontmatter.');
  });

  it('does NOT cross-link a trial-number suffix (the rtog trap)', () => {
    // rtog-0539 must never resolve to rtog-0848's dossier just by suffix shape.
    write('rtog-0848', '---\naliases: []\n---\nRTOG 0848 note.');
    expect(loadStudyContext('rtog-0539', root)).toBeNull();
  });

  it('first dossier (by filename sort) wins a contested alias', () => {
    write('aaa', '---\naliases: [shared]\n---\nfrom aaa');
    write('bbb', '---\naliases: [shared]\n---\nfrom bbb');
    expect(loadStudyContext('shared', root)).toBe('from aaa');
  });
});

describe('isSafeSlug', () => {
  it('accepts kebab-case and bare digits, rejects paths and caps', () => {
    expect(isSafeSlug('prestige-psma-2')).toBe(true);
    expect(isSafeSlug('40112848')).toBe(true);
    expect(isSafeSlug('../evil')).toBe(false);
    expect(isSafeSlug('Has-Caps')).toBe(false);
    expect(isSafeSlug('')).toBe(false);
  });
});
