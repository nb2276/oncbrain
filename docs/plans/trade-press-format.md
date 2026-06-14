# Plan: trade-press source format (single-study + topic-review)

Source design: `~/.gstack/projects/nb2276-oncbrain/nboehling-fix-trade-press-article-link-design-20260613-135111.md` (APPROVED)
Builds on: v0.15.3 (source_url plumbing + `article →` link already shipped)
Status: PLAN — reviewed via /plan-eng-review 2026-06-13. **Foundation reworked per Codex outside voice** (see report).

## Settled decisions (post-review)
- **`content_type: 'study_report' | 'review'` is a FIRST-CLASS field, classified at PHASE 1, orthogonal to `methodology`** (reverses the earlier A1). Codex #1/#2: Phase 1's "one item = one study" clustering runs before Phase 2, so a multi-trial review must be recognized as its own standalone cluster at grouping time, not repaired downstream; and `methodology` means study *design* (a trade report of a phase-3 RCT is still phase-3-rct) — overloading it loses that + pollutes `/tags/`.
- **"Trials discussed" is ACRONYM TEXT, not NCT links** (Codex #3). The exemplar UroToday review names STOMP/ORIOLE/RADIOSA/WOLVERINE/ARTO by acronym with zero NCTs; the conservative no-inference rule means we cannot link them. Render the trial names as plain text the LLM lifts from the review; link to ct.gov ONLY for an acronym that also carries an explicit NCT in the text (rare).
- **Provenance is source-level, not card-level** (Codex #5, refines CQ1). The source pills already show "📄 UroToday". A card-level "as reported by {outlet}" label renders ONLY when the study's sources are trade-press-only; for a mixed cluster (trade + primary paper + slides) it would misattribute, so it's suppressed there.
- **Classification is LLM-inferred**, gated by an **instrumented** probe (M0). Curator-declared rejected (D1).
- **Conservative primary link:** ct.gov/DOI only when the trade text carries an explicit NCT/DOI; never infer (dato-DXd lesson).

## What already exists (reused, not rebuilt)
- `source_url` + `article →` link (StudyCard/api/obsidian) — shipped v0.15.3.
- Verdict suppression: StudyCard guards `study.verdict?` everywhere → a no-verdict study renders clean (no rendering work; verified L113/155/199).
- `methodology` → `/tags/` via `tag-foundations.ts`; source-type pills already carry the outlet.
- NCT extraction (`extract.ts`) + `nct` → ct.gov link.

## Milestone 0 — Probe instrumentation + classification probe (GATE)
Codex #6: raw Phase 2 JSON is parsed for `related_search` then discarded — the probe isn't executable as-is.
1. Add temporary instrumentation: log/persist the raw Phase 1 cluster decision + raw Phase 2 JSON for trade-press items (a `--probe` flag on build:day, or a scratch console dump in `llm-pipeline.ts`).
2. Throwaway Phase 1 nudge: tag a trade-press cluster `content_type: study_report | review`; Phase 2 nudge: emit `discussed_trials: string[]` (acronyms).
3. **Back up** `data/digests/2026-06-09.json` + `2026-06-12.json` (build:day clobbers — memory `build-day-dry-run-clobbers`). Build both dates. Inspect: did Phase 1 keep the UroToday review as its own cluster (not flattened/merged)? content_type correct on both? Were trial acronyms extracted (no wrong-trial)? **Restore** the digests.
4. Codex #7: add ≥1 ambiguous article + a mixed-source cluster + a repeat run, not just the 2 hand-picked.
5. GATE: reliable classification + clean Phase-1 handling + acronym extraction → M1. Else STOP/reconsider.

### M0 RESULT (2026-06-13) — GATE: PASS with refinements
Ran the probe (Phase-2 capability proxy: `probe_content_type` + `probe_discussed_trials`, PROBE-gated logging) on 2026-06-09 (3 papers) + 2026-06-12 (UroToday review).
- ✅ **Classification 4/4 correct.** UroToday SBRT survey → `review`; ASCO Post breast-RT (→RAPCHEM), RTOG-0539, FIRESTORM → `study_report`. Clean review-vs-study distinction, incl. FIRESTORM (a formal meta-analysis) correctly NOT lumped with the narrative review.
- ✅ **Acronym extraction works (resolves Codex #3).** The review yielded 14 trial acronyms VERBATIM (STOMP, ORIOLE, RADIOSA, ARTO, STAMPEDE2, PLATON, OLIGOPRESTO, SATURN, RAVENS, LUNAR, …) with zero NCTs present — confirming the acronym-TEXT design (NCT-linking would have rendered blank).
- ⚠️ **Verdict suppression is NOT automatic (confirms Codex #9).** The review still emitted `verdict=confirmatory`. M1 MUST explicitly force `verdict:null` for `content_type==='review'` (post-override invariant), not rely on classification alone.
- ⚠️ **Acronym list needs a cap (~8) + a light noise filter.** 14 is high and included a likely fragment ("PP3"). Cap + drop sub-2-char / non-acronym tokens.
- ⚠️ **Phase-1 flattening (Codex #1) NOT exercised.** Both probe days had distinct-topic papers (no review co-occurring with a single-trial item about a trial it discusses), so the clustering-merge risk wasn't triggered. Residual: M1 should add a constructed co-occurrence fixture (a review + a single-trial item on an overlapping trial, same day) to confirm Phase 1 keeps them as distinct clusters, OR accept it as a known risk.

Net: capability validated (classify + extract are reliable); the layer placement (Phase 1) + verdict invariant + acronym cap are implementation details for M1; the Phase-1 co-occurrence case is the one residual to cover in M1.

## Milestone 1 — Phase 1 + schema + parse (only if M0 passes)
- `prompts/digest-v5-grouping.txt`: recognize a trade-press review as a standalone cluster + emit `content_type`.
- `src/lib/llm-pipeline.ts`: `content_type` on the cluster→study; parse `discussed_trials: string[]` (cap ~8); **post-override invariant** (Codex #9): a `review` study must end with `verdict: null` AFTER `applyOverrides` (assert/clamp in `digest-builder.ts` after override application, not just at parse).
- Schema: `content_type` + `discussed_trials` on DigestStudy + the artifact types. `methodology` stays the study design (unchanged).

### M1 RESULT (2026-06-13) — DONE (data/parse/prompt/invariant layer); 1298 tests pass, 0 type errors
- **New module `src/lib/content-type.ts`**: `ContentType` (`study_report` | `review`), `parseContentType` (normalizes case/separators, conservative `study_report` default), `isValidContentType`, and `stripReviewVerdicts(digest)` — the Codex-#9 invariant as a testable pure helper. Lives OUTSIDE `tags.ts` on purpose (not a `/tags/` namespace → excluded from the global tag-slug uniqueness assertion).
- **Phase 1**: `StudyCluster.content_type` (required), parsed in `parseGroupingResponse` with the back-compat default. Grouping prompt: classify rule + "a review stays its OWN cluster, never merged" rule (closes Codex #1 at the mechanism level).
- **Phase 2**: `content_type` INHERITED from the cluster (Phase 2 does not re-classify); `discussed_trials` parsed via `parseDiscussedTrials` (cap 8, dedupe case-insensitive, drop empties/single-char/sentence-blobs, keep S1207/E2112-style names). Only a review attaches it; the default `study_report` omits `content_type` to keep the committed corpus byte-stable. Study-agent prompt: verbatim-acronym, no-NCT, no-inference emission rule.
- **Builder**: `stripReviewVerdicts(digest)` runs in the post-override sweep next to the preprint clamp.
- **Schema**: both `DigestStudy` definitions (llm-pipeline + digest-data) carry `content_type?` + `discussed_trials?`; the artifact `digest` block carries them automatically (no `buildArtifact` field-mapping change).
- **Tests**: `test/content-type.test.ts` (enum/parse/validate + the override-survival invariant) + grouping-content_type / Phase-2-inheritance / `parseDiscussedTrials` cases in `test/llm-pipeline.test.ts`.
- **Residual carried to M3**: the Phase-1 co-occurrence case (review + single-trial item on an overlapping trial, same day) is covered by the prompt's keep-standalone rule but is confirmed empirically only at the M3 real-build verify — no unit test can exercise live LLM clustering.
- **Not in M1 (→ M2)**: rendering. A review currently produces `content_type:review` + `discussed_trials` + no verdict, but nothing renders the acronym list / provenance line yet, and the TriageRail no-verdict fallback emoji is still M2.

## Milestone 2 — Rendering
- `StudyCard.astro`: "🗞️ Reported via {journal} →" provenance line; trade-press-ONLY card gets the "as reported by {outlet}" label (suppressed on mixed clusters, Codex #5); for `content_type==='review'`, render `discussed_trials` as a plain-text "Trials discussed" list; verdict already suppressed by the existing guards.
- TriageRail fallback 📋 emoji for a no-verdict study — fix in ALL three builders (Codex #10): `src/pages/[date].astro`, `sites/[site].astro`, `tags/[...slug].astro` (extract a shared helper, DRY).

## Milestone 3 — Tests + eval + verify
- Unit: `content_type` parse; `discussed_trials` cap; review → `verdict:null` survives overrides (the #9 invariant); render-time provenance label conditional on trade-press-only; TriageRail fallback emoji helper.
- Eval (T1, refined per Codex #8): the judge has no classification/attribution dimension and `npm run eval` doesn't baseline-compare by default. Either add a classification-correctness dimension to `prompts/eval-judge-v1.txt` + run with `--compare-baseline`, or accept the eval only as a coarse regression check and rely on the probe + manual verify for classification. Add a trade-press fixture (review + single-study).
- Real build verify on 2026-06-12 + 2026-06-09; publish as a separate content commit.

## Open / deferred
- **#4 body-DOI for single-study reports:** trade ingestion (`inbox-enrichment.ts:628`) deliberately strips body DOIs, and StudyCard only links `paper.doi`. Linking an explicit DOI named in a single-study trade article needs an ingestion change — **deferred decision** (out of this scope unless we decide to capture body DOIs).
- **Phase-1 classification mechanism:** LLM-classify at grouping vs a lightweight heuristic — **decide after M0** shows what's reliable.

## Failure modes
- Mis-classify review↔study → bogus verdict / lost numbers. Mitigation: M0 gate + conservative default (prefer `review` when unsure — losing a verdict beats a bogus one) + the post-override `verdict:null` invariant.
- `discussed_trials` wrong acronym → misleading list. Mitigation: lift verbatim from text, cap, no NCT inference.
- Mixed-cluster attribution → handled by source-only label suppression (#5).

## Parallelization
Sequential, probe-gated (M0 → M1 → M2). Independent unit: the trade-press eval fixture (M3).

## Distribution
Existing pipeline (build:day → committed JSON → DO static). Prompt-dependent; verified on a real build before publish.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 10 findings; foundation reworked |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | 3 section findings (A1/CQ1/T1) all folded; reworked per Codex |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** outside voice found the plan's foundation unsound (review breaks Phase-1 clustering; `methodology` is the wrong field; trials-discussed-via-NCT renders blank on the exemplar; probe not executable). User accepted the reframe; plan reworked: content_type as a first-class Phase-1 field, acronym-text trials-discussed, instrumented probe, source-level attribution, post-override verdict invariant, TriageRail fixed on all 3 pages.
- **CROSS-MODEL:** Codex reversed the section review's A1 (methodology-as-signal) and refined CQ1 (card-level → source-level attribution). Both accepted by the user.
- **VERDICT:** ENG reviewed; plan REWORKED, NOT yet cleared to implement — M0 (instrumented probe) must pass and two design points remain open. Re-run /plan-eng-review after M0, or proceed to M0 directly.

**UNRESOLVED DECISIONS:**
- Phase-1 classification mechanism (LLM-classify at grouping vs heuristic) — decide after the M0 probe shows what's reliable.
- #4 body-DOI capture for single-study trade reports — needs an ingestion change; in/out of scope is undecided.
