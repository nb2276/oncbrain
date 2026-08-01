// v0.37 (E5): the build-time half — stamping `prior_estimate` from committed
// artifacts on disk, and surfacing the move in the curator's build-done DM.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampPriorEstimates } from '../build/digest-builder.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oncbrain-prior-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const endpoint = (stat_value: string, stat_detail: string | null = null) => ({
  name: 'Overall survival', klass: 'overall-survival' as const, stat_value, stat_detail,
});

function writeArtifact(date: string, studies: unknown[]) {
  writeFileSync(join(dir, `${date}.json`), JSON.stringify({
    date, conference: null, generated_at: 1, digest: { top_line: '', tldr: '', sites: [{ disease_site: 'prostate', intro: null, studies, open_questions: null }] },
  }));
}

const current = (studies: unknown[]) => ({ sites: [{ studies }] }) as never;

describe('stampPriorEstimates', () => {
  it('stamps a study whose magnitude moved since an earlier date', () => {
    writeArtifact('2026-01-01', [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.90', '95% CI 0.70-1.16') }]);
    const studies = [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62', '95% CI 0.44-0.88') }];

    const hits = stampPriorEstimates('2026-06-01', current(studies), dir);

    expect(hits).toEqual([{ slug: 'trialx', from: 'HR 0.90', to: 'HR 0.62', priorDate: '2026-01-01' }]);
    expect((studies[0] as { prior_estimate?: unknown }).prior_estimate).toMatchObject({
      date: '2026-01-01', slug: 'trialx', stat_value: 'HR 0.90', point: 0.9,
    });
  });

  it('leaves an unchanged estimate alone', () => {
    writeArtifact('2026-01-01', [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62') }]);
    const studies = [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62') }];
    expect(stampPriorEstimates('2026-06-01', current(studies), dir)).toEqual([]);
    expect((studies[0] as { prior_estimate?: unknown }).prior_estimate).toBeUndefined();
  });

  // A rebuild of an existing date re-reads the directory it is about to write.
  // Without the strict `<` it would find ITSELF and cite its own number.
  it('never reads the date being rebuilt, nor any later date', () => {
    writeArtifact('2026-06-01', [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62') }]);
    writeArtifact('2026-09-01', [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.51') }]);
    const studies = [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62') }];
    expect(stampPriorEstimates('2026-06-01', current(studies), dir)).toEqual([]);
  });

  // A longitudinal note is a nice-to-have. It must never be able to fail a
  // publish, so bad input degrades to "no prior" rather than throwing.
  it('survives a malformed artifact and a missing directory', () => {
    writeFileSync(join(dir, '2026-01-01.json'), '{ not json');
    const studies = [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62') }];
    expect(() => stampPriorEstimates('2026-06-01', current(studies), dir)).not.toThrow();
    expect(() => stampPriorEstimates('2026-06-01', current(studies), join(dir, 'nope'))).not.toThrow();
  });

  it('skips studies with no slug rather than emitting an unlinkable prior', () => {
    writeArtifact('2026-01-01', [{ name: 'TRIALX', nct: 'NCT01', primary_endpoint: endpoint('HR 0.90') }]);
    const studies = [{ name: 'TRIALX', slug: 'trialx', nct: 'NCT01', primary_endpoint: endpoint('HR 0.62') }];
    expect(stampPriorEstimates('2026-06-01', current(studies), dir)).toEqual([]);
  });
});
