# Specialty perspective profiles

Each `*.md` file here is a **specialty lens** that biases the Phase 2 per-study
analysis toward one subspecialty's decision needs. The profile text is injected
into the study-agent prompt's `{{PERSPECTIVE}}` slot at build time.

## Selecting a profile

Set `DIGEST_PERSPECTIVE` to the file's base name (no extension):

```bash
DIGEST_PERSPECTIVE=radonc npm run build:day -- --date=2026-06-10
```

Or make it permanent for every manual + cron build by adding it to `.env`:

```
DIGEST_PERSPECTIVE=radonc
```

Unset / blank / unknown name = **no bias** (one-size-fits-all default; the build
is byte-identical to having no perspective at all). The name is sanitized to a
single path segment, so it can only resolve to a file inside this directory.

## Shipped profiles

- `radonc.md` — radiation oncology. Foregrounds the role and magnitude of RT,
  isolates RT's contribution from a systemic backbone, surfaces dose /
  fractionation / target volume and local-regional endpoints.
- `medonc.md` — medical oncology. Foregrounds regimen, biomarker gating,
  sequencing, and the systemic-therapy decision.

## Authoring your own

Copy an existing profile and edit. Match `VOICE.md` register (peer-to-peer,
terse, no em dashes) and keep the no-fabrication rule paramount: a lens changes
WHAT gets foregrounded and HOW it's framed, never whether a number can be
invented. State plainly when a magnitude the lens wants lives only in a figure
the source text didn't capture, rather than guessing it.

The lens applies to Phase 2 (per-study deep analysis) only. Phase 1 (clustering)
and Phase 3 (cross-site synthesis) are intentionally left specialty-neutral.

## Display label (the "Why it matters" heading)

The v0.22 per-study **"Why it matters"** callout is headed `WHY IT MATTERS ·
{label}`, where `{label}` is a human-readable name for the active lens. Known
lenses get a curated label from `PERSPECTIVE_DISPLAY_NAMES` in
`src/lib/llm-pipeline.ts` (e.g. `radonc` → "Radiation oncology"). A new profile
works with no code change: an unmapped slug falls back to a title-cased form
(`gyn-onc` → "Gyn Onc"). Add a one-line entry to that map when you want a nicer
label than the fallback.
