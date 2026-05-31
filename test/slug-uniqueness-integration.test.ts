// v0.11 PR-1a: Astro integration that validates slug uniqueness in the
// astro:build:start hook (BEFORE SSG begins).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import slugUniqueness from '../src/integrations/slug-uniqueness.ts';
import type { DigestArtifact, DigestStudy } from '../src/lib/digest-data.ts';

function makeStudy(name: string, slug?: string, overrides: Partial<DigestStudy> = {}): DigestStudy {
  return {
    name,
    tldr: `${name} tldr`,
    details: [],
    nct: null,
    tweet_ids: [],
    slug,
    ...overrides,
  };
}

function makeDigest(
  date: string,
  confSlug: string | null,
  studies: DigestStudy[],
): DigestArtifact {
  return {
    date,
    conference: confSlug ? { slug: confSlug, name: confSlug.toUpperCase() } : null,
    generated_at: 0,
    digest: {
      top_line: 'top',
      tldr: 'tldr',
      sites: [{ disease_site: 'breast', intro: null, studies, open_questions: null }],
    },
    bookmarks: [],
  };
}

function writeFixture(digests: DigestArtifact[]): string {
  const root = mkdtempSync(join(tmpdir(), 'slug-uniq-int-'));
  const digestsDir = join(root, 'digests');
  mkdirSync(digestsDir, { recursive: true });
  for (const d of digests) {
    writeFileSync(join(digestsDir, `${d.date}.json`), JSON.stringify(d));
  }
  return digestsDir;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fork: vi.fn(),
    options: {} as Record<string, unknown>,
    label: 'test',
    fullLabel: 'test',
  };
}

describe('slug-uniqueness integration', () => {
  it('exposes the expected integration shape with an astro:build:start hook', () => {
    const integration = slugUniqueness();
    expect(integration.name).toBe('oncbrain:slug-uniqueness');
    expect(integration.hooks['astro:build:start']).toBeTypeOf('function');
  });

  it('passes on a clean corpus and logs the validation', async () => {
    const digestsDir = writeFixture([
      makeDigest('2026-05-21', 'asco-2026', [
        makeStudy('Alpha', 'alpha', { modality: 'radiation' }),
      ]),
    ]);
    try {
      const integration = slugUniqueness({ digestsDir });
      const logger = makeLogger();
      const hook = integration.hooks['astro:build:start']!;
      await hook({ logger } as never);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/slug uniqueness: 1 digest/),
      );
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      rmSync(digestsDir, { recursive: true, force: true });
    }
  });

  it('throws when a meeting slug collides with a canonical enum slug', async () => {
    // assertSlugUniqueness validates meeting slugs against verdict slugs
    // (and via findSlugCollision, against the rest of the /tags/
    // namespaces). A conference whose slug collides with the 'radiation'
    // modality enum value would silently route /tags/radiation/ to the
    // wrong studies — the integration must fail-closed here.
    const digestsDir = writeFixture([
      makeDigest('2026-05-21', 'radiation', [makeStudy('A')]),
    ]);
    try {
      const integration = slugUniqueness({ digestsDir });
      const logger = makeLogger();
      const hook = integration.hooks['astro:build:start']!;
      await expect(hook({ logger } as never)).rejects.toThrow(/collision/i);
      expect(logger.error).toHaveBeenCalled();
    } finally {
      rmSync(digestsDir, { recursive: true, force: true });
    }
  });

  it('throws on a malformed meeting slug (URL-unsafe characters)', async () => {
    const digestsDir = writeFixture([
      makeDigest('2026-05-21', 'Bad Slug!', [makeStudy('A')]),
    ]);
    try {
      const integration = slugUniqueness({ digestsDir });
      const logger = makeLogger();
      const hook = integration.hooks['astro:build:start']!;
      await expect(hook({ logger } as never)).rejects.toThrow(/malformed/i);
    } finally {
      rmSync(digestsDir, { recursive: true, force: true });
    }
  });
});
