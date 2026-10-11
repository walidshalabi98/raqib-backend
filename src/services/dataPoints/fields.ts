import { z } from 'zod';
import { parseNumeric } from './breakdown';

/**
 * Zod building blocks for request bodies, shared by the data point and project
 * validators. Messages are written as predicates ("is required", "must be one
 * of: …") and prefixed with the field name by formatIssues, giving responses
 * such as "donorType must be one of: usaid, eu, …".
 */

export function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : String(part)), '');
}

/** Turns zod issues into readable messages; `prefix` is prepended to each (e.g. "Row 3: "). */
export function formatIssues(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map(issue => {
    const field = formatPath(issue.path) || 'request body';
    return `${prefix}${field} ${issue.message}`;
  });
}

function enumErrorMap(allowed: string): z.ZodErrorMap {
  return (issue, ctx) => {
    if (issue.code === 'invalid_type' && ctx.data === undefined) return { message: 'is required' };
    if (issue.code === 'invalid_enum_value' || issue.code === 'invalid_type') return { message: `must be one of: ${allowed}` };
    return { message: ctx.defaultError };
  };
}

/** A Prisma enum field with a message listing the allowed values. */
export function enumField<T extends Record<string, string>>(values: T) {
  return z.nativeEnum(values, { errorMap: enumErrorMap(Object.values(values).join(', ')) });
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T/;

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Parses "YYYY-MM-DD" (or an ISO date-time starting with it) into a Date.
 * Rejects impossible dates such as 2026-02-31, which `new Date()` would
 * silently move to March. Returns null when the input is not a valid date.
 */
export function parseDateInput(input: unknown): Date | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const match = DATE_ONLY.exec(s) ?? DATE_TIME.exec(s);
  if (!match) return null;
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A required date in "YYYY-MM-DD" form. */
export function dateField() {
  return z.unknown().transform((value, ctx): Date => {
    if (value === undefined || value === null || value === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'is required' });
      return z.NEVER;
    }
    const date = parseDateInput(value);
    if (!date) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid date (YYYY-MM-DD)' });
      return z.NEVER;
    }
    return date;
  });
}

/** Optional free text; "" and whitespace become null, so clients can clear a field. */
export function optionalText() {
  return z
    .string({ invalid_type_error: 'must be text' })
    .nullish()
    .transform(v => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim()));
}

/** Required, non-empty text (trimmed); null counts as missing, so a required field cannot be cleared. */
export function requiredText() {
  return z
    .string({
      errorMap: (issue, ctx) => {
        if (issue.code === 'invalid_type') return { message: ctx.data === undefined || ctx.data === null ? 'is required' : 'must be text' };
        return { message: ctx.defaultError };
      },
    })
    .trim()
    .min(1, 'is required');
}

/**
 * Optional non-negative number; accepts JSON numbers and numeric strings.
 * undefined → undefined (not provided); null or "" → null (cleared).
 */
export function optionalNumber(opts: { integer?: boolean; max: number }) {
  return z.unknown().transform((value, ctx): number | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
    const n = parseNumeric(value);
    if (n === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: opts.integer ? 'must be a whole number' : 'must be a number' });
      return z.NEVER;
    }
    if (opts.integer && !Number.isInteger(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a whole number' });
      return z.NEVER;
    }
    if (n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not be negative' });
      return z.NEVER;
    }
    if (n > opts.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must not be more than ${opts.max.toLocaleString('en-US')}` });
      return z.NEVER;
    }
    return n;
  });
}

/** Joins validation messages into one response message, listing at most `max` of them. */
export function summariseErrors(errors: string[], max = 10): string {
  const shown = errors.slice(0, max).join('; ');
  const rest = errors.length - max;
  return rest > 0 ? `${shown}; and ${rest} more problem${rest === 1 ? '' : 's'}` : shown;
}

/** Body of a 400 response: one readable message plus every problem, for forms and import previews. */
export function validationErrorBody(errors: string[]): { message: string; errors: string[] } {
  return { message: summariseErrors(errors), errors };
}
