/**
 * Indicator name rules (rules 3–4 of knowledge/kpi-assistant-spec.md §A4 step 3; me-foundations §1 and §2: an
 * indicator states what is measured and never contains its target or direction; design section 1.5 rows 3–4, D13).
 * The only implementation of the directional patterns once the Phase 3 indicatorAlternative.ts is removed. Pure: no
 * prisma, no env (tests/kpiPurity.test.ts).
 */

/** Dash variants (hyphen, non-breaking hyphen, figure dash, en and em dash, minus) read as "-". */
const DASHES = /[‐-―−]/g;

/** Latin or Arabic-Indic digits. */
const DIGIT = '[0-9٠-٩۰-۹]';
/** A number as written in a name: digits with decimal or thousands separators (ASCII or Arabic). */
const NUMBER = `${DIGIT}(?:[0-9٠-٩۰-۹.,٫٬]*${DIGIT})?`;

/**
 * Leading verbs of the Phase 3 hasDirectionalWording (EN): "Increase…", "Improved…", "Reduced…", "To achieve…".
 * A name starting with one states a change, not what is measured.
 */
const LEADING_VERB_EN = /^(?:to\s+)?(?:increas|decreas|reduc|improv|rais|achiev|reach|ensur|enhanc|strengthen|boost|expand|minimi[sz]|maximi[sz])\w*\b/i;

/** "increase(d) to/by", "reduce(d) to/by", … anywhere (spec "increase to", generalised; D13). */
const CHANGE_TO_OR_BY = /\b(?:increase|reduce|decrease|raise|improve)d?\s+(?:to|by)\b/i;

/** Digits followed by a percent sign anywhere (spec "digits followed by %"; also "٪" and Arabic-Indic digits). */
const NUMBER_PERCENT = new RegExp(`${DIGIT}\\s?[%٪]`, 'u');

/** "by 20 percent", "by at least 5 percentage points" (spec "by 20%", written in words). */
const BY_NUMBER_PERCENT_WORDS = new RegExp(`\\bby\\s+(?:at\\s+least\\s+)?${NUMBER}\\s*(?:percent|per\\s+cent|percentage\\s+points?)\\b`, 'iu');

/** "reach" as a whole word (spec "reach"); "reached", "reaching" and "hard-to-reach" are other words. */
const REACH_WORD = /(?<![\p{L}\p{N}-])reach(?![\p{L}\p{N}-])/giu;
/** "hard to reach" / "difficult to reach" describe a population, not a target. */
const HARD_TO_REACH_BEFORE = /(?:hard|difficult)\s+to\s+$/i;

/** Arabic text as compared: no diacritics or tatweel, alif with hamza or madda as bare alif, alif maqsura as yaa. */
function normaliseArabic(text: string): string {
  return text
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

/** Leading Arabic verbal nouns of the Phase 3 hasDirectionalWording ("زيادة…", "تحسين…"), after normaliseArabic. */
const LEADING_VERB_AR = /^(?:زيادة|تقليل|خفض|تحسين|رفع|تعزيز|الوصول\s+الي|ضمان|تقليص)/;

/** Arabic "بنسبة N%" / "إلى N%" (also with بالمئة, بالمائة, في المئة, في المائة), after normaliseArabic. */
const ARABIC_RATE_TARGET = new RegExp(`(?<!\\p{L})و?(?:بنسبة|الي)\\s*${NUMBER}\\s*(?:[%٪]|بالمئة|بالمائة|في\\s+المئة|في\\s+المائة)`, 'u');

function hasReachWord(name: string): boolean {
  for (const match of name.matchAll(REACH_WORD)) {
    const before = name.slice(0, match.index ?? 0);
    if (!HARD_TO_REACH_BEFORE.test(before)) return true;
  }
  return false;
}

function englishHasTargetOrDirection(raw: string): boolean {
  const name = raw.replace(DASHES, '-').replace(/\s+/g, ' ').trim();
  if (!name) return false;
  return LEADING_VERB_EN.test(name)
    || CHANGE_TO_OR_BY.test(name)
    || NUMBER_PERCENT.test(name)
    || BY_NUMBER_PERCENT_WORDS.test(name)
    || hasReachWord(name);
}

function arabicHasTargetOrDirection(raw: string): boolean {
  const name = normaliseArabic(raw).replace(/\s+/g, ' ').trim();
  if (!name) return false;
  return LEADING_VERB_AR.test(name) || ARABIC_RATE_TARGET.test(name) || NUMBER_PERCENT.test(name);
}

/**
 * Rule 3 (spec §A4 step 3 "name contains a target or direction"; me-foundations §2: the indicator never contains the
 * target): true when the English or the Arabic name holds
 * - a leading verb of change (EN "Increase…", "Improved…", "Reduced…", "To achieve…"; AR زيادة، تقليل، خفض، تحسين، رفع،
 *   تعزيز، الوصول إلى، ضمان، تقليص);
 * - "(increase|reduce|decrease|raise|improve)d? to/by" anywhere;
 * - digits followed by "%" or "٪" anywhere (Latin or Arabic-Indic digits), "by N percent", Arabic "بنسبة N%" / "إلى N%";
 * - "reach" as a whole word (not "reached", "reaching", "hard-to-reach" or "hard to reach").
 * Definitional thresholds are not targets and are not flagged (D13): "at least 4 antenatal care visits", "at least 15
 * litres", "aged 6–59 months", "under 5", "up to 5 years", "from 15 to 49".
 */
export function nameHasTargetOrDirection(name: string, nameAr?: string | null): boolean {
  const texts = [name, nameAr ?? ''].filter(t => t.trim() !== '');
  return texts.some(t => englishHasTargetOrDirection(t) || arabicHasTargetOrDirection(t));
}

/** Words that start a second measurement after a conjunction ("… and % with soap", "… and number of …"). */
const MEASUREMENT_HEAD = /^(?:%|percentage of\b|proportion of\b|share of\b|number of\b|rate of\b|average\b|mean\b|level of\b|score\b|ratio\b)/i;
/** Conjunctions that may join two measurements (and/or first, so "and/or" is one conjunction). */
const CONJUNCTION = /\s+(?:and\/or|and|or)\s+/gi;
/** States that are measured on their own ("employed and satisfied"). */
const STATE_WORDS = new Set(['aware', 'satisfied', 'confident', 'able', 'literate']);
/** The name ends with "X and Y" (one word each). */
const ENDS_WITH_PAIR = /(?:^|\s)([\p{L}-]+)\s+and\s+([\p{L}-]+)$/iu;

const isStateWord = (word: string) => {
  const w = word.toLowerCase();
  return w.endsWith('ed') || STATE_WORDS.has(w);
};

/**
 * Rule 4 (spec §A4 step 3 "' and ' joining two measurements"; me-foundations §2: one dimension per indicator), English
 * only: true when (a) the part after " and ", " and/or " or " or " starts with a measurement head (%, percentage of,
 * proportion of, share of, number of, rate of, average, mean, level of, score, ratio) — "% of households with water and
 * % with soap"; or (b) the name ends with "X and Y" where both are states (ending in -ed, or aware, satisfied, confident,
 * able, literate) — "% of youth employed and satisfied". The 63 library names are never flagged (11 hold " and ").
 */
export function isDoubleBarrelled(name: string): boolean {
  const text = name.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!text) return false;
  for (const match of text.matchAll(CONJUNCTION)) {
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (MEASUREMENT_HEAD.test(after)) return true;
  }
  const pair = ENDS_WITH_PAIR.exec(text);
  return pair !== null && isStateWord(pair[1]) && isStateWord(pair[2]);
}

/**
 * Lower case, every run of characters other than letters, digits and "%" as one space, trimmed: the key of the duplicate
 * checks (spec §A4 step 3 "normalised text equal", rule 18; me-foundations §2 rule 9 not duplicated; accept's 409 duplicate).
 */
export function normalisedIndicatorName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();
}
