import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolvePmcOaPackageUrl,
  parsePmcFigures,
  enrichPmcOaFigures,
  isPmcOaFiguresEnabled,
  assertSafeTarListing,
  resolvePmcIdForDoi,
} from '../src/lib/pmc-oa.ts';

const OA_XML = `<OA><records><record id="PMC13901" license="CC BY">
  <link format="pdf" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/08/e0/PMC13901.pdf"/>
  <link format="tgz" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/08/e0/PMC13901.tar.gz"/>
</record></records></OA>`;
const NON_OA_XML = `<OA><request id="PMC999"/><error code="idIsNotOpenAccess">not OA</error></OA>`;

describe('resolvePmcOaPackageUrl (v0.24)', () => {
  it('returns the tgz package URL, rewritten ftp→https, for an OA article', async () => {
    const url = await resolvePmcOaPackageUrl('PMC13901', async () => OA_XML);
    expect(url).toBe('https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/08/e0/PMC13901.tar.gz');
  });
  it('normalizes a bare numeric id to a PMC-prefixed query', async () => {
    let seen = '';
    await resolvePmcOaPackageUrl('13901', async (u) => {
      seen = u;
      return OA_XML;
    });
    expect(seen).toContain('id=PMC13901');
  });
  it('returns null for a non-OA article', async () => {
    expect(await resolvePmcOaPackageUrl('PMC999', async () => NON_OA_XML)).toBeNull();
  });
  it('returns null when the OA query throws', async () => {
    expect(
      await resolvePmcOaPackageUrl('PMC1', async () => {
        throw new Error('net');
      }),
    ).toBeNull();
  });

  it('REJECTS a poisoned tgz href pointing off NCBI (#P1 host-pin)', async () => {
    const evil = `<OA><records><record><link format="tgz" href="https://ftp.ncbi.nlm.nih.gov.evil.com/x.tar.gz"/></record></records></OA>`;
    expect(await resolvePmcOaPackageUrl('PMC1', async () => evil)).toBeNull();
    const evil2 = `<OA><records><record><link format="tgz" href="https://evil.com/x.tar.gz"/></record></records></OA>`;
    expect(await resolvePmcOaPackageUrl('PMC1', async () => evil2)).toBeNull();
  });
});

describe('resolvePmcIdForDoi (v0.25 #1 DOI→PMCID)', () => {
  it('returns the PMCID for a DOI that is in PMC', async () => {
    const json = JSON.stringify({ status: 'ok', records: [{ doi: '10.1200/x', pmcid: 'PMC7654321' }] });
    expect(await resolvePmcIdForDoi('10.1200/x', async () => json)).toBe('PMC7654321');
  });
  it('returns null when the DOI is not in PMC (error record)', async () => {
    const json = JSON.stringify({ records: [{ doi: '10.1200/x', status: 'error', errmsg: 'invalid' }] });
    expect(await resolvePmcIdForDoi('10.1200/x', async () => json)).toBeNull();
  });
  it('rejects a mis-mapped record whose echoed DOI differs from the query (#P2)', async () => {
    const json = JSON.stringify({ records: [{ doi: '10.9999/other', pmcid: 'PMC111' }] });
    expect(await resolvePmcIdForDoi('10.1200/x', async () => json)).toBeNull();
  });
  it('rejects a record with a pmcid but NO echoed DOI (unverified) (#P2 re-review)', async () => {
    const json = JSON.stringify({ records: [{ pmcid: 'PMC111' }] });
    expect(await resolvePmcIdForDoi('10.1200/x', async () => json)).toBeNull();
  });
  it('returns null on malformed JSON or a fetch failure', async () => {
    expect(await resolvePmcIdForDoi('10.1200/x', async () => 'not json')).toBeNull();
    expect(
      await resolvePmcIdForDoi('10.1200/x', async () => {
        throw new Error('net');
      }),
    ).toBeNull();
  });
  it('returns null for a blank doi (no query)', async () => {
    let queried = false;
    const r = await resolvePmcIdForDoi('  ', async () => {
      queried = true;
      return '';
    });
    expect(r).toBeNull();
    expect(queried).toBe(false);
  });
});

describe('assertSafeTarListing (v0.24 #P1 tar-slip / bomb)', () => {
  const clean = `-rw-r--r--  0 0 0    12345 Jan  1 2020 PMC13901/main.nxml
-rw-r--r--  0 0 0   200000 Jan  1 2020 PMC13901/fig1.jpg`;

  it('accepts a clean file/dir listing', () => {
    expect(() => assertSafeTarListing(clean)).not.toThrow();
  });

  it('rejects a symlink entry (escape vector)', () => {
    const sym = `lrwxr-xr-x  0 0 0        0 Jan  1 2020 PMC/evil -> /etc/passwd`;
    expect(() => assertSafeTarListing(sym)).toThrow(/unsafe entry type/);
  });

  it('rejects a path-traversal entry', () => {
    const trav = `-rw-r--r--  0 0 0    12345 Jan  1 2020 ../../etc/cron.d/x`;
    expect(() => assertSafeTarListing(trav)).toThrow(/unsafe path/);
  });

  it('rejects an absolute-path entry', () => {
    const abs = `-rw-r--r--  0 0 0    12345 Jan  1 2020 /etc/passwd`;
    expect(() => assertSafeTarListing(abs)).toThrow(/unsafe path/);
  });

  it('rejects a decompression bomb (uncompressed size over cap)', () => {
    const bomb = `-rw-r--r--  0 0 0 600000000 Jan  1 2020 PMC/huge.bin`;
    expect(() => assertSafeTarListing(bomb)).toThrow(/exceeds cap/);
  });
});

describe('parsePmcFigures (v0.24)', () => {
  const nxml = `<article>
    <fig id="F1"><label>Figure 1</label><caption><p>KM overall survival, HR 0.62.</p></caption><graphic xlink:href="fig1"/></fig>
    <table-wrap id="T1"><label>Table 2</label><caption><title>Baseline</title></caption><graphic xlink:href="tbl2.jpg"/></table-wrap>
    <fig id="F2"><label>Figure 2</label><caption><p>Not in package.</p></caption><graphic xlink:href="missing"/></fig>
  </article>`;
  const files = ['/tmp/x/PMC1/fig1.jpg', '/tmp/x/PMC1/tbl2.jpg', '/tmp/x/PMC1/logo.png'];

  it('maps a graphic href (extension-agnostic) to the extracted image, with label + caption', () => {
    const figs = parsePmcFigures(nxml, files);
    // F2 dropped: its href ("missing") maps to no extracted file.
    expect(figs.map((f) => f.label)).toEqual(['Figure 1', 'Table 2']);
    expect(figs[0]!.imagePath).toBe('/tmp/x/PMC1/fig1.jpg');
    expect(figs[0]!.caption).toContain('HR 0.62');
    expect(figs[1]!.imagePath).toBe('/tmp/x/PMC1/tbl2.jpg');
  });

  it('prefers the rendered raster (.jpg) over a .tif on a basename collision (#P2)', () => {
    const nx = `<fig><label>Figure 1</label><caption><p>x</p></caption><graphic xlink:href="fig1"/></fig>`;
    // Order shouldn't matter: .tif listed first, .jpg still wins.
    const figs = parsePmcFigures(nx, ['/x/fig1.tif', '/x/fig1.jpg']);
    expect(figs[0]!.imagePath).toBe('/x/fig1.jpg');
  });
});

describe('enrichPmcOaFigures (v0.24)', () => {
  afterEach(() => {
    delete process.env.PMC_OA_FIGURES;
  });

  const bigJpg = Buffer.alloc(10 * 1024, 1); // ≥ MIN_FIGURE_BYTES (8KB)
  function fixtureUntar(_tarPath: string, dest: string): void {
    const sub = join(dest, 'PMC13901');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'main.nxml'),
      `<article><fig><label>Figure 1</label><caption><p>KM</p></caption><graphic xlink:href="fig1"/></fig></article>`,
    );
    writeFileSync(join(sub, 'fig1.jpg'), bigJpg);
  }
  const okDeps = {
    fetchText: async () => OA_XML,
    fetchBuffer: async () => Buffer.from('fake-tarball'),
    untar: fixtureUntar,
    ocr: async () => 'OS HR 0.62 (0.48-0.79)',
    ocrAvailable: () => true,
    qwenAvailable: async () => false, // no structured / LLM in the unit test
  };

  it('OCRs OA figure images and returns labeled figure_ocr_md', async () => {
    const r = await enrichPmcOaFigures('PMC13901', okDeps);
    expect(r.figure_ocr_md).toContain('HR 0.62');
    expect(r.figure_ocr_md).toContain('[Figure 1]');
    expect(r.figure_structured_md).toBeNull(); // Qwen off
  });

  it('runs the grounded structured layer when Qwen is available', async () => {
    const r = await enrichPmcOaFigures('PMC13901', {
      ...okDeps,
      qwenAvailable: async () => true,
      structured: async () => '### Panel A\n- HR 0.62 (0.48-0.79)',
    });
    expect(r.figure_structured_md).toContain('HR 0.62');
  });

  it('returns nulls for a non-OA article and never downloads', async () => {
    let downloaded = false;
    const r = await enrichPmcOaFigures('PMC999', {
      ...okDeps,
      fetchText: async () => NON_OA_XML,
      fetchBuffer: async () => {
        downloaded = true;
        return Buffer.from('');
      },
    });
    expect(r).toEqual({ figure_ocr_md: null, figure_structured_md: null });
    expect(downloaded).toBe(false);
  });

  it('returns nulls when Vision OCR is unavailable (non-macOS)', async () => {
    const r = await enrichPmcOaFigures('PMC13901', { ...okDeps, ocrAvailable: () => false });
    expect(r.figure_ocr_md).toBeNull();
  });

  it('honors the PMC_OA_FIGURES=off kill switch', async () => {
    process.env.PMC_OA_FIGURES = 'off';
    expect(isPmcOaFiguresEnabled()).toBe(false);
    const r = await enrichPmcOaFigures('PMC13901', okDeps);
    expect(r).toEqual({ figure_ocr_md: null, figure_structured_md: null });
  });

  it('slices a single over-cap OCR block to the char cap (#P2), never overflows', async () => {
    const r = await enrichPmcOaFigures('PMC13901', {
      ...okDeps,
      ocr: async () => 'x'.repeat(10_000), // >> MAX_FIGURE_OCR_CHARS (6000)
    });
    expect(r.figure_ocr_md!.length).toBeLessThanOrEqual(6000);
  });
});
