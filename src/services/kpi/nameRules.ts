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
 * Leading verbs of the Phase 3 hasDirectionalWording (EN): "Increase…", "Improved…", "Reduced…", "To achieve…"; also
 * "Doubling…", "Halving…", "Tripling…" (a change by a factor). A name starting with one states a change, not what is measured.
 */
const LEADING_VERB_EN = /^(?:to\s+)?(?:increas|decreas|reduc|improv|rais|achiev|reach|ensur|enhanc|strengthen|boost|expand|minimi[sz]|maximi[sz]|doubl|halv|tripl)\w*\b/i;

/**
 * Standard indicator names that start with a participle (not a change): WFP's "Reduced Coping Strategies Index (rCSI)",
 * the "Enhanced Vegetation Index (EVI)" and JMP's "improved (drinking) water source(s)" / "improved sanitation". They are
 * exempt from LEADING_VERB_EN only (a number with "%" in them is still flagged).
 */
const STANDARD_TERM_START = /^(?:reduced\s+coping\s+strateg(?:y|ies)\s+index|enhanced\s+vegetation\s+index|improved\s+(?:drinking[\s-]+)?water\s+sources?|improved\s+sanitation)\b/i;

/** What a leading comparative compares when it states a direction: a measure, a common outcome noun or the people counted. */
const COMPARED_EN = '(?:%|per\\s*cent(?:age)?s?|percentages?|proportions?|shares?|numbers?|rates?|levels?|access|use|uptake|coverage'
  + '|incomes?|yields?|consumption|participation|enrol?ment|attendance|retention|resilience|awareness|knowledge|satisfaction'
  + '|productivity|quality|households?|famil(?:y|ies)|people|persons|individuals|women|men|girls|boys|children|youths?|adolescents'
  + '|students|pupils|farmers|beneficiaries|participants|communities|refugees|idps|caregivers|mothers|patients|teachers|workers)';
/**
 * Leading comparatives state a direction: "Higher % of households …", "More households with …", "Fewer children …",
 * "Better access to …" (the comparative followed by what it compares, COMPARED_EN). Names that only start with such a
 * word are not flagged (finisher re-check): "Higher education gross enrolment ratio", "Greater Amman Municipality …",
 * "Better Cotton farmers trained", "Larger farms adopting …", and the threshold "More than one meal per day: …".
 */
const LEADING_COMPARATIVE_EN = new RegExp(`^(?:higher|more|fewer|greater|better|bigger|larger|lower|less)\\s+${COMPARED_EN}(?![\\p{L}\\p{N}])`, 'iu');

/** "target: 3,500", "(target 500)", "target of 3,500", "target = 80%": a target value in the name ("target households" is not). */
const TARGET_VALUE_EN = /(?<![\p{L}])targets?\s*(?:[:=]|of\s+(?:at\s+least\s+)?[0-9٠-٩]|[0-9٠-٩])/iu;

/**
 * A name that starts with a count ("3,500 displaced households …", "At least 3,500 households …"): a target, not an
 * indicator. A number that is part of a compound or a code ("24-hour recall …", "5-year-old children …", "1,000-day
 * window: …", "3W reporting …", "24/7 hotline …") or a duration ("12 months after training: …") is not a count.
 */
const LEADING_NUMBER_EN = new RegExp(`^(?:(?:at\\s+least|no\\s+(?:fewer|less)\\s+than|more\\s+than|over|up\\s+to|a\\s+minimum\\s+of|minimum\\s+of|≥|>)\\s*)?${NUMBER}`
  + `(?![0-9٠-٩۰-۹.,٫٬]|-?\\p{L}|\\/|\\s*(?:years?|months?|weeks?|days?|hours?|minutes?)(?![\\p{L}]))`, 'iu');

/** "500 by (the) end (of …)", "1,200 by 2027": a number with its target date. */
const NUMBER_BY_DATE_EN = new RegExp(`${NUMBER}%?\\s+by\\s+(?:the\\s+)?(?:end\\b|(?:19|20)\\d\\d\\b)`, 'iu');

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

/** Leading Arabic verbal nouns of the Phase 3 hasDirectionalWording ("زيادة…", "تحسين…"; also "مضاعفة…"), after normaliseArabic. */
const LEADING_VERB_AR = /^(?:زيادة|تقليل|خفض|تحسين|رفع|تعزيز|الوصول\s+الي|ضمان|تقليص|مضاعفة)/;

/** Arabic "بنسبة N%" / "إلى N%" (also with بالمئة, بالمائة, في المئة, في المائة), after normaliseArabic. */
const ARABIC_RATE_TARGET = new RegExp(`(?<!\\p{L})و?(?:بنسبة|الي)\\s*${NUMBER}\\s*(?:[%٪]|بالمئة|بالمائة|في\\s+المئة|في\\s+المائة)`, 'u');

/** Arabic "المستهدف: 3500", "(المستهدف 500)", "القيمة المستهدفة: 80%", after normaliseArabic ("الأسر المستهدفة" is not). */
const ARABIC_TARGET_VALUE = new RegExp(`(?<!\\p{L})(?:ال)?مستهدف[ةه]?\\s*(?:[:=]\\s*)?${NUMBER}`, 'u');

/**
 * A name that starts with a count ("3500 أسرة نازحة …", "ما لا يقل عن 3500 أسرة …"), after normaliseArabic; as in
 * LEADING_NUMBER_EN, a compound, code or duration ("24-hour …", "3W …", "24 ساعة …") is not a count. Applied to both names.
 */
const ARABIC_LEADING_NUMBER = new RegExp(`^(?:(?:ما\\s+لا\\s+يقل\\s+عن|علي\\s+الاقل|اكثر\\s+من)\\s*)?${NUMBER}`
  + `(?![0-9٠-٩۰-۹.,٫٬]|-?\\p{L}|\\/|\\s*(?:years?|months?|weeks?|days?|hours?|minutes?|ساعة|ساعات|يوم|أيام|ايام|شهر|أشهر|اشهر|سنة|سنوات)(?![\\p{L}]))`, 'u');

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
  const standardTerm = STANDARD_TERM_START.test(name);
  return (!standardTerm && LEADING_VERB_EN.test(name))
    || (!standardTerm && LEADING_COMPARATIVE_EN.test(name))
    || TARGET_VALUE_EN.test(name)
    || LEADING_NUMBER_EN.test(name)
    || NUMBER_BY_DATE_EN.test(name)
    || CHANGE_TO_OR_BY.test(name)
    || NUMBER_PERCENT.test(name)
    || BY_NUMBER_PERCENT_WORDS.test(name)
    || hasReachWord(name);
}

function arabicHasTargetOrDirection(raw: string): boolean {
  const name = normaliseArabic(raw).replace(/\s+/g, ' ').trim();
  if (!name) return false;
  return LEADING_VERB_AR.test(name) || ARABIC_RATE_TARGET.test(name) || NUMBER_PERCENT.test(name)
    || ARABIC_TARGET_VALUE.test(name) || ARABIC_LEADING_NUMBER.test(name);
}

/**
 * Rule 3 (spec §A4 step 3 "name contains a target or direction"; me-foundations §2: the indicator never contains the
 * target): true when the English or the Arabic name holds
 * - a leading verb of change (EN "Increase…", "Improved…", "Reduced…", "To achieve…", "Doubling…"; AR زيادة، تقليل، خفض،
 *   تحسين، رفع، تعزيز، الوصول إلى، ضمان، تقليص، مضاعفة) or a leading comparative ("Higher % of …", "More households …", "Fewer …"), except
 *   standard names that start with a participle ("Reduced Coping Strategies Index", "Enhanced Vegetation Index",
 *   JMP "improved (drinking) water source", "improved sanitation");
 * - a target value: "target: 3,500", "(target 500)", "target of 80%", Arabic "المستهدف: 3500";
 * - a leading count: "3,500 displaced households …", "At least 3,500 households …", Arabic "3500 أسرة …";
 * - a number with its target date: "500 by end of project", "1,200 by 2027";
 * - "(increase|reduce|decrease|raise|improve)d? to/by" anywhere;
 * - digits followed by "%" or "٪" anywhere (Latin or Arabic-Indic digits), "by N percent", Arabic "بنسبة N%" / "إلى N%";
 * - "reach" as a whole word (not "reached", "reaching", "hard-to-reach" or "hard to reach").
 * Definitional thresholds are not targets and are not flagged (D13): "at least 4 antenatal care visits", "at least 15
 * litres", "aged 6–59 months", "under 5", "up to 5 years", "from 15 to 49". A number in a model-written name that no
 * library text supports is flagged by validate.ts (nameFiguresUnsupported), not here.
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
