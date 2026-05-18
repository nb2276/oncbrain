import { describe, it, expect } from 'vitest';
import { renderObsidian, wikilinkify, type DigestArtifactForExport } from '../src/lib/obsidian-export.ts';

const sampleArtifact: DigestArtifactForExport = {
  date: '2026-05-30',
  conference: { slug: 'asco2026', name: 'ASCO Annual Meeting 2026' },
  generated_at: 1717000000000,
  digest: {
    top_line: 'NCT04567890 delivers OS HR 0.62 in mCRPC.',
    tldr:
      'NCT04567890 met primary OS endpoint in mCRPC (HR 0.62). doi:10.1056/NEJMoa2024999 expected soon.',
    clusters: [
      {
        topic: 'Metastatic Castration-Resistant Prostate Cancer',
        emoji: '🍇',
        intro: 'mCRPC remains a setting of significant unmet need for OS-prolonging therapy.',
        methods: 'NCT04567890: phase III, ARPI + agent X vs ARPI alone, primary OS.',
        results: [
          'NCT04567890 met primary OS endpoint, HR 0.62',
          'See PMID: 36912345 for prior context',
        ],
        discussion: ['Sequencing vs taxanes remains open', 'Awaiting full QoL data'],
        tweet_ids: [1, 2],
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
    expect(md).toContain('  - conference/asco2026');
    expect(md).toContain('  - year/2026');
  });

  it('renders top_line bold above the TL;DR callout', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('**[[NCT04567890]] delivers OS HR 0.62 in mCRPC.**');
    expect(md).toContain('> [!summary] TL;DR');
  });

  it('renders cluster heading with emoji prefix', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('## 🍇 Metastatic Castration-Resistant Prostate Cancer');
  });

  it('emits Intro / Methods / Results / Discussion sections with emoji headings', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('> [!info] 🧪 Intro');
    expect(md).toContain('> [!example] 📐 Methods');
    expect(md).toContain('### 📊 Results');
    expect(md).toContain('### 💭 Discussion');
  });

  it('renders results bullets with wikilinks', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('- [[NCT04567890]] met primary OS endpoint, HR 0.62');
    expect(md).toContain('- See [[PMID 36912345]] for prior context');
  });

  it('omits Methods section when cluster.methods is null', () => {
    const noMethods: DigestArtifactForExport = {
      ...sampleArtifact,
      digest: {
        ...sampleArtifact.digest,
        clusters: [{ ...sampleArtifact.digest.clusters[0]!, methods: null }],
      },
    };
    const md = renderObsidian(noMethods);
    expect(md).not.toContain('📐 Methods');
  });

  it('omits Discussion section when cluster.discussion is null or empty', () => {
    const noDisc: DigestArtifactForExport = {
      ...sampleArtifact,
      digest: {
        ...sampleArtifact.digest,
        clusters: [{ ...sampleArtifact.digest.clusters[0]!, discussion: null }],
      },
    };
    const md = renderObsidian(noDisc);
    expect(md).not.toContain('💭 Discussion');
  });

  it('renders sources with author + URL + curator note', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('### 📚 Sources');
    expect(md).toContain('[Dr Foo, MD (@drfoo)](https://x.com/drfoo/status/1)');
    expect(md).toContain("📝 *Curator note:* practice-changing");
  });

  it('falls back to "unknown" when no author info available', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('[unknown](https://x.com/drbar/status/2)');
  });

  it('emits See also section with neighboring dates and conference link', () => {
    const md = renderObsidian(sampleArtifact);
    expect(md).toContain('## See also');
    expect(md).toContain('[[ASCO Annual Meeting 2026]]');
    expect(md).toContain('[[2026-05-29]]');
    expect(md).toContain('[[2026-05-31]]');
  });

  it('emits a url field when publicSiteUrl is provided', () => {
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
    expect(md).not.toContain('conference-slug:');
    expect(md).not.toMatch(/^# 2026-05-30 —/m); // no " — Conf Name" suffix
    expect(md).toMatch(/^# 2026-05-30$/m);
  });

  it('quotes YAML scalar with embedded colons', () => {
    const conf: DigestArtifactForExport = {
      ...sampleArtifact,
      conference: { slug: 'asco2026', name: 'ASCO: Annual Meeting' },
    };
    const md = renderObsidian(conf);
    expect(md).toContain('conference: "ASCO: Annual Meeting"');
  });
});

describe('wikilinkify', () => {
  it('wraps NCT in [[NCT...]]', () => {
    expect(wikilinkify('See NCT04567890 for data.')).toBe('See [[NCT04567890]] for data.');
  });

  it('wraps PMID in [[PMID N]]', () => {
    expect(wikilinkify('PMID: 12345678 supports this.')).toBe('[[PMID 12345678]] supports this.');
  });

  it('wraps doi: in [[doi:...]]', () => {
    expect(wikilinkify('See doi:10.1056/NEJMoa1234567')).toBe('See [[doi:10.1056/NEJMoa1234567]]');
  });

  it('wraps doi.org URL', () => {
    expect(wikilinkify('https://doi.org/10.1056/NEJMoa1234567')).toBe('[[doi:10.1056/NEJMoa1234567]]');
  });

  it('handles multiple kinds in one string', () => {
    const result = wikilinkify('NCT01234567 vs PMID: 99887766');
    expect(result).toContain('[[NCT01234567]]');
    expect(result).toContain('[[PMID 99887766]]');
  });

  it('returns empty for empty input', () => {
    expect(wikilinkify('')).toBe('');
  });

  it('returns unchanged text when no citations present', () => {
    expect(wikilinkify('No citations here.')).toBe('No citations here.');
  });

  it('normalizes NCT to uppercase', () => {
    expect(wikilinkify('nct04567890')).toBe('[[NCT04567890]]');
  });
});
