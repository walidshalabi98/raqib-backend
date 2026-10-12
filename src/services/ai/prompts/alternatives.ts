/**
 * Indicator alternatives prompt (feature "indicator.alternatives", fast tier), used by
 * src/services/ai/indicatorAlternative.ts. The AI client sends the shared M&E system prompt
 * (role + knowledge/me-foundations.md §1–12) before ALTERNATIVES_SYSTEM.
 */
import * as z from 'zod/v4';
import { CollectionMethod, Frequency } from '@prisma/client';
import { donorGuidance, donorLabel } from './donors';

export const ALTERNATIVES_PROMPT_VERSION = 'alternatives-v2';

/** How many alternatives the model is asked for. */
export const ALTERNATIVES_COUNT = 3;

export const ALTERNATIVE_LEVELS = ['impact', 'outcome', 'output'] as const;

/** Structured-output schema of the answer (every property required; "" when unknown). */
export const ALTERNATIVES_SCHEMA = z.object({
  alternatives: z.array(z.object({
    indicatorText: z.string(),
    indicatorTextAr: z.string(),
    level: z.enum(ALTERNATIVE_LEVELS),
    dataCollectionMethod: z.enum(CollectionMethod),
    frequency: z.enum(Frequency),
    rationale: z.string(),
    pros: z.array(z.string()),
    cons: z.array(z.string()),
  })),
});

export type AlternativesAnswer = z.infer<typeof ALTERNATIVES_SCHEMA>;

/** Feature-specific instructions. */
export const ALTERNATIVES_SYSTEM = `You suggest alternative indicators for one indicator in an NGO results framework. You answer in the requested JSON format only.

Rules:
- Each alternative measures one dimension of the same result as the current indicator, with a different measurement approach or data source where that helps.
- Neutral wording: state what is measured, never the desired direction or a target. Write "% of households with an acceptable Food Consumption Score", never "Increase to 80% the households…" or "Improved food security". Direction and target are separate fields and are not part of the indicator text.
- Never include baseline values, target values or statistics.
- Prefer established indicators (donor frameworks such as EU GERF, cluster and sector standards, recognised tools) over custom wording, and say in the rationale which standard an alternative follows, or that it is custom and why.
- Percentages need a clear numerator and denominator in the wording. People-level indicators are disaggregated by sex at least; mention this in the pros or cons when relevant.
- The data collection method must be realistic in the Palestinian context: movement restrictions, closures and access constraints (especially Gaza and Area C). Mention remote options (phone surveys, partner records) where field access is uncertain.
- No indicator may expose respondents to harm; sensitive topics (GBV, child protection, MHPSS) use specialist tools and aggregated data.
- indicatorTextAr is the same indicator in Modern Standard Arabic suitable for donor and ministry readers.
- Keep language neutral and professional; no political characterisations.`;

export interface AlternativesIndicatorInput {
  indicatorText: string;
  level: string;
  dataCollectionMethod: string;
  frequency: string;
  definition?: string | null;
  unit?: string | null;
  /** Text of the result (outcome, output…) the indicator measures. */
  resultText?: string | null;
  resultCode?: string | null;
}

export interface AlternativesProjectInput {
  sector: string;
  donor: string;
  donorType: string;
  description?: string | null;
  humanitarian?: boolean;
}

/** The level the alternatives must have: the current indicator's level ("output" for activity-level indicators). */
export function alternativeLevelFor(level: string): (typeof ALTERNATIVE_LEVELS)[number] {
  return (ALTERNATIVE_LEVELS as readonly string[]).includes(level) ? (level as (typeof ALTERNATIVE_LEVELS)[number]) : 'output';
}

/** The user message. All values are organisational texts (no personal data); the description is redacted by the caller. */
export function generateAlternativesPrompt(indicator: AlternativesIndicatorInput, project: AlternativesProjectInput): string {
  const line = (label: string, value: string | null | undefined): string => (value && value.trim() ? `- ${label}: ${value.trim()}\n` : '');
  const level = alternativeLevelFor(indicator.level);
  return `Suggest ${ALTERNATIVES_COUNT} alternative indicators for the current indicator below.

CURRENT INDICATOR:
${line('Text', indicator.indicatorText)}${line('Level', indicator.level)}${line('Definition', indicator.definition)}${line('Unit', indicator.unit)}${line('Data collection method', indicator.dataCollectionMethod)}${line('Frequency', indicator.frequency)}${line('Result it measures', indicator.resultText ? `${indicator.resultCode ? `${indicator.resultCode} ` : ''}${indicator.resultText}` : null)}
PROJECT CONTEXT:
${line('Sector', project.sector)}${line('Donor', `${project.donor} (${donorLabel(project.donorType)})`)}${line('Donor guidance', donorGuidance(project.donorType))}${line('Humanitarian project', project.humanitarian ? 'yes' : 'no')}${line('Description', project.description ? project.description.slice(0, 2000) : null)}
For each alternative return:
- indicatorText: the indicator in English, neutral wording, one dimension, no target.
- indicatorTextAr: the same indicator in Modern Standard Arabic.
- level: "${level}".
- dataCollectionMethod: one of ${Object.values(CollectionMethod).join(', ')}.
- frequency: one of ${Object.values(Frequency).join(', ')}.
- rationale: one or two sentences on why this alternative could work better, naming the standard it follows or saying it is custom and why.
- pros: two or three short advantages.
- cons: one to three short drawbacks (cost, access, data quality).

Do not repeat the current indicator.`;
}
