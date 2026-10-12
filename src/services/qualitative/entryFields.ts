/**
 * Checks the non-text fields of a qualitative entry before it is saved, so a bad value gets a clear
 * 400 instead of reaching the database (whose error would quote the whole entry; CLAUDE.md rule 5).
 * Pure functions, no I/O. Messages name the field only, never its value.
 */
import { QualitativeType } from '@prisma/client';

export const QUALITATIVE_TYPES = Object.values(QualitativeType) as QualitativeType[];

/** Most participants one entry can record (a large FGD round, not a survey). */
export const MAX_PARTICIPANTS = 100_000;

export class EntryFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryFieldError';
  }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** The entry type, or `fallback` when none was given; an unknown value is refused. */
export function entryTypeOf(value: unknown, field: string, fallback?: QualitativeType): QualitativeType {
  if (isBlank(value) && fallback) return fallback;
  if (typeof value === 'string' && (QUALITATIVE_TYPES as string[]).includes(value)) return value as QualitativeType;
  throw new EntryFieldError(`${field} must be one of: ${QUALITATIVE_TYPES.join(', ')}`);
}

/** A whole number of participants (0 to MAX_PARTICIPANTS) from a number or a form string; undefined when blank. */
export function participantsOf(value: unknown, field = 'participants'): number | undefined {
  if (isBlank(value)) return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_PARTICIPANTS) {
    throw new EntryFieldError(`${field} must be a whole number from 0 to ${MAX_PARTICIPANTS}`);
  }
  return n;
}

/** A date from an ISO date or date-time string (or a Date); undefined when blank. */
export function dateOf(value: unknown, field: string): Date | undefined {
  if (isBlank(value)) return undefined;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw new EntryFieldError(`${field} must be a date`);
  return date;
}
