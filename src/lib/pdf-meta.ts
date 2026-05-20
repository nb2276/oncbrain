// PDF metadata extraction via the LLM (v0.8 PR2).
//
// A PDF has no Highwire <meta> tags like a journal HTML page, so we extract
// bibliographic metadata from its text. Unlike the URL path (which resolves a
// DOI/PMID through Crossref/PubMed), a PDF carries the FULL text — the richest
// possible source — so we ask the LLM to read it directly. This also yields a
// provisional disease_site for vault filing and a title even when the paper
// has no DOI/PMID at all (the user chose "store every PDF").
//
// Robustness: the full text is stored separately as fulltext_excerpt_md and
// fed to the build-time study agent regardless, so if the LLM response can't
// be parsed we degrade to a text-derived title rather than dropping the paper.
// A DOI/PMID regex backstops the LLM so dedup against URL-ingested papers
// still works when the model misses an identifier.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLlmClient, type LlmClient } from './llm-client.ts';
import { diseaseSiteSlugList, isValidDiseaseSiteSlug } from './disease-sites.ts';
import { normalizeDoi } from './doi.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '../../prompts/pdf-meta-v1.txt');

// Title/authors/abstract/DOI all sit on the first page; cap the prompt so a
// 200-page PDF doesn't blow the token budget. Identifiers in footers are
// covered by the regex backstop over the full text.
const MAX_PROMPT_CHARS = 16_000;

export type PdfPaperMeta = {
  title: string;
  authors: string[];
  journal: string | null;
  pub_date: string | null;
  doi: string | null;
  pmid: string | null;
  abstract: string | null;
  disease_site: string;
};

export type ExtractMetaOptions = {
  client?: LlmClient;
  model?: string;
};

const DOI_IN_TEXT_RE = /\b10\.\d{4,9}\/[^\s"<>)\]}]+/gi;
const PMID_IN_TEXT_RE = /\bPMID\s*[:.]?\s*(\d{4,9})\b/i;

// Extract metadata from a PDF's full text. Never throws on a malformed LLM
// response — falls back to a text-derived title. Re-throws only if the LLM
// CALL itself fails (network/backend), which the caller treats as retryable.
export async function extractPaperMetaFromText(
  text: string,
  opts: ExtractMetaOptions = {},
): Promise<PdfPaperMeta> {
  const client = opts.client ?? createLlmClient();
  const template = readFileSync(PROMPT_PATH, 'utf-8');
  const prompt = template
    .replace('{{SITE_SLUGS}}', diseaseSiteSlugList())
    .replace('{{PDF_TEXT}}', text.slice(0, MAX_PROMPT_CHARS));

  const raw = await client.complete([{ role: 'user', content: prompt }], {
    model: opts.model,
    maxTokens: 1500,
    temperature: 0,
  });

  const meta = parsePdfMeta(raw, text);
  // Regex backstop: fill identifiers the model missed so dedup still works.
  if (!meta.doi) {
    const m = text.match(DOI_IN_TEXT_RE);
    if (m && m[0]) meta.doi = normalizeDoi(m[0]);
  }
  if (!meta.pmid) {
    const m = text.match(PMID_IN_TEXT_RE);
    if (m && m[1]) meta.pmid = m[1];
  }
  return meta;
}

// Parse the LLM JSON. Tolerant: on any structural failure, return a minimal
// meta keyed off a text-derived title so the paper is still captured.
export function parsePdfMeta(raw: string, fallbackText = ''): PdfPaperMeta {
  const fallbackTitle = firstMeaningfulLine(fallbackText) || '(untitled PDF)';
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return minimalMeta(fallbackTitle);
  }
  if (!parsed || typeof parsed !== 'object') return minimalMeta(fallbackTitle);
  const o = parsed as Record<string, unknown>;

  const title = str(o.title) ?? fallbackTitle;
  const authors = Array.isArray(o.authors)
    ? o.authors.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
    : [];
  const siteRaw = str(o.disease_site) ?? '';
  const disease_site = isValidDiseaseSiteSlug(siteRaw) ? siteRaw : 'other';
  const pmidRaw = str(o.pmid);
  const pmid = pmidRaw && /^\d{4,9}$/.test(pmidRaw) ? pmidRaw : null;

  return {
    title,
    authors,
    journal: str(o.journal),
    pub_date: normalizePubDate(str(o.pub_date)),
    doi: normalizeDoi(str(o.doi)),
    pmid,
    abstract: str(o.abstract),
    disease_site,
  };
}

function minimalMeta(title: string): PdfPaperMeta {
  return {
    title,
    authors: [],
    journal: null,
    pub_date: null,
    doi: null,
    pmid: null,
    abstract: null,
    disease_site: 'other',
  };
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// Accept "YYYY" or "YYYY-MM-DD" (or longer ISO); reject anything else so a
// free-text date doesn't pollute the column.
function normalizePubDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/\b(\d{4}(?:-\d{2}(?:-\d{2})?)?)\b/);
  return m ? m[1]! : null;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length >= 8) return t.slice(0, 300);
  }
  return '';
}

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
