// v0.10 added optional modality / intent / methodology fields to DigestStudy.
// Every digest in data/digests/ predates v0.10 and lacks those keys. The fields
// are typed `?: T | null` so undefined is valid, but a renderer or post-load
// transform that assumes presence would crash silently in production.
//
// This guard loads every existing digest and asserts:
//   1. JSON parses without errors (no schema-incompat breakage)
//   2. Every study has the existing v0.9-and-before required fields
//   3. The new v0.10 fields are EITHER absent (legacy artifacts) OR valid
//      enum values when present (post-backfill artifacts)
//
// Catches the failure mode v0.7 hit with verdict before verdictMetaFor — where
// downstream consumers branched on `study.verdict` without a presence check.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidModality, isValidIntent, isValidMethodology } from '../src/lib/tags.ts';

const DIGESTS_DIR = resolve(__dirname, '..', 'data', 'digests');

function listDigestFiles(): string[] {
  return readdirSync(DIGESTS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
}

describe('DigestStudy schema migration (v0.10 optional fields)', () => {
  it('every existing digest parses without errors', () => {
    const files = listDigestFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const json = JSON.parse(readFileSync(resolve(DIGESTS_DIR, f), 'utf8'));
      expect(json, `${f}: parse failed`).toBeTruthy();
      expect(json.digest, `${f}: missing .digest`).toBeTruthy();
      expect(Array.isArray(json.digest.sites), `${f}: .digest.sites not array`).toBe(true);
    }
  });

  it('every study has the legacy required fields (name, tldr, details)', () => {
    for (const f of listDigestFiles()) {
      const json = JSON.parse(readFileSync(resolve(DIGESTS_DIR, f), 'utf8'));
      for (const site of json.digest.sites ?? []) {
        for (const study of site.studies ?? []) {
          expect(study.name, `${f}/${study?.name}: missing name`).toBeTruthy();
          expect(study.tldr, `${f}/${study?.name}: missing tldr`).toBeTruthy();
          expect(Array.isArray(study.details), `${f}/${study?.name}: details not array`).toBe(
            true,
          );
        }
      }
    }
  });

  it('every study with a modality tag has a VALID enum value', () => {
    for (const f of listDigestFiles()) {
      const json = JSON.parse(readFileSync(resolve(DIGESTS_DIR, f), 'utf8'));
      for (const site of json.digest.sites ?? []) {
        for (const study of site.studies ?? []) {
          if (study.modality !== undefined && study.modality !== null) {
            expect(
              isValidModality(study.modality),
              `${f}/${study.name}: invalid modality "${study.modality}"`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('every study with an intent tag has a VALID enum value', () => {
    for (const f of listDigestFiles()) {
      const json = JSON.parse(readFileSync(resolve(DIGESTS_DIR, f), 'utf8'));
      for (const site of json.digest.sites ?? []) {
        for (const study of site.studies ?? []) {
          if (study.intent !== undefined && study.intent !== null) {
            expect(
              isValidIntent(study.intent),
              `${f}/${study.name}: invalid intent "${study.intent}"`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('every study with a methodology tag has a VALID enum value', () => {
    for (const f of listDigestFiles()) {
      const json = JSON.parse(readFileSync(resolve(DIGESTS_DIR, f), 'utf8'));
      for (const site of json.digest.sites ?? []) {
        for (const study of site.studies ?? []) {
          if (study.methodology !== undefined && study.methodology !== null) {
            expect(
              isValidMethodology(study.methodology),
              `${f}/${study.name}: invalid methodology "${study.methodology}"`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('post-v0.10 corpus: every dated digest carries at least one tagged study (regression catcher)', () => {
    // Inverted from the pre-v0.10 transition guard. The backfill landed in
    // v0.10.0; from here forward, every digest in data/digests/ must include
    // at least one study with a populated modality/intent/methodology field.
    // A future builder regression that silently dropped tag emission would
    // strip tags on the next backfill rebuild, breaking the /tags/ landing
    // pages — this assertion catches it pre-deploy.
    for (const f of listDigestFiles()) {
      const json = JSON.parse(readFileSync(resolve(DIGESTS_DIR, f), 'utf8'));
      let anyTagged = false;
      for (const site of json.digest.sites ?? []) {
        for (const study of site.studies ?? []) {
          if (study.modality || study.intent || study.methodology) {
            anyTagged = true;
          }
        }
      }
      expect(anyTagged, `${f}: no study carries any tag — backfill regressed?`).toBe(true);
    }
  });
});
