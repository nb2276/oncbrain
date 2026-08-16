// v0.37 (E5): the moved-magnitude line in the curator's build-done DM. This is
// the detector half's only push surface — if it is silent the curator never
// learns the number changed, because the digest publishes either way.
import { describe, it, expect } from 'vitest';
import { formatMessage } from '../build/notify-curator.ts';

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
