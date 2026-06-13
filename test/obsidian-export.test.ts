import { describe, it, expect } from 'vitest';
import { renderObsidian, wikilinkify, type DigestArtifactForExport } from '../src/lib/obsidian-export.ts';

const sampleArtifact: DigestArtifactForExport = {
  date: '2026-05-30',
  conference: { slug: 'asco2026', name: 'ASCO Annual Meeting 2026' },
  generated_at: 1717000000000,
  digest: {
    top_line: 'NCT04567890 delivers OS HR 0.62 in mCRPC.',
    tldr:
      'NCT04567890 met primary OS endpoint. doi:10.1056/NEJMoa2024999 expected soon.',
    sites: [
      {
        disease_site: 'prostate',
        intro: 'Two trials reported on mCRPC.',
        studies: [
          {
            name: 'PRESTIGE-PSMA',
            tldr: 'NCT04567890 met primary OS endpoint, HR 0.62.',
            details: [
              'HR 0.62 (95% CI 0.45-0.85)',
              'See PMID: 36912345 for prior context',
            ],
            nct: 'NCT04567890',
            tweet_ids: [1, 2],
          },
        ],
        open_questions: ['Sequencing vs taxanes remains open'],
      },
    ],
  },
  bookmarks: [
    {
      id: 1,
      url: 'https://x.com/drfoo/status/1',
      author_handle: '@drfoo',
      author_name: 'Dr Foo, MD',
      text: 'NCT04567890 met primary endpoint with HR 0.62 OS in mCRPC.',
      note: 'practice-changing',
      fetched_via: 'manual',
      conference_slug: 'asco2026',
    },
    {
      id: 2,
      url: 'https://x.com/drbar/status/2',
      author_handle: null,
      author_name: null,
      text: 'Standalone tweet without attribution.',
      note: null,
      fetched_via: 'manual',
      conference_slug: 'asco2026',
    },
  ],
};

describe('renderObsidian', () => {
  it('includes YAML frontmatter with date, conference, tags, source-count', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('date: 2026-05-30');
    expect(md).toContain('conference: ASCO Annual Meeting 2026');
    expect(md).toContain('conference-slug: asco2026');
    expect(md).toContain('source-count: 2');
    expect(md).toContain('  - oncology/digest');
  });

  it('renders top_line bold + TL;DR callout', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('**[[NCT04567890]] delivers OS HR 0.62 in mCRPC.**');
    expect(md).toContain('> [!summary] TL;DR');
  });

  it('renders site heading with emoji + label', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('## 🌰 Prostate');
  });

  it('renders site intro (when present) and skips when null', () => {
    expect(renderObsidian(sampleArtifact)).toContain('Two trials reported on mCRPC.');
    const noIntro: DigestArtifactForExport = {
      ...sampleArtifact,
      digest: {
        ...sampleArtifact.digest,
        sites: [{ ...sampleArtifact.digest.sites[0]!, intro: null }],
      },
    };
    const md = renderObsidian(noIntro);
    expect(md).not.toContain('Two trials reported');
  });

  it('renders each study with name, per-study TL;DR, and bullets', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('### PRESTIGE-PSMA · [[NCT04567890]]');
    expect(md).toContain('> [[NCT04567890]] met primary OS endpoint, HR 0.62.');
    expect(md).toContain('- HR 0.62 (95% CI 0.45-0.85)');
    expect(md).toContain('- See [[PMID 36912345]] for prior context');
  });

  it('renders sources with author + URL + curator note', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('**Sources:**');
    expect(md).toContain('[Dr Foo, MD (@drfoo)](https://x.com/drfoo/status/1)');
    expect(md).toContain("📝 *Curator note:* practice-changing");
  });

  it('falls back to "unknown" when no author info available', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('[unknown](https://x.com/drbar/status/2)');
  });

  it('emits open-questions callout when present', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('> [!question] Open questions');
    expect(md).toContain('> - Sequencing vs taxanes remains open');
  });

  it('omits open-questions section when null or empty', () => {
    const noQ: DigestArtifactForExport = {
      ...sampleArtifact,
      digest: {
        ...sampleArtifact.digest,
        sites: [{ ...sampleArtifact.digest.sites[0]!, open_questions: null }],
      },
    };
    const md = renderObsidian(noQ);
    expect(md).not.toContain('Open questions');
  });

  it('emits See also section with neighboring dates and conference link', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('## See also');
    expect(md).toContain('[[ASCO Annual Meeting 2026]]');
    expect(md).toContain('[[2026-05-29]]');
    expect(md).toContain('[[2026-05-31]]');
  });

  it('emits url field when publicSiteUrl is provided', () => {
    const md = renderObsidian(sampleArtifact, { publicSiteUrl: 'https://oncbrain.example.com' });
    expect(md).toContain('url: https://oncbrain.example.com/2026-05-30/');
  });

  it('omits conference fields and link when artifact has no conference', () => {
    const noConf: DigestArtifactForExport = {
      ...sampleArtifact,
      conference: null,
      bookmarks: sampleArtifact.bookmarks.map((b) => ({ ...b, conference_slug: null })),
    };
    const md = renderObsidian(noConf);
    expect(md).not.toContain('conference:');
    expect(md).toMatch(/^# 2026-05-30$/m);
  });

  it('renders fallback "other" label for unknown disease_site slug', () => {
    const unknown: DigestArtifactForExport = {
      ...sampleArtifact,
      digest: {
        ...sampleArtifact.digest,
        sites: [{ ...sampleArtifact.digest.sites[0]!, disease_site: 'invented-slug' }],
      },
    };
    const md = renderObsidian(unknown);
    expect(md).toContain('## 📋 Other');
  });
});

describe('renderObsidian — papers + filed PDF (v0.8 PR2)', () => {
  const withPaper: DigestArtifactForExport = {
    date: '2026-05-30',
    conference: null,
    generated_at: 1,
    digest: {
      top_line: 'x',
      tldr: 'y',
      sites: [
        {
          disease_site: 'prostate',
          intro: null,
          studies: [
            {
              name: 'PRESTIGE-PSMA',
              tldr: 't',
              details: [],
              nct: null,
              tweet_ids: [],
              source_ids: [{ type: 'paper', id: 7 }],
            },
          ],
          open_questions: null,
        },
      ],
    },
    bookmarks: [],
    papers: [
      {
        id: 7,
        pmid: null, // DOI-only / PDF-only paper
        doi: '10.1056/x',
        pmc_id: null,
        title: 'PRESTIGE-PSMA: a randomized trial',
        authors: ['Smith J'],
        journal: 'NEJM',
        pub_date: '2026',
        abstract: null,
        pdf_path: 'data/obsidian/papers/prostate/prestige-psma.pdf',
        note: null,
      },
    ],
  };

  it('emits a vault wikilink embed for a filed PDF (data/obsidian/ prefix stripped)', () => {
    const md = renderObsidian(withPaper);
    expect(md).toContain('📎 [[papers/prostate/prestige-psma.pdf|PRESTIGE-PSMA (full text)]]');
  });

  it('renders a DOI-only paper without a [[PMID null]] wikilink', () => {
    const md = renderObsidian(withPaper);
    expect(md).not.toContain('PMID null');
    expect(md).toContain('[doi:10.1056/x](https://doi.org/10.1056/x)');
  });

  // v0.15.3: trade-press papers (UroToday/ASCO Post) have no PMID/DOI/PMC — the
  // source_url is their only link and must render.
  it('links the source article for a trade-press paper (no PMID/DOI)', () => {
    const url = 'https://www.urotoday.com/conference-highlights/eau-2026/167454.html';
    const tradePress: DigestArtifactForExport = {
      ...withPaper,
      papers: [
        {
          id: 7, pmid: null, doi: null, pmc_id: null,
          title: 'EAU 2026: SBRT intensification', authors: ['UroToday'],
          journal: 'UroToday', pub_date: '2026', abstract: null,
          source_url: url, pdf_path: null, note: null,
        },
      ],
    };
    const md = renderObsidian(tradePress);
    expect(md).toContain(`[article](${url})`);
    expect(md).not.toContain('PMID null');
  });

  it('suppresses the article link when source_url just duplicates the doi.org link', () => {
    const dup: DigestArtifactForExport = {
      ...withPaper,
      papers: [
        {
          id: 7, pmid: null, doi: '10.1016/x', pmc_id: null,
          title: 'IJROBP paper', authors: ['Smith J'], journal: 'IJROBP', pub_date: '2026',
          abstract: null, source_url: 'https://doi.org/10.1016/x', pdf_path: null, note: null,
        },
      ],
    };
    const md = renderObsidian(dup);
    expect(md).toContain('[doi:10.1016/x](https://doi.org/10.1016/x)');
    expect(md).not.toContain('[article]'); // no redundant second doi.org link
  });

  it('omits the embed when the paper has no filed PDF', () => {
    const noPdf: DigestArtifactForExport = {
      ...withPaper,
      papers: [{ ...withPaper.papers![0]!, pdf_path: null }],
    };
    expect(renderObsidian(noPdf)).not.toContain('(full text)');
  });
});

describe('wikilinkify', () => {
  it('wraps NCT', () => {
    expect(wikilinkify('See NCT04567890.')).toBe('See [[NCT04567890]].');
  });
  it('wraps PMID', () => {
    expect(wikilinkify('PMID: 12345678 supports.')).toBe('[[PMID 12345678]] supports.');
  });
  it('wraps doi', () => {
    expect(wikilinkify('doi:10.1056/x')).toBe('[[doi:10.1056/x]]');
  });
  it('wraps doi.org url', () => {
    expect(wikilinkify('https://doi.org/10.1056/y')).toBe('[[doi:10.1056/y]]');
  });
  it('handles multiple kinds', () => {
    const result = wikilinkify('NCT01234567 vs PMID: 99887766');
    expect(result).toContain('[[NCT01234567]]');
    expect(result).toContain('[[PMID 99887766]]');
  });
  it('handles empty input', () => {
    expect(wikilinkify('')).toBe('');
  });
  it('uppercases nct', () => {
    expect(wikilinkify('nct04567890')).toBe('[[NCT04567890]]');
  });
});
