/**
 * Qualitative entries are stored without phone numbers, ID numbers or email addresses
 * (CLAUDE.md rule 5): the title, the notes or transcript (content), the location and the
 * facilitator are redacted with redactPersonalData when an entry is saved (typed notes, the
 * transcript upload, the KoboToolbox webhook) and by the one-off backfill
 * (scripts/redact-stored-text.ts --include-qualitative).
 *
 * Pure functions, no I/O. Counts are numbers only and safe to log; the text never is.
 */
import { redactPersonalData, type RedactionCounts } from '../ai/redact';

/** The free-text fields of a QualitativeEntry that can hold personal data. */
export const QUALITATIVE_TEXT_FIELDS = ['title', 'content', 'location', 'facilitator'] as const;
export type QualitativeTextField = (typeof QUALITATIVE_TEXT_FIELDS)[number];

export type QualitativeTextValues = Partial<Record<QualitativeTextField, string | null | undefined>>;

export function noRedactions(): RedactionCounts {
  return { phone: 0, idNumber: 0, email: 0 };
}

/** Adds `more` to `total` (in place) and returns `total`. */
export function addRedactions(total: RedactionCounts, more: RedactionCounts): RedactionCounts {
  total.phone += more.phone;
  total.idNumber += more.idNumber;
  total.email += more.email;
  return total;
}

export function redactionTotal(counts: RedactionCounts): number {
  return counts.phone + counts.idNumber + counts.email;
}

/** "removed 1 phone numbers, 0 ID numbers, 0 email addresses", worded like the document parser's log line. */
export function describeRedactions(counts: RedactionCounts): string {
  return `removed ${counts.phone} phone numbers, ${counts.idNumber} ID numbers, ${counts.email} email addresses`;
}

/**
 * Redacts every free-text field that holds a string; any other value (undefined, null) is returned
 * as it is, and fields this function does not know are copied unchanged. `counts` sums the matches
 * removed over all fields.
 */
export function redactQualitativeFields<T extends QualitativeTextValues>(values: T): { values: T; counts: RedactionCounts } {
  const counts = noRedactions();
  const out: T = { ...values };
  for (const field of QUALITATIVE_TEXT_FIELDS) {
    const value = values[field];
    if (typeof value !== 'string') continue;
    const redacted = redactPersonalData(value);
    (out as QualitativeTextValues)[field] = redacted.text;
    addRedactions(counts, redacted.counts);
  }
  return { values: out, counts };
}
