/**
 * Report narrative prompt (feature "report.narrative", main tier), used by
 * src/services/ai/reportNarrative.ts. The AI client sends the shared M&E system prompt
 * (role + knowledge/me-foundations.md §1–12) before NARRATIVE_SYSTEM.
 *
 * The model receives indicator figures only (aggregates, no personal data) and may cite only
 * those figures (knowledge/me-foundations.md §6).
 */
import * as z from 'zod/v4';
import { formatNumber, parseNumeric } from '../../dataPoints/breakdown';
import { PROGRESS_NO_BASELINE_NOTE } from '../indicatorFigures';
import { redactPersonalData } from '../redact';
import { donorLabel } from './donors';

export const NARRATIVE_PROMPT_VERSION = 'report-narrative-v3';

/** At most this many characters of a data point's disaggregated counts are sent (whole dimensions only). */
export const MAX_BREAKDOWN_CHARS = 500;

/** Added when dimensions of a breakdown are left out to stay within MAX_BREAKDOWN_CHARS. */
export const BREAKDOWN_OMITTED = '(further categories omitted)';

/** Dimensions sent first (sex is the minimum disaggregation, me-foundations §4); the others follow in stored order. */
const DIMENSION_PRIORITY = ['sex', 'age', 'disability', 'displacement_status'];

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
- "Progress toward target" is already calculated (from baseline to target, or as a share of the target when it says "${PROGRESS_NO_BASELINE_NOTE}"); quote it as given, with that note, and never calculate it yourself.
- A breakdown lists disaggregated counts per dimension ("sex: female 120, male 98"); "${BREAKDOWN_OMITTED}" means some dimensions were not sent, so do not describe them.
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
  /** Progress in percent, calculated in code (indicatorFigures.indicatorProgress); null when it cannot be calculated. */
  progressPercent: number | null;
  /** True when progressPercent is current / target × 100 because no baseline is recorded. */
  progressNoBaseline?: boolean;
  /** Values and areas already redacted; breakdown labels are redacted by formatBreakdown. */
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Labels are free text typed by staff: phone, ID and email numbers are removed, separators flattened. */
function label(text: string): string {
  return redactPersonalData(text).text.replace(/\s+/g, ' ').trim();
}

/**
 * A data point breakdown as prompt text, one dimension after another:
 * "sex: female 9120, male 8790; location: Gaza City 1200, Rafah 300". Numbers are never cut: a
 * dimension is sent whole or not at all; dimensions that do not fit in maxChars are left out
 * (sex, age, disability and displacement status are tried first) and BREAKDOWN_OMITTED is added.
 * Category labels are redacted. Categories that are not numbers are skipped; "" when nothing is left.
 */
export function formatBreakdown(breakdown: unknown, maxChars = MAX_BREAKDOWN_CHARS): string {
  if (!isPlainObject(breakdown)) return '';
  const keys = Object.keys(breakdown);
  const ordered = [...DIMENSION_PRIORITY.filter(k => keys.includes(k)), ...keys.filter(k => !DIMENSION_PRIORITY.includes(k))];
  const dimensions = ordered.flatMap(key => {
    const categories = breakdown[key];
    if (!isPlainObject(categories)) return [];
    const parts = Object.entries(categories).flatMap(([name, count]) => {
      const n = parseNumeric(count);
      return n === null ? [] : [`${label(name)} ${formatNumber(n)}`];
    });
    return parts.length ? [`${label(key)}: ${parts.join(', ')}`] : [];
  });

  const kept: string[] = [];
  let length = 0;
  let omitted = false;
  for (const dimension of dimensions) {
    const added = (kept.length ? 2 : 0) + dimension.length;
    if (length + added > maxChars) {
      omitted = true;
      continue;
    }
    kept.push(dimension);
    length += added;
  }
  return [kept.join('; '), omitted ? BREAKDOWN_OMITTED : ''].filter(Boolean).join(' ');
}

/** "Progress toward target: …" of an indicator. */
function progressText(ind: NarrativeIndicatorInput): string {
  if (ind.progressPercent === null) return DATA_NOT_AVAILABLE;
  return ind.progressNoBaseline ? `${ind.progressPercent}% (${PROGRESS_NO_BASELINE_NOTE})` : `${ind.progressPercent}%`;
}

/** One indicator as sent to the model: figures, progress and recent data points. */
export function narrativeIndicatorBlock(ind: NarrativeIndicatorInput): string {
  const points = ind.dataPoints.length
    ? ind.dataPoints.map(dp => {
      const breakdown = formatBreakdown(dp.breakdown);
      const extras = [dp.area ? `area ${dp.area}` : '', breakdown ? `breakdown ${breakdown}` : ''].filter(Boolean).join('; ');
      return `${dp.value} (${dp.date}${extras ? `; ${extras}` : ''})`;
    }).join(', ')
    : 'no data collected';
  return `[${ind.level.toUpperCase()}] ${ind.indicatorText}
  Status: ${ind.status} | Unit: ${figure(ind.unit)}
  Baseline: ${figure(ind.baselineValue)} | Target: ${figure(ind.targetValue)} | Current: ${figure(ind.currentValue)} | Progress toward target: ${progressText(ind)}
  Recent data: ${points}`;
}

/** The project facts as sent to the model. */
export function narrativeProjectBlock(projectInfo: NarrativeProjectInput, donorFormat?: string | null): string {
  return `PROJECT: ${projectInfo.name}
SECTOR: ${projectInfo.sector}
DONOR: ${projectInfo.donor}
${projectInfo.periodStart || projectInfo.periodEnd ? `REPORTING PERIOD: ${projectInfo.periodStart ?? DATA_NOT_AVAILABLE} to ${projectInfo.periodEnd ?? DATA_NOT_AVAILABLE}\n` : ''}${donorFormat ? `DONOR FORMAT: follow the reporting conventions of ${donorLabel(donorFormat)}\n` : ''}`;
}

/** The user message: project facts, indicator figures and the sections to write. */
export function writeNarrativePrompt(
  projectInfo: NarrativeProjectInput,
  indicators: NarrativeIndicatorInput[],
  donorFormat?: string | null,
): string {
  const indicatorBlock = indicators.length ? indicators.map(narrativeIndicatorBlock).join('\n\n') : 'No indicators recorded.';

  return `Write the narrative sections of a progress report for the project below.

${narrativeProjectBlock(projectInfo, donorFormat)}
INDICATOR DATA (${indicators.length} ${indicators.length === 1 ? 'indicator' : 'indicators'}):
${indicatorBlock}

Return (about 500–800 words in all):
- executiveSummary: one or two paragraphs on overall progress, citing the figures above.
- progress: achievements and progress against targets, indicator by indicator where there are data.
- challenges: indicators that are off track or at risk, what the data show and possible reasons, stated as possibilities.
- patterns: geographic or demographic patterns visible in the data (areas, breakdowns); if the data show none, say "${DATA_NOT_AVAILABLE}".
- recommendations: three to six specific, practical recommendations for the next reporting period (including data collection gaps). No target values.`;
}
