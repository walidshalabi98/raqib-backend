import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { escapeHtml, figureWarning, htmlList, htmlParagraphs } from './html';
import { indicatorProgress, unverifiedFigures } from './indicatorFigures';
import {
  NARRATIVE_PROMPT_VERSION,
  NARRATIVE_SCHEMA,
  NARRATIVE_SYSTEM,
  NarrativeAnswer,
  NarrativeIndicatorInput,
  NarrativeProjectInput,
  narrativeIndicatorBlock,
  narrativeProjectBlock,
  writeNarrativePrompt,
} from './prompts/narrative';
import { redactPersonalData } from './redact';

/**
 * Writes the AI narrative of a report (main tier) from the indicator figures of the project's
 * current framework and stores the report HTML in Report.aiNarrative. Numbers in the narrative
 * that are not among the figures sent are listed in a warning line of their section
 * (unverifiedFigures). AI errors propagate (typed errors from ./errors).
 */
export async function generateReportNarrative(reportId: string, projectId: string): Promise<void> {
  const report = await prisma.report.findFirst({ where: { id: reportId, projectId } });
  if (!report) throw new Error(`Report ${reportId} not found`);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      // The current framework: the newest version whose generation did not fail.
      frameworks: {
        where: { generationError: null },
        orderBy: { version: 'desc' },
        take: 1,
        include: {
          indicators: {
            orderBy: { sortOrder: 'asc' },
            include: {
              dataPoints: {
                orderBy: { collectionDate: 'desc' },
                take: 10,
              },
            },
          },
        },
      },
    },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const framework = project.frameworks[0];
  if (!framework) throw new Error('No framework found for project');

  // Aggregates only: values, dates, areas and disaggregated counts (never data point notes). Values
  // and areas are free text, so they are redacted like descriptions; breakdown labels are redacted
  // by formatBreakdown.
  const indicatorData: NarrativeIndicatorInput[] = framework.indicators.map(ind => {
    const progress = indicatorProgress(ind);
    return {
      indicatorText: ind.indicatorText,
      level: ind.level,
      status: ind.status,
      unit: ind.unit,
      baselineValue: ind.baselineValue,
      targetValue: ind.targetValue,
      currentValue: ind.currentValue,
      progressPercent: progress?.percent ?? null,
      progressNoBaseline: progress?.noBaseline ?? false,
      dataPoints: ind.dataPoints.map(dp => ({
        value: redactPersonalData(dp.value).text,
        date: isoDate(dp.collectionDate),
        area: dp.geographicArea ? redactPersonalData(dp.geographicArea).text : null,
        breakdown: dp.breakdown ?? undefined,
      })),
    };
  });

  const projectInfo: NarrativeProjectInput = {
    name: project.name,
    sector: project.sector,
    donor: project.donor,
    periodStart: report.periodStart ? isoDate(report.periodStart) : undefined,
    periodEnd: report.periodEnd ? isoDate(report.periodEnd) : undefined,
  };
  const prompt = writeNarrativePrompt(projectInfo, indicatorData, report.donorFormat);

  const result = await generateStructured({
    feature: 'report.narrative',
    model: 'main',
    effort: 'medium',
    system: NARRATIVE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    schema: NARRATIVE_SCHEMA,
    promptVersion: NARRATIVE_PROMPT_VERSION,
    maxTokens: 8000,
    timeoutMs: 180_000,
    context: { organizationId: project.organizationId, projectId: project.id },
  });

  // Every figure the model was given: project facts, indicator texts and figures, progress, data
  // points with their dates, areas and breakdowns, and the number of indicators.
  const allowedFigures = narrativeAllowedFigures(projectInfo, indicatorData, report.donorFormat);
  const narrative = cleanNarrative(result.data);
  const figureChecks = checkNarrativeFigures(narrative, allowedFigures);

  // HTML report content (no PDF/Puppeteer needed); every value is escaped.
  const html = generateReportHtml({
    projectName: project.name,
    reportTitle: report.title,
    narrative,
    unverifiedFigures: figureChecks,
    indicators: indicatorData,
    model: result.model,
    promptVersion: result.promptVersion,
  });

  await prisma.report.update({
    where: { id: reportId },
    data: {
      aiNarrative: html,
      fileUrl: null,
      status: 'draft',
    },
  });

  const unverified = Object.values(figureChecks).reduce((sum, figures) => sum + figures.length, 0);
  console.log(`[ReportNarrative] Report ${reportId} generated (${indicatorData.length} indicators; ${unverified} unverified figures; ${result.model}, ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens)`);
}

/** The figures sent in the narrative prompt (the project facts and every indicator block), for unverifiedFigures. */
export function narrativeAllowedFigures(projectInfo: NarrativeProjectInput, indicators: readonly NarrativeIndicatorInput[], donorFormat?: string | null): string[] {
  return [narrativeProjectBlock(projectInfo, donorFormat), String(indicators.length), ...indicators.map(narrativeIndicatorBlock)];
}

export type NarrativeSection = keyof NarrativeAnswer;

/** The numbers of each narrative section that are not among the allowed figures; sections without any are left out. */
export function checkNarrativeFigures(narrative: NarrativeAnswer, allowedFigures: readonly string[]): Partial<Record<NarrativeSection, string[]>> {
  const sections: Record<NarrativeSection, string> = {
    executiveSummary: narrative.executiveSummary,
    progress: narrative.progress,
    challenges: narrative.challenges,
    patterns: narrative.patterns,
    recommendations: narrative.recommendations.join('\n'),
  };
  const checks: Partial<Record<NarrativeSection, string[]>> = {};
  for (const [section, text] of Object.entries(sections) as [NarrativeSection, string][]) {
    const figures = unverifiedFigures(text, allowedFigures);
    if (figures.length) checks[section] = figures;
  }
  return checks;
}

function isoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Trims every section and removes any phone number, ID number or email address the model wrote anyway. */
function cleanNarrative(answer: NarrativeAnswer): NarrativeAnswer {
  const clean = (value: string) => redactPersonalData((value ?? '').trim()).text;
  return {
    executiveSummary: clean(answer.executiveSummary),
    progress: clean(answer.progress),
    challenges: clean(answer.challenges),
    patterns: clean(answer.patterns),
    recommendations: (answer.recommendations ?? []).map(clean).filter(Boolean),
  };
}

const STATUS_COLOURS: Readonly<Record<string, string>> = {
  on_track: '#22c55e',
  at_risk: '#f59e0b',
  off_track: '#ef4444',
  not_started: '#9ca3af',
  completed: '#3b82f6',
};

export interface ReportHtmlInput {
  projectName: string;
  reportTitle: string;
  narrative: NarrativeAnswer;
  /** Per section, the numbers not found in the data sent (checkNarrativeFigures); each gets a warning line. */
  unverifiedFigures?: Partial<Record<NarrativeSection, string[]>>;
  indicators: ReadonlyArray<Pick<NarrativeIndicatorInput, 'indicatorText' | 'level' | 'status' | 'baselineValue' | 'targetValue' | 'currentValue'>>;
  model: string;
  promptVersion: string;
  generatedAt?: Date;
}

function section(title: string, body: string, figures?: readonly string[]): string {
  return body ? `<h2>${escapeHtml(title)}</h2>\n<div class="narrative">${body}${figureWarning(figures)}</div>` : '';
}

/** The report HTML. Every interpolated value (model output and database text) is HTML-escaped. */
export function generateReportHtml(input: ReportHtmlInput): string {
  const { narrative } = input;
  const checks = input.unverifiedFigures ?? {};
  const generated = (input.generatedAt ?? new Date()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const value = (v: string | null | undefined) => escapeHtml(v && v.trim() ? v : 'N/A');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="generator" content="${escapeHtml(`Raqib AI report narrative (${input.promptVersion}; ${input.model})`)}">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; color: #1a1a1a; line-height: 1.6; }
    h1 { color: #1e3a5f; border-bottom: 3px solid #1e3a5f; padding-bottom: 10px; }
    h2 { color: #2563eb; margin-top: 30px; }
    .header { text-align: center; margin-bottom: 40px; }
    .ai-label { display: inline-block; padding: 4px 10px; border-radius: 4px; background: #fef3c7; color: #92400e; font-size: 12px; }
    .figure-check { padding: 6px 10px; border-left: 4px solid #d97706; background: #fffbeb; color: #92400e; font-size: 14px; }
    .narrative { margin: 20px 0; text-align: justify; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #1e3a5f; color: white; padding: 10px; text-align: left; }
    td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
    tr:nth-child(even) { background: #f9fafb; }
    .status { padding: 2px 8px; border-radius: 4px; color: white; font-size: 12px; }
    .footer { margin-top: 40px; text-align: center; color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(input.reportTitle)}</h1>
    <p><strong>Project:</strong> ${escapeHtml(input.projectName)}</p>
    <p><strong>Generated:</strong> ${escapeHtml(generated)}</p>
    <p class="ai-label">AI suggested — review before approval</p>
  </div>

  ${section('Executive Summary', htmlParagraphs(narrative.executiveSummary), checks.executiveSummary)}
  ${section('Progress Against Targets', htmlParagraphs(narrative.progress), checks.progress)}
  ${section('Challenges', htmlParagraphs(narrative.challenges), checks.challenges)}
  ${section('Patterns', htmlParagraphs(narrative.patterns), checks.patterns)}
  ${section('Recommendations', htmlList(narrative.recommendations, true), checks.recommendations)}

  <h2>Indicator Summary</h2>
  <table>
    <thead>
      <tr><th>Indicator</th><th>Level</th><th>Baseline</th><th>Target</th><th>Current</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${input.indicators.map(ind => `
        <tr>
          <td>${escapeHtml(ind.indicatorText)}</td>
          <td>${escapeHtml(ind.level)}</td>
          <td>${value(ind.baselineValue)}</td>
          <td>${value(ind.targetValue)}</td>
          <td>${value(ind.currentValue)}</td>
          <td><span class="status" style="background:${STATUS_COLOURS[ind.status] ?? '#9ca3af'}">${escapeHtml(ind.status.replace(/_/g, ' '))}</span></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="footer">
    <p>Generated by RAQIB M&amp;E Platform — Momentum Labs</p>
  </div>
</body>
</html>`;
}
