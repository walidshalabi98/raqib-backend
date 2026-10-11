import { CollectionMethod, Prisma } from '@prisma/client';
import { z } from 'zod';
import { Breakdown, validateBreakdown } from './breakdown';
import { dateField, enumField, formatIssues, optionalText, requiredText } from './fields';

/**
 * Request-body validation for data points (POST /api/indicators/:id/data and
 * POST /api/projects/:id/data/bulk). Pure functions: the routes load the
 * indicator's unit and pass it in.
 */

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

const valueField = z.preprocess(
  v => (typeof v === 'number' && Number.isFinite(v) ? String(v) : v),
  z.string({ required_error: 'is required', invalid_type_error: 'must be text or a number' }).trim().min(1, 'is required'),
);

const fields = {
  value: valueField,
  collectionDate: dateField(),
  collectionMethod: enumField(CollectionMethod),
  dataSource: optionalText(),
  geographicArea: optionalText(),
  notes: optionalText(),
  assessmentId: optionalText(),
  attachments: z.unknown().optional(),
  breakdown: z.unknown().optional(),
};

const dataPointSchema = z.object(fields, { invalid_type_error: 'must be a JSON object' });
const bulkRowSchema = z.object({ ...fields, indicatorId: requiredText() }, { invalid_type_error: 'must be a JSON object' });

/** Validated fields; `breakdown` is still raw until checked against the indicator's unit. */
export type DataPointFields = z.infer<typeof dataPointSchema>;
export type BulkRowFields = z.infer<typeof bulkRowSchema>;

/** Data point fields ready for prisma.dataPoint.create (without ids). */
export interface DataPointInput {
  value: string;
  collectionDate: Date;
  collectionMethod: CollectionMethod;
  dataSource: string | null | undefined;
  geographicArea: string | null | undefined;
  notes: string | null | undefined;
  assessmentId: string | null | undefined;
  attachments: Prisma.InputJsonValue | undefined;
  breakdown: Breakdown | null;
}

/** Validates the body of POST /api/indicators/:id/data, except the breakdown. */
export function parseDataPointFields(body: unknown): ParseResult<DataPointFields> {
  const parsed = dataPointSchema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, errors: formatIssues(parsed.error) };
}

/** Label used in bulk error messages; rows are numbered from 1. */
export function rowLabel(index: number): string {
  return `Row ${index + 1}: `;
}

/** Validates one row of a bulk import (index is 0-based; messages say "Row 1", "Row 2"…), except the breakdown. */
export function parseBulkRowFields(row: unknown, index: number): ParseResult<BulkRowFields> {
  const parsed = bulkRowSchema.safeParse(row);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, errors: formatIssues(parsed.error, rowLabel(index)) };
}

/**
 * Checks the breakdown against the indicator's unit and returns the data
 * point ready to store. `prefix` is prepended to every message (e.g. "Row 3: ").
 */
export function completeDataPoint(
  input: DataPointFields,
  unit: string | null | undefined,
  prefix = '',
): ParseResult<DataPointInput> {
  const breakdown = validateBreakdown(input.breakdown, { value: input.value, unit });
  if (breakdown.ok === false) return { ok: false, errors: breakdown.errors.map(e => `${prefix}${e}`) };
  return {
    ok: true,
    data: {
      value: input.value,
      collectionDate: input.collectionDate,
      collectionMethod: input.collectionMethod,
      dataSource: input.dataSource,
      geographicArea: input.geographicArea,
      notes: input.notes,
      assessmentId: input.assessmentId,
      attachments: input.attachments === undefined || input.attachments === null
        ? undefined
        : input.attachments as Prisma.InputJsonValue,
      breakdown: breakdown.breakdown,
    },
  };
}
