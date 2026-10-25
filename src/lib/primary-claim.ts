// v0.62.3: never call an endpoint "primary" unless the sources say so.
//
// The Phase 2 output template opened every card with a `📊 1° EP: ...` bullet,
// and the model filled it from the headline endpoint whether or not the source
// named a primary. ARANOTE's tweet ("median rPFS NR vs 22.4mo, HR 0.55") became
// "1° EP rPFS"; the eval judge capped two runs at 5.0 for it, and 7 of the 55
// published cards carrying "1° EP" assert a primary their sources never state
// (TALAPRO-3, EORTC 22033, ...). Which endpoint a trial was powered on is a
// design fact, and asserting it from memory is the fabrication VOICE.md bans.
//
// When the sources state no primary, the LABEL is removed and the content
// kept: "📊 1° EP rPFS: HR 0.55" → "📊 rPFS: HR 0.55". The number is still
// grounded (other gates check numbers); only the unsupported design claim goes.

// What counts as a source stating a primary. Deliberately phrase-level: the
// bare word "primary" is everywhere in oncology ("primary tumour", "primary
// RT", "primary prostate cancer") and says nothing about endpoints.
const SOURCE_STATES_PRIMARY =
  /\bprimary\s+(?:efficacy\s+)?(?:end\s?-?points?|outcomes?|objectives?|aims?|analys[ie]s|variables?)\b|\bco-?primary\b|1°\s?(?:EP|end\s?point|outcome)|\bprimary\s*:|\bprimary\s+EP\b/i;

export function sourceStatesPrimary(sourceText: string): boolean {
  return SOURCE_STATES_PRIMARY.test(sourceText);
}

const keepCase = (match: string, replacement: string) =>
  /^[A-Z]/.test(match) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;

// A sentence that hedges about the primary ("No primary endpoint stated in
// source", "not clear whether X was the primary endpoint") is the model being
// honest; stripping "primary" there would turn it into a different, false
// statement ("No endpoint stated"). Only affirmative labels are removed.
const HEDGE =
  /\b(?:not|no|never)\s+(?:\w+\s+){0,4}?(?:stated|reported|specified|given|named|identified|clear|disclosed|designated|prespecified)\b|\bnone\s+of\b|\bneither\b|\bwhether\b|\bunclear\b|\bunstated\b|\bunknown\b|\bno\s+(?:single\s+)?(?:stated\s+)?primary\b|\bdoes(?:n't| not)\s+state\b/i;

/** Remove affirmative "primary" labels from one prose string, sentence by sentence. */
export function stripPrimaryLabels(text: string): string {
  // Split KEEPING the separators (odd indices), so untouched text round-trips
  // byte for byte.
  return text
    .split(/((?<=[.!?])\s+)/)
    .map((sentence, i) => {
      if (i % 2 === 1 || HEDGE.test(sentence)) return sentence;
      const out = sentence
        .replace(/\*\*\s*Primary\s*:\s*\*\*\s*/g, '')
        // "1° EP (not) met" keeps its subject: "endpoint (not) met".
        .replace(/1°\s?EP\s+((?:not\s+)?met)\b/g, 'endpoint $1')
        .replace(/1°\s?EP\s*:?\s*/g, '')
        .replace(/\bco-?primary\s+(end\s?-?points?)\b/gi, (m, ep: string) => keepCase(m, ep.toLowerCase()))
        .replace(/\bprimary\s+(end\s?-?points?|outcomes?)\b/gi, (m, ep: string) => keepCase(m, ep.toLowerCase()))
        .replace(/\bPrimary\s*:\s*/g, '');
      // Tidy the gap a removed label leaves, only where one was removed.
      return out === sentence ? sentence : out.replace(/ {2,}/g, ' ');
    })
    .join('');
}

type Detail = string | { text?: string; subdetails?: unknown[] };
type StudyProse = {
  slug?: string;
  name: string;
  tldr?: string;
  details?: unknown[];
  analysis_sections?: Array<{ label: string; body: string }> | null;
  significance?: string | null;
  monday_clinic?: string | null;
  interpretation?: string | null;
  significance_by_specialty?: Record<string, string> | null;
  verdict?: { rationale?: string } | null;
  presentation?: { summary?: string | null; critique?: string[] } | null;
};

/**
 * When the sources state no primary endpoint, strip "primary" labels from
 * every prose surface of the study. Mutates; returns the surfaces it changed.
 */
export function stripUngroundedPrimaryClaims(study: StudyProse, sourceText: string): string[] {
  if (sourceStatesPrimary(sourceText)) return [];
  const changed: string[] = [];
  const fix = (surface: string, text: string | null | undefined): string | null | undefined => {
    if (typeof text !== 'string') return text;
    const out = stripPrimaryLabels(text);
    if (out !== text) changed.push(surface);
    return out;
  };

  if (typeof study.tldr === 'string') study.tldr = fix('tldr', study.tldr) as string;
  if (Array.isArray(study.details)) {
    study.details = study.details.map((d, i) => {
      if (typeof d === 'string') return fix(`details[${i}]`, d);
      const det = d as Detail & object;
      if (det && typeof det === 'object') {
        const next: Record<string, unknown> = { ...det };
        if (typeof det.text === 'string') next.text = fix(`details[${i}]`, det.text);
        if (Array.isArray(det.subdetails)) {
          next.subdetails = det.subdetails.map((s, j) => (typeof s === 'string' ? fix(`details[${i}].${j}`, s) : s));
        }
        return next;
      }
      return d;
    });
  }
  if (Array.isArray(study.analysis_sections)) {
    study.analysis_sections = study.analysis_sections.map((s) => ({ ...s, body: fix(`section:${s.label}`, s.body) as string }));
  }
  for (const key of ['significance', 'monday_clinic', 'interpretation'] as const) {
    study[key] = fix(key, study[key]) as string | null;
  }
  if (study.significance_by_specialty) {
    for (const [k, v] of Object.entries(study.significance_by_specialty)) {
      study.significance_by_specialty[k] = fix(`significance:${k}`, v) as string;
    }
  }
  if (study.verdict && typeof study.verdict.rationale === 'string') {
    study.verdict.rationale = fix('verdict.rationale', study.verdict.rationale) as string;
  }
  if (study.presentation) {
    study.presentation.summary = fix('presentation.summary', study.presentation.summary) as string | null;
    if (Array.isArray(study.presentation.critique)) {
      study.presentation.critique = study.presentation.critique.map((c, i) => fix(`presentation.critique[${i}]`, c) as string);
    }
  }
  return changed;
}
