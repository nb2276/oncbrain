# Plan: ingest the trials a review discusses as full sources

Status: PLAN — /plan-eng-review 2026-06-13. Builds on v0.16 (content_type:review + discussed_trials).
**Foundation reworked per the outside voice (codex)** — see GSTACK REVIEW REPORT.
Feature: when a trade-press review names trials by acronym (STOMP, ORIOLE, RADIOSA, ARTO, ...),
resolve each to its primary published study and surface it as a real study card — through a
**curator-gated resolution manifest**, not automatic in-build ingestion.

## Problem + probe

A v0.16 review renders `discussed_trials` as plain text (no links, no cards). The curator wants
those named trials surfaced as real studies. Probe (2026-06-13):
- **ct.gov `AREA[Acronym]` is unsafe** — `STOMP` → 20 trials, NONE the oligomet-prostate STOMP;
  the real trials are mostly European/published and not on ct.gov under that acronym.
- **PubMed `<ACRONYM>[Title] AND <disease_site>` resolves cleanly** — STOMP 4 hits, ORIOLE 6
  (top = the JAMA Oncol primary), RADIOSA 3, ARTO 3, all topically on-target.

## Settled decisions (this review)

The eng-review locked automatic-in-build + full-verdict + det/rerank gate; the outside voice
(codex, gpt-5.5) showed that foundation is technically infeasible against the real code AND
editorially wrong, and the curator accepted the reframe. The settled design:

- **D1 (REVERSED → curator-gated manifest).** The resolver does NOT mutate the build. It writes a
  persisted **resolution manifest**; the curator approves/rejects; only APPROVED PMIDs enter the
  NEXT normal `build:day` as ORDINARY paper sources. Reuses the whole ingest→build pipeline
  unchanged — NO second clustering pass, NO `buildDigest` decomposition, NO partial-build mutation.
- **D2 (verdict).** A curator-approved trial is a normal source → normal study card + full verdict
  (it is human-vetted, so no cap is needed). It still renders a provenance marker
  (`↘ from the {review} round-up`, a **text pill** at `.section-label` typography per the
  emoji-vocab learning, NOT a colored circle) so the reader knows why a years-old trial appears.
- **D3 (resolver = an ASSIST, not a sole defense).** The resolver surfaces RANKED CANDIDATES +
  confidence for the curator; it never auto-publishes. So the rerank gate's calibration is no
  longer clinical-safety-critical (codex #13/#21 dissolved — the curator is the gate).

### Manifest is the freeze (resolves codex #1-4)
The manifest is a NEW table `review_trial_resolutions`, NOT a column on `papers` (codex #2):

```
review_trial_resolutions
  id                       INTEGER PK
  review_source_paper_id   INTEGER   -- STABLE key: the trade-press paper row id, NOT the
                                     --   Phase-1 slug (codex #3: slug changes on rebuild)
  acronym_norm             TEXT      -- normalized (upper, trimmed) acronym
  disease_site             TEXT
  status                   TEXT      -- 'pending' | 'approved' | 'rejected' | 'failed'
  chosen_pmid              TEXT      -- set on approve
  candidates_json          TEXT      -- [{pmid,title,journal,year,score}], for curator review
  confidence               REAL
  resolver_version         TEXT      -- so a resolver change can re-open stale entries deliberately
  created_at / decided_at  INTEGER
  UNIQUE(review_source_paper_id, acronym_norm)   -- the freeze: resolve a pair ONCE
```
Re-running `resolve` skips a pair that already has a row (any status) → resolution is frozen and
re-resolution never silently mutates a historical digest (the `static-site-live-vs-historical`
learning). A resolver_version bump is the explicit, intentional re-open path.

### Prior learnings applied
- `trade-press-doi-misattribution` (9/10): key the resolution on the resolver's OWN chosen PMID;
  the curator gate is the human gate the learning called for. Never key on a body-scraped ID.
- `static-site-live-vs-historical-tension` (9/10): the manifest IS the explicit freeze.
- `llm-plus-external-api-eval-determinism` (8/10): injectable seams (mirror `EnrichRelatedTrialsDeps`),
  recorded esearch/esummary/rerank fixtures, watch pre/post-LLM type confusion.
- `colored-circle-emoji-status-collision` (9/10): provenance marker is a text pill, not a circle.

## Architecture

```
build:day(date)                    [UNCHANGED — no second pass, no decomposition]
  └─ Phase 1 → Phase 2 → Phase 3 → committed digest (reviews carry discussed_trials)

resolve:review-trials --date=X     [NEW CLI; curator runs after a build surfaces a review]
  for each review study, for each acronym in discussed_trials (capped, see #18):
    1. key=(review_source_paper_id, acronym_norm) already in manifest? → skip (FREEZE)
    2. PubMed esearch: `<ACRONYM>[Title] AND <disease_site>`  AND a broader
         `<ACRONYM> AND <disease_site>` fallback (codex #10: primaries omit acronym in title)
    3. esummary/efetch the candidate PMIDs → titles/journal/year/abstract  (codex #8: BEFORE ranking)
    4. RANK candidates (acronym-in-title = weak signal not a gate #11; disease/MeSH match; recency)
    5. rerank-LLM: order candidates + a confidence, or NONE — ADVISORY, shown to curator (#13)
    6. write manifest row status='pending' with candidates_json + top_pick + confidence
       (no candidates / esearch error → status='failed', acronym stays plain text)

resolve:review-trials --review     [NEW; curator approves — TUI in studio]
    show acronym · disease · top candidate (title/journal/year) · alternatives · confidence
    curator → approve (choose a PMID, resolves codex #7 "which primary") | reject | defer

build:day (next run)               [approved entries flow through the EXISTING pipeline]
  └─ for each APPROVED manifest row for a review on this date:
       savePaper(chosen_pmid via fetchPubMedPaper) as an ORDINARY source for this date
       (dedup by PMID/NCT, codex #12 — never by acronym)
     → Phase 1 clusters it as a normal study; Phase 2 analyzes; full verdict
     → provenance pill "from the {review} round-up"; review's discussed_trials links to the anchor
```

No artifact-timing bug (codex #6): approved papers are ordinary sources read by the NEXT build's
normal `papersForDate`, not injected mid-build.

## What already exists (reuse, do not rebuild)

- `pubmed-client.ts` `fetchPubMedPaper(pmid)` — reuse for the approved-paper fetch. ADD
  `searchPubMed(term)` (esearch) + a batched `summarizePmids(pmids)` (esummary) for candidates.
- `clinicaltrials.ts` `acquireSlot`/retry/backoff — mirror the limiter; but add a real
  requests-per-second throttle for NCBI (codex #19: a concurrency cap ≠ an rps cap; each candidate
  is multiple E-util calls).
- `db.ts` `savePaper` + `FetchedVia` — reuse savePaper for APPROVED entries; add `'review-resolved'`
  to `FetchedVia`. The manifest is a NEW table (not a papers column).
- `build/studio.ts` (@clack TUI) + `build/manage-overrides.ts` — the approval UI mirrors the
  existing studio suppress/edit flows.
- v0.13 `EnrichRelatedTrialsDeps` / rerank client — MIRROR the injectable-deps + rerank shape.
- v0.16 `content_type` / `discussed_trials` — the resolver keys off `content_type==='review'`.

## Files (~8-9, mostly small touches; net SIMPLER than automatic-in-build per codex)

- `src/lib/pubmed-client.ts` — `searchPubMed` (esearch) + `summarizePmids` (esummary) + rps throttle.
- `src/lib/review-trial-resolver.ts` — NEW. esearch + candidate fetch + rank + rerank → manifest rows.
- `src/lib/db.ts` — NEW `review_trial_resolutions` table + migration + queries (upsert/list-pending/
  decide); `FetchedVia += 'review-resolved'`.
- `build/resolve-review-trials.ts` — NEW CLI: `--date` (populate manifest) + `--review` (approve).
- `build/studio.ts` — add the manifest-approval flow (curator approves/rejects pending).
- `build/digest-builder.ts` — on build, savePaper the APPROVED entries for the date's reviews as
  ordinary sources (small; not a second pass). Mark `resolved_from_review`.
- `src/components/StudyCard.astro` (+ `digest-data.ts` type) — provenance pill.
- `prompts/digest-v5-rerank-candidates.txt` — NEW rerank prompt (rank candidates / NONE / confidence).

## Test coverage diagram

```
CODE PATHS                                                        TESTS
[+] pubmed-client.ts
  ├─ searchPubMed(term) ........ happy/empty/HTTP-error/429-retry .. unit (recorded esearch fixture)
  └─ summarizePmids(pmids) ...... batch summary / partial failure ... unit (recorded esummary fixture)
[+] review-trial-resolver.ts
  ├─ candidate fetch + rank ..... ranking order, weak-signal title ... unit
  ├─ rerank-LLM ................. NONE → failed row; ranked → pending  unit (mock client)
  ├─ FREEZE: existing pair ...... skip, no re-search ................ unit
  ├─ esearch error .............. status='failed', no crash ......... unit
  └─ [→EVAL] candidate precision/recall on the real acronyms + ≥3
       same-disease collisions (must NOT top-rank the wrong trial) .. eval (recorded, labeled corpus #14)
[+] db.ts review_trial_resolutions
  ├─ upsert/freeze UNIQUE(paper_id,acronym) ........................ unit
  ├─ list-pending / approve(pmid) / reject ......................... unit
  └─ resolver_version bump re-opens ................................ unit
[+] resolve-review-trials CLI + studio approval
  ├─ populate manifest for a review date ........................... integration (mocked deps)
  └─ approve → status flips, chosen_pmid set ....................... integration
[+] digest-builder (approved → source)
  ├─ approved entry → savePaper as ordinary source next build ...... integration (backfill-smoke)
  ├─ pending/rejected entry → NOT ingested ......................... integration (the gate invariant)
  ├─ dedup: chosen_pmid already a source → no duplicate ............ integration
  └─ resolved study carries resolved_from_review + full verdict .... integration
[+] StudyCard.astro
  └─ provenance pill renders ....................................... [BUILD-VERIFIED] synthetic build

COVERAGE TARGET: 100% resolver + manifest + CLI branches; the freeze + gate (pending-not-ingested)
                 invariants; a labeled resolution eval (precision-first, collisions → NONE).
```

## Failure modes

- **Bad candidate surfaced** → curator sees it in the manifest and rejects. Not a published error
  (the gate is BEFORE publish). TEST: collision fixture → rerank NONE / low confidence.
- **esearch/esummary/NCBI down or rate-limited** → manifest row status='failed'; acronym stays
  plain text; build unaffected. TEST: HTTP-error fixture.
- **Re-resolution drift** → frozen by the manifest UNIQUE key. TEST: freeze unit + the
  resolver_version re-open unit.
- **Duplicate study** (approved PMID already a source) → dedup by PMID/NCT at ingest. TEST: dedup integration.
- **Curator never approves** → discussed_trials stays plain text (the v0.16 status quo). No regression.
- No un-mitigated SILENT clinical gap: nothing publishes without the curator approving it.

## NOT in scope

- Automatic in-build ingestion / a second clustering pass (codex: infeasible + editorially wrong; reversed).
- ct.gov resolution (probe: unsafe for these acronyms).
- Resolving trials named outside a review (study_report bullets) — reviews only.
- Cross-day entity persistence (ties to the v0.7+ entity-resolution TODO; separate).
- Backfilling already-published review days (a one-off `resolve --backfill` later; not v1).
- Auto-approval / confidence-threshold auto-accept (defer until the eval shows the resolver is
  precise enough to trust without a human — explicitly a follow-up, NOT v1).

## Eval

Touches the LLM (rerank) + an external API (PubMed) → recorded fixtures, no live calls. Because the
curator gates publication, the eval measures CANDIDATE QUALITY (does the right paper rank top, do
same-disease collisions rank NONE/low), not a safety gate — a precision-first labeled corpus
(the real acronym set + ≥3 deliberate collisions), run before ship. (codex #14, right-sized to D1.)

## Open resolution-quality items folded in (codex #7-12, must be in the build)
- #7 "primary paper": the manifest shows candidates + alternatives; the CURATOR picks (protocol vs
  results vs follow-up). The resolver does not force-pick a single "primary."
- #8: esummary/efetch candidate metadata BEFORE ranking (not one post-resolution fetch).
- #9: DROP the verbatim-acronym-in-source check — it is circular (the acronym came from that text),
  it proves nothing about the candidate paper.
- #10: search title AND broader; don't gate on title-membership.
- #11: result_count is a weak signal at most, never a hard accept/reject.
- #12: dedup by PMID/NCT only, never by acronym.

## Distribution
Existing pipeline (build:day → committed JSON → DO static) + two new CLI subcommands. No new artifact type.

## Parallelization
| Step | Modules | Depends on |
|------|---------|------------|
| esearch+esummary in pubmed-client | src/lib | — |
| review_trial_resolutions table | src/lib/db | — |
| resolver module | src/lib | esearch, table |
| resolve CLI + studio approval | build/ | resolver, table |
| digest-builder approved→source | build/ | table |
| StudyCard provenance pill | src/components | db type |

Lane A: pubmed-client + table (parallel) → resolver → CLI/studio + builder (sequential).
Lane B: StudyCard pill (independent once the type lands). Mostly Lane A.

## Implementation Tasks
- [ ] **T1 (P1)** — db — `review_trial_resolutions` table + migration + upsert/list/decide queries + freeze UNIQUE. Files: src/lib/db.ts, test/db.test.ts. Verify: unit.
- [ ] **T2 (P1)** — pubmed-client — `searchPubMed` (esearch) + `summarizePmids` (esummary) + rps throttle. Files: src/lib/pubmed-client.ts, test/pubmed-client.test.ts. Verify: recorded-fixture unit.
- [ ] **T3 (P1)** — resolver — review-trial-resolver.ts: candidate fetch + rank + rerank-LLM (advisory) → manifest rows; failed-row + freeze paths. Files: src/lib/review-trial-resolver.ts, test/. Verify: unit + mock rerank.
- [ ] **T4 (P1)** — CLI + approval — resolve-review-trials.ts (`--date`/`--review`) + studio approval flow. Files: build/resolve-review-trials.ts, build/studio.ts. Verify: integration.
- [ ] **T5 (P1)** — builder — approved manifest entries → savePaper as ordinary sources (dedup by PMID/NCT); pending/rejected NOT ingested. Files: build/digest-builder.ts. Verify: backfill-smoke integration.
- [ ] **T6 (P2)** — render — provenance pill + discussed_trials → anchor link. Files: src/components/StudyCard.astro, src/lib/digest-data.ts. Verify: synthetic astro build.
- [ ] **T7 (P2)** — eval — labeled resolution corpus (real acronyms + ≥3 collisions), recorded fixtures, precision-first. Files: test/fixtures, build/eval.ts. Verify: npm run eval.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 21 findings; foundation reworked |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | 4 decisions locked (D1 reversed per codex), 0 unmitigated critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** outside voice found the automatic-in-build foundation technically infeasible against the real code (savePaper global keying, monolithic buildDigest, non-atomic persistence, artifact-capture timing) and editorially wrong (historical-paper distortion of a daily digest; uncalibrated LLM as the sole defense for full-verdict cards). Recommended the curator-gated manifest. Curator ACCEPTED the reframe.
- **CROSS-MODEL:** the eng review locked automatic-in-build + full-verdict + det/rerank gate; codex reversed the foundation to a curator-gated manifest. Curator accepted — D1 reversed, D2/D3 re-scoped (curator is the gate; resolver is an advisory candidate-ranker; freeze is the manifest UNIQUE key). Surviving resolution-quality findings (#7-12, #14) folded in as build requirements; the circular source-check (#9) dropped.
- **VERDICT:** ENG reviewed; plan REWORKED to the curator-gated manifest and cleared to implement. The resolution-quality + eval-precision work (T7) is folded into the build, not deferred.

**UNRESOLVED DECISIONS:**
- Auto-approval threshold — whether a high-confidence resolver pick should ever auto-approve without the curator, deferred until the T7 eval shows the resolver's precision (NOT in v1).
