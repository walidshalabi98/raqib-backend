/**
 * The indicator an accepted suggestion becomes (knowledge/kpi-assistant-spec.md §A1 "accept in one click", §A5;
 * me-foundations §3 reference sheet; design sections 4.2 and 8.1). Accept and framework generation use the same
 * mapping. Pure: no prisma, no env (tests/kpiPurity.test.ts).
 */
import type { CollectionMethod, Frequency, IndicatorDirection } from '@prisma/client';
import { isPercentUnit, TO_BE_CONFIRMED } from '../ai/frameworkNormalize';
import type { IndicatorCreatePayload } from '../ai/frameworkNormalize';
import { INDICATOR_UNITS } from '../ai/prompts/framework';
import { parseIndicatorCreate } from '../indicators/validation';
import type { IndicatorCreateInput } from '../indicators/validation';
import type { IndicatorDraft, IndicatorUnit, SuggestableLevel } from './types';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Trimmed text, or null when empty or not text. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** "YYYY-MM-DD" from a Date or an ISO string; null for anything else. */
function ymd(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

const UNITS: ReadonlySet<string> = new Set(INDICATOR_UNITS);

function draftUnit(unit: unknown, name: string): IndicatorUnit {
  const value = typeof unit === 'string' ? unit.trim() : '';
  if (UNITS.has(value)) return value as IndicatorUnit;
  return isPercentUnit(value, name) ? 'percent' : 'number';
}

function draftCalculation(value: unknown): IndicatorDraft['calculation'] {
  if (!isObject(value)) return null;
  const out: NonNullable<IndicatorDraft['calculation']> = {};
  for (const key of ['numerator', 'denominator', 'formula', 'rounding'] as const) {
    const part = textOrNull(value[key]);
    if (part !== null) out[key] = part;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function draftIntermediateTargets(value: unknown): IndicatorDraft['intermediateTargets'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map(t => ({ date: ymd(t.date) ?? '', value: textOrNull(t.value) ?? '' }))
    .filter(t => t.date !== '' && t.value !== '');
}

/**
 * IndicatorCreatePayload (normalizeIndicator) → IndicatorDraft (design 4.2 and the field mapping of 8.1; me-foundations
 * §3: every reference-sheet field filled or "To be confirmed by the M&E officer"): dates as YYYY-MM-DD; frameworkId,
 * sortOrder, provenance, aiModel, promptVersion, phases and milestones dropped (the server sets them on accept);
 * startDate/endDate = the project dates (m15: the target refers to the end date; editable on accept).
 */
export function indicatorDraftFromPayload(payload: IndicatorCreatePayload, resultId: string,
  dates: { startDate: string | null; endDate: string | null }): IndicatorDraft {
  const level: SuggestableLevel = payload.level === 'activity' ? 'output' : payload.level;
  const disaggregation = Array.isArray(payload.disaggregation)
    ? payload.disaggregation.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    : [];
  return {
    indicatorText: payload.indicatorText,
    indicatorTextAr: textOrNull(payload.indicatorTextAr),
    level,
    resultId,
    libraryId: textOrNull(payload.libraryId),
    standardReferenceCode: textOrNull(payload.standardReferenceCode),
    definition: textOrNull(payload.definition) ?? TO_BE_CONFIRMED,
    unit: draftUnit(payload.unit, payload.indicatorText),
    calculation: draftCalculation(payload.calculation),
    // The model's answer always holds a direction (structured outputs); 'increase' only guards the type.
    direction: (payload.direction ?? 'increase') as IndicatorDirection,
    disaggregation,
    dataCollectionMethod: payload.dataCollectionMethod as CollectionMethod,
    frequency: payload.frequency as Frequency,
    meansOfVerification: textOrNull(payload.meansOfVerification) ?? TO_BE_CONFIRMED,
    baselineValue: textOrNull(payload.baselineValue),
    baselineDate: ymd(payload.baselineDate),
    baselineMethod: textOrNull(payload.baselineMethod) ?? TO_BE_CONFIRMED,
    targetValue: textOrNull(payload.targetValue),
    targetJustification: textOrNull(payload.targetJustification) ?? TO_BE_CONFIRMED,
    intermediateTargets: draftIntermediateTargets(payload.intermediateTargets),
    assumptions: textOrNull(payload.assumptions) ?? TO_BE_CONFIRMED,
    responsibility: textOrNull(payload.responsibility) ?? TO_BE_CONFIRMED,
    startDate: ymd(dates.startDate),
    endDate: ymd(dates.endDate),
    aiRationale: textOrNull(payload.aiRationale),
  };
}

const EDITABLE_KEYS = [
  'indicatorText', 'indicatorTextAr', 'level', 'resultId', 'libraryId', 'standardReferenceCode', 'definition', 'unit',
  'calculation', 'direction', 'disaggregation', 'dataCollectionMethod', 'frequency', 'meansOfVerification',
  'baselineValue', 'baselineDate', 'baselineMethod', 'targetValue', 'targetJustification', 'intermediateTargets',
  'assumptions', 'responsibility', 'startDate', 'endDate', 'aiRationale',
] as const satisfies readonly (keyof IndicatorDraft)[];

/** Compile-time check: every IndicatorDraft key is editable (a new draft key must be added above). */
type MissingEditableKey = Exclude<keyof IndicatorDraft, (typeof EDITABLE_KEYS)[number]>;
const _everyDraftKeyIsEditable: [MissingEditableKey] extends [never] ? true : never = true;

/**
 * Keys a client may change on accept (spec §A1 "edit before accepting"; design 8.1): every IndicatorDraft key
 * (provenance, status, currentValue, sortOrder never).
 */
export const DRAFT_EDITABLE_KEYS: readonly (keyof IndicatorDraft)[] = EDITABLE_KEYS;

/** Only the editable keys of `edits` (anything else, e.g. provenance or status, is stripped); {} for a non-object. */
function editableEdits(edits: unknown): Partial<Record<keyof IndicatorDraft, unknown>> {
  if (!isObject(edits)) return {};
  const out: Partial<Record<keyof IndicatorDraft, unknown>> = {};
  for (const key of DRAFT_EDITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(edits, key)) out[key] = edits[key];
  }
  return out;
}

/**
 * Merges edits (only DRAFT_EDITABLE_KEYS; others stripped) over the draft and parses once with parseIndicatorCreate
 * (throws AppError 400 naming every failing field; design 8.1 step 4, the same keys as PATCH /api/indicators/:id).
 * Provenance, aiModel and promptVersion are never taken from the client: the server sets them on accept.
 */
export function draftToCreateInput(draft: IndicatorDraft, edits?: Record<string, unknown>): IndicatorCreateInput {
  return parseIndicatorCreate({ ...draft, ...editableEdits(edits) });
}

/** JSON with object keys sorted and Dates as ISO strings, for comparing parsed values. */
function comparable(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => {
    if (isObject(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]));
    }
    return v;
  });
}

/**
 * Edited keys whose parsed value differs from the draft's parsed value (decides edited_accepted, design 8.1 step 6), in
 * DRAFT_EDITABLE_KEYS order. Sending a key with the draft's own value (or an equivalent one, e.g. "" for null) is not an
 * edit. Throws AppError 400 like draftToCreateInput when the edits are invalid.
 */
export function editedFields(draft: IndicatorDraft, edits: Record<string, unknown>): string[] {
  const changes = editableEdits(edits);
  const base = parseIndicatorCreate({ ...draft }) as Record<string, unknown>;
  const merged = draftToCreateInput(draft, edits) as Record<string, unknown>;
  return DRAFT_EDITABLE_KEYS.filter(key => key in changes && comparable(base[key]) !== comparable(merged[key]));
}
