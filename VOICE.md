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
