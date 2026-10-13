import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { parseIndicatorNumber, unverifiedFigures, valueTrend } from './indicatorFigures';
import { RISK_PROMPT_VERSION, RISK_SCHEMA, RISK_SYSTEM, RiskAnswer, RiskIndicatorInput, riskAnalysisPrompt } from './prompts/risk';
import { redactPersonalData } from './redact';

export interface RiskAlert {
  indicatorId: string;
  indicatorText: string;
  level: string;
  currentValue: number | null;
  targetValue: number | null;
  status: string;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  trend: 'declining' | 'stagnant' | 'improving';
  aiAnalysis: string;
  suggestedActions: string[];
  estimatedImpact: string;
}

const DEFAULT_ACTIONS = ['Review data collection methods', 'Consult with field team', 'Consider timeline adjustments'];
const MAX_ACTIONS = 5;

/** An at-risk or off-track indicator with its latest data points (newest first). */
export interface AtRiskIndicator {
  id: string;
  indicatorText: string;
  level: string;
  status: string;
  unit: string | null;
  direction: string | null;
  baselineValue: string | null;
  targetValue: string | null;
  currentValue: string | null;
  dataPoints: Array<{ value: string; collectionDate: Date; geographicArea?: string | null }>;
}

/** Options of analyzeProjectRisks. */
export interface AnalyzeProjectRisksOptions {
  /**
   * Only approved indicators are analysed (and sent to the model): set for donor viewers, who see approved
   * indicators only (knowledge/kpi-assistant-spec.md §A1; design section 4.7). Default false.
   */
  approvedOnly?: boolean;
}

/**
 * Risk assessment of the at-risk and off-track indicators of the project's current reviewed
 * framework (with `approvedOnly`, of its approved indicators only). The model (fast tier) adds a risk
 * level, an analysis and actions; the trend comes from the data whenever there are two comparable data
 * points, and texts with numbers that were not sent are replaced by the deterministic text. On any AI
 * error every indicator gets the deterministic assessment instead.
 */
export async function analyzeProjectRisks(projectId: string, options: AnalyzeProjectRisksOptions = {}): Promise<RiskAlert[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) return [];

  const framework = await prisma.framework.findFirst({
    where: { projectId, generationError: null, status: { in: ['approved', 'active', 'expert_review', 'client_review'] } },
    orderBy: { version: 'desc' },
    include: {
      indicators: {
        where: options.approvedOnly ? { isApproved: true } : undefined,
        orderBy: { sortOrder: 'asc' },
        include: {
          dataPoints: {
            orderBy: { collectionDate: 'desc' },
            take: 10,
          },
        },
      },
    },
  });

  if (!framework) return [];
  const atRiskIndicators: AtRiskIndicator[] = framework.indicators.filter(
    (ind) => ind.status === 'off_track' || ind.status === 'at_risk',
  );

  if (atRiskIndicators.length === 0) return [];

  // Aggregates only: indicator texts, values and dates (data point values are free text, so redacted).
  const indicatorContext: RiskIndicatorInput[] = atRiskIndicators.map((ind) => ({
    id: ind.id,
    text: ind.indicatorText,
    level: ind.level,
    status: ind.status,
    unit: ind.unit,
    direction: ind.direction,
    baseline: ind.baselineValue,
    target: ind.targetValue,
    current: ind.currentValue,
    computedTrend: computedTrend(ind),
    dataPoints: ind.dataPoints.map((dp) => ({
      value: redactPersonalData(dp.value).text,
      date: dp.collectionDate.toISOString().split('T')[0],
    })),
  }));
  const projectFacts = { name: project.name, sector: project.sector, donor: project.donor };

  try {
    const result = await generateStructured({
      feature: 'risk.analysis',
      model: 'fast',
      effort: 'low',
      system: RISK_SYSTEM,
      messages: [{ role: 'user', content: riskAnalysisPrompt(projectFacts, indicatorContext) }],
      schema: RISK_SCHEMA,
      promptVersion: RISK_PROMPT_VERSION,
      maxTokens: 4000,
      context: { organizationId: project.organizationId, projectId: project.id },
    });
    // Every figure sent: the project facts and the indicators without their ids (uuids hold digits).
    const allowed = [JSON.stringify(projectFacts), JSON.stringify(indicatorContext.map(({ id: _id, ...rest }) => rest))];
    const { alerts, replaced } = checkedRiskAnswer(atRiskIndicators, result.data, allowed);
    if (replaced > 0) console.warn(`[RiskAnalyzer] Project ${projectId}: ${replaced} AI texts held figures not in the data and were replaced`);
    return alerts;
  } catch (err) {
    // Error class only: no prompt or model text in logs.
    console.error(`[RiskAnalyzer] AI risk analysis failed for project ${projectId}: ${err instanceof Error ? err.name : 'unknown error'}; using the deterministic assessment`);
    return atRiskIndicators.map(fallbackRiskAlert);
  }
}

function baseAlert(ind: AtRiskIndicator): Pick<RiskAlert, 'indicatorId' | 'indicatorText' | 'level' | 'currentValue' | 'targetValue' | 'status'> {
  return {
    indicatorId: ind.id,
    indicatorText: ind.indicatorText,
    level: ind.level,
    currentValue: parseIndicatorNumber(ind.currentValue),
    targetValue: parseIndicatorNumber(ind.targetValue),
    status: ind.status,
  };
}

/** The trend of the indicator's data points (same area, earlier date; see valueTrend), as sent to the model. */
function computedTrend(ind: AtRiskIndicator): ReturnType<typeof valueTrend> {
  return valueTrend(
    ind.dataPoints.map(dp => ({ value: dp.value, date: dp.collectionDate, area: dp.geographicArea })),
    ind.direction,
    ind.targetValue,
  );
}

function deterministicTrend(ind: AtRiskIndicator): RiskAlert['trend'] {
  const trend = computedTrend(ind);
  return trend === 'insufficient_data' ? 'stagnant' : trend;
}

/** The assessment without AI: high risk when off track, medium when at risk; trend from the data points. */
export function fallbackRiskAlert(ind: AtRiskIndicator): RiskAlert {
  return {
    ...baseAlert(ind),
    riskLevel: ind.status === 'off_track' ? 'high' : 'medium',
    trend: deterministicTrend(ind),
    aiAnalysis: `This ${ind.level} indicator is ${ind.status.replace(/_/g, ' ')} and requires attention.`,
    suggestedActions: [...DEFAULT_ACTIONS],
    estimatedImpact: 'May affect project outcomes if not addressed promptly.',
  };
}

/** Every figure of the indicators as sent to the model (texts, values, dates; never ids). */
export function riskAllowedFigures(indicators: readonly AtRiskIndicator[]): string[] {
  return indicators.flatMap(ind => [
    ind.indicatorText,
    ind.unit ?? '',
    ind.baselineValue ?? '',
    ind.targetValue ?? '',
    ind.currentValue ?? '',
    ...ind.dataPoints.flatMap(dp => [dp.value, dp.collectionDate.toISOString().split('T')[0]]),
  ]);
}

/**
 * Combines the model's answer with the indicators: answers for ids that were not sent are ignored
 * (the first answer per id wins), and indicators without an answer get the deterministic assessment.
 * The trend is the computed one whenever the data allow it (the model's only when they do not).
 * Texts are redacted; an analysis or impact with a number not among `allowedFigures` (default: the
 * indicators' own figures) is replaced by the deterministic text, and such an action is dropped.
 */
export function mergeRiskAnswer(indicators: AtRiskIndicator[], answer: RiskAnswer, allowedFigures?: readonly string[]): RiskAlert[] {
  return checkedRiskAnswer(indicators, answer, allowedFigures ?? riskAllowedFigures(indicators)).alerts;
}

function checkedRiskAnswer(indicators: AtRiskIndicator[], answer: RiskAnswer, allowed: readonly string[]): { alerts: RiskAlert[]; replaced: number } {
  const byId = new Map<string, RiskAnswer['risks'][number]>();
  const known = new Set(indicators.map(ind => ind.id));
  for (const risk of answer.risks ?? []) {
    if (known.has(risk.indicatorId) && !byId.has(risk.indicatorId)) byId.set(risk.indicatorId, risk);
  }

  let replaced = 0;
  /** The redacted text, or null when it is empty or holds a number that was not sent. */
  const checked = (value: string | null | undefined): string | null => {
    const text = redactPersonalData((value ?? '').trim()).text;
    if (!text) return null;
    if (unverifiedFigures(text, allowed).length > 0) {
      replaced += 1;
      return null;
    }
    return text;
  };

  const alerts = indicators.map((ind) => {
    const risk = byId.get(ind.id);
    if (!risk) return fallbackRiskAlert(ind);
    const fallback = fallbackRiskAlert(ind);
    const trend = computedTrend(ind);
    const actions = (risk.suggestedActions ?? [])
      .map(checked)
      .filter((a): a is string => a !== null)
      .slice(0, MAX_ACTIONS);
    return {
      ...baseAlert(ind),
      riskLevel: risk.riskLevel,
      trend: trend === 'insufficient_data' ? risk.trend : trend,
      aiAnalysis: checked(risk.analysis) ?? fallback.aiAnalysis,
      suggestedActions: actions.length ? actions : fallback.suggestedActions,
      estimatedImpact: checked(risk.estimatedImpact) ?? fallback.estimatedImpact,
    };
  });
  return { alerts, replaced };
}
