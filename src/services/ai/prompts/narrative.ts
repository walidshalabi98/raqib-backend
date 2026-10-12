/**
 * Report narrative prompt (feature "report.narrative", main tier), used by
 * src/services/ai/reportNarrative.ts. The AI client sends the shared M&E system prompt
 * (role + knowledge/me-foundations.md §1–12) before NARRATIVE_SYSTEM.
 *
 * The model receives indicator figures only (aggregates, no personal data) and may cite only
 * those figures (knowledge/me-foundations.md §6).
 */
import * as z from 'zod/v4';
import { donorLabel } from './donors';

export const NARRATIVE_PROMPT_VERSION = 'report-narrative-v2';

/** At most this many characters of a data point's disaggregated counts are sent. */
const MAX_BREAKDOWN_CHARS = 500;

/** The phrase the model must use when a figure is missing. */
export const DATA_NOT_AVAILABLE = 'data not available';

/** Structured-output schema of the answer: one field per section of the report HTML. */
export const NARRATIVE_SCHEMA = z.object({
  executiveSummary: z.string(),
  progress: z.string(),
  challenges: z.string(),
  patterns: z.string(),
  recommendations: z.array(z.string()),
});

export type NarrativeAnswer = z.infer<typeof NARRATIVE_SCHEMA>;

/** Feature-specific instructions. */
export const NARRATIVE_SYSTEM = `You write the narrative sections of an M&E progress report for an NGO project, for donor readers. You answer in the requested JSON format only.

Rules:
- Use only the figures given in the indicator data. Never invent, estimate, extrapolate or calculate new numbers, percentages or statistics; copy figures exactly as given, with their units. Where a figure is needed but not given, write "${DATA_NOT_AVAILABLE}".
- "Progress toward target" is already calculated; quote it as given and never calculate it yourself.
- Do not claim causes, trends or results the data do not show. Say when data are missing or too few to judge.
- Never mention people by name and never include personal data.
- Keep language neutral, professional and free of political characterisations. Mention access constraints (closures, movement restrictions) only as possible factors, not as established causes.
- Write in English unless asked otherwise. Separate paragraphs with a blank line.
- When a donor format is given, follow that donor's reporting conventions and terminology.`;

export interface NarrativeIndicatorInput {
  indicatorText: string;
  level: string;
  status: string;
  unit?: string | null;
  baselineValue?: string | null;
  targetValue?: string | null;
  currentValue?: string | null;
  /** Percent of the way from baseline to target, calculated in code; null when it cannot be calculated. */
  progressPercent: number | null;
  dataPoints: Array<{ value: string; date: string; area?: string | null; breakdown?: unknown }>;
}

export interface NarrativeProjectInput {
  name: string;
  sector: string;
  donor: string;
  periodStart?: string;
  periodEnd?: string;
}

function figure(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : DATA_NOT_AVAILABLE;
}

/** The user message: project facts, indicator figures and the sections to write. */
export function writeNarrativePrompt(
  projectInfo: NarrativeProjectInput,
  indicators: NarrativeIndicatorInput[],
  donorFormat?: string | null,
): string {
  const indicatorBlock = indicators.length
    ? indicators.map(ind => {
      const points = ind.dataPoints.length
        ? ind.dataPoints.map(dp => {
          const extras = [dp.area ? `area ${dp.area}` : '', dp.breakdown ? `breakdown ${JSON.stringify(dp.breakdown).slice(0, MAX_BREAKDOWN_CHARS)}` : ''].filter(Boolean).join('; ');
          return `${dp.value} (${dp.date}${extras ? `; ${extras}` : ''})`;
        }).join(', ')
        : 'no data collected';
      return `[${ind.level.toUpperCase()}] ${ind.indicatorText}
  Status: ${ind.status} | Unit: ${figure(ind.unit)}
  Baseline: ${figure(ind.baselineValue)} | Target: ${figure(ind.targetValue)} | Current: ${figure(ind.currentValue)} | Progress toward target: ${ind.progressPercent === null ? DATA_NOT_AVAILABLE : `${ind.progressPercent}%`}
  Recent data: ${points}`;
    }).join('\n\n')
    : 'No indicators recorded.';

  return `Write the narrative sections of a progress report for the project below.

PROJECT: ${projectInfo.name}
SECTOR: ${projectInfo.sector}
DONOR: ${projectInfo.donor}
${projectInfo.periodStart || projectInfo.periodEnd ? `REPORTING PERIOD: ${projectInfo.periodStart ?? DATA_NOT_AVAILABLE} to ${projectInfo.periodEnd ?? DATA_NOT_AVAILABLE}\n` : ''}${donorFormat ? `DONOR FORMAT: follow the reporting conventions of ${donorLabel(donorFormat)}\n` : ''}
INDICATOR DATA:
${indicatorBlock}

Return (about 500–800 words in all):
- executiveSummary: one or two paragraphs on overall progress, citing the figures above.
- progress: achievements and progress against targets, indicator by indicator where there are data.
- challenges: indicators that are off track or at risk, what the data show and possible reasons, stated as possibilities.
- patterns: geographic or demographic patterns visible in the data (areas, breakdowns); if the data show none, say "${DATA_NOT_AVAILABLE}".
- recommendations: three to six specific, practical recommendations for the next reporting period (including data collection gaps). No target values.`;
}
