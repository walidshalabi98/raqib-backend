import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { parseIndicatorNumber, valueTrend } from './indicatorFigures';
import { RISK_PROMPT_VERSION, RISK_SCHEMA, RISK_SYSTEM, RiskAnswer, RiskIndicatorInput, riskAnalysisPrompt } from './prompts/risk';

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
  dataPoints: Array<{ value: string; collectionDate: Date }>;
}

/**
 * Risk assessment of the project's at-risk and off-track indicators. The model (fast tier) adds an
 * analysis and actions; on any AI error every indicator gets the deterministic assessment instead.
 */
export async function analyzeProjectRisks(projectId: string): Promise<RiskAlert[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) return [];

  const framework = await prisma.framework.findFirst({
    where: { projectId, status: { in: ['approved', 'active', 'expert_review', 'client_review'] } },
    orderBy: { version: 'desc' },
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
  });

  if (!framework) return [];
  const atRiskIndicators: AtRiskIndicator[] = framework.indicators.filter(
    (ind) => ind.status === 'off_track' || ind.status === 'at_risk',
  );

  if (atRiskIndicators.length === 0) return [];

  // Aggregates only: indicator texts, values and dates.
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
    computedTrend: valueTrend(ind.dataPoints.map(dp => dp.value), ind.direction),
    dataPoints: ind.dataPoints.map((dp) => ({
      value: dp.value,
      date: dp.collectionDate.toISOString().split('T')[0],
    })),
  }));

  try {
    const result = await generateStructured({
      feature: 'risk.analysis',
      model: 'fast',
      effort: 'low',
      system: RISK_SYSTEM,
      messages: [{ role: 'user', content: riskAnalysisPrompt({ name: project.name, sector: project.sector, donor: project.donor }, indicatorContext) }],
      schema: RISK_SCHEMA,
      promptVersion: RISK_PROMPT_VERSION,
      maxTokens: 4000,
      context: { organizationId: project.organizationId, projectId: project.id },
    });
    return mergeRiskAnswer(atRiskIndicators, result.data);
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

function deterministicTrend(ind: AtRiskIndicator): RiskAlert['trend'] {
  const trend = valueTrend(ind.dataPoints.map(dp => dp.value), ind.direction);
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

/**
 * Combines the model's answer with the indicators: answers for ids that were not sent are ignored
 * (the first answer per id wins), and indicators without an answer get the deterministic assessment.
 */
export function mergeRiskAnswer(indicators: AtRiskIndicator[], answer: RiskAnswer): RiskAlert[] {
  const byId = new Map<string, RiskAnswer['risks'][number]>();
  const known = new Set(indicators.map(ind => ind.id));
  for (const risk of answer.risks ?? []) {
    if (known.has(risk.indicatorId) && !byId.has(risk.indicatorId)) byId.set(risk.indicatorId, risk);
  }

  return indicators.map((ind) => {
    const risk = byId.get(ind.id);
    if (!risk) return fallbackRiskAlert(ind);
    const fallback = fallbackRiskAlert(ind);
    const actions = (risk.suggestedActions ?? []).map(a => a.trim()).filter(Boolean).slice(0, MAX_ACTIONS);
    return {
      ...baseAlert(ind),
      riskLevel: risk.riskLevel,
      trend: risk.trend,
      aiAnalysis: risk.analysis.trim() || fallback.aiAnalysis,
      suggestedActions: actions.length ? actions : fallback.suggestedActions,
      estimatedImpact: risk.estimatedImpact.trim() || fallback.estimatedImpact,
    };
  });
}
