/**
 * Risk analysis prompt (feature "risk.analysis", fast tier), used by
 * src/services/ai/riskAnalyzer.ts for at-risk and off-track indicators. The AI client sends the
 * shared M&E system prompt (role + knowledge/me-foundations.md §1–12) before RISK_SYSTEM.
 *
 * Input is aggregates only: indicator texts, values (redacted), dates and the deterministic trend.
 */
import * as z from 'zod/v4';

export const RISK_PROMPT_VERSION = 'risk-analysis-v2';

export const RISK_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export const RISK_TRENDS = ['declining', 'stagnant', 'improving'] as const;

/** Structured-output schema of the answer (every property required). */
export const RISK_SCHEMA = z.object({
  risks: z.array(z.object({
    indicatorId: z.string(),
    riskLevel: z.enum(RISK_LEVELS),
    trend: z.enum(RISK_TRENDS),
    analysis: z.string(),
    suggestedActions: z.array(z.string()),
    estimatedImpact: z.string(),
  })),
});

export type RiskAnswer = z.infer<typeof RISK_SCHEMA>;

/** Feature-specific instructions. */
export const RISK_SYSTEM = `You are an M&E risk analyst for development and humanitarian projects in Palestine. You assess indicators that are at risk or off track and suggest practical corrective actions. You answer in the requested JSON format only.

Rules:
- Return one item per indicator, using the indicator id exactly as given. Do not add indicators.
- Use only the figures given. Never invent, estimate or calculate new numbers or statistics; quote figures exactly as given. If data are missing or too few, say so.
- "trend" follows the data points (newest first) and the computed trend; with fewer than two data points use "stagnant".
- Suggested actions are specific and realistic for the Palestinian context (movement restrictions, closures, access constraints in Gaza and Area C; remote data collection where field access is uncertain). Never suggest new target values.
- Keep language neutral and professional; no political characterisations. Never include personal data.`;

export interface RiskIndicatorInput {
  id: string;
  text: string;
  level: string;
  status: string;
  unit: string | null;
  direction: string | null;
  baseline: string | null;
  target: string | null;
  current: string | null;
  /** Deterministic trend: the latest value against the previous one of the same area (indicatorFigures.valueTrend); it overrides the model's trend unless insufficient_data. */
  computedTrend: string;
  dataPoints: Array<{ value: string; date: string }>;
}

/** The user message: project facts and the indicators needing attention (as JSON). */
export function riskAnalysisPrompt(project: { name: string; sector: string; donor: string }, indicators: RiskIndicatorInput[]): string {
  return `Analyse the indicators below, which are at risk or off track, and assess each one.

PROJECT: ${project.name}
SECTOR: ${project.sector}
DONOR: ${project.donor}

INDICATORS REQUIRING ATTENTION (JSON):
${JSON.stringify(indicators, null, 2)}

For each indicator return:
- indicatorId: the "id" given above.
- riskLevel: critical, high, medium or low.
- trend: declining, stagnant or improving.
- analysis: two or three sentences on why the indicator is at risk, citing only the figures above.
- suggestedActions: two or three specific corrective actions.
- estimatedImpact: one sentence on the likely effect on the project's results if not addressed.`;
}
