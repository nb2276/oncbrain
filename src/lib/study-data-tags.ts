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
//    verdict:practice-changing meeting:asco-2026 site:breast"
//
// Why namespaced (not slug-only): the namespace map JSON also carries
// the lookup, but the ?tag=<slug> URL form is slug-only by design (the
// global slug-uniqueness assertion guarantees no ambiguity at the URL
// boundary). data-tags being namespaced is an internal-DOM convenience
// for the filter's intersection logic — never exposed in URLs.
//
// The `site:<slug>` token IS emitted here even though the intent slug
// `supportive` collides with the disease-site slug `supportive`. The
// namespacing in the DOM (`site:supportive` vs `intent:supportive`)
// makes them unambiguous at this layer. The /tags/<slug>/ URL surface
// stays restricted to the 5 globally-unique /tags/ namespaces; site
// filtering uses a separate URL form (decision deferred to PR-2).
//
// IMPORTANT semantic — a study with NO emitted tokens (no modality,
// intent, methodology, verdict, meeting, or site) returns the empty
// string. Callers use `dataTags || undefined` to omit the attribute
// entirely. The PR-2 filter logic must treat cards lacking the
// attribute as "always renders" (every filter state should keep them
// visible) — they were never categorized to begin with, and hiding
// them would silently drop content from view. This is intentional
// and tested in test/study-data-tags.test.ts.

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
  if (diseaseSite && diseaseSite.length > 0) {
    tokens.push(`site:${diseaseSite}`);
  }
  return tokens.join(' ');
}
