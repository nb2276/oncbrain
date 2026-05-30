// listDigestsStrict shape validation guards. Adversarial-review finding:
// a digest artifact missing .date / .digest / .digest.sites would otherwise
// propagate as a confusing TypeError deep in buildReverseIndex or
// computeSiblings. listDigestsStrict throws with the file path and a
// "delete the file and rerun" hint, making recovery obvious.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDigestsStrict } from '../src/lib/tag-index.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tag-index-strict-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeArtifact(name: string, contents: string): void {
  writeFileSync(join(tempDir, name), contents);
}

describe('listDigestsStrict', () => {
  it('returns [] when the directory does not exist', () => {
    const missing = join(tempDir, 'absent');
    expect(listDigestsStrict(missing)).toEqual([]);
  });

  it('returns [] when the directory is empty', () => {
    expect(listDigestsStrict(tempDir)).toEqual([]);
  });

  it('skips non-.json files silently', () => {
    writeFileSync(join(tempDir, 'README.md'), 'hi');
    writeFileSync(join(tempDir, '.DS_Store'), '');
    expect(listDigestsStrict(tempDir)).toEqual([]);
  });

  it('parses a well-formed digest and sorts newest first', () => {
    writeArtifact(
      '2026-05-26.json',
      JSON.stringify({
        date: '2026-05-26',
        conference: null,
        generated_at: 0,
        digest: { top_line: '', tldr: '', sites: [] },
        bookmarks: [],
      }),
    );
    writeArtifact(
      '2026-05-27.json',
      JSON.stringify({
        date: '2026-05-27',
        conference: null,
        generated_at: 0,
        digest: { top_line: '', tldr: '', sites: [] },
        bookmarks: [],
      }),
    );
    const result = listDigestsStrict(tempDir);
    expect(result.map((d) => d.date)).toEqual(['2026-05-27', '2026-05-26']);
  });

  it('throws on malformed JSON with a file-path-bearing message', () => {
    writeArtifact('2026-05-27.json', '{ this is not json');
    expect(() => listDigestsStrict(tempDir)).toThrowError(/malformed JSON in/);
    expect(() => listDigestsStrict(tempDir)).toThrowError(/2026-05-27\.json/);
  });

  it('throws when the root is not an object (e.g. JSON array)', () => {
    writeArtifact('2026-05-27.json', '[]');
    expect(() => listDigestsStrict(tempDir)).toThrowError(/root is not an object/);
  });

  it('throws when .date is missing', () => {
    writeArtifact(
      '2026-05-27.json',
      JSON.stringify({ digest: { sites: [] }, bookmarks: [] }),
    );
    expect(() => listDigestsStrict(tempDir)).toThrowError(/missing \.date/);
  });

  it('throws when .date is an empty string', () => {
    writeArtifact(
      '2026-05-27.json',
      JSON.stringify({ date: '', digest: { sites: [] }, bookmarks: [] }),
    );
    expect(() => listDigestsStrict(tempDir)).toThrowError(/missing \.date/);
  });

  it('throws when .digest is missing', () => {
    writeArtifact('2026-05-27.json', JSON.stringify({ date: '2026-05-27', bookmarks: [] }));
    expect(() => listDigestsStrict(tempDir)).toThrowError(/missing \.digest/);
  });

  it('throws when .digest is not an object', () => {
    writeArtifact(
      '2026-05-27.json',
      JSON.stringify({ date: '2026-05-27', digest: 'not an object', bookmarks: [] }),
    );
    expect(() => listDigestsStrict(tempDir)).toThrowError(/missing \.digest/);
  });

  it('throws when .digest.sites is not an array', () => {
    writeArtifact(
      '2026-05-27.json',
      JSON.stringify({
        date: '2026-05-27',
        digest: { top_line: '', tldr: '', sites: null },
        bookmarks: [],
      }),
    );
    expect(() => listDigestsStrict(tempDir)).toThrowError(/missing \.digest\.sites array/);
  });

  it('error messages include "delete the file and rerun" hint for malformed shapes', () => {
    writeArtifact('2026-05-27.json', '{}');
    expect(() => listDigestsStrict(tempDir)).toThrowError(/delete the file and rerun/);
  });
});
