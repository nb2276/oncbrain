// v0.37 (E5): the moved-magnitude line in the curator's build-done DM. This is
// the detector half's only push surface — if it is silent the curator never
// learns the number changed, because the digest publishes either way.
import { describe, it, expect } from 'vitest';
import { formatMessage, summarizeDropReason } from '../build/notify-curator.ts';

const artifact = (studies: unknown[]) => ({
  date: '2026-06-01',
  digest: { sites: [{ disease_site: 'prostate', studies }] },
}) as never;

describe('notify:curator moved-magnitude line', () => {
  it('names the trial and both readings when the estimate moved', () => {
    const msg = formatMessage(artifact([{
      name: 'TRIALX',
      primary_endpoint: { stat_value: 'HR 0.62' },
      prior_estimate: { date: '2026-01-01', stat_value: 'HR 0.90' },
    }]), 'https://example.com');
    expect(msg).toContain('↻ TRIALX: HR 0.90 → HR 0.62 (was 2026-01-01)');
    // Above the fold: the site breakdown and URL come after.
    expect(msg.indexOf('↻')).toBeLessThan(msg.indexOf('https://example.com'));
  });

  it('stays silent on an ordinary build', () => {
    const msg = formatMessage(artifact([{ name: 'TRIALX', primary_endpoint: { stat_value: 'HR 0.62' } }]), 'https://example.com');
    expect(msg).not.toContain('↻');
    expect(msg).toContain('2026-06-01 built');
  });
});

// Trial lineage: a supersession is the only thing a build does that REMOVES
// something already published. The build log records it, but the curator reads
// the DM — so an auto-unpublish that appears nowhere in the DM is a silent
// deletion from the reader's point of view.
describe('notify:curator supersession line', () => {
  it('names the retired card so an auto-unpublish is never silent', () => {
    const msg = formatMessage(artifact([{
      name: 'NRG-GU005',
      primary_endpoint: { stat_value: '88.6% vs 92.1%' },
      supersedes: { date: '2026-07-08', slug: 'nrg-gu005', auto_dropped: true },
    }]), 'https://example.com');
    expect(msg).toContain('⤴ NRG-GU005 supersedes 2026-07-08/nrg-gu005');
    expect(msg).toContain('queued for removal');
    expect(msg.indexOf('⤴')).toBeLessThan(msg.indexOf('https://example.com'));
  });

  it('stays silent when nothing was superseded', () => {
    const msg = formatMessage(artifact([{ name: 'TRIALX' }]), 'https://example.com');
    expect(msg).not.toContain('⤴');
  });

  it('reports both a moved estimate and a supersession together', () => {
    const msg = formatMessage(artifact([
      { name: 'A', primary_endpoint: { stat_value: 'HR 0.62' }, prior_estimate: { date: '2026-01-01', stat_value: 'HR 0.90' } },
      { name: 'B', supersedes: { date: '2026-07-08', slug: 'b-old', auto_dropped: true } },
    ]), 'https://example.com');
    expect(msg).toContain('↻ A:');
    expect(msg).toContain('⤴ B supersedes');
  });
});

// The other shape: identity was acronym-only, so nothing came down. This line is
// a REQUEST, and it carries the exact reply token dedup-command.ts parses so
// acting on it costs one message.
describe('notify:curator pending-drop line', () => {
  it('asks instead of announcing when the drop was withheld', () => {
    const msg = formatMessage(artifact([{
      name: 'NRG-GU005',
      supersedes: {
        date: '2026-07-08',
        slug: 'nrg-gu005',
        auto_dropped: false,
        declined_reason: 'no shared registration (acronym-only identity)',
        // The offer is STRUCTURAL now — the DM never parses the decline wording,
        // because that is how a maturity regression got offered as "just confirm
        // the identity".
        droppable: true,
      },
    }]), 'https://example.com');
    expect(msg).toContain('NOT dropped (no shared registration');
    expect(msg).toContain('reply: drop 2026-07-08/nrg-gu005');
    expect(msg).not.toContain('queued for removal');
  });

  it('does NOT offer the drop token when the refusal was the empty-day guard', () => {
    // `drop` has no empty-day guard of its own, so offering it here would hand
    // back the exact footgun the automatic path just refused.
    const msg = formatMessage(artifact([{
      name: 'NRG-GU005',
      supersedes: {
        date: '2026-07-08',
        slug: 'nrg-gu005',
        auto_dropped: false,
        declined_reason: 'would empty 2026-07-08 (last surviving study)',
      },
    }]), 'https://example.com');
    expect(msg).not.toMatch(/reply: drop/i);
    expect(msg).toContain('Review both cards');
  });
});

// The offer must be structural. A verdict blocked on EVIDENCE never gets a drop
// token, however its decline happens to read — executeDedupDrop applies the
// structural guards but deliberately not the evidence gate, so an offer we make
// wrongly is an offer the curator can act on.
describe('notify:curator offers drop only when droppable', () => {
  it('withholds the token for an evidence refusal', () => {
    const msg = formatMessage(artifact([{
      name: 'TRIALX',
      supersedes: {
        date: '2026-07-08',
        slug: 'old',
        auto_dropped: false,
        declined_reason: 'maturity regressed (full-publication → conference-abstract)',
        droppable: false,
      },
    }]), 'https://example.com');
    expect(msg).not.toMatch(/drop 2026-07-08/);
    expect(msg).toContain('maturity regressed');
    expect(msg).toContain('Review both cards');
  });
});

// A study that did not make it. The pipeline records these in meta.dropped
// rather than omitting them silently, and the artifact has carried them for
// releases — but this DM reported only a COUNT, so the curator read "4 studies"
// and never learned WHICH one vanished. Observed live: a Phase 2 response that
// opened with prose instead of JSON dropped the day's only practice-changing
// readout, and nothing said so.
describe('notify:curator names a dropped study', () => {
  const withDropped = (dropped: { slug: string; name: string; reason: string }[]) =>
    ({
      date: '2026-08-14',
      digest: { sites: [{ disease_site: 'prostate', studies: [{ name: 'ARANOTE' }] }], meta: { dropped } },
    }) as never;

  it('names the study and gives the re-run command', () => {
    const msg = formatMessage(
      withDropped([
        {
          slug: 'prestige-psma',
          name: 'PRESTIGE-PSMA',
          reason: "phase2:prestige-psma failed after 2 attempts: Phase 2 not valid JSON: Unexpected token 'C'",
        },
      ]),
      'https://example.com',
    );
    expect(msg).toContain('⚠️ DROPPED PRESTIGE-PSMA');
    expect(msg).toContain('Phase 2 returned unparseable output');
    // The failure is usually transient, so the re-run IS the message.
    expect(msg).toContain('npm run build:day -- --date=2026-08-14');
  });

  it('puts the drop FIRST — it is what the build failed to do', () => {
    const msg = formatMessage(
      withDropped([{ slug: 'a', name: 'TRIALA', reason: 'no matching tweets' }]),
      'https://example.com',
    );
    expect(msg.indexOf('DROPPED')).toBeLessThan(msg.indexOf('🌰'));
    expect(msg.indexOf('DROPPED')).toBeLessThan(msg.indexOf('https://example.com'));
  });

  it('names every dropped study, not just the first', () => {
    const msg = formatMessage(
      withDropped([
        { slug: 'a', name: 'TRIALA', reason: 'no matching tweets' },
        { slug: 'b', name: 'TRIALB', reason: 'phase2:b failed: request timed out' },
      ]),
      'https://example.com',
    );
    expect(msg).toContain('TRIALA');
    expect(msg).toContain('TRIALB');
    expect(msg).toContain('the model call timed out');
  });

  it('stays silent on an ordinary build', () => {
    const msg = formatMessage(withDropped([]), 'https://example.com');
    expect(msg).not.toContain('DROPPED');
    expect(msg).not.toContain('Re-run');
  });

  it('survives an older artifact with no meta at all', () => {
    const legacy = { date: '2026-08-14', digest: { sites: [{ disease_site: 'prostate', studies: [{ name: 'A' }] }] } } as never;
    expect(() => formatMessage(legacy, 'https://example.com')).not.toThrow();
  });
});

describe('summarizeDropReason', () => {
  it('turns an internal diagnostic into something a curator can act on', () => {
    expect(summarizeDropReason("phase2:x failed after 2 attempts: Phase 2 not valid JSON: Unexpected token 'C'"))
      .toBe('Phase 2 returned unparseable output');
    expect(summarizeDropReason('no matching tweets')).toBe('no sources matched the cluster');
    expect(summarizeDropReason('phase2:y failed: request timed out')).toBe('the model call timed out');
    expect(summarizeDropReason('phase2:z failed: 429 rate limit exceeded')).toBe('rate limited');
  });

  it('falls back to a bounded first clause on an unrecognised reason', () => {
    const out = summarizeDropReason('phase2:q something unexpected happened: with detail');
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).not.toContain('phase2:');
  });
});
