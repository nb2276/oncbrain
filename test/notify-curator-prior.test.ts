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
