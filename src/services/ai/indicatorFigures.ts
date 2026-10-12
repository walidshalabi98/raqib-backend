/**
 * Deterministic figures computed from indicator values before an AI call (CLAUDE.md rule 7), so
 * the model only quotes numbers and never calculates or invents them (me-foundations §6), and the
 * check of the numbers in the model's answer against the figures it was given.
 * Pure functions, no I/O.
 */
import { isCountUnit, parseNumeric } from '../dataPoints/breakdown';

export type ValueTrend = 'improving' | 'declining' | 'stagnant' | 'insufficient_data';

const ARABIC_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/g;
const PERCENT_SUFFIX = /\s*[%\u066A]$/;

/** A plain number read from an indicator value, and whether it was written with a percent sign. */
interface Figure {
  value: number;
  percent: boolean;
}

function readFigure(value: string | number | null | undefined): Figure | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { value, percent: false } : null;
  const text = String(value).trim();
  const percent = PERCENT_SUFFIX.test(text);
  // parseNumeric accepts only proper thousands groups: "1,200" is 1200, but "12,5" and "1,2" are not numbers.
  const number = parseNumeric(percent ? text.replace(PERCENT_SUFFIX, '') : text);
  return number === null ? null : { value: number, percent };
}

/**
 * True when some values are written as percentages ("50%") and others as plain proportions
 * ("0.35", a number strictly between -1 and 1 other than 0): comparing them would give a wrong
 * figure, so no progress or trend is computed.
 */
function mixesPercentAndProportion(figures: readonly Figure[]): boolean {
  return figures.some(f => f.percent) && figures.some(f => !f.percent && f.value !== 0 && Math.abs(f.value) < 1);
}

/**
 * The number in an indicator value such as "45", "45%", "1,200", "12.5" or "٤٥٪"; null when the
 * value is empty or not a plain number ("about 40", "40-50", "yes"), or uses a comma that is not a
 * thousands separator ("12,5" and "1,2" are null, never 125 or 12). A trailing % or ٪ is ignored.
 */
export function parseIndicatorNumber(value: string | number | null | undefined): number | null {
  return readFigure(value)?.value ?? null;
}

/**
 * Progress from baseline to target in percent, rounded: (current − baseline) / (target − baseline).
 * Null unless all three values are plain numbers, the target differs from the baseline and the
 * values do not mix percentages and proportions ("0.35" with "50%").
 */
export function progressTowardTarget(baseline: string | null | undefined, target: string | null | undefined, current: string | null | undefined): number | null {
  const b = readFigure(baseline);
  const t = readFigure(target);
  const c = readFigure(current);
  if (b === null || t === null || c === null || t.value === b.value) return null;
  if (mixesPercentAndProportion([b, t, c])) return null;
  return Math.round(((c.value - b.value) / (t.value - b.value)) * 100);
}

/** How the progress of an indicator without a baseline is labelled wherever it is shown or sent. */
export const PROGRESS_NO_BASELINE_NOTE = 'of target; no baseline recorded';

/** Levels whose count indicators start from zero when no baseline is recorded (the project delivers them). */
const ZERO_START_LEVELS = new Set(['output', 'activity']);

export interface IndicatorProgress {
  /** Rounded percent. */
  percent: number;
  /**
   * True when no baseline is recorded and the percent is current / target × 100 (an output count
   * of a new service starts from zero); show it with PROGRESS_NO_BASELINE_NOTE.
   */
  noBaseline: boolean;
}

/**
 * Progress of an indicator, calculated in code: from baseline to target (progressTowardTarget);
 * or, for an output (or activity) count ('number' and its count aliases) with no baseline recorded,
 * current / target × 100, flagged noBaseline. Null otherwise (outcome levels, ratios, scores,
 * percentages and amounts without a baseline, values that are not plain numbers, a target ≤ 0).
 */
export function indicatorProgress(indicator: {
  level: string;
  unit?: string | null;
  baselineValue?: string | null;
  targetValue?: string | null;
  currentValue?: string | null;
}): IndicatorProgress | null {
  const fromBaseline = progressTowardTarget(indicator.baselineValue, indicator.targetValue, indicator.currentValue);
  if (fromBaseline !== null) return { percent: fromBaseline, noBaseline: false };
  const hasBaseline = (indicator.baselineValue ?? '').trim() !== '';
  if (hasBaseline || !ZERO_START_LEVELS.has(indicator.level) || !isCountUnit(indicator.unit)) return null;
  const t = readFigure(indicator.targetValue);
  const c = readFigure(indicator.currentValue);
  if (t === null || c === null || t.percent || c.percent || t.value <= 0) return null;
  return { percent: Math.round((c.value / t.value) * 100), noBaseline: true };
}

/** A data point for valueTrend. */
export interface TrendPoint {
  value: string | number | null | undefined;
  /** Collection date; only points of an earlier date are compared with the latest. */
  date?: Date | string | null;
  /** Geographic area; only points of the same area (or both without one) are compared. */
  area?: string | null;
}

/** Relative change within which an indicator to maintain counts as stable: 5% of the target (or of the previous value). */
export const MAINTAIN_TOLERANCE = 0.05;

function dateKey(date: Date | string | null | undefined): string | null {
  if (date === null || date === undefined) return null;
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  return String(date).trim().slice(0, 10) || null;
}

function areaKey(area: string | null | undefined): string {
  return (area ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Trend of the latest value against the one before it (points newest first; plain values or
 * TrendPoints). Values that are not plain numbers are skipped. The earlier value must be of the
 * same geographic area as the latest (both without an area also match) and, when dates are given,
 * of an earlier date, so Gaza is never compared with Hebron and two entries of one day are not a
 * trend. Direction "decrease": a falling value is improving; "maintain": a change within
 * MAINTAIN_TOLERANCE is stagnant (stable), otherwise moving towards the target is improving and
 * anything else declining; any other direction: a rising value is improving. Equal values are
 * stagnant. insufficient_data when there is no pair to compare, or it mixes percentages and
 * proportions.
 */
export function valueTrend(
  pointsNewestFirst: readonly (TrendPoint | string | number | null | undefined)[],
  direction?: string | null,
  target?: string | null,
): ValueTrend {
  const points = pointsNewestFirst
    .map((p): TrendPoint => (typeof p === 'object' && p !== null ? p : { value: p as string | number | null | undefined }))
    .map(p => ({ figure: readFigure(p.value), date: dateKey(p.date), area: areaKey(p.area) }))
    .filter((p): p is { figure: Figure; date: string | null; area: string } => p.figure !== null);
  const latest = points[0];
  if (!latest) return 'insufficient_data';
  const previous = points.slice(1).find(p => p.area === latest.area && (latest.date === null || p.date === null || p.date < latest.date));
  if (!previous || mixesPercentAndProportion([latest.figure, previous.figure])) return 'insufficient_data';

  const now = latest.figure.value;
  const before = previous.figure.value;
  const delta = now - before;

  if (direction === 'maintain') {
    const t = readFigure(target);
    const usableTarget = t !== null && !mixesPercentAndProportion([t, latest.figure, previous.figure]) ? t.value : null;
    const tolerance = Math.abs(usableTarget ?? before) * MAINTAIN_TOLERANCE;
    if (Math.abs(delta) <= tolerance) return 'stagnant';
    if (usableTarget === null) return 'declining';
    return Math.abs(now - usableTarget) < Math.abs(before - usableTarget) ? 'improving' : 'declining';
  }

  if (delta === 0) return 'stagnant';
  const rising = delta > 0;
  return (direction === 'decrease' ? !rising : rising) ? 'improving' : 'declining';
}

// ------------------------------------------------------------ figures in model text

/** One number of a reading, as compared, and whether it is never checked (a year or a single-digit count). */
interface NumberPart {
  key: string;
  ignored: boolean;
}

/**
 * A number found in text, as written, with its possible readings: "1,200.5" has one; "12,5" is read
 * as the numbers 12 and 5 or as the decimal 12.5. The token is verified when every part of one
 * reading is allowed or ignored.
 */
interface NumberToken {
  text: string;
  readings: NumberPart[][];
}

/** A run of digits joined by decimal or thousands separators (after Arabic digits and separators become ASCII). */
const NUMBER_RUN = /\d(?:[\d.,]*\d)?/g;
const CLEAN_NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;
const DECIMAL_COMMA = /^\d+,\d+$/;
const LATIN_LETTER = /[A-Za-z]/;
const PERCENT_AFTER = /^\s?[%\u066A]/;

/** Arabic-Indic digits and separators become ASCII, one character for one, so positions stay the same. */
function asciiNumbers(text: string): string {
  return text
    .replace(ARABIC_DIGIT, ch => {
      const code = ch.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, ',');
}

/** One number as compared: its value as a string ("1,200" → "1200", "12.50" → "12.5"); years and single-digit counts are ignored. */
function numberPart(written: string, percent: boolean): NumberPart | null {
  const number = Number(written.replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  const year = !percent && /^\d{4}$/.test(written) && number >= 1900 && number <= 2100;
  const singleDigit = !percent && !written.includes('.') && number < 10;
  return { key: String(number), ignored: year || singleDigit };
}

/** The readings of a run: one number ("1,200.5"), or its parts when the separators are not a number's ("12,5" → 12 and 5, or 12.5). */
function runReadings(run: string, percent: boolean): NumberPart[][] {
  const parts = (pieces: string[]) => pieces.map(piece => numberPart(piece, percent)).filter((p): p is NumberPart => p !== null);
  if (CLEAN_NUMBER.test(run)) return [parts([run])];
  const readings = [parts(run.split(',').flatMap(piece => (PLAIN_NUMBER.test(piece) ? [piece] : piece.split('.'))).filter(Boolean))];
  if (DECIMAL_COMMA.test(run)) readings.push(parts([run.replace(',', '.')]));
  return readings;
}

/**
 * The numbers in a text. With skipCodes, a number written against a Latin letter is skipped as part
 * of a code ("O1.2", "Q3", "COVID-19").
 */
function numberTokens(text: string, skipCodes: boolean): NumberToken[] {
  const normalised = asciiNumbers(text);
  const tokens: NumberToken[] = [];
  for (const match of normalised.matchAll(NUMBER_RUN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = normalised[start - 1] ?? '';
    if (skipCodes && (LATIN_LETTER.test(before) || (before === '-' && LATIN_LETTER.test(normalised[start - 2] ?? '')))) continue;
    const percentSign = PERCENT_AFTER.exec(normalised.slice(end));
    tokens.push({
      text: text.slice(start, end + (percentSign?.[0].length ?? 0)).trim(),
      readings: runReadings(match[0], percentSign !== null),
    });
  }
  return tokens;
}

/** Normalised values of the allowed figures, cached per array (one list is checked against many sections). */
const allowedCache = new WeakMap<readonly string[], ReadonlySet<string>>();

function allowedValues(allowed: readonly string[]): ReadonlySet<string> {
  const cached = allowedCache.get(allowed);
  if (cached) return cached;
  const values = new Set(allowed.flatMap(figure => numberTokens(figure ?? '', false).flatMap(t => t.readings.flat().map(part => part.key))));
  allowedCache.set(allowed, values);
  return values;
}

/**
 * The numbers in model text that match none of the allowed figures (me-foundations §6: the AI never
 * invents or calculates numbers). Numbers are compared by value after normalisation: ASCII or Arabic
 * digits, thousands separators and decimals ("1,200" = "١٬٢٠٠" = "1200", "12.50" = "12.5"); a % or ٪
 * sign is not compared ("50%" matches 50). `allowed` holds every figure sent to the model, as values
 * or whole texts (values, baselines, targets, computed progress, counts, dates, quoted documents):
 * every number in them is allowed. Not checked: years 1900–2100, single-digit counts and numbers that
 * are part of a code ("O1.2", "Q3"). Returns each unverified number once, as written, in text order.
 */
export function unverifiedFigures(text: string, allowed: readonly string[]): string[] {
  const values = allowedValues(allowed);
  const out: string[] = [];
  for (const token of numberTokens(text ?? '', true)) {
    const verified = token.readings.some(reading => reading.every(part => part.ignored || values.has(part.key)));
    if (!verified && !out.includes(token.text)) out.push(token.text);
  }
  return out;
}
