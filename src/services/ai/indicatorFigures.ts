/**
 * Deterministic figures computed from indicator values before an AI call (CLAUDE.md rule 7), so
 * the model only quotes numbers and never calculates or invents them (me-foundations §6).
 * Pure functions, no I/O.
 */

export type ValueTrend = 'improving' | 'declining' | 'stagnant' | 'insufficient_data';

const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/**
 * The number in an indicator value such as "45", "45%", "1,200", "12.5" or "٤٥٪"; null when the
 * value is empty or not a plain number ("about 40", "40-50", "yes").
 */
export function parseIndicatorNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value)
    .trim()
    .replace(ARABIC_DIGITS, ch => {
      const code = ch.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/\u066B/g, '.') // Arabic decimal separator
    .replace(/[,\u066C]/g, '') // thousands separators
    .replace(/\s*[%\u066A]$/, ''); // percent signs
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * Progress from baseline to target in percent, rounded: (current − baseline) / (target − baseline).
 * Null unless all three values are plain numbers and the target differs from the baseline.
 */
export function progressTowardTarget(baseline: string | null | undefined, target: string | null | undefined, current: string | null | undefined): number | null {
  const b = parseIndicatorNumber(baseline);
  const t = parseIndicatorNumber(target);
  const c = parseIndicatorNumber(current);
  if (b === null || t === null || c === null || t === b) return null;
  return Math.round(((c - b) / (t - b)) * 100);
}

/**
 * Trend of the two most recent values (newest first). For indicators whose desired direction is
 * "decrease", a falling value is improving; otherwise a rising value is. Equal values are stagnant;
 * fewer than two numeric values give insufficient_data.
 */
export function valueTrend(valuesNewestFirst: readonly (string | null | undefined)[], direction?: string | null): ValueTrend {
  const numbers = valuesNewestFirst.map(v => parseIndicatorNumber(v)).filter((n): n is number => n !== null);
  if (numbers.length < 2) return 'insufficient_data';
  const delta = numbers[0] - numbers[1];
  if (delta === 0) return 'stagnant';
  const rising = delta > 0;
  return (direction === 'decrease' ? !rising : rising) ? 'improving' : 'declining';
}
