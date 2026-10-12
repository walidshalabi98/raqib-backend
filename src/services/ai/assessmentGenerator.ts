import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from './errors';
import { escapeHtml, htmlList, htmlParagraphs } from './html';
import { progressTowardTarget, valueTrend } from './indicatorFigures';
import {
  ASSESSMENT_PROMPT_VERSION,
  ASSESSMENT_SCHEMA,
  ASSESSMENT_SYSTEM,
  AssessmentAnswer,
  AssessmentDocumentInput,
  AssessmentIndicatorInput,
  AssessmentQualitativeInput,
  assessmentPrompt,
} from './prompts/assessment';
import { redactPersonalData } from './redact';

/** Marker after which legacy rows appended the document analysis to parsedText. */
const LEGACY_ANALYSIS_MARKER = '---AI_ANALYSIS---';
const QUALITATIVE_EXCERPT_CHARS = 500;
const DOCUMENT_FALLBACK_CHARS = 300;
const MAX_DOCUMENT_FINDINGS = 8;
const MAX_LIST_ITEMS = 12;

type StatusCounts = Record<'on_track' | 'at_risk' | 'off_track' | 'not_started' | 'completed', number>;

/**
 * AI Assessment Generator
 * Ingests the project's data (indicators, data points, qualitative entries, document analyses),
 * generates an assessment report with the model (main tier) and stores it: the JSON in
 * Assessment.scopeDescription and the HTML in a new Report. Only aggregates and redacted text
 * reach the model. On an AI failure the assessment stays in "analysis" with a message that
 * holds no model output; logs hold ids, counts and error classes only.
 */
export async function generateAutoAssessment(
  assessmentId: string,
  projectId: string,
  assessmentType: string,
): Promise<void> {
  console.log(`[AssessmentGenerator] Starting auto-assessment ${assessmentId} for project ${projectId}`);

  const assessment = await prisma.assessment.findFirst({ where: { id: assessmentId, projectId }, select: { id: true } });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  // Update status to scoping
  await prisma.assessment.update({
    where: { id: assessmentId },
    data: { status: 'scoping' },
  });

  // 1. Gather the project data
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error('Project not found');

  const framework = await prisma.framework.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    include: {
      indicators: {
        orderBy: { sortOrder: 'asc' },
        include: {
          dataPoints: { orderBy: { collectionDate: 'desc' }, take: 20 },
        },
      },
    },
  });

  const qualitativeEntries = await prisma.qualitativeEntry.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const documents = await prisma.document.findMany({
    where: { projectId, parsingStatus: 'completed' },
    orderBy: { uploadedAt: 'desc' },
    take: 20,
    select: { fileName: true, fileType: true, parsedText: true, aiAnalysis: true },
  });

  // Update to analysis phase
  await prisma.assessment.update({
    where: { id: assessmentId },
    data: { status: 'analysis' },
  });

  // 2. Build the context (aggregates and redacted text only)
  const indicators = framework?.indicators || [];
  const indicatorSummary: AssessmentIndicatorInput[] = indicators.map(ind => ({
    text: ind.indicatorText,
    level: ind.level,
    status: ind.status,
    unit: ind.unit,
    baseline: ind.baselineValue,
    target: ind.targetValue,
    current: ind.currentValue,
    progressPercent: progressTowardTarget(ind.baselineValue, ind.targetValue, ind.currentValue),
    trend: valueTrend(ind.dataPoints.map(dp => dp.value), ind.direction),
    recentDataPoints: ind.dataPoints.slice(0, 5).map(dp => ({
      value: dp.value,
      date: isoDate(dp.collectionDate),
      method: dp.collectionMethod,
      area: dp.geographicArea,
    })),
  }));

  const qualSummary: AssessmentQualitativeInput[] = qualitativeEntries.map(e => ({
    type: e.entryType,
    title: redactPersonalData(e.title).text,
    themes: stringList(e.themes).map(theme => redactPersonalData(theme).text),
    sentiment: e.sentiment,
    // Redact first, then cut, so a number is never cut in half and left behind.
    excerpt: redactPersonalData(e.content ?? '').text.slice(0, QUALITATIVE_EXCERPT_CHARS),
    participants: e.participants,
    location: e.location,
  }));

  const docSummary = documents.map(documentSummaryFor);

  const statusCounts = countStatuses(indicators);
  const achievementRate = indicators.length > 0
    ? Math.round(((statusCounts.on_track + statusCounts.completed) / indicators.length) * 100)
    : null;

  const prompt = assessmentPrompt({
    assessmentType,
    project: {
      name: project.name,
      sector: project.sector,
      donor: project.donor,
      donorType: project.donorType,
      startDate: isoDate(project.startDate),
      endDate: isoDate(project.endDate),
      targetBeneficiaries: project.targetBeneficiaries,
      geographicScope: project.geographicScope,
      budgetUsd: project.budgetUsd === null ? null : project.budgetUsd.toString(),
    },
    indicators: indicatorSummary,
    statusCounts,
    achievementRate,
    qualitative: qualSummary,
    documents: docSummary,
  });

  // 3. Generate the assessment with AI
  try {
    const result = await generateStructured({
      feature: 'assessment.report',
      model: 'main',
      effort: 'medium',
      system: ASSESSMENT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      schema: ASSESSMENT_SCHEMA,
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      maxTokens: 16000,
      timeoutMs: 300_000,
      context: { organizationId: project.organizationId, projectId: project.id },
    });
    const report = normalizeAssessment(result.data);

    // Generate HTML report (every value escaped)
    const html = generateAssessmentHtml({
      project: { name: project.name, sector: project.sector, donor: project.donor },
      assessmentType,
      report,
      statusCounts,
      totalIndicators: indicators.length,
      model: result.model,
      promptVersion: result.promptVersion,
    });

    await prisma.assessment.update({
      where: { id: assessmentId },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
        reportUrl: null, // HTML stored in the Report below; the JSON in scopeDescription
        scopeDescription: JSON.stringify({ ...report, model: result.model, promptVersion: result.promptVersion }),
      },
    });

    // Also create a Report record with the HTML
    await prisma.report.create({
      data: {
        projectId,
        type: assessmentType === 'baseline' ? 'assessment_report' : assessmentType === 'midterm' ? 'quarterly_summary' : 'assessment_report',
        title: `AI ${capitalise(assessmentType)} Assessment — ${project.name}`,
        aiNarrative: html,
        status: 'draft',
      },
    });

    // Notify the organisation's admins
    const admins = await prisma.user.findMany({
      where: { organizationId: project.organizationId, role: { in: ['org_admin', 'platform_admin'] } },
      select: { id: true },
    });
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          type: 'assessment_ready',
          title: `Assessment Complete: ${project.name}`,
          message: `AI ${assessmentType} assessment has been generated with ${indicators.length} indicators analyzed.`,
          link: `/projects/${projectId}/assessments`,
        },
      });
    }

    console.log(`[AssessmentGenerator] Assessment ${assessmentId} complete (${indicators.length} indicators, ${qualSummary.length} qualitative entries, ${docSummary.length} documents; ${result.model}, ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens)`);
  } catch (err) {
    console.error(`[AssessmentGenerator] Assessment ${assessmentId} failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    await prisma.assessment.update({
      where: { id: assessmentId },
      data: { status: 'analysis', scopeDescription: assessmentFailureMessage(err) },
    });
  }
}

/** The message stored on a failed assessment: the kind of failure only, never model output or error text. */
export function assessmentFailureMessage(err: unknown): string {
  if (err instanceof AiRefusalError) return 'AI generation failed: the AI model declined the request. Try again or write the assessment manually.';
  if (err instanceof AiOutputTruncatedError) return 'AI generation failed: the AI answer was too long. Try again.';
  if (err instanceof AiInvalidOutputError) return 'AI generation failed: the AI answer did not match the expected format. Try again.';
  if (err instanceof AiRequestError) return 'AI generation failed: the AI service could not be reached. Try again later.';
  return 'AI generation failed: an unexpected error occurred. Try again.';
}

function isoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function countStatuses(indicators: ReadonlyArray<{ status: string }>): StatusCounts {
  const count = (status: string) => indicators.filter(i => i.status === status).length;
  return {
    on_track: count('on_track'),
    at_risk: count('at_risk'),
    off_track: count('off_track'),
    not_started: count('not_started'),
    completed: count('completed'),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Summary and key findings of an analysis object (Document.aiAnalysis, or a legacy analysis); null when it has neither. */
function readAnalysis(value: unknown): { summary: string; keyFindings: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const analysis = value as Record<string, unknown>;
  const summary = typeof analysis.summary === 'string' ? analysis.summary : '';
  const keyFindings = stringList(analysis.keyFindings ?? analysis.key_findings);
  return summary.trim() || keyFindings.length ? { summary, keyFindings } : null;
}

/**
 * What the assessment prompt gets for a document: the summary and key findings of
 * Document.aiAnalysis; for legacy rows, the analysis appended to parsedText after
 * "---AI_ANALYSIS---"; otherwise the first 300 characters of the (redacted) text. Every text is
 * redacted again here, since legacy rows were stored before redaction existed.
 */
export function documentSummaryFor(doc: { fileName: string; fileType: string; parsedText: string | null; aiAnalysis: unknown }): AssessmentDocumentInput {
  const parsedText = doc.parsedText ?? '';
  let analysis = readAnalysis(doc.aiAnalysis);
  const markerAt = parsedText.indexOf(LEGACY_ANALYSIS_MARKER);
  if (!analysis && markerAt >= 0) {
    // Stored legacy data (not a fresh model answer); malformed JSON falls through to the text.
    try {
      const legacy = parsedText.slice(parsedText.lastIndexOf(LEGACY_ANALYSIS_MARKER) + LEGACY_ANALYSIS_MARKER.length).trim();
      analysis = readAnalysis(JSON.parse(legacy));
    } catch {
      analysis = null;
    }
  }

  const clean = (text: string) => redactPersonalData(text).text.replace(/\s+/g, ' ').trim();
  const documentText = markerAt >= 0 ? parsedText.slice(0, markerAt) : parsedText;
  return {
    name: redactPersonalData(doc.fileName).text,
    type: doc.fileType,
    summary: analysis?.summary.trim() ? clean(analysis.summary) : clean(documentText).slice(0, DOCUMENT_FALLBACK_CHARS),
    keyFindings: (analysis?.keyFindings ?? []).map(clean).filter(Boolean).slice(0, MAX_DOCUMENT_FINDINGS),
  };
}

/** Trims every text, removes any phone number, ID number or email address the model wrote anyway, drops empty list entries and caps list sizes. */
export function normalizeAssessment(answer: AssessmentAnswer): AssessmentAnswer {
  const text = (value: string) => redactPersonalData((value ?? '').trim()).text;
  const list = (values: string[]) => (values ?? []).map(text).filter(Boolean).slice(0, MAX_LIST_ITEMS);
  return {
    executiveSummary: text(answer.executiveSummary),
    methodology: text(answer.methodology),
    keyFindings: (answer.keyFindings ?? [])
      .map(f => ({ area: text(f.area), finding: text(f.finding), evidence: text(f.evidence), rating: f.rating }))
      .filter(f => f.finding)
      .slice(0, MAX_LIST_ITEMS),
    indicatorAnalysis: {
      overallAchievement: text(answer.indicatorAnalysis.overallAchievement),
      strongPerformers: list(answer.indicatorAnalysis.strongPerformers),
      challengeAreas: list(answer.indicatorAnalysis.challengeAreas),
      dataGaps: list(answer.indicatorAnalysis.dataGaps),
    },
    qualitativeInsights: {
      mainThemes: list(answer.qualitativeInsights.mainThemes),
      beneficiaryVoices: text(answer.qualitativeInsights.beneficiaryVoices),
      contextualFactors: text(answer.qualitativeInsights.contextualFactors),
    },
    recommendations: (answer.recommendations ?? [])
      .map(r => ({ priority: r.priority, recommendation: text(r.recommendation), timeline: r.timeline, responsible: text(r.responsible) }))
      .filter(r => r.recommendation)
      .slice(0, MAX_LIST_ITEMS),
    lessonsLearned: list(answer.lessonsLearned),
    riskAssessment: {
      currentRisks: list(answer.riskAssessment.currentRisks),
      mitigationStrategies: list(answer.riskAssessment.mitigationStrategies),
    },
    nextSteps: list(answer.nextSteps),
  };
}

const RATING_COLOURS: Readonly<Record<string, string>> = { strong: '#16a34a', moderate: '#d97706', weak: '#dc2626' };
const PRIORITY_CLASSES = new Set(['high', 'medium', 'low']);
const TIMELINE_LABELS: Readonly<Record<string, string>> = { immediate: 'Immediate', short_term: 'Short term', medium_term: 'Medium term' };

export interface AssessmentHtmlInput {
  project: { name: string; sector: string; donor: string };
  assessmentType: string;
  report: AssessmentAnswer;
  statusCounts: StatusCounts;
  totalIndicators: number;
  model: string;
  promptVersion: string;
  generatedAt?: Date;
}

/** The assessment HTML. Every interpolated value (model output and database text) is HTML-escaped. */
export function generateAssessmentHtml(input: AssessmentHtmlInput): string {
  const { project, report, statusCounts, totalIndicators } = input;
  const achievement = totalIndicators > 0
    ? `${Math.round(((statusCounts.on_track + statusCounts.completed) / totalIndicators) * 100)}%`
    : 'N/A';
  const generated = (input.generatedAt ?? new Date()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const titled = (title: string, body: string, tag = 'h3') => (body ? `<${tag}>${escapeHtml(title)}</${tag}>${body}` : '');
  const { indicatorAnalysis: ia, qualitativeInsights: qi, riskAssessment: ra } = report;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="generator" content="${escapeHtml(`Raqib AI assessment (${input.promptVersion}; ${input.model})`)}">
<style>
body{font-family:'Segoe UI',Arial,sans-serif;margin:40px;color:#1a1a1a;line-height:1.7}
h1{color:#1e3a5f;border-bottom:3px solid #1e3a5f;padding-bottom:10px}
h2{color:#2563eb;margin-top:30px;border-bottom:1px solid #e5e7eb;padding-bottom:5px}
h3{color:#374151;margin-top:20px}
.header{text-align:center;margin-bottom:40px;padding:20px;background:#f8fafc;border-radius:8px}
.ai-label{display:inline-block;padding:4px 10px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px}
.metric-row{display:flex;flex-wrap:wrap;gap:20px;margin:20px 0}
.metric{flex:1;min-width:120px;text-align:center;padding:15px;border-radius:8px;border:1px solid #e5e7eb}
.metric .value{font-size:28px;font-weight:bold}
.green{background:#f0fdf4;color:#16a34a} .amber{background:#fffbeb;color:#d97706}
.red{background:#fef2f2;color:#dc2626} .blue{background:#eff6ff;color:#2563eb}
.finding{padding:12px;margin:8px 0;border-left:4px solid #2563eb;background:#f8fafc;border-radius:0 8px 8px 0}
.rec{padding:10px;margin:8px 0;border-radius:8px;border:1px solid #e5e7eb}
.rec.high{border-left:4px solid #ef4444} .rec.medium{border-left:4px solid #f59e0b} .rec.low{border-left:4px solid #3b82f6}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:white}
.footer{margin-top:40px;text-align:center;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:20px}
</style></head><body>
<div class="header">
<h1>AI ${escapeHtml(capitalise(input.assessmentType))} Assessment</h1>
<p><strong>Project:</strong> ${escapeHtml(project.name)} | <strong>Sector:</strong> ${escapeHtml(project.sector)} | <strong>Donor:</strong> ${escapeHtml(project.donor)}</p>
<p><strong>Generated:</strong> ${escapeHtml(generated)}</p>
<p class="ai-label">AI suggested — review before approval</p>
</div>

<div class="metric-row">
<div class="metric blue"><div class="value">${totalIndicators}</div>Total Indicators</div>
<div class="metric green"><div class="value">${statusCounts.on_track}</div>On Track</div>
<div class="metric amber"><div class="value">${statusCounts.at_risk}</div>At Risk</div>
<div class="metric red"><div class="value">${statusCounts.off_track}</div>Off Track</div>
<div class="metric blue"><div class="value">${escapeHtml(achievement)}</div>Achievement</div>
</div>

<h2>Executive Summary</h2>
${htmlParagraphs(report.executiveSummary)}

${titled('Methodology', htmlParagraphs(report.methodology), 'h2')}

<h2>Key Findings</h2>
${report.keyFindings.map(f => `
<div class="finding">
<strong>${escapeHtml(f.area || 'Finding')}</strong> <span class="badge" style="background:${RATING_COLOURS[f.rating] ?? RATING_COLOURS.moderate}">${escapeHtml(f.rating)}</span>
<p>${escapeHtml(f.finding)}</p>
${f.evidence ? `<p><em>Evidence: ${escapeHtml(f.evidence)}</em></p>` : ''}
</div>`).join('')}

<h2>Indicator Analysis</h2>
${htmlParagraphs(ia.overallAchievement)}
${titled('Strong Performers', htmlList(ia.strongPerformers))}
${titled('Challenge Areas', htmlList(ia.challengeAreas))}
${titled('Data Gaps', htmlList(ia.dataGaps))}

<h2>Qualitative Insights</h2>
${titled('Main Themes', htmlList(qi.mainThemes))}
${titled('Beneficiary Voices', htmlParagraphs(qi.beneficiaryVoices))}
${titled('Contextual Factors', htmlParagraphs(qi.contextualFactors))}

<h2>Recommendations</h2>
${report.recommendations.map(r => `
<div class="rec ${PRIORITY_CLASSES.has(r.priority) ? r.priority : 'medium'}">
<strong>${escapeHtml(r.priority.toUpperCase())} Priority</strong> — ${escapeHtml(TIMELINE_LABELS[r.timeline] ?? r.timeline)}
<p>${escapeHtml(r.recommendation)}</p>
${r.responsible ? `<p><em>Responsible: ${escapeHtml(r.responsible)}</em></p>` : ''}
</div>`).join('')}

${titled('Lessons Learned', htmlList(report.lessonsLearned), 'h2')}

${ra.currentRisks.length || ra.mitigationStrategies.length ? `<h2>Risk Assessment</h2>
${htmlList(ra.currentRisks)}
${titled('Mitigation Strategies', htmlList(ra.mitigationStrategies))}` : ''}

${titled('Next Steps', htmlList(report.nextSteps, true), 'h2')}

<div class="footer">
<p>Generated by RAQIB M&amp;E Platform — Momentum Labs</p>
<p>This assessment was generated using AI analysis of ${totalIndicators} indicators, qualitative data, and project documents.</p>
</div>
</body></html>`;
}
