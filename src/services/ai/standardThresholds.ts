/**
 * Recognised standard thresholds of the indicator library (me-foundations §6 (c): the AI may "cite a recognised standard
 * threshold where one exists (e.g., Sphere minimum of 15 litres of water per person per day)"; KPI Assistant rule 11).
 *
 * A number in a library entry's text is not a threshold by itself: entries also hold recall periods (FCS "7 days"),
 * score cut-offs (FCS 21/35, 28/42), durations ("6 months"), years ("CHS 2024"), commitment and framework numbers
 * ("Commitment 5", "EU GERF 2.38") and visit counts (ANC4). So a standard-threshold target is kept only when it is one
 * of the values listed here for the linked entry, in the entry's unit (and, as before, written in the entry's own text).
 * Every value is checked against knowledge/indicator-library.json by tests/kpiValidate.test.ts. Pure: no prisma, no env.
 */

/** One recognised threshold: the value as the entry writes it, the indicator unit it applies to and its source. */
export interface StandardThreshold {
  value: string;
  unit: string;
  /** Where the threshold comes from, e.g. "Sphere minimum" (shown to the model next to the value). */
  label: string;
}

/**
 * Library id → its recognised thresholds. Only WA-01 has one today: Sphere's water supply standard, "minimum 15 l/p/d
 * (aim for 20)", in the entry's standard reference and notes ("a standard threshold the AI may cite").
 */
export const STANDARD_THRESHOLDS: Readonly<Record<string, readonly StandardThreshold[]>> = {
  'WA-01': [
    { value: '15', unit: 'litres_per_person_per_day', label: 'Sphere minimum' },
    { value: '20', unit: 'litres_per_person_per_day', label: 'Sphere aim' },
  ],
};

/** ASCII digits for Arabic-Indic and Extended Arabic-Indic digits, "." / "," / "%" for the Arabic signs, lower case. */
function normalise(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/٪/g, '%')
    .toLowerCase();
}

/** Numbers in normalised text: digits with decimal or thousands separators, without a trailing "%". */
const NUMBER = /\d+(?:[.,]\d+)*/g;

const numberKey = (token: string) => token.replace(/,/g, '');

/**
 * The recognised threshold `value` stands for on library entry `entryId` (STANDARD_THRESHOLDS), or null: the value holds
 * exactly one number, that number equals a listed threshold, it carries no percent sign unless the threshold's unit is a
 * percentage, and the indicator's unit (when known) is the threshold's unit. "15", "15 l/p/d" and "at least 15" are the
 * Sphere minimum on WA-01; "35" on FS-01 (an FCS cut-off), "2024" on AC-01 and "15%" on WA-01 are not thresholds.
 */
export function recognisedThreshold(entryId: string | null | undefined, value: string, unit?: string | null): StandardThreshold | null {
  const listed = STANDARD_THRESHOLDS[(entryId ?? '').trim().toUpperCase()];
  if (!listed) return null;
  const text = normalise(value ?? '');
  const numbers = Array.from(text.matchAll(NUMBER), m => numberKey(m[0]));
  if (numbers.length !== 1) return null;
  const percent = text.includes('%') || /\bper ?cent\b|بالمئة|بالمائة|في المئة|في المائة/.test(text);
  return listed.find(t => numberKey(t.value) === numbers[0]
    && percent === t.unit.startsWith('percent')
    && (unit === undefined || unit === null || unit.trim() === '' || unit.trim() === t.unit)) ?? null;
}

/** The thresholds of an entry as one prompt fragment ("15 (Sphere minimum), 20 (Sphere aim)"), or null when it has none. */
export function thresholdsForPrompt(entryId: string): string | null {
  const listed = STANDARD_THRESHOLDS[entryId.trim().toUpperCase()];
  return listed && listed.length > 0 ? listed.map(t => `${t.value} (${t.label})`).join(', ') : null;
}
