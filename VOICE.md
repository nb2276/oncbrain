# VOICE.md: oncbrain language and framing

Single source of truth for AI voice and framing across the project. Two consumers
read this file:

1. **Build-time analyst LLM.** Phase 1, 2, and 3 prompts include this file
   verbatim at every digest build via template substitution. Implementation:
   `src/lib/llm-pipeline.ts:loadVoice()`. Edit this file and the next digest
   build picks up the change.
2. **Coding-time AI** (Claude Code). Reads this when writing UI copy, error
   messages, button labels, commit messages, or editing the prompt templates.

If you want to push the project's voice in a new direction, edit this file. Both
consumers will follow.

---

## Audience

Oncology subspecialists, reading on a phone in 60-90 seconds between cases or in
a conference hallway. They already know the abbreviations and the comparator
trials. Assume context. No primers.

## Register

Subspecialist-to-subspecialist. Peer-review terse. Twitter-onc shorthand.

## Approved vocabulary

- **Abbreviations.** Use the canonical clinical form. The reader knows the
  field; the reader knows the abbreviation. mOS, mPFS, HR, OR, ORR, DCR, AE, IO,
  ADT, ARSI, SBRT, EBRT, SABR, RP, ADC, BCR-FS, NSCLC, mCRPC, HER2-low, TNBC,
  EFS, RFS, DFS, cFFS, MFS, etc.
- **Arrows.** `→` to connect cause/effect, before/after, treatment sequencing.
- **Casual asides** when they sharpen the point. "Looks promising tho short f/u",
  "small N, watch for replication", "ITT not pp".

## Banned vocabulary

AI-isms and hype words that flag content as machine-generated and erode trust.
Never use:

- delve, crucial, robust, comprehensive, nuanced, multifaceted
- notably, of note, interestingly, furthermore, moreover, additionally
- pivotal, landscape, tapestry, underscore, foster, showcase
- intricate, vibrant, fundamental, significant (when used as flat intensifiers)
- "game-changing" anywhere
- "practice-changing" without a specific qualifier. "Potentially practice-
  changing for X if Y" is allowed; bare "practice-changing" is not.

## Hard prohibitions

- **No em dashes.** Anywhere. Prose, prompts, code comments, UI chrome, commit
  messages. Use commas, parentheses, or middle dots (`·`).
- **No patient-facing language.** "Patients" → "pts" or "men/women" if relevant.
  This is peer communication, not a patient handout.
- **No fabricated numbers.** If the source content (tweets, paper abstract,
  slide OCR) does not give a number, write "no effect size reported in source".
  Never invent one. This is the highest-stakes rule; hallucinated numbers in
  clinical content are the worst failure mode for this project.
- **No promotional tone.** No marketing-deck phrasings, no "unlock the power
  of", no "transform your practice", no "revolutionary".

## Per-study bullet emoji vocabulary

Used in each study's `details[]`. The emoji is a TYPE label that carries semantic
load, not decoration. A bullet without an emoji is fine when the type is
ambiguous or the content is plainly factual; don't force them.

| Emoji | Meaning |
|---|---|
| 📊 | Primary results / effect sizes |
| 🔍 | Methodology / trial design |
| 💊 | Systemic / regimen |
| 📐 | Stat detail (CI, p, HR) |
| ⚠️ | Counter / critique / methodological concern |
| 🔗 | Comparison to prior data (recent or historic landmark) |
| ❓ | Open question |

## Source-type pills

Used by the Astro renderer to label where a study's data came from:

| Emoji | Source |
|---|---|
| 🐦 | Tweet |
| 📄 | Paper (PubMed) |
| 🩻 | Slide (curator photo) |

## Framing principles

What a subspecialist actually wants to know in a 60-second scan. The bullet
emoji vocabulary above maps directly to these questions:

1. **What's the headline number?** Effect size, HR, p, n, median. Verbatim from
   source. (📊, 📐)
2. **What's the comparison to current practice?** When a study has a comparator
   trial reference (recent or historic landmark), surface it. Don't soft-pedal
   divergence from current standard of care. (🔗)
3. **What are the methodological caveats?** Open-label, composite endpoint,
   short follow-up, post-hoc, single-arm, sponsor-funded, high crossover. A
   study without any caveats is suspicious. (⚠️)
4. **For whom?** Disease stage, biomarker, prior therapy, eligibility. The
   reader gates "does this apply to my patient" before going deeper. (🔍)
5. **What didn't this answer?** Open questions for the field this trial raises.
   (❓)

These principles describe what the emoji vocabulary already covers. They are
not a new required output schema; each phase has its own JSON schema. When the
source data supports a framing, use it; when it doesn't, don't fabricate one.

## SOC-implication verdict (Phase 2)

Every per-study output emits a `verdict` object. The verdict is the
single most useful 5-second triage signal for a subspecialist scanning the
day's data. Assignment requires honest judgment about what the trial does
and doesn't establish for the population studied.

### Taxonomy: `soc_implication`

- 🚀 `practice-changing`. Rare. On its own, this study may shift the
  standard of care for the population studied. Requires ALL of: adequately
  powered, prospective, primary endpoint hit, sufficient follow-up,
  applicable patient population, no major methodological caveats. Most
  trials don't clear this bar. Reserve.
- ↔️ `challenges-soc`. Result diverges from current practice for the
  studied population. May not warrant immediate change, but the reader
  needs to know the field is contested. (E.g., a randomised trial of
  pelvic RT that's null when prior evidence suggested benefit.)
- 🔄 `confirmatory`. Adds to existing evidence; consistent with current or
  emerging-but-recognized practice. Covers BOTH literal current SOC (the
  trial reinforces what most people already do) AND emerging-recognized
  practice (the trial supports a guideline-listed but not-yet-universal
  option, e.g., a non-randomised cohort backing an emerging modality).
  Most common verdict for high-quality studies whose results align with
  the field's direction.
- 🧪 `early-signal`. **Maturity issue.** The trial hasn't reached the
  point where you can draw a conclusion. Phase I/II, single-arm, small N,
  short follow-up, interim analysis. Worth knowing, not worth changing
  practice yet.
- ⚠️ `methodologically-limited`. **Design issue.** The trial's design or
  reporting prevents you from drawing the conclusion the headline claims.
  Post-hoc subgroup, biased endpoint (HR-QoL standing in for clinical
  efficacy), open-label with subjective endpoint, high control crossover,
  sponsor-funded with selection bias, primary endpoint not reported in
  source.
- `unclear`. Source content does not give enough to classify. Default
  when uncertain.

### Default to honesty

When uncertain between two verdicts, pick the more conservative one.
"Practice-changing" is the most-overclaimed label in clinical media;
reserve it. A confirmatory phase III is `confirmatory`, not
`practice-changing`, even if the headline is positive.

The "pick conservative" rule applies to UNCERTAINTY, not to STRENGTH.
If a trial has a clear positive signal (randomised, prespecified
primary endpoint hit, adequate follow-up, named comparator), the
question is which strength bucket to choose, not whether to downgrade
to a weaker one. A randomised phase II that hits its primary endpoint
with adequate follow-up and a named comparator is `confirmatory` (or
`practice-changing`), not `early-signal`. `early-signal` is for trials
where the data hasn't matured (phase I, single-arm, small N, short
f/u, interim analysis); it is not a place to hide strong results
because the phase number is small.

**Hard maturity gates that always trump strength.** Three patterns
are `early-signal` regardless of follow-up, consistency with prior
data, or how clean the design otherwise looks:

1. **Single-arm trials are `early-signal`.** No amount of follow-up
   or pooled consistency with prior single-arm data elevates a
   single-arm trial to `confirmatory`. `confirmatory` requires
   randomised evidence OR a large prospective non-randomised IPD
   cohort with multiple sites and explicit comparator analyses.
   FASTRACK II is `early-signal` (single-arm, even with 62-mo f/u).
2. **Interim analyses are `early-signal` until the prespecified
   final primary analysis.** Hitting a primary endpoint at partial
   accrual or before the planned cutoff does not promote to
   `confirmatory`. The full pre-specified analysis is the gate.
3. **Post-hoc analyses (subgroups, alternate timepoints, salvage
   analyses) are `methodologically-limited`,** regardless of the
   parent trial's strength. The post-hoc design dominates the read
   even if the parent trial was definitive.

When in real doubt: prefer `unclear` over a wrong guess.

### Choosing between `challenges-soc` and `methodologically-limited`

When a trial produces a divergent result AND has a design issue, the
verdict hinges on whether the design issue undermines the divergence:

- If the trial design is internally valid for the divergence claim
  (randomised, prespecified primary endpoint, adequate power,
  completed analysis), and the divergent result is the headline: pick
  `challenges-soc`. The design issue is secondary and goes in a ⚠️
  bullet, not the verdict.
- If the design issue is large enough to make the divergent result
  unreliable (post-hoc subgroup driving the divergence, biased
  endpoint, missing primary endpoint, high control crossover): pick
  `methodologically-limited`. The divergence isn't trustworthy
  enough to count as a real challenge to SOC.
- When in doubt: pick `methodologically-limited`. A weakly-grounded
  challenge to SOC is more dangerous to the reader than a flagged-
  design caveat.

### Choosing between `early-signal` and `methodologically-limited`

These two verdicts both communicate "can't draw a conclusion from this
trial alone," but they describe different gaps. Use them honestly; don't
collapse design issues into maturity issues:

- Is the gap that the trial hasn't matured enough? Phase I/II, single-arm,
  small N, short follow-up, interim analysis → `early-signal`.
- Is the gap that the trial design or reporting doesn't support the
  conclusion being drawn? Post-hoc subgroup, HR-QoL endpoint standing in
  for clinical efficacy, open-label with subjective outcome, primary
  endpoint not reported, high control crossover → `methodologically-
  limited`.
- A phase III with a biased endpoint is `methodologically-limited`, not
  `early-signal`. A phase II with a clean design but small N is
  `early-signal`, not `methodologically-limited`.
- When both apply, name the LARGER concern. A small phase 2 with selection
  bias is usually `early-signal` (maturity dominates), but a phase 3
  post-hoc subgroup of a definitive trial is `methodologically-limited`
  (design dominates).

### `rationale`: explain the verdict, not the trial

`rationale` is a ≤ 30-word string explaining the VERDICT CHOICE. It tells
the reader WHY the verdict was assigned, by naming the specific design
features or comparator gaps that drove the choice. It must NOT restate
the trial result; the `tldr` field already does that.

❌ Bad: "This is an important phase 2 trial showing benefit for SBRT in
RCC, with 100% local control over 84 months."

✅ Good: "Single-arm phase 2 in inoperable pts only; no randomised
comparator vs partial nephrectomy. Consistent with prior SAFIR /
STAR-TRK signals."

### `audience`: one-line eligibility gate

`audience` is a ≤ 80-char string (or null) that lets a reader gate
applicability before reading deeper. **Patient facts only.** Surface
disease + stage + biomarker (if applicable) + prior therapy line.

`audience` is NOT:
- the trial's clinical question ("organ preservation intent" describes
  treatment goal, not patient)
- treatment intent or rationale
- the verdict in disguise ("basket trial; pancreas/prostate strongest
  signals")
- a population summary of subgroups

If the trial enrolled a defined population, name it. If the population
is too heterogeneous to compress without losing signal: emit `null`.

✅ Good: "Inoperable primary RCC, T1b-dominant, median age 77"
✅ Good: "HER2-low metastatic breast, ≥ 1 prior endocrine line"
✅ Good: "Localised intermediate-risk prostate, post-RP biochemical
failure"
✅ Good: "Stage III NSCLC, post-CRT consolidation"
✅ Good: "Locally advanced rectal cancer, post-NAT"

❌ Bad: "Locally advanced rectal cancer, organ preservation intent,
post-NAT response assessment" (mixes patient facts with trial intent)
❌ Bad: "Oligometastatic solid tumors, 1-5 mets, multiple histologies
(pancreas/prostate strongest)" (verdict-in-disguise parenthetical)

## Examples: good vs. bad bullets

❌ Bad: "📊 The study shows that PRESTIGE-PSMA had a notable and robust
improvement in median progression-free survival compared to the comparator arm,
which is crucial for clinical practice."

✅ Good: "📊 mPFS 14.2 vs 9.8mo, HR 0.62 (0.48-0.79), p<0.001"

❌ Bad: "🔗 This is a game-changing trial that will revolutionize the treatment
landscape."

✅ Good: "🔗 vs VISION (NEJM 2021): similar HR, but PRESTIGE enriched for prior
taxane. Different population, similar effect size."

❌ Bad: "⚠️ Some limitations should be noted regarding the study design."

✅ Good: "⚠️ 1° EP was rPFS composite (not OS); OS HR 0.87, not significant.
Single-blind, sponsor-funded, 25% control crossover."

❌ Bad: "❓ Future research is needed to address several important questions."

✅ Good: "❓ Optimal sequencing vs cabazitaxel still open. No biomarker
predicting Lu-PSMA response identified."
