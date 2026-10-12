/**
 * Disaggregated data points (knowledge/me-foundations.md §4, BUILD_GUIDE Phase 2 task 3).
 *
 * A breakdown splits a data point's value by groups:
 *   { "sex": { "female": 120, "male": 98 }, "disability": { "yes": 12, "no": 206 } }
 *
 * Every dimension of a count indicator must add up to the value. Pure functions
 * only: no database access, so the rules are unit-tested (CLAUDE.md rule 7).
 *
 * Which rules apply (breakdownRules):
 *   - a count unit (number, people, households…): every dimension adds up to the value;
 *   - a percent unit: every category is between 0 and 100, no sum check;
 *   - no unit: inferred from the indicator text ("% of…", "proportion", "rate",
 *     نسبة, معدل… → percent rules), otherwise no sum check, because a blank
 *     unit does not tell us the indicator counts something;
 *   - any other unit (score, currency…): no sum check.
 */

export type Breakdown = Record<string, Record<string, number>>;

export type BreakdownValidation =
  | { ok: true; breakdown: Breakdown | null }
  | { ok: false; errors: string[] };

export const BREAKDOWN_LIMITS = {
  maxDimensions: 10,
  maxCategoriesPerDimension: 50,
  maxCategoryLength: 60,
  /** Allowed difference between the sum of a dimension's categories and the value. */
  sumTolerance: 1e-6,
} as const;

/** e.g. sex, age, disability, location, displacement_status, sex_of_household_head */
const DIMENSION_KEY = /^[a-z][a-z0-9_]*$/;

const COUNT_UNITS = new Set([
  'number', 'count', '#', 'people', 'persons', 'individuals', 'households', 'beneficiaries', 'participants',
]);

function normaliseUnit(unit: string | null | undefined): string {
  return (unit ?? '').trim().toLowerCase();
}

/**
 * True when the unit says the indicator counts something, so each breakdown
 * dimension must add up to the value. A blank unit is not a count (see breakdownRules).
 */
export function isCountUnit(unit: string | null | undefined): boolean {
  const u = normaliseUnit(unit);
  return u !== '' && (COUNT_UNITS.has(u) || u.startsWith('number'));
}

/** True for '%', 'percent', 'percentage' (and forms such as "% of households"). */
export function isPercentUnit(unit: string | null | undefined): boolean {
  const u = normaliseUnit(unit);
  return u.startsWith('%') || u.startsWith('percent');
}

const PERCENT_WORDS = /\b(percent|percentage|proportion|share|rate)\b/i;
// \b does not work with Arabic letters, so these match anywhere (also with a prefix: النسبة، بنسبة).
const ARABIC_PERCENT_WORDS = /نسبة|معدل/;

/**
 * True when the indicator text reads as a percentage: it starts with '%' or uses
 * percent, percentage, proportion, share or rate (or نسبة / معدل). Used only when
 * the indicator has no unit.
 */
export function isPercentIndicatorText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return t.startsWith('%') || PERCENT_WORDS.test(t) || ARABIC_PERCENT_WORDS.test(t);
}

export type BreakdownRules = 'count' | 'percent' | 'none';

/** Which breakdown rules apply to an indicator; see the comment at the top of this file. */
export function breakdownRules(unit: string | null | undefined, indicatorText?: string | null): BreakdownRules {
  if (normaliseUnit(unit) === '') return isPercentIndicatorText(indicatorText) ? 'percent' : 'none';
  if (isCountUnit(unit)) return 'count';
  if (isPercentUnit(unit)) return 'percent';
  return 'none';
}

export const COUNT_VALUE_NOT_NUMERIC = 'value must be a number to record a breakdown for a count indicator';

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const WITH_THOUSANDS = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * Parses a number typed by a user. Accepts JSON numbers and numeric strings,
 * including Arabic-Indic digits (١٢٠), the Arabic decimal separator (٫) and
 * thousands separators ("1,200"). Returns null for anything else
 * ("", "12 people", "N/A", "0x10", Infinity).
 * raqib-frontend src/lib/numbers.ts has a copy for form validation; change both together.
 */
export function parseNumeric(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  let s = input
    .trim()
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic digits
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)) // Extended Arabic-Indic digits
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/٬/g, ','); // Arabic thousands separator
  if (WITH_THOUSANDS.test(s)) s = s.replace(/,/g, '');
  if (!NUMERIC.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Formats a number for an error message without floating-point noise (0.1 + 0.2 → "0.3"). */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 30 ? `${text.slice(0, 27)}...` : text;
}

function shorten(text: string, max = 30): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Validates and normalises a data point breakdown against the indicator's unit.
 *
 * - null, undefined or {} → no breakdown.
 * - An object of dimensions → objects of categories → finite, non-negative
 *   numbers (numeric strings are converted).
 * - Dimension keys match /^[a-z][a-z0-9_]*$/; category names are trimmed,
 *   non-empty and at most 60 characters; at most 10 dimensions and 1–50
 *   categories per dimension.
 * - Count units (see isCountUnit): the value must be a number and every
 *   dimension must add up to it (tolerance 1e-6).
 * - Percent units, or no unit and a percentage-like indicator text: every
 *   category must be between 0 and 100; no sum check.
 * - No unit and any other text, or other units (score, currency, litres…): no sum check.
 *
 * All problems are reported together.
 */
export function validateBreakdown(
  breakdown: unknown,
  opts: { value: string; unit: string | null | undefined; indicatorText?: string | null },
): BreakdownValidation {
  if (breakdown === null || breakdown === undefined) return { ok: true, breakdown: null };
  if (!isPlainObject(breakdown)) {
    return {
      ok: false,
      errors: ['breakdown must be an object of dimensions, for example { "sex": { "female": 120, "male": 98 } }'],
    };
  }

  const dimensions = Object.entries(breakdown);
  if (dimensions.length === 0) return { ok: true, breakdown: null };

  const errors: string[] = [];
  const { maxDimensions, maxCategoriesPerDimension, maxCategoryLength, sumTolerance } = BREAKDOWN_LIMITS;
  if (dimensions.length > maxDimensions) {
    errors.push(`breakdown can have at most ${maxDimensions} dimensions (got ${dimensions.length})`);
  }

  const rules = breakdownRules(opts.unit, opts.indicatorText);
  const percent = rules === 'percent';
  const total = rules === 'count' ? parseNumeric(opts.value) : null;
  // A count breakdown is only meaningful against a numeric value; never skip the sum check silently.
  if (rules === 'count' && total === null) errors.push(COUNT_VALUE_NOT_NUMERIC);

  // Built with Map + Object.fromEntries so a key such as "__proto__" stays an ordinary property.
  const result = new Map<string, Record<string, number>>();

  for (const [dimension, categories] of dimensions) {
    if (!DIMENSION_KEY.test(dimension)) {
      errors.push(
        `"${shorten(dimension)}" is not a valid dimension name: use lower-case letters, digits and underscores, ` +
        'starting with a letter (for example sex, age, disability, location, displacement_status)',
      );
      continue;
    }
    if (!isPlainObject(categories)) {
      errors.push(`${dimension}: must be an object of categories, for example { "female": 120, "male": 98 } (got ${describe(categories)})`);
      continue;
    }

    const entries = Object.entries(categories);
    if (entries.length === 0) {
      errors.push(`${dimension}: needs at least one category`);
      continue;
    }
    if (entries.length > maxCategoriesPerDimension) {
      errors.push(`${dimension}: can have at most ${maxCategoriesPerDimension} categories (got ${entries.length})`);
      continue;
    }

    const values = new Map<string, number>();
    let dimensionOk = true;
    for (const [rawCategory, rawValue] of entries) {
      const category = rawCategory.trim();
      if (category === '') {
        errors.push(`${dimension}: category names must not be empty`);
        dimensionOk = false;
        continue;
      }
      if (category.length > maxCategoryLength) {
        errors.push(`${dimension}: category "${shorten(category)}" is longer than ${maxCategoryLength} characters`);
        dimensionOk = false;
        continue;
      }
      if (values.has(category)) {
        errors.push(`${dimension}: category "${category}" appears more than once`);
        dimensionOk = false;
        continue;
      }
      const n = parseNumeric(rawValue);
      if (n === null) {
        errors.push(`${dimension}: "${category}" must be a number (got ${describe(rawValue)})`);
        dimensionOk = false;
      } else if (n < 0) {
        errors.push(`${dimension}: "${category}" must not be negative (got ${formatNumber(n)})`);
        dimensionOk = false;
      } else if (percent && n > 100) {
        errors.push(`${dimension}: "${category}" must be between 0 and 100 for a percentage (got ${formatNumber(n)})`);
        dimensionOk = false;
      } else {
        values.set(category, n);
      }
    }
    if (!dimensionOk) continue;

    if (total !== null) {
      let sum = 0;
      for (const v of values.values()) sum += v;
      if (Math.abs(sum - total) > sumTolerance) {
        errors.push(`${dimension}: categories add up to ${formatNumber(sum)} but the value is ${formatNumber(total)}`);
        continue;
      }
    }
    result.set(dimension, Object.fromEntries(values));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, breakdown: Object.fromEntries(result) };
}
