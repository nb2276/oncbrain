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
  it('builds the reader post: header, top-line, verdict-emoji study list, deep link', () => {
    const msg = formatChannelPost(artifact(), 'https://oncbrain.example.com/');
    expect(msg).toContain('🧠 oncbrain · 2026-06-09');
    expect(msg).toContain('FIRESTORM: 5-yr PFS 65.8% vs 38.8%.');
    expect(msg).toContain('🚀 FIRESTORM — CNS'); // practice-changing emoji + site label
    expect(msg).toContain('🔄 ARANOTE — Prostate (preprint)'); // confirmatory emoji + preprint flag
    expect(msg).toContain('Full digest → https://oncbrain.example.com/2026-06-09/');
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
    expect(msg).toContain('• NOVERDICT — Breast');
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
    expect(msg).toContain('…and 3 more'); // 15 - 12
  });

  it('omits the top-line block when absent', () => {
    const msg = formatChannelPost(
      artifact({ digest: { top_line: '', sites: artifact().digest.sites } }),
      'https://x.com',
    );
    expect(msg.startsWith('🧠 oncbrain · 2026-06-09')).toBe(true);
  });
});
