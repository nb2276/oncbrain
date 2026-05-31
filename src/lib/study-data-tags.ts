// v0.11 PR-1a foundations: single source of truth for the `data-tags`
// HTML attribute that v0.11+ filter logic reads off study cards.
//
// Emitted on every study card root regardless of element type (StudyCard
// uses `<div class="study">`; the home recent feed uses
// `<li class="recent-li">`). Filter UI in PR-2 queries `[data-tags]`
// regardless of tag name, so divergent DOM shells stay safe.
//
// Format: space-separated namespace:slug tokens, e.g.
//   "modality:radiation intent:curative methodology:phase-3-rct
//    verdict:practice-changing meeting:asco-2026"
//
// Why namespaced (not slug-only): the namespace map JSON also carries
// the lookup, but ?tag=<slug> URL form is slug-only by design (the
// global slug-uniqueness assertion guarantees no ambiguity at the URL
// boundary). data-tags being namespaced is an internal-DOM convenience
// for the filter's intersection logic — never exposed in URLs.
//
// Disease-site is intentionally NOT emitted as a `site:<slug>` token —
// the intent enum value `supportive` collides with the disease-site
// slug `supportive`, and v0.10's slug-uniqueness assertion does not
// cross-validate /tags/ namespaces against /sites/. Disease-site stays
// at /sites/<slug>/; the diseaseSite parameter is kept on the signature
// for forward compatibility (v0.12+ may extend the invariant) but is
// presently unused in the token list.

import { isValidModality, isValidIntent, isValidMethodology } from './tags.ts';
import { VERDICT_META } from './verdict.ts';
import type { DigestStudy } from './digest-data.ts';

export function studyDataTags(
  study: DigestStudy,
  diseaseSite: string,
  conferenceSlug: string | null,
): string {
  const tokens: string[] = [];
  if (study.modality && isValidModality(study.modality)) {
    tokens.push(`modality:${study.modality}`);
  }
  if (study.intent && isValidIntent(study.intent)) {
    tokens.push(`intent:${study.intent}`);
  }
  if (study.methodology && isValidMethodology(study.methodology)) {
    tokens.push(`methodology:${study.methodology}`);
  }
  const verdictSlug = study.verdict?.soc_implication;
  if (
    verdictSlug &&
    Object.prototype.hasOwnProperty.call(VERDICT_META, verdictSlug)
  ) {
    tokens.push(`verdict:${verdictSlug}`);
  }
  if (conferenceSlug && conferenceSlug.length > 0) {
    tokens.push(`meeting:${conferenceSlug}`);
  }
  // diseaseSite intentionally not emitted — see file header for why.
  void diseaseSite;
  return tokens.join(' ');
}
