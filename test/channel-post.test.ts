import { describe, it, expect } from 'vitest';
import { formatChannelPost, type ChannelArtifact } from '../src/lib/channel-post.ts';

function artifact(over: Partial<ChannelArtifact> = {}): ChannelArtifact {
  return {
    date: '2026-06-09',
    conference: null,
    digest: {
      top_line: 'FIRESTORM: 5-yr PFS 65.8% vs 38.8%.',
      sites: [
        { disease_site: 'cns', studies: [{ name: 'FIRESTORM', verdict: { soc_implication: 'practice-changing' } }] },
        { disease_site: 'prostate', studies: [{ name: 'ARANOTE', verdict: { soc_implication: 'confirmatory' }, is_preprint: true }] },
      ],
    },
    ...over,
  };
}

describe('formatChannelPost', () => {
  it('builds the reader post: header, verdict-emoji study list, deep link', () => {
    const msg = formatChannelPost(artifact(), 'https://oncbrain.example.com/');
    expect(msg).toContain('🧠 oncbrain · 2026-06-09');
    expect(msg).toContain('🚀 FIRESTORM — CNS'); // practice-changing emoji + site label
    expect(msg).toContain('🔄 ARANOTE — Prostate (preprint)'); // confirmatory emoji + preprint flag
    expect(msg).toContain('Full digest → https://oncbrain.example.com/2026-06-09/');
  });

  // v0.40: the OG card renders top_line as its headline and Telegram shows that
  // card directly under this text, so printing it here published the same
  // sentence twice in one post. The card owns the takeaway; the body owns the
  // inventory and the link.
  it('never repeats top_line, which the card already carries', () => {
    const msg = formatChannelPost(artifact(), 'https://x.com');
    expect(msg).not.toContain('FIRESTORM: 5-yr PFS 65.8% vs 38.8%.');
    expect(msg).not.toContain('65.8%');
  });

  // The single-study case the curator flagged: card headline names the trial,
  // so a full study line here was a third printing of one fact. Keep only what
  // the card lacks — disease site and SOC verdict.
  it('collapses a single-study day to site + verdict, not a study line', () => {
    const msg = formatChannelPost(
      artifact({ digest: { top_line: 'X: some finding.', sites: [
        { disease_site: 'lower-gi', studies: [{ name: 'SIB-CRT vs Standard CRT for LARC', verdict: { soc_implication: 'early-signal' } }] },
      ] } }),
      'https://x.com',
    );
    expect(msg).toContain('1 study · GI Lower · 🧪 early signal');
    expect(msg).not.toContain('SIB-CRT'); // the card says it; the body must not
    expect(msg).toContain('Full digest →');
  });

  it('still lists studies when there is more than one', () => {
    const msg = formatChannelPost(artifact(), 'https://x.com');
    expect(msg).toContain('🚀 FIRESTORM — CNS');
    expect(msg).toContain('🔄 ARANOTE — Prostate (preprint)');
    expect(msg).not.toContain('1 study ·');
  });

  it('includes the conference in the header when present', () => {
    const msg = formatChannelPost(artifact({ conference: { name: 'ASCO 2026' } }), 'https://x.com');
    expect(msg).toContain('🧠 oncbrain · 2026-06-09 · ASCO 2026');
  });

  it('uses a bullet for a verdict-less study and skips empty sites', () => {
    const msg = formatChannelPost(
      artifact({ digest: { top_line: 't', sites: [
        { disease_site: 'breast', studies: [{ name: 'NOVERDICT' }] },
        { disease_site: 'lung', studies: [] },
      ] } }),
      'https://x.com',
    );
    // Single study on the day, so it collapses to the compact line; the
    // verdict-less case shows the site with no verdict suffix.
    expect(msg).toContain('1 study · Breast');
    expect(msg).not.toContain('Lung');
  });

  it('caps the study list and notes the overflow', () => {
    const studies = Array.from({ length: 15 }, (_, i) => ({
      name: `S${i}`,
      verdict: { soc_implication: 'early-signal' as const },
    }));
    const msg = formatChannelPost(
      artifact({ digest: { top_line: '', sites: [{ disease_site: 'cns', studies }] } }),
      'https://x.com',
    );
    expect(msg).toContain('…and 7 more'); // 15 - 8: a long body pushes the
    // link preview (the card) out of view on a phone, so the cap is tighter now.
  });

  it('omits the top-line block when absent', () => {
    const msg = formatChannelPost(
      artifact({ digest: { top_line: '', sites: artifact().digest.sites } }),
      'https://x.com',
    );
    expect(msg.startsWith('🧠 oncbrain · 2026-06-09')).toBe(true);
  });
});
