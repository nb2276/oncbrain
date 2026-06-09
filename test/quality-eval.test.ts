import { describe, it, expect, vi } from 'vitest';
import {
  parsePersonaResponse,
  synthesizeReport,
  buildPersonaPrompt,
  formatReportMarkdown,
  runPersonaJudge,
  QualityEvalParseError,
  QUALITY_AXES,
  type PersonaReport,
  type QualityAxisScore,
} from '../src/lib/quality-eval.ts';
import type { LlmClient } from '../src/lib/llm-client.ts';
import type { DigestArtifact } from '../src/lib/digest-data.ts';

function axis(score: number, issues: string[] = []): QualityAxisScore {
  return { score, notes: 'n', issues };
}

function goodPersonaJson(over: Partial<{
  score_overrides: Partial<Record<(typeof QUALITY_AXES)[number], number>>;
  top: string[];
  recs: string[];
  overall: number | undefined;
  verdict: string;
}> = {}): string {
  const scores = {
    accuracy: 9,
    voice_readability: 8,
    ui_ux: 7,
    clinical_relevance: 8,
    ...over.score_overrides,
  };
  const body: Record<string, unknown> = {
    axes: {
      accuracy: { score: scores.accuracy, notes: 'numbers trace.', issues: ['x'] },
      voice_readability: { score: scores.voice_readability, notes: 'voice ok.', issues: [] },
      ui_ux: { score: scores.ui_ux, notes: 'hierarchy ok.', issues: ['cardiology jargon'] },
      clinical_relevance: { score: scores.clinical_relevance, notes: 'useful.', issues: [] },
    },
    top_issues: over.top ?? ['top one', 'top two'],
    prescriptive_recommendations: over.recs ?? ['rec one'],
    verdict: over.verdict ?? 'Ship.',
  };
  if (over.overall !== undefined) body.overall_score = over.overall;
  else body.overall_score = (scores.accuracy + scores.voice_readability + scores.ui_ux + scores.clinical_relevance) / 4;
  return JSON.stringify(body);
}

function fakeArtifact(): DigestArtifact {
  return {
    date: '2026-06-09',
    conference: null,
    generated_at: 0,
    digest: {
      top_line: 't',
      tldr: 'd',
      sites: [],
      meta: { clusters_total: 0, studies_analyzed: 0, dropped: [], ocr_available: false },
    },
    bookmarks: [],
  };
}

function fakeReport(persona: 'designer' | 'oncologist' | 'trainee', scores: number[] = [9, 8, 7, 8]): PersonaReport {
  return {
    persona,
    axes: {
      accuracy: axis(scores[0]!),
      voice_readability: axis(scores[1]!),
      ui_ux: axis(scores[2]!),
      clinical_relevance: axis(scores[3]!),
    },
    top_issues: [`${persona} top 1`],
    prescriptive_recommendations: [`${persona} rec`],
    overall_score: scores.reduce((a, b) => a + b, 0) / 4,
    verdict: `${persona} verdict`,
  };
}

describe('parsePersonaResponse', () => {
  it('parses a clean response', () => {
    const r = parsePersonaResponse(goodPersonaJson(), 'designer');
    expect(r.persona).toBe('designer');
    expect(r.axes.accuracy.score).toBe(9);
    expect(r.axes.ui_ux.issues).toEqual(['cardiology jargon']);
    expect(r.overall_score).toBe(8); // (9+8+7+8)/4 = 8.0
    expect(r.verdict).toBe('Ship.');
  });

  it('recomputes overall_score when the judge omits it', () => {
    const raw = goodPersonaJson({ overall: undefined });
    const obj = JSON.parse(raw) as Record<string, unknown>;
    delete obj.overall_score;
    const r = parsePersonaResponse(JSON.stringify(obj), 'oncologist');
    expect(r.overall_score).toBe(8); // computed (9+8+7+8)/4 = 8.0
  });

  it('strips code fences', () => {
    const wrapped = '```json\n' + goodPersonaJson() + '\n```';
    const r = parsePersonaResponse(wrapped, 'designer');
    expect(r.axes.accuracy.score).toBe(9);
  });

  it('throws on empty input', () => {
    expect(() => parsePersonaResponse('', 'designer')).toThrow(QualityEvalParseError);
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePersonaResponse('not json', 'designer')).toThrow(/not valid JSON/);
  });

  it('throws when axes is missing', () => {
    expect(() => parsePersonaResponse('{}', 'designer')).toThrow(/missing axes object/);
  });

  it('throws when an axis is missing', () => {
    const obj = JSON.parse(goodPersonaJson()) as Record<string, unknown>;
    delete (obj.axes as Record<string, unknown>).accuracy;
    expect(() => parsePersonaResponse(JSON.stringify(obj), 'designer')).toThrow(/missing axis: accuracy/);
  });

  it('throws when an axis score is out of range', () => {
    const obj = JSON.parse(goodPersonaJson()) as Record<string, unknown>;
    (obj.axes as Record<string, unknown>).accuracy = { score: 11, notes: 'too high', issues: [] };
    expect(() => parsePersonaResponse(JSON.stringify(obj), 'designer')).toThrow(/invalid score/);
  });

  it('throws when an axis score is below 1', () => {
    const obj = JSON.parse(goodPersonaJson()) as Record<string, unknown>;
    (obj.axes as Record<string, unknown>).accuracy = { score: 0, notes: 'zero', issues: [] };
    expect(() => parsePersonaResponse(JSON.stringify(obj), 'designer')).toThrow(/invalid score/);
  });

  it('throws when an axis is not an object', () => {
    const obj = JSON.parse(goodPersonaJson()) as Record<string, unknown>;
    (obj.axes as Record<string, unknown>).accuracy = 'string instead of object' as never;
    expect(() => parsePersonaResponse(JSON.stringify(obj), 'designer')).toThrow(/missing axis: accuracy/);
  });

  it('filters non-string issues silently (defensive against array of objects)', () => {
    const obj = JSON.parse(goodPersonaJson()) as Record<string, unknown>;
    (obj.axes as Record<string, unknown>).accuracy = {
      score: 8,
      notes: 'ok',
      issues: ['valid', { not: 'a string' }, '', '  ', 'another valid'],
    };
    const r = parsePersonaResponse(JSON.stringify(obj), 'designer');
    expect(r.axes.accuracy.issues).toEqual(['valid', 'another valid']);
  });

  it('handles missing top_issues / prescriptive_recommendations gracefully (empty arrays)', () => {
    const obj = JSON.parse(goodPersonaJson()) as Record<string, unknown>;
    delete obj.top_issues;
    delete obj.prescriptive_recommendations;
    const r = parsePersonaResponse(JSON.stringify(obj), 'designer');
    expect(r.top_issues).toEqual([]);
    expect(r.prescriptive_recommendations).toEqual([]);
  });

  it('rounds overall_score to one decimal', () => {
    const raw = goodPersonaJson({ score_overrides: { accuracy: 9, voice_readability: 8, ui_ux: 7, clinical_relevance: 7 } });
    const obj = JSON.parse(raw) as Record<string, unknown>;
    delete obj.overall_score; // force recompute
    const r = parsePersonaResponse(JSON.stringify(obj), 'designer');
    // (9+8+7+7)/4 = 7.75 → 7.8
    expect(r.overall_score).toBe(7.8);
  });
});

describe('synthesizeReport', () => {
  it('computes mean axis scores across three personas', () => {
    const reports = [
      fakeReport('designer', [9, 9, 9, 9]),
      fakeReport('oncologist', [7, 7, 7, 7]),
      fakeReport('trainee', [8, 8, 8, 8]),
    ];
    const out = synthesizeReport(reports, '2026-06-09', '/tmp/x.json', '2026-06-09T00:00:00Z');
    expect(out.mean_axes.accuracy).toBe(8.0);
    expect(out.mean_axes.voice_readability).toBe(8.0);
    expect(out.mean_axes.ui_ux).toBe(8.0);
    expect(out.mean_axes.clinical_relevance).toBe(8.0);
    expect(out.overall_mean_score).toBe(8.0);
  });

  it('rounds means to one decimal', () => {
    const reports = [
      fakeReport('designer', [9, 9, 9, 9]),
      fakeReport('oncologist', [8, 8, 8, 8]),
      fakeReport('trainee', [8, 8, 8, 8]),
    ];
    const out = synthesizeReport(reports, '2026-06-09', '/tmp/x.json', 'now');
    // (9+8+8)/3 = 8.333 → 8.3
    expect(out.mean_axes.accuracy).toBe(8.3);
    expect(out.overall_mean_score).toBe(8.3);
  });

  it('throws when given zero persona reports', () => {
    expect(() => synthesizeReport([], '2026-06-09', '/tmp/x.json', 'now')).toThrow(/at least one persona/);
  });

  it('preserves the date / artifact_path / generated_at fields', () => {
    const reports = [fakeReport('designer')];
    const out = synthesizeReport(reports, '2026-06-09', '/tmp/x.json', '2026-06-09T01:23:45Z');
    expect(out.date).toBe('2026-06-09');
    expect(out.artifact_path).toBe('/tmp/x.json');
    expect(out.generated_at).toBe('2026-06-09T01:23:45Z');
    expect(out.personas).toHaveLength(1);
  });
});

describe('buildPersonaPrompt', () => {
  it('substitutes all template slots and includes the persona block', () => {
    const template = '[P]{{PERSONA_BLOCK}}[D]{{DESIGN_MD}}[V]{{VOICE_MD}}[A]{{ARTIFACT_JSON}}[R]{{RECENT_REPORTS}}';
    const out = buildPersonaPrompt('designer', fakeArtifact(), {
      judgeTemplate: template,
      designMd: 'DESIGN',
      voiceMd: 'VOICE',
    });
    expect(out).toContain('[P]PERSONA_HEADER: Senior product designer');
    expect(out).toContain('[D]DESIGN');
    expect(out).toContain('[V]VOICE');
    expect(out).toContain('[A]{');
    expect(out).toContain('"date": "2026-06-09"');
    expect(out).toContain('[R](no recent reports)');
  });

  it('joins multiple recent reports with separators', () => {
    const template = '{{RECENT_REPORTS}}';
    const out = buildPersonaPrompt('designer', fakeArtifact(), {
      judgeTemplate: template,
      designMd: '',
      voiceMd: '',
      recentReports: ['# Report A', '# Report B'],
    });
    expect(out).toContain('# Report A');
    expect(out).toContain('---');
    expect(out).toContain('# Report B');
  });
});

describe('runPersonaJudge', () => {
  it('returns a parsed report on the first successful response', async () => {
    const client: LlmClient = { complete: vi.fn(async () => goodPersonaJson()) };
    const r = await runPersonaJudge('oncologist', fakeArtifact(), {
      client,
      judgeTemplate: '{{PERSONA_BLOCK}}{{DESIGN_MD}}{{VOICE_MD}}{{ARTIFACT_JSON}}{{RECENT_REPORTS}}',
      designMd: '',
      voiceMd: '',
    });
    expect(r.persona).toBe('oncologist');
    expect(r.overall_score).toBe(8);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('retries once on parse failure then succeeds', async () => {
    let n = 0;
    const client: LlmClient = {
      complete: vi.fn(async () => {
        n += 1;
        return n === 1 ? 'not json' : goodPersonaJson();
      }),
    };
    const r = await runPersonaJudge('oncologist', fakeArtifact(), {
      client,
      judgeTemplate: '{{PERSONA_BLOCK}}{{DESIGN_MD}}{{VOICE_MD}}{{ARTIFACT_JSON}}{{RECENT_REPORTS}}',
      designMd: '',
      voiceMd: '',
      maxRetries: 1,
    });
    expect(r.overall_score).toBe(8);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const client: LlmClient = { complete: vi.fn(async () => 'always broken') };
    await expect(
      runPersonaJudge('trainee', fakeArtifact(), {
        client,
        judgeTemplate: '{{PERSONA_BLOCK}}{{DESIGN_MD}}{{VOICE_MD}}{{ARTIFACT_JSON}}{{RECENT_REPORTS}}',
        designMd: '',
        voiceMd: '',
        maxRetries: 1,
      }),
    ).rejects.toThrow(QualityEvalParseError);
  });
});

describe('formatReportMarkdown', () => {
  const reports = [
    fakeReport('designer', [9, 9, 9, 9]),
    fakeReport('oncologist', [7, 7, 7, 7]),
    fakeReport('trainee', [8, 8, 8, 8]),
  ];

  it('includes the date, axis-mean table, and per-persona sections', () => {
    const md = formatReportMarkdown(
      synthesizeReport(reports, '2026-06-09', '/tmp/x.json', '2026-06-09T00:00:00Z'),
    );
    expect(md).toContain('# Quality eval 2026-06-09');
    expect(md).toContain('| Axis | Mean |');
    expect(md).toContain('Accuracy');
    expect(md).toContain('Voice + readability');
    expect(md).toContain('UI/UX');
    expect(md).toContain('Clinical relevance');
    expect(md).toContain('## Persona: designer');
    expect(md).toContain('## Persona: oncologist');
    expect(md).toContain('## Persona: trainee');
    expect(md).toMatch(/Overall mean: \*\*8\.0 \/ 10\*\*/);
  });

  it('renders each persona\'s verdict as a blockquote', () => {
    const md = formatReportMarkdown(
      synthesizeReport(reports, '2026-06-09', '/tmp/x.json', 'now'),
    );
    expect(md).toMatch(/> designer verdict/);
    expect(md).toMatch(/> oncologist verdict/);
  });

  it('renders top issues + recommendations per persona', () => {
    const md = formatReportMarkdown(
      synthesizeReport(reports, '2026-06-09', '/tmp/x.json', 'now'),
    );
    expect(md).toContain('### Top issues');
    expect(md).toContain('- designer top 1');
    expect(md).toContain('### Recommendations');
    expect(md).toContain('- designer rec');
  });

  it('omits empty Top issues / Recommendations sections', () => {
    const minimal = [
      {
        persona: 'designer' as const,
        axes: {
          accuracy: axis(7),
          voice_readability: axis(7),
          ui_ux: axis(7),
          clinical_relevance: axis(7),
        },
        top_issues: [],
        prescriptive_recommendations: [],
        overall_score: 7,
        verdict: '',
      },
    ];
    const md = formatReportMarkdown(
      synthesizeReport(minimal, '2026-06-09', '/tmp/x.json', 'now'),
    );
    expect(md).not.toContain('### Top issues');
    expect(md).not.toContain('### Recommendations');
  });
});
