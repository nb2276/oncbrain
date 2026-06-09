// Multi-persona quality eval for the daily digest.
//
// Runs three personas (senior product designer, expert subspecialty oncologist,
// PGY-2 trainee) over the day's data/digests/<date>.json artifact and produces
// a dated markdown report at ~/.gstack/projects/<slug>/quality-reports/<date>.md.
//
// Distinct from src/lib/eval.ts (single-judge LLM-as-judge CI gate). This
// is a curator-facing READING tool: scored across four axes (accuracy,
// voice + readability, UI/UX, clinical relevance), with each persona
// commenting from their own lens. The output is meant to be read by a
// human after build:day, not consumed by CI.
//
// Persona prompts live in prompts/quality-personas/<persona>.txt; the shared
// judge template lives in prompts/quality-eval-judge.txt.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLlmClient, type LlmClient } from './llm-client.ts';
import type { DigestArtifact } from './digest-data.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const QUALITY_PERSONAS = ['designer', 'oncologist', 'trainee'] as const;
export type QualityPersona = (typeof QUALITY_PERSONAS)[number];

export const QUALITY_AXES = ['accuracy', 'voice_readability', 'ui_ux', 'clinical_relevance'] as const;
export type QualityAxisName = (typeof QUALITY_AXES)[number];

export type QualityAxisScore = {
  score: number; // 1-10
  notes: string;
  issues: string[];
};

export type PersonaReport = {
  persona: QualityPersona;
  axes: Record<QualityAxisName, QualityAxisScore>;
  top_issues: string[];
  prescriptive_recommendations: string[];
  overall_score: number;
  verdict: string;
};

export type QualityReport = {
  date: string;
  artifact_path: string;
  generated_at: string;
  personas: PersonaReport[];
  // Mean axis scores across the three personas (one decimal).
  mean_axes: Record<QualityAxisName, number>;
  overall_mean_score: number;
};

export type QualityEvalDeps = {
  client?: LlmClient;
  clock?: () => Date;
  // Directory containing the per-persona prompts (designer.txt etc.) and the
  // judge template (../quality-eval-judge.txt). Defaults to repo prompts/.
  personasDir?: string;
  // Direct overrides for tests; production loads from the repo paths.
  judgeTemplate?: string;
  designMd?: string;
  voiceMd?: string;
  recentReports?: string[]; // verbatim markdown snippets, joined with "---"
  model?: string;
  maxRetries?: number;
};

export class QualityEvalParseError extends Error {
  constructor(message: string, readonly persona: QualityPersona, readonly raw?: string) {
    super(message);
    this.name = 'QualityEvalParseError';
  }
}

const PROMPTS_DIR = resolve(__dirname, '../../prompts');
const DEFAULT_PERSONAS_DIR = resolve(PROMPTS_DIR, 'quality-personas');
const DEFAULT_JUDGE_TEMPLATE_PATH = resolve(PROMPTS_DIR, 'quality-eval-judge.txt');
const DEFAULT_DESIGN_MD_PATH = resolve(__dirname, '../../DESIGN.md');
const DEFAULT_VOICE_MD_PATH = resolve(__dirname, '../../VOICE.md');

export function loadPersonaBlock(persona: QualityPersona, personasDir?: string): string {
  const dir = personasDir ?? DEFAULT_PERSONAS_DIR;
  return readFileSync(resolve(dir, `${persona}.txt`), 'utf-8').trim();
}

export function loadDefaults(): { judgeTemplate: string; designMd: string; voiceMd: string } {
  return {
    judgeTemplate: readFileSync(DEFAULT_JUDGE_TEMPLATE_PATH, 'utf-8'),
    designMd: readFileSync(DEFAULT_DESIGN_MD_PATH, 'utf-8'),
    voiceMd: readFileSync(DEFAULT_VOICE_MD_PATH, 'utf-8'),
  };
}

// Build the prompt for one persona by substituting the persona block + DESIGN
// + VOICE + artifact JSON + recent-reports block into the judge template.
// Pure function: same inputs always produce same output.
export function buildPersonaPrompt(
  persona: QualityPersona,
  artifact: DigestArtifact,
  deps: QualityEvalDeps = {},
): string {
  const personaBlock = loadPersonaBlock(persona, deps.personasDir);
  // Lazy-load the heavy templates only when not injected.
  const template = deps.judgeTemplate ?? readFileSync(DEFAULT_JUDGE_TEMPLATE_PATH, 'utf-8');
  const designMd = deps.designMd ?? readFileSync(DEFAULT_DESIGN_MD_PATH, 'utf-8');
  const voiceMd = deps.voiceMd ?? readFileSync(DEFAULT_VOICE_MD_PATH, 'utf-8');
  const recent = (deps.recentReports ?? []).join('\n\n---\n\n').trim() || '(no recent reports)';

  return template
    .replace('{{PERSONA_BLOCK}}', personaBlock)
    .replace('{{DESIGN_MD}}', designMd)
    .replace('{{VOICE_MD}}', voiceMd)
    .replace('{{ARTIFACT_JSON}}', JSON.stringify(artifact, null, 2))
    .replace('{{RECENT_REPORTS}}', recent);
}

// Parse and validate one persona's JSON response. Strict on shape (every
// axis must be present with score+notes+issues) so a malformed judge can
// be retried rather than silently producing garbage report rows.
export function parsePersonaResponse(raw: string, persona: QualityPersona): PersonaReport {
  if (!raw) throw new QualityEvalParseError('Empty persona response', persona);
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new QualityEvalParseError(
      `Persona response not valid JSON: ${(err as Error).message}`,
      persona,
      raw,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new QualityEvalParseError('Persona response is not an object', persona, raw);
  }
  const obj = parsed as Record<string, unknown>;

  if (!obj.axes || typeof obj.axes !== 'object' || Array.isArray(obj.axes)) {
    throw new QualityEvalParseError('Persona response missing axes object', persona, raw);
  }
  const axesRaw = obj.axes as Record<string, unknown>;
  const axes = {} as Record<QualityAxisName, QualityAxisScore>;
  for (const axis of QUALITY_AXES) {
    const a = axesRaw[axis];
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new QualityEvalParseError(`Persona response missing axis: ${axis}`, persona, raw);
    }
    const axisObj = a as Record<string, unknown>;
    const score = typeof axisObj.score === 'number' ? axisObj.score : NaN;
    if (!Number.isFinite(score) || score < 1 || score > 10) {
      throw new QualityEvalParseError(
        `Axis ${axis} has invalid score: ${axisObj.score}`,
        persona,
        raw,
      );
    }
    const notes = typeof axisObj.notes === 'string' ? axisObj.notes.trim() : '';
    const issues = Array.isArray(axisObj.issues)
      ? axisObj.issues.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
    axes[axis] = { score, notes, issues };
  }

  const top_issues = Array.isArray(obj.top_issues)
    ? obj.top_issues
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const prescriptive_recommendations = Array.isArray(obj.prescriptive_recommendations)
    ? obj.prescriptive_recommendations
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const overallFromJudge =
    typeof obj.overall_score === 'number' && Number.isFinite(obj.overall_score)
      ? obj.overall_score
      : NaN;
  // Defensive recompute when the judge omitted/miscomputed it.
  const computedMean = QUALITY_AXES.reduce((sum, k) => sum + axes[k].score, 0) / QUALITY_AXES.length;
  const overall_score = Math.round((Number.isFinite(overallFromJudge) ? overallFromJudge : computedMean) * 10) / 10;

  const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim() : '';

  return {
    persona,
    axes,
    top_issues,
    prescriptive_recommendations,
    overall_score,
    verdict,
  };
}

// Run one persona judge: send prompt to LLM, parse, retry once on parse
// failure. The retry appends the parse error + previous raw so the model
// has a chance to fix its own JSON.
export async function runPersonaJudge(
  persona: QualityPersona,
  artifact: DigestArtifact,
  deps: QualityEvalDeps = {},
): Promise<PersonaReport> {
  const client = deps.client ?? createLlmClient();
  const maxRetries = deps.maxRetries ?? 1;
  const basePrompt = buildPersonaPrompt(persona, artifact, deps);

  let lastError: Error | undefined;
  let lastRaw: string | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous response could not be parsed: ${lastError?.message ?? 'unknown'}\n\nRe-emit ONLY the JSON object exactly per the schema. Previous response:\n${lastRaw ?? '(empty)'}`;

    let raw: string;
    try {
      raw = await client.complete([{ role: 'user', content: prompt }], {
        model: deps.model,
        maxTokens: 2048,
        temperature: 0,
      });
    } catch (err) {
      lastError = err as Error;
      continue;
    }
    lastRaw = raw;
    try {
      return parsePersonaResponse(raw, persona);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw new QualityEvalParseError(
    `Persona ${persona} failed after ${maxRetries + 1} attempts: ${lastError?.message ?? 'unknown'}`,
    persona,
    lastRaw,
  );
}

// Synthesize a multi-persona report from the per-persona outputs. Pure:
// no LLM calls. Mean axis scores are the average across the three
// persona's per-axis scores; overall_mean_score is the mean of the four
// axis means. Both rounded to one decimal.
export function synthesizeReport(
  personaReports: PersonaReport[],
  date: string,
  artifactPath: string,
  generatedAt: string,
): QualityReport {
  if (personaReports.length === 0) {
    throw new Error('synthesizeReport requires at least one persona report');
  }
  const meanAxes = {} as Record<QualityAxisName, number>;
  for (const axis of QUALITY_AXES) {
    const sum = personaReports.reduce((acc, p) => acc + p.axes[axis].score, 0);
    meanAxes[axis] = Math.round((sum / personaReports.length) * 10) / 10;
  }
  const overall =
    QUALITY_AXES.reduce((acc, axis) => acc + meanAxes[axis], 0) / QUALITY_AXES.length;
  return {
    date,
    artifact_path: artifactPath,
    generated_at: generatedAt,
    personas: personaReports,
    mean_axes: meanAxes,
    overall_mean_score: Math.round(overall * 10) / 10,
  };
}

// Top-level entry: build prompts for all three personas, run them in
// parallel (each one is its own LLM call), synthesize the report. Throws
// if any persona fails its parse-retry budget.
export async function runQualityEval(
  artifact: DigestArtifact,
  artifactPath: string,
  deps: QualityEvalDeps = {},
): Promise<QualityReport> {
  const clock = deps.clock ?? (() => new Date());
  const generatedAt = clock().toISOString();
  const personaReports = await Promise.all(
    QUALITY_PERSONAS.map((p) => runPersonaJudge(p, artifact, deps)),
  );
  return synthesizeReport(personaReports, artifact.date, artifactPath, generatedAt);
}

// Render the multi-persona report as a dated markdown file. Reader-first:
// summary table at the top, per-persona detail below, prescriptive
// recommendations broken out so they're scannable.
export function formatReportMarkdown(report: QualityReport): string {
  const lines: string[] = [];
  lines.push(`# Quality eval ${report.date}`);
  lines.push('');
  lines.push(`Generated: ${report.generated_at}  `);
  lines.push(`Artifact: \`${report.artifact_path}\`  `);
  lines.push(`Personas: ${report.personas.map((p) => p.persona).join(', ')}  `);
  lines.push(`Overall mean: **${report.overall_mean_score.toFixed(1)} / 10**`);
  lines.push('');

  // Summary table: axis means across personas.
  lines.push('## Mean scores by axis');
  lines.push('');
  lines.push('| Axis | Mean | ' + report.personas.map((p) => p.persona).join(' | ') + ' |');
  lines.push('|---|---|' + report.personas.map(() => '---').join('|') + '|');
  for (const axis of QUALITY_AXES) {
    const row = [
      axisLabel(axis),
      report.mean_axes[axis].toFixed(1),
      ...report.personas.map((p) => p.axes[axis].score.toFixed(1)),
    ];
    lines.push('| ' + row.join(' | ') + ' |');
  }
  lines.push('');

  // Per-persona detail.
  for (const p of report.personas) {
    lines.push(`## Persona: ${p.persona}`);
    lines.push('');
    lines.push(`**Overall: ${p.overall_score.toFixed(1)} / 10**`);
    lines.push('');
    if (p.verdict) {
      lines.push(`> ${p.verdict}`);
      lines.push('');
    }
    for (const axis of QUALITY_AXES) {
      const a = p.axes[axis];
      lines.push(`### ${axisLabel(axis)} (${a.score.toFixed(1)})`);
      lines.push('');
      if (a.notes) {
        lines.push(a.notes);
        lines.push('');
      }
      if (a.issues.length > 0) {
        for (const issue of a.issues) {
          lines.push(`- ${issue}`);
        }
        lines.push('');
      }
    }
    if (p.top_issues.length > 0) {
      lines.push('### Top issues');
      lines.push('');
      for (const issue of p.top_issues) lines.push(`- ${issue}`);
      lines.push('');
    }
    if (p.prescriptive_recommendations.length > 0) {
      lines.push('### Recommendations');
      lines.push('');
      for (const rec of p.prescriptive_recommendations) lines.push(`- ${rec}`);
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

function axisLabel(axis: QualityAxisName): string {
  switch (axis) {
    case 'accuracy':
      return 'Accuracy';
    case 'voice_readability':
      return 'Voice + readability';
    case 'ui_ux':
      return 'UI/UX';
    case 'clinical_relevance':
      return 'Clinical relevance';
  }
}
