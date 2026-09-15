// The Lancet family prints decimals with a MIDDLE DOT: "OR 2·80 (0·75–10·41);
// p=0·079". Every numeric tokenizer in the grounding gates reads `\d+\.\d+`, so
// "2·80" became the two tokens "2" and "80", and a card quoting the paper's own
// "2.80" was judged ungrounded. On TORPEdO (2026-09-09) that withheld the primary
// endpoint and two results tables — numbers printed verbatim in the source.
//
// effect-size.ts and figure-extract.ts already normalize middle dots, each for its
// own inputs. The Phase 2 gates, the comparator gate and the figure-sourced marker
// did not. Rather than a fourth local fix, source text is normalized once at the
// door (buildDigest's input items; source-tier's token reader, which the builder
// feeds straight from DB rows), so the study agent and every gate read one
// spelling.
//
// ONLY between two digits. A middle dot is also a separator (" · ") and a bullet
// ("•" is left alone entirely); rewriting those in prose the agent reads would
// corrupt it. Measured on the 11 stored papers that use the convention: 1447
// digit·digit occurrences, none of them anything but a decimal ("D0·1 cc" is
// D0.1 cc).
import type { DigestInputItem } from './llm-pipeline.ts';

const DIGIT_DOT_DIGIT = /(\d)[·∙⋅](?=\d)/g;

export function normalizeDecimalSeparators(text: string): string {
  return text.replace(DIGIT_DOT_DIGIT, '$1.');
}

function norm<T extends string | null | undefined>(v: T): T {
  return (typeof v === 'string' ? normalizeDecimalSeparators(v) : v) as T;
}

// Every source-text field an item carries. Identifiers (doi, pmid) and file paths
// are left alone: a DOI is quoted verbatim and never contains a digit·digit anyway.
export function normalizeItemDecimals(item: DigestInputItem): DigestInputItem {
  if (item.source_type === 'paper') {
    return {
      ...item,
      title: normalizeDecimalSeparators(item.title),
      abstract: norm(item.abstract),
      fulltext_excerpt_md: norm(item.fulltext_excerpt_md),
      figure_ocr_md: norm(item.figure_ocr_md),
      figure_structured_md: norm(item.figure_structured_md),
    };
  }
  if (item.source_type === 'slide') {
    return { ...item, ocr_text: norm(item.ocr_text) };
  }
  return {
    ...item,
    text: normalizeDecimalSeparators(item.text),
    image_ocr_texts: item.image_ocr_texts?.map(normalizeDecimalSeparators),
  };
}
