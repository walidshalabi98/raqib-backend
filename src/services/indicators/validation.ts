import { z } from 'zod';
import {
  CollectionMethod, Frequency, IndicatorDirection, IndicatorLevel, IndicatorProvenance, IndicatorStatus, Prisma,
} from '@prisma/client';
import { AppError } from '../../middleware/errorHandler';

/**
 * Validation for results-chain nodes and indicator reference sheets
 * (knowledge/me-foundations.md §3). Pure: no database access. Unknown keys are
 * stripped (not rejected) so older frontend payloads keep working; every
 * problem is reported in one 400 message that names the failing fields.
 */

// ---------------------------------------------------------------- primitives

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const blankOrNullToUndefined = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const numberToString = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : v);

const tooLong = (max: number) => `must be at most ${max} characters`;

/** Required text: trimmed and not empty. */
const requiredText = (max: number) =>
  z.string({ invalid_type_error: 'must be text', required_error: 'is required' })
    .trim()
    .min(1, 'cannot be empty')
    .max(max, tooLong(max));

/** Optional text: trimmed; '' and null clear the field (stored as null). */
const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string({ invalid_type_error: 'must be text' }).trim().max(max, tooLong(max)).nullable());

/** Indicator values (baseline, target, current) are stored as text; numbers are accepted and converted. */
const optionalValue = (max: number) => z.preprocess(numberToString, optionalText(max));

function enumOf<T extends Record<string, string>>(values: T) {
  const allowed = Object.values(values).join(', ');
  return z.nativeEnum(values, {
    errorMap: issue => ({
      message: issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined' ? 'is required' : `must be one of: ${allowed}`,
    }),
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parses a calendar date "YYYY-MM-DD" to UTC midnight; null when the format or the date is wrong (e.g. 2026-02-30). */
export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

const DATE_MESSAGE = 'must be a real date in YYYY-MM-DD format';

const calendarDate = z.string({ invalid_type_error: DATE_MESSAGE, required_error: 'is required' })
  .trim()
  .refine(v => parseIsoDate(v) !== null, DATE_MESSAGE);

/** Nullable calendar date "YYYY-MM-DD" ('' and null clear it), returned as a Date at UTC midnight. */
const dateOnly = z.preprocess(blankToNull, calendarDate.transform(v => parseIsoDate(v) as Date).nullable());

/**
 * True for "YYYY-MM-DD" or an ISO date-time whose date part is a real calendar
 * date: "2026-02-30T00:00:00Z" is rejected instead of rolling over to March.
 */
export function isLegacyDate(value: string): boolean {
  if (parseIsoDate(value) !== null) return true;
  return ISO_DATETIME.test(value) && parseIsoDate(value.slice(0, 10)) !== null && !Number.isNaN(Date.parse(value));
}

/**
 * Nullable date for the older schedule fields (startDate, endDate, ...): "YYYY-MM-DD"
 * or a full ISO date-time, as the current frontend sends; '' and null clear it.
 */
const legacyDate = z.preprocess(
  blankToNull,
  z.string({ invalid_type_error: DATE_MESSAGE })
    .trim()
    .refine(isLegacyDate, DATE_MESSAGE)
    .transform(v => new Date(v))
    .nullable(),
);

const sortOrder = z.number({ invalid_type_error: 'must be a whole number' })
  .int('must be a whole number')
  .min(0, 'cannot be negative')
  .max(1_000_000, 'must be at most 1000000');

// -------------------------------------------------------- reference sheet

export const DISAGGREGATION_KEY = /^[a-z][a-z0-9_]*$/;
export const MAX_DISAGGREGATION_KEYS = 20;
export const MAX_INTERMEDIATE_TARGETS = 20;

/** Provenance values a client may set; ai_suggested / ai_generated are set only by Raqib's AI features. */
export const CLIENT_PROVENANCE = ['manual', 'library', 'imported'] as const satisfies readonly IndicatorProvenance[];
export type ClientProvenance = (typeof CLIENT_PROVENANCE)[number];

const provenance = z.string({ invalid_type_error: `must be one of: ${CLIENT_PROVENANCE.join(', ')}` })
  .superRefine((v, ctx) => {
    if ((CLIENT_PROVENANCE as readonly string[]).includes(v)) return;
    const message = v === 'ai_suggested' || v === 'ai_generated'
      ? `${v} is set only by Raqib's AI features; use one of: ${CLIENT_PROVENANCE.join(', ')}`
      : `must be one of: ${CLIENT_PROVENANCE.join(', ')}`;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  })
  .transform(v => v as ClientProvenance);

/**
 * Provenance after a PATCH, worked out by the server (clients cannot set it on
 * update): a manual or library indicator follows its library link (library
 * when `libraryId` is set after the update, manual when it is empty); AI and
 * imported provenance never change.
 */
export function provenanceAfterUpdate(stored: IndicatorProvenance, libraryId: string | null): IndicatorProvenance {
  if (stored !== 'manual' && stored !== 'library') return stored;
  return libraryId ? 'library' : 'manual';
}

const CALCULATION_KEYS = ['numerator', 'denominator', 'formula', 'rounding'] as const;
export type IndicatorCalculation = Partial<Record<(typeof CALCULATION_KEYS)[number], string>>;

/**
 * { numerator?, denominator?, formula?, rounding? } as text. Other keys are
 * dropped; empty values are left out; an object with nothing left becomes null.
 */
const calculation = z.object({
  numerator: optionalText(1000).optional(),
  denominator: optionalText(1000).optional(),
  formula: optionalText(2000).optional(),
  rounding: optionalText(200).optional(),
}, { invalid_type_error: 'must be an object with numerator, denominator, formula and rounding' })
  .transform((c): IndicatorCalculation | null => {
    const out: IndicatorCalculation = {};
    for (const key of CALCULATION_KEYS) if (c[key]) out[key] = c[key] as string;
    return Object.keys(out).length > 0 ? out : null;
  })
  .nullable();

/** Disaggregation groups as unique snake_case keys, e.g. ["sex", "age", "disability"]. */
const disaggregation = z.array(
  z.string({ invalid_type_error: 'must be text' })
    .trim()
    .min(1, 'cannot be empty')
    .max(50, tooLong(50))
    .regex(DISAGGREGATION_KEY, 'must be a snake_case key such as sex, age or displacement_status'),
  { invalid_type_error: 'must be a list of keys such as ["sex", "age"]' },
)
  .max(MAX_DISAGGREGATION_KEYS, `can list at most ${MAX_DISAGGREGATION_KEYS} groups`)
  .superRefine((keys, ctx) => {
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lists ${Array.from(new Set(duplicates)).join(', ')} more than once` });
    }
  })
  .nullable();

export type IntermediateTarget = { date: string; value: string };

/** Intermediate targets [{ date: "YYYY-MM-DD", value }], one per date, returned sorted by date. */
const intermediateTargets = z.array(
  z.object({
    date: calendarDate,
    value: z.preprocess(numberToString, requiredText(200)),
  }, { invalid_type_error: 'must be an object with date and value' }),
  { invalid_type_error: 'must be a list of { date, value } objects' },
)
  .max(MAX_INTERMEDIATE_TARGETS, `can have at most ${MAX_INTERMEDIATE_TARGETS} targets`)
  .superRefine((targets, ctx) => {
    const dates = targets.map(t => t.date);
    const duplicates = dates.filter((d, i) => dates.indexOf(d) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `has more than one target for ${Array.from(new Set(duplicates)).join(', ')}` });
    }
  })
  .transform((targets): IntermediateTarget[] => targets
    .map(t => ({ date: t.date as string, value: t.value as string }))
    .sort((a, b) => a.date.localeCompare(b.date)))
  .nullable();

// ------------------------------------------------------------ older fields

const phases = z.array(requiredText(50), { invalid_type_error: 'must be a list of phase names' })
  .max(20, 'can list at most 20 phases');

const milestones = z.array(
  z.object({
    label: requiredText(300),
    date: optionalText(50).optional(),
    completed: z.boolean({ invalid_type_error: 'must be true or false' }).optional(),
  }, { invalid_type_error: 'must be an object with label, date and completed' }),
  { invalid_type_error: 'must be a list of milestones' },
)
  .max(100, 'can have at most 100 milestones')
  .nullable();

// --------------------------------------------------------------- indicators

const indicatorFields = {
  // Fields from before Phase 2
  indicatorText: requiredText(1000),
  indicatorTextAr: optionalText(1000),
  level: enumOf(IndicatorLevel),
  dataCollectionMethod: enumOf(CollectionMethod),
  frequency: enumOf(Frequency),
  baselineValue: optionalValue(200),
  targetValue: optionalValue(200),
  currentValue: optionalValue(200),
  unit: optionalText(100),
  status: enumOf(IndicatorStatus),
  phases,
  sortOrder,
  startDate: legacyDate,
  endDate: legacyDate,
  actualStartDate: legacyDate,
  actualEndDate: legacyDate,
  milestones,
  responsibility: optionalText(300),
  aiRationale: optionalText(5000),
  // Reference sheet (Phase 2)
  resultId: optionalText(100),
  definition: optionalText(5000),
  calculation,
  direction: z.preprocess(blankToNull, enumOf(IndicatorDirection).nullable()),
  disaggregation,
  meansOfVerification: optionalText(2000),
  baselineDate: dateOnly,
  baselineMethod: optionalText(2000),
  targetJustification: optionalText(2000),
  intermediateTargets,
  assumptions: optionalText(5000),
  // Library ids are upper-case ("FS-01"); "fs-01" finds the same entry.
  libraryId: optionalText(50).transform(v => (typeof v === 'string' ? v.toUpperCase() : v)),
  standardReferenceCode: optionalText(100),
  // provenance is accepted on create only (see indicatorCreateSchema); on update the server sets it.
};

const BODY_MESSAGE = 'the request body must be a JSON object';

/** PATCH /api/indicators/:id — any subset of the fields. `provenance` is not one of them (stripped like other unknown keys). */
export const indicatorUpdateSchema = z.object(indicatorFields, { invalid_type_error: BODY_MESSAGE }).partial();

/** Fields that have a default on create: '' and null mean "use the default", as before Phase 2. */
const withDefault = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankOrNullToUndefined, schema.optional());

/** POST /api/frameworks/:id/indicators — every field optional; see toIndicatorCreateData for defaults. */
export const indicatorCreateSchema = indicatorUpdateSchema.extend({
  indicatorText: withDefault(indicatorFields.indicatorText),
  level: withDefault(indicatorFields.level),
  dataCollectionMethod: withDefault(indicatorFields.dataCollectionMethod),
  frequency: withDefault(indicatorFields.frequency),
  status: withDefault(indicatorFields.status),
  phases: withDefault(indicatorFields.phases),
  sortOrder: withDefault(indicatorFields.sortOrder),
  provenance: provenance.optional(),
});

export type IndicatorUpdateInput = z.infer<typeof indicatorUpdateSchema>;
export type IndicatorCreateInput = z.infer<typeof indicatorCreateSchema>;

// ------------------------------------------------------------------ results

const resultFields = {
  level: enumOf(IndicatorLevel),
  code: requiredText(50),
  text: requiredText(2000),
  textAr: optionalText(2000),
  parentId: optionalText(100),
  sortOrder,
};

/** POST /api/frameworks/:id/results */
export const resultCreateSchema = z.object(resultFields, { invalid_type_error: BODY_MESSAGE }).extend({
  textAr: resultFields.textAr.optional(),
  parentId: resultFields.parentId.optional(),
  sortOrder: resultFields.sortOrder.optional(),
});

/** PATCH /api/results/:id — any subset of the fields. */
export const resultUpdateSchema = z.object(resultFields, { invalid_type_error: BODY_MESSAGE }).partial();

export type ResultCreateInput = z.infer<typeof resultCreateSchema>;
export type ResultUpdateInput = z.infer<typeof resultUpdateSchema>;

// ------------------------------------------------------------------ parsing

/** One line naming every failing field, e.g. "level must be one of: ...; baselineDate must be a real date ...". */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')} ${issue.message}` : issue.message))
    .join('; ');
}

function parseWith<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new AppError(400, `Invalid ${what}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

export const parseIndicatorCreate = (body: unknown): IndicatorCreateInput => parseWith(indicatorCreateSchema, body, 'indicator');
export const parseIndicatorUpdate = (body: unknown): IndicatorUpdateInput => parseWith(indicatorUpdateSchema, body, 'indicator');
export const parseResultCreate = (body: unknown): ResultCreateInput => parseWith(resultCreateSchema, body, 'result');
export const parseResultUpdate = (body: unknown): ResultUpdateInput => parseWith(resultUpdateSchema, body, 'result');

// ------------------------------------------------------- Prisma conversion

const NULLABLE_JSON_FIELDS = new Set<string>(['calculation', 'disaggregation', 'intermediateTargets', 'milestones']);

/**
 * Prisma update data for the fields present in the input. A null JSON field
 * becomes SQL NULL (Prisma.DbNull); other nulls clear the column.
 */
export function toIndicatorUpdateData(input: IndicatorUpdateInput): Prisma.IndicatorUncheckedUpdateInput {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    data[key] = value === null && NULLABLE_JSON_FIELDS.has(key) ? Prisma.DbNull : value;
  }
  return data as Prisma.IndicatorUncheckedUpdateInput;
}

export const DEFAULT_PHASES = ['baseline', 'midterm', 'endline'];

/**
 * Prisma create data with the defaults used before Phase 2 (text "New
 * Indicator", household survey, quarterly, baseline/midterm/endline). The level
 * defaults to the linked result's level, else output. Provenance defaults to
 * library when a libraryId is given, else manual.
 */
export function toIndicatorCreateData(
  frameworkId: string,
  input: IndicatorCreateInput,
  defaults: { sortOrder: number; resultLevel?: IndicatorLevel | null },
): Prisma.IndicatorUncheckedCreateInput {
  const rest = toIndicatorUpdateData(input);
  return {
    ...(rest as Record<string, unknown>),
    frameworkId,
    indicatorText: input.indicatorText ?? 'New Indicator',
    level: input.level ?? defaults.resultLevel ?? 'output',
    dataCollectionMethod: input.dataCollectionMethod ?? 'hh_survey',
    frequency: input.frequency ?? 'quarterly',
    phases: input.phases ?? DEFAULT_PHASES,
    sortOrder: input.sortOrder ?? defaults.sortOrder,
    provenance: input.provenance ?? (input.libraryId ? 'library' : 'manual'),
  } as Prisma.IndicatorUncheckedCreateInput;
}
