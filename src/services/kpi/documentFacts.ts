/**
 * DOCUMENT FACTS: sentences of the project's own uploaded documents that hold a number, each with a kind from cue
 * words (knowledge/kpi-assistant-spec.md §A3 documentFacts; me-foundations §6: baselines and targets only from uploaded
 * documents, by string match; design sections 1.3, 4.3, 6.4, D14). Input text is already redacted and stripped of the
 * AI analysis (documentTextForAi); the analysis is stripped again here, so text after ---AI_ANALYSIS--- is never a fact
 * (rule 14). Every excerpt is a substring of its document's own text: sentences are split only at sentence punctuation
 * followed by whitespace (never inside a number) and long sentences are cut at whitespace, never after a digit, so an
 * excerpt edge never cuts a number. Pure: no prisma, no env (tests/kpiPurity.test.ts).
 */
import { AI_ANALYSIS_MARKER, excerptSupportsValue, normaliseForMatch, stripAiAnalysis } from '../ai/frameworkNormalize';
import type { VerifiedFigure } from '../ai/frameworkNormalize';
import { REDACTION_PLACEHOLDERS } from '../ai/redact';
import type { DocumentFact } from './types';

/** At most 40 facts per context (spec §A3 documentFacts; design 1.3), at most 15 from one document. */
export const MAX_DOCUMENT_FACTS = 40;
export const MAX_FACTS_PER_DOCUMENT = 15;
/** Excerpt length limit (design 1.3); longer sentences are cut at whitespace. */
export const MAX_EXCERPT_CHARS = 300;
/** Shorter segments are headings or table cells, too short to tell what a number means. */
export const MIN_EXCERPT_CHARS = 20;

/** Cue words, matched in normaliseForMatch(excerpt) at word boundaries (EN) or as tokens (AR, after Arabic normalisation). */
export const FACT_CUES: { target: readonly string[]; baseline: readonly string[] } = {
  target: [
    'target', 'targets', 'will', 'by the end', 'expected', 'planned', 'plan', 'plans', 'planning to', 'expect', 'expects',
    'aim', 'aims', 'goal', 'achieve', 'reach', 'intend to', 'intends to', 'intended to', 'at endline', 'by endline',
    'المستهدف', 'هدف', 'سيتم', 'بحلول', 'نهدف', 'الوصول إلى', 'يخطط', 'تخطط', 'نخطط', 'من المخطط', 'من المتوقع', 'يتوقع',
    'نتوقع',
  ],
  baseline: [
    'baseline', 'currently', 'at present', 'as of', 'today', 'survey found', 'assessment found', 'found that', 'stood at',
    'stands at',
    'حاليًا', 'حاليا', 'خط الأساس', 'أظهر المسح', 'أظهرت الدراسة',
  ],
};

// ------------------------------------------------------------------ sentences

/** Line breaks, tabs, form feeds and table cell separators always end a segment. */
const HARD_BREAK = /[\r\n\t\f\v|\u2028\u2029]+/;
/** Sentence punctuation (EN and AR question mark). */
const SENTENCE_END = new Set(['.', '!', '?', '؟']);
/** Closing quotes and brackets that may follow the sentence punctuation ("done." or (done.)). */
const CLOSERS = new Set(['"', "'", '”', '’', '»', ')', ']']);
/** Abbreviations whose full stop never ends a sentence (lower case, without the final "."). */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'approx', 'vs', 'fig', 'figs', 'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'cf', 'al', 'incl', 'ref',
  'ca', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'govt', 'dept',
]);

/** True when the "." at `at` (in `line`) ends a sentence; `next` is the index after the punctuation run. */
function isFullStop(line: string, at: number, next: number): boolean {
  const token = /[\p{L}.]+$/u.exec(line.slice(Math.max(0, at - 24), at))?.[0].replace(/^\.+/, '').toLowerCase() ?? '';
  if (token === '') return true; // after a number, "%" or a bracket: "trained 300." ends a sentence
  if (/^\p{L}$/u.test(token)) return false; // a single letter: an initial or a list label ("J.", "a.")
  if (/^(?:\p{L}\.)+\p{L}$/u.test(token)) return false; // initialisms: e.g, i.e, u.n
  if (token === 'no' || token === 'nos') return !/^\s*\p{Nd}/u.test(line.slice(next)); // "No. 5" vs "the answer was no."
  return !ABBREVIATIONS.has(token);
}

/** Splits one line (no hard breaks) at sentence ends: punctuation (+ closers) followed by whitespace or the line end. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!SENTENCE_END.has(line[i])) continue;
    let j = i;
    while (j + 1 < line.length && (SENTENCE_END.has(line[j + 1]) || CLOSERS.has(line[j + 1]))) j++;
    const after = line[j + 1];
    const run = line.slice(i, j + 1);
    const endsSentence = (after === undefined || /\s/.test(after))
      && !/\.\./.test(run) // an ellipsis written as dots continues the sentence
      && (line[i] !== '.' || isFullStop(line, i, j + 1));
    if (endsSentence) {
      out.push(line.slice(start, j + 1));
      start = j + 1;
    }
    i = j;
  }
  out.push(line.slice(start));
  return out;
}

/**
 * Splits a document's own text into candidate sentences (exported for tests): at line breaks, tabs and "|"; and after
 * ". ! ? ؟" only when followed by whitespace (or the end of the text) and the "." is not part of an abbreviation
 * (e.g., i.e., etc., approx., no., vs., fig., dr., mr., ms., a single letter, or a number before it like "No. 5").
 * Never between digits ("22.5", "1.200", "١٢٫٥" stay whole). ";" does not split (a clause shares its sentence's cue).
 * Segments are trimmed; empty ones are dropped. Each segment is a substring of `text`.
 */
export function splitSentences(text: string): string[] {
  return text.split(HARD_BREAK).flatMap(splitLine).map(s => s.trim()).filter(s => s !== '');
}

// ------------------------------------------------------------------ cue words

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ARABIC_LETTER = /[؀-ۿ]/;
const ARABIC_DIACRITICS = '[ً-ْـ]*';
const ARABIC_VARIANTS: Readonly<Record<string, string>> = { ا: '[اأإآ]', ي: '[يى]', ة: '[ةه]', ه: '[هة]' };
const normaliseArabic = (s: string) => s.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');

/**
 * "target(s)" used as an adjective ("target households", "target areas") describes who is reached, not an intended
 * value: "45% of target households treat water" is context, never a target (me-foundations §6; design M1).
 */
const TARGET_ADJECTIVE_NOUNS = '(?:households?|groups?|populations?|areas?|communit(?:y|ies)|beneficiar(?:y|ies)|schools?'
  + '|localit(?:y|ies)|locations?|villages?|governorates?|municipalit(?:y|ies)|famil(?:y|ies)|people|persons?|individuals?'
  + '|children|women|men|girls?|boys?|youths?|farmers?|participants?|sites?|facilit(?:y|ies)|districts?|camps?|regions?'
  + '|neighbou?rhoods?|caregivers?|students?|teachers?|audiences?|crops?)';

/** Extra guards per English cue (beyond word boundaries). */
const CUE_GUARDS: Readonly<Record<string, { before?: string; after?: string }>> = {
  target: { after: `(?!\\s+${TARGET_ADJECTIVE_NOUNS}(?![\\p{L}\\p{N}]))` },
  targets: { after: `(?!\\s+${TARGET_ADJECTIVE_NOUNS}(?![\\p{L}\\p{N}]))` },
  // "hard-to-reach areas" describes where people live, not an intended value.
  reach: { before: '(?<!hard[\\s-]to[\\s-])' },
  // The verb only ("plans to train 600"): the noun ("the 2025 response plan", "the work plan foresees") is context.
  plan: { after: '(?=\\s+to(?![\\p{L}\\p{N}]))' },
  plans: { after: '(?=\\s+to(?![\\p{L}\\p{N}]))' },
  // "planned" as a verb ("are planned to be trained", "Planned: 600"), not before a noun ("the 12 planned water points":
  // only that number is planned, PLANNED_BEFORE_NOUN), which would make every value of its clause a target.
  planned: { after: `(?!\\s+(?!${'(?:to|for|by|in|at|as|and|or|with|under|until|before|after|during|over|from|on|is|are|was|were)'}(?![\\p{L}\\p{N}]))\\p{L})` },
};

/**
 * The pattern of one FACT_CUES entry in normaliseForMatch(text): English cues at word boundaries (multi-word cues with
 * any whitespace); Arabic cues as tokens, with optional proclitics (و/ف, ب/ل/ك, the article) and any diacritics,
 * hamza and alif-maqsura variants, so offsets stay offsets in the normalised text.
 */
function cuePattern(cue: string): RegExp {
  const lower = normaliseForMatch(cue).trim();
  if (!ARABIC_LETTER.test(lower)) {
    const body = lower.split(/\s+/).map(escapeRegExp).join('\\s+');
    const guard = CUE_GUARDS[lower] ?? {};
    return new RegExp(`${guard.before ?? ''}(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])${guard.after ?? ''}`, 'gu');
  }
  const bare = normaliseArabic(lower);
  const body = Array.from(bare)
    .map(ch => (ch === ' ' ? '\\s+' : ARABIC_VARIANTS[ch] ?? escapeRegExp(ch)))
    .join(ARABIC_DIACRITICS);
  const article = bare.startsWith('ال') ? '' : '(?:[اأإآ]ل)?';
  return new RegExp(`(?<!\\p{L})(?:[وف])?(?:[بلك])?${article}${body}(?!\\p{L})`, 'gu');
}

const CUE_PATTERNS: ReadonlyArray<{ kind: 'baseline' | 'target'; cue: string; pattern: RegExp }> = [
  ...FACT_CUES.target.map(cue => ({ kind: 'target' as const, cue, pattern: cuePattern(cue) })),
  ...FACT_CUES.baseline.map(cue => ({ kind: 'baseline' as const, cue, pattern: cuePattern(cue) })),
];

/** A cue word found in an excerpt; start/end are offsets in normaliseForMatch(stripAiAnalysis(excerpt)); `cue` is the FACT_CUES entry. */
export interface FactCue { kind: 'baseline' | 'target'; cue: string; start: number; end: number }

/** Cues in already normalised text (see factCuePositions). */
function cuesIn(text: string): FactCue[] {
  const seen = new Set<string>();
  const out: FactCue[] = [];
  for (const { kind, cue, pattern } of CUE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const key = `${kind}:${start}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, cue, start, end: start + match[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Every FACT_CUES occurrence in the excerpt, in text order (one per position: "حاليًا" and "حاليا" match once).
 * Offsets are in normaliseForMatch(stripAiAnalysis(excerpt)), the text standaloneValueOffsets measures values in, so
 * rules 8–9 can find the cues around a value (valueKindAt; design M1, D14).
 */
export function factCuePositions(excerpt: string): FactCue[] {
  return cuesIn(normaliseForMatch(stripAiAnalysis(excerpt)));
}

// ------------------------------------------------------------------ the kind of one value (rules 8–9, D14)

/** Baseline cues that only date a statement: "currently plans to train 600" states a plan, not a measured value. */
const TIME_CUES: ReadonlySet<string> = new Set(['currently', 'at present', 'as of', 'today', 'حاليًا', 'حاليا']);
/** Target cues that announce a plan or the future. */
const FUTURE_CUES: ReadonlySet<string> = new Set([
  'will', 'plan', 'plans', 'planned', 'planning to', 'expected', 'expect', 'expects', 'aim', 'aims', 'by the end',
  'intend to', 'intends to', 'intended to', 'سيتم', 'بحلول', 'نهدف', 'يخطط', 'تخطط', 'نخطط', 'من المخطط', 'من المتوقع',
  'يتوقع', 'نتوقع',
]);
/** A time cue followed this closely (at most three words, no number between) by a future cue dates the plan. */
const TIME_FUTURE_GAP = /^[^\d]{0,30}$/u;

/**
 * The cues that decide kinds: every cue, except a time cue ("currently", "at present", "as of", "حاليا") followed within
 * three words, with no number between, by a future or plan cue ("currently plans to", "as of now expected"): such a
 * sentence states a plan, so "currently" does not make its numbers baselines.
 */
function effectiveCues(text: string): FactCue[] {
  const cues = cuesIn(text);
  return cues.filter(cue => {
    if (cue.kind !== 'baseline' || !TIME_CUES.has(cue.cue)) return true;
    return !cues.some(f => f.kind === 'target' && FUTURE_CUES.has(f.cue) && f.start >= cue.end
      && TIME_FUTURE_GAP.test(text.slice(cue.end, f.start)) && text.slice(cue.end, f.start).trim().split(/\s+/).filter(Boolean).length <= 3);
  });
}

/** A number in normalised text (with an optional "%"), not glued to a letter or another digit. */
const NUM = '(?<![\\p{L}\\p{N}])\\d+(?:[.,]\\d+)*%?(?!\\d)';
const YEARS = /(?<![\d.,])(?:19\d\d|20\d\d|2100)(?![\d.,])/g;
/** Words of change that make "from X to Y" a baseline-to-target statement (EN; AR after normaliseArabic). */
const CHANGE_WORDS_EN = /(?<!\p{L})(?:increas|rais|rise|rising|rose|risen|reduc|decreas|improv|grow|grew|fall|fell|drop|declin|cut|lower|boost|expand|climb|go|goes|going|move|moving|shift|chang)\p{L}*/u;
const CHANGE_WORDS_AR = /(?:زياد|يزيد|رفع|خفض|تقليل|تحسين|ارتفا|ارتفع|يرتفع|انخفا|انخفض|ينخفض|تقليص|تخفيض|نمو|ينمو)/u;
/** After Y: a duration or age unit makes "from 6 to 59 months" a range, not a change. */
const RANGE_UNIT_AFTER = /^\s*(?:years?|yrs?|months?|weeks?|days?|hours?|minutes?|mins?|km|kilomet\p{L}*|سنة|سنوات|عام|اعوام|أعوام|شهر|شهرا|أشهر|اشهر|يوم|أيام|ايام|ساعة|ساعات|دقيقة|دقائق)(?!\p{L})/u;
/**
 * Before X: an age or range phrase ("aged from 6", "between 15"), as a whole word: "coverage from 60% to 85%",
 * "percentage from", "average from" and "shortage from" are changes, not age ranges.
 */
const RANGE_BEFORE = /(?<!\p{L})(?:aged?|ages|between|بعمر|بين|اعمارهم|أعمارهم)\s*$/u;
/** "the current", "the present", "the existing" before a starting value ("from the current 40% to 70%"). */
const CURRENT_BEFORE = '(?:(?:the\\s+)?(?:current|present|existing)\\s+(?:level\\s+of\\s+|rate\\s+of\\s+)?)?';

const FROM_TO_EN = new RegExp(`(?<!\\p{L})from\\s+(?:(?:a|the)\\s+baseline\\s+(?:value\\s+)?of\\s+)?${CURRENT_BEFORE}(${NUM})([^;]{0,60}?)\\s(?:to|up to)\\s+(?:(?:a|the)\\s+target\\s+of\\s+)?(?:at\\s+least\\s+)?(${NUM})`, 'gu');
const FROM_TO_AR = new RegExp(`(?<!\\p{L})من\\s+(${NUM})([^;]{0,60}?)\\s*(?:إلى|الى|إلي|الي)\\s*(${NUM})`, 'gu');
const UP_FROM_EN = new RegExp(`(?<!\\p{L})(?:up|down|increas\\p{L}*|decreas\\p{L}*|ris\\p{L}*|rose|fall\\p{L}*|fell|drop\\p{L}*|improv\\p{L}*|declin\\p{L}*)\\s+from\\s+(?:(?:a|the)\\s+baseline\\s+(?:value\\s+)?of\\s+)?(${NUM})`, 'gu');
const UP_FROM_AR = new RegExp(`(?:ارتفاعا|ارتفاعًا|انخفاضا|انخفاضًا)\\s+من\\s+(${NUM})`, 'gu');

/** A year as a pattern part (1900–2100). */
const YEAR_PART = '(?:19\\d\\d|20\\d\\d|2100)';
/**
 * What dates a value as a reference point after it: "in 2025", "(2025)", "as of 2025", "during 2025", "at baseline",
 * "in the baseline", "currently", "today", "now", "last year"; group 1 holds the words before it ("households reached"),
 * group 2 or 3 the year when there is one.
 */
const REFERENCE_AFTER = new RegExp(`^((?:\\s+[\\p{L}'-]+){0,4}?)\\s*(?:\\(\\s*(${YEAR_PART})\\s*\\)|(?:in|as\\s+of|during)\\s+(${YEAR_PART})(?!\\d)|at\\s+(?:the\\s+)?baseline|in\\s+the\\s+baseline|currently|today|now|last\\s+year)(?![\\p{L}\\p{N}])`, 'u');
/** "compared with/to", "against", "versus"/"vs", "relative to" X, optionally "a baseline of X" or "a target of X". */
const COMPARATOR_EN = new RegExp(`(?<!\\p{L})(?:compared\\s+(?:with|to)|as\\s+against|against|versus|vs\\.?|relative\\s+to)\\s+(?:(?:a|the)\\s+(baseline|target)\\s+(?:value\\s+|level\\s+)?of\\s+)?(?:only\\s+|just\\s+)?(${NUM})`, 'gu');
/** "from X in 2025", "from X at baseline", "from X currently" (a starting value without "to Y"). */
const FROM_DATED_EN = new RegExp(`(?<!\\p{L})from\\s+(${NUM})`, 'gu');
/** "from the current X", "from the present X" (a starting value, with or without "to Y"). */
const FROM_CURRENT_EN = new RegExp(`(?<!\\p{L})from\\s+(?:the\\s+)?(?:current|present|existing)\\s+(?:level\\s+of\\s+|rate\\s+of\\s+)?(${NUM})`, 'gu');
/** "X last year", "X the previous year" (at most four words between, no number): a past value, never a target. */
const LAST_YEAR_AFTER = new RegExp(`(${NUM})((?:\\s+[\\p{L}'-]+){0,4}?)\\s+(?:last|the\\s+previous|the\\s+past)\\s+year(?![\\p{L}\\p{N}])`, 'gu');
/** "N planned <noun>" ("the 12 planned water points"): that number is planned; the others of the clause are not. */
const PLANNED_BEFORE_NOUN = new RegExp(`(${NUM})\\s+planned\\s+(?!(?:to|for|by|in|at|as|and|or|with|under|until|before|after|during|over|from|on|is|are|was|were)(?![\\p{L}\\p{N}]))\\p{L}`, 'gu');
/** A value in brackets dated or labelled as the reference: "(45% in 2025)", "(45%, 2025)", "(45% at baseline)". */
const PAREN_REFERENCE = new RegExp(`\\(\\s*(${NUM})\\s*(?:,\\s*(${YEAR_PART})|\\s+(?:in|as\\s+of|during)\\s+(${YEAR_PART})|\\s+at\\s+(?:the\\s+)?baseline)\\s*\\)`, 'gu');
/** A value dated with a year a few words later, no number or punctuation between: "45% in 2025", "1,200 households reached in 2025". */
const DATED_IN = new RegExp(`(${NUM})((?:\\s+[\\p{L}'-]+){0,4}?)\\s+(?:in|during|as\\s+of)\\s+(${YEAR_PART})(?!\\d)`, 'gu');
/** The year a sentence plans for: "by 2027", "by the end of 2027", "بحلول عام 2027". */
const BY_YEAR = new RegExp(`(?:(?<!\\p{L})by\\s+(?:the\\s+end\\s+of\\s+)?|بحلول\\s+(?:عام\\s+|نهاية\\s+(?:عام\\s+)?)?)(${YEAR_PART})(?!\\d)`, 'gu');

/** A value whose kind an explicit pattern states; start/end in the normalised text (the number, with its "%"). 'none': a comparison point that is neither. */
interface ExplicitKind { start: number; end: number; kind: 'baseline' | 'target' | 'none' }

/**
 * The year REFERENCE_AFTER finds after `end` (at most `maxWords` words before it, no number or punctuation between), 0
 * for a reference without a year, null for no reference.
 */
function referenceAfter(text: string, end: number, maxWords: number): number | null {
  const m = REFERENCE_AFTER.exec(text.slice(end, end + 80));
  if (!m || m[1].trim().split(/\s+/).filter(Boolean).length > maxWords) return null;
  const year = m[2] ?? m[3];
  return year ? Number(year) : 0;
}

/**
 * Values whose kind the sentence states explicitly (rules 8–9, D14), in normalised text, first match first:
 * - "from X (…) to Y" (EN) and "من X … إلى Y" (AR) → X baseline, Y target, when the sentence speaks of a change (a change
 *   word, or a baseline or target cue) and it is not a range: no other number than a year between X and Y, X not after
 *   "aged"/"between", Y not followed by a duration or age unit ("aged from 6 to 59 months" is a range);
 * - "up/down from X", "increased/rose/fell from X", "ارتفاعًا من X" → X baseline;
 * - a comparison point (SPEC-2): "compared with/against/versus a baseline of X" → baseline, "… a target of X" → target;
 *   "compared with X in 2025 / at baseline / today" → baseline (unless the sentence plans "by" that year or earlier);
 *   any other "compared with X" → none (a national average or a comparison group is neither);
 * - "from X in 2025 / at baseline / currently" without "to Y" → X baseline;
 * - "(X in 2025)", "(X, 2025)", "(X at baseline)" after another number of the sentence → X baseline;
 * - in a sentence that plans "by <year>": a value dated "in <earlier year>" ("stood at 45% in 2025 and is expected to
 *   reach 75% by 2027") → baseline; in a sentence with a target cue and values dated in two different years, the
 *   earlier-dated values → baseline.
 */
function explicitValueKinds(text: string): ExplicitKind[] {
  const out: ExplicitKind[] = [];
  const arabic = normaliseArabic(text);
  const changeContext = CHANGE_WORDS_EN.test(text) || CHANGE_WORDS_AR.test(arabic) || cuesIn(text).length > 0;
  const fromTo = (pattern: RegExp) => {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      const [whole, x, middle, y] = m;
      const xStart = at + whole.indexOf(x); // X is the first number of the match
      const yStart = at + whole.length - y.length; // Y ends the match
      const yEnd = yStart + y.length;
      if (!changeContext || /[.!?؟]\s/.test(middle) || /\d/.test(middle.replace(YEARS, ' ')) || isYear(x) || isYear(y)) continue;
      if (RANGE_BEFORE.test(text.slice(Math.max(0, at - 20), at)) || RANGE_UNIT_AFTER.test(text.slice(yEnd, yEnd + 20))) continue;
      out.push({ start: xStart, end: xStart + x.length, kind: 'baseline' }, { start: yStart, end: yEnd, kind: 'target' });
    }
  };
  fromTo(FROM_TO_EN);
  fromTo(FROM_TO_AR);
  const add = (start: number, value: string, kind: ExplicitKind['kind']) => {
    if (isYear(value) || out.some(o => o.start === start)) return;
    out.push({ start, end: start + value.length, kind });
  };
  for (const pattern of [UP_FROM_EN, UP_FROM_AR]) {
    for (const m of text.matchAll(pattern)) add((m.index ?? 0) + m[0].lastIndexOf(m[1]), m[1], 'baseline');
  }

  const plannedYears = Array.from(text.matchAll(BY_YEAR), m => Number(m[1]));
  const latestPlanned = plannedYears.length > 0 ? Math.max(...plannedYears) : null;
  /** A reference dated `year` (0: no year) is a baseline unless the sentence plans for that year or an earlier one. */
  const pastReference = (year: number) => year === 0 || plannedYears.every(y => y > year);

  for (const m of text.matchAll(COMPARATOR_EN)) {
    const value = m[2];
    const start = (m.index ?? 0) + m[0].length - value.length;
    if (m[1] === 'baseline' || m[1] === 'target') {
      add(start, value, m[1]);
      continue;
    }
    const year = referenceAfter(text, start + value.length, 4);
    add(start, value, year !== null && pastReference(year) ? 'baseline' : 'none');
  }
  for (const m of text.matchAll(FROM_DATED_EN)) {
    const start = (m.index ?? 0) + m[0].length - m[1].length;
    const year = referenceAfter(text, start + m[1].length, 0);
    if (year !== null && pastReference(year)) add(start, m[1], 'baseline');
  }
  for (const m of text.matchAll(FROM_CURRENT_EN)) add((m.index ?? 0) + m[0].length - m[1].length, m[1], 'baseline');
  for (const m of text.matchAll(LAST_YEAR_AFTER)) {
    if (!/\d/.test(m[2])) add(m.index ?? 0, m[1], 'baseline');
  }
  for (const m of text.matchAll(PLANNED_BEFORE_NOUN)) add(m.index ?? 0, m[1], 'target');
  for (const m of text.matchAll(PAREN_REFERENCE)) {
    const start = (m.index ?? 0) + m[0].indexOf(m[1]);
    const year = Number(m[2] ?? m[3] ?? 0);
    const numberBefore = Array.from(text.slice(0, m.index ?? 0).matchAll(NUMBER_TOKEN)).some(n => !isYear(n[0]));
    if (numberBefore && pastReference(year)) add(start, m[1], 'baseline');
  }

  const dated = Array.from(text.matchAll(DATED_IN), m => ({ start: m.index ?? 0, value: m[1], year: Number(m[3]) }))
    .filter(d => !isYear(d.value));
  const datedYears = Array.from(new Set(dated.map(d => d.year)));
  const targetCue = cuesIn(text).some(c => c.kind === 'target');
  const earliest = datedYears.length > 0 ? Math.min(...datedYears) : null;
  for (const d of dated) {
    if (latestPlanned !== null && d.year < latestPlanned) add(d.start, d.value, 'baseline');
    else if (latestPlanned === null && targetCue && datedYears.length > 1 && d.year === earliest) add(d.start, d.value, 'baseline');
  }
  return out;
}

/** Clause breaks in normalised text: ";", ", ", " - ", and the conjunctions but, while, whereas, although, however (EN, AR). */
const CLAUSE_BREAK = /;|,\s|\s-\s|\s(?:but|while|whereas|although|however)\s|\s(?:بينما|لكن|ولكن)\s/gu;

/** [start, end) of the clause around [start, end) of normalised text. */
function clauseAround(text: string, start: number, end: number): [number, number] {
  let from = 0;
  let to = text.length;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    const at = m.index ?? 0;
    if (at + m[0].length <= start) from = at + m[0].length;
    else if (at >= end) {
      to = at;
      break;
    }
  }
  return [from, to];
}

/** The cues nearest before `start` (all ending at the same offset), or []. */
function nearestBefore(cues: readonly FactCue[], start: number): FactCue[] {
  const before = cues.filter(c => c.end <= start);
  if (before.length === 0) return [];
  const nearest = Math.max(...before.map(c => c.end));
  return before.filter(c => c.end === nearest);
}

/** The cues nearest after `end` (all starting at the same offset), or []. */
function nearestAfter(cues: readonly FactCue[], end: number): FactCue[] {
  const after = cues.filter(c => c.start >= end);
  if (after.length === 0) return [];
  const nearest = Math.min(...after.map(c => c.start));
  return after.filter(c => c.start === nearest);
}

/** One kind for a set of equally near cues; null when they disagree; undefined for none. */
function kindOf(cues: readonly FactCue[]): 'baseline' | 'target' | null | undefined {
  if (cues.length === 0) return undefined;
  const kinds = new Set(cues.map(c => c.kind));
  return kinds.size === 1 ? cues[0].kind : null;
}

/** Words that link another clause or subject: a plan cue after one of them is not the value's own verb. */
const LINK_WORD = /(?<![\p{L}])(?:and|or|but|which|that|who|whom|whose|where|while|so|then|than|و|التي|الذي|الذين|بينما)(?![\p{L}])/u;
/** At most this many words between a value and the plan cue that is its own verb ("600 young people are planned"). */
const MAX_OWN_VERB_WORDS = 6;

/**
 * SPEC-2: a time cue ("currently", "as of", "at present", "حاليا") before a value is only a date. When the value's own
 * verb, later in its clause, is a plan or future cue ("As of the end of year two 450 graduates will have found work";
 * "Currently 600 young people are planned to be trained"), the value is a target: no number, no linking word (and,
 * which, that, while…) and at most six words between the value and that cue.
 */
function planVerbAfterTimeCue(text: string, clauseCues: readonly FactCue[], before: readonly FactCue[], end: number): boolean {
  if (before.length === 0 || !before.every(c => c.kind === 'baseline' && TIME_CUES.has(c.cue))) return false;
  const verb = clauseCues.filter(c => c.kind === 'target' && FUTURE_CUES.has(c.cue) && c.start >= end).sort((a, b) => a.start - b.start)[0];
  if (!verb) return false;
  const between = text.slice(end, verb.start);
  return !/\d/.test(between) && !LINK_WORD.test(between) && between.trim().split(/\s+/).filter(Boolean).length <= MAX_OWN_VERB_WORDS;
}

/**
 * The kind the cues of the value's own clause give [start, end): the nearest cue before it (a label: "baseline 45%",
 * "will train 600"; a time cue yields to the value's own plan verb, planVerbAfterTimeCue), else, unless `labelsOnly`,
 * the nearest cue after it (a verb of its clause: "45% currently treat water"); with `labelsOnly`, only a cue at most
 * two words after it, no number between ("45% at baseline", "70% at endline"). Null when equally near cues disagree;
 * undefined when no cue decides.
 */
function clauseCueKind(text: string, cues: readonly FactCue[], start: number, end: number, labelsOnly: boolean): 'baseline' | 'target' | null | undefined {
  const [from, to] = clauseAround(text, start, end);
  const clauseCues = cues.filter(c => c.start >= from && c.end <= to);
  const before = nearestBefore(clauseCues, start);
  if (before.length > 0) return planVerbAfterTimeCue(text, clauseCues, before, end) ? 'target' : kindOf(before);
  const after = nearestAfter(clauseCues, end);
  if (after.length === 0) return undefined;
  if (labelsOnly) {
    const gap = text.slice(end, after[0].start);
    if (/\d/.test(gap) || gap.trim().split(/\s+/).filter(Boolean).length > 2) return undefined;
  }
  return kindOf(after);
}

/**
 * The kind of the value at [start, end) of normaliseForMatch(stripAiAnalysis(excerpt)) (rules 8–9, D14; design M1), the
 * offsets standaloneValueOffsets returns:
 * 1. an explicit pattern (explicitValueKinds): "from 30% at baseline to 60%" → 30% baseline, 60% target; "75%, up from
 *    45%" → 45% baseline; "compared with 45% in 2025" → baseline; a comparison point that is neither → null;
 * 2. the nearest cue in the value's own clause (CLAUSE_BREAK), before it first (a time cue yields to the value's own
 *    plan verb), then after it (effectiveCues: "currently plans to train 600" is a plan);
 * 3. the nearest cue in the whole excerpt, before it first, then after it.
 * Null when nothing decides or two cues of different kinds are equally near.
 */
export function valueKindAt(excerpt: string, start: number, valueEnd: number): 'baseline' | 'target' | null {
  const text = normaliseForMatch(stripAiAnalysis(excerpt));
  const [, end] = valueRange(text, start, valueEnd);
  const explicit = explicitKindAt(text, start, end);
  if (explicit) return explicit.kind === 'none' ? null : explicit.kind;
  const cues = effectiveCues(text);
  const inClause = clauseCueKind(text, cues, start, end, false);
  if (inClause !== undefined) return inClause;
  const before = nearestBefore(cues, start);
  return (before.length > 0 ? kindOf(before) : kindOf(nearestAfter(cues, end))) ?? null;
}

/**
 * The kind the excerpt itself states for the value at [start, end), for a figure the structure step already verified
 * with a kind (framework generation, D14; Phase 3 parity): an explicit pattern, the nearest cue before it in its clause,
 * or a cue right after it ("45% at baseline"). A cue further after it in its clause ("stood at 45% in 2025 and is
 * expected to reach 75%") is a verb of another value and does not override the verified kind. Null when the excerpt
 * states no kind for this value (the verified kind stands) or states neither.
 */
export function statedValueKindAt(excerpt: string, start: number, valueEnd: number): 'baseline' | 'target' | 'none' | null {
  const text = normaliseForMatch(stripAiAnalysis(excerpt));
  const [, end] = valueRange(text, start, valueEnd);
  const explicit = explicitKindAt(text, start, end);
  if (explicit) return explicit.kind;
  return clauseCueKind(text, effectiveCues(text), start, end, true) ?? null;
}

/** [start, end) of the value: an empty range (only a start given) covers the number written at `start`. */
function valueRange(text: string, start: number, end: number): [number, number] {
  if (end > start) return [start, end];
  const number = /^\d+(?:[.,]\d+)*%?/.exec(text.slice(start));
  return [start, start + (number ? number[0].length : 0)];
}

/** The explicit pattern covering [start, end) of normalised text, if any. */
function explicitKindAt(text: string, start: number, end: number): ExplicitKind | undefined {
  return explicitValueKinds(text).find(x => x.start < Math.max(end, start + 1) && start < x.end);
}

/** True when the excerpt holds a cue (after effectiveCues) or an explicit pattern: then valueKindAt decides every value. */
export function hasKindEvidence(excerpt: string): boolean {
  const text = normaliseForMatch(stripAiAnalysis(excerpt));
  return effectiveCues(text).length > 0 || explicitValueKinds(text).length > 0;
}

// ------------------------------------------------------------------ numbers and verified targets

/** A number in normalised text (ASCII digits; separators inside), not glued to a letter ("o1.2" is a code). */
const NUMBER_TOKEN = /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*%?/gu;

const isYear = (token: string) => /^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100;

/** True when the text holds a number that is not a year 1900–2100 on its own. */
function hasFactNumber(text: string): boolean {
  for (const [token] of normaliseForMatch(text).matchAll(NUMBER_TOKEN)) {
    if (!isYear(token)) return true;
  }
  return false;
}

/**
 * A verified target is a usable pointer only when it holds a figure worth checking (like documentParser's check: not a
 * year, and at least 10, or a percentage or a decimal): a bare "3" would mark unrelated sentences as targets.
 */
function usableTargetFigures(target: string): string[] {
  const figures = Array.from(normaliseForMatch(target).matchAll(NUMBER_TOKEN), m => m[0]).filter(f => !isYear(f));
  return figures.some(f => /[%.]/.test(f) || Number(f.replace(/,/g, '')) >= 10) ? figures : [];
}

/** The excerpt holds the verified target: written as given, or every non-year figure of it standing alone. */
function containsVerifiedTarget(excerpt: string, target: string): boolean {
  const figures = usableTargetFigures(target);
  if (figures.length === 0) return false;
  return excerptSupportsValue(excerpt, target) || figures.every(f => excerptSupportsValue(excerpt, f));
}

// ------------------------------------------------------------------ kinds, ranking

/**
 * 'target' (only target cues or explicit target values, or the segment contains a verified target), 'baseline' (only
 * baseline cues or explicit baseline values), 'mixed' (both: "75%, up from 45%" or "from 30% at baseline to 60%"), null
 * (none: context for the model, never evidence for a baseline or a target). Cues are effectiveCues ("currently plans to"
 * is a plan). Rules 8–9 (D14): each value then takes its own kind (valueKindAt), so a target sentence never supplies a
 * baseline and a baseline sentence never a target.
 */
export function factKind(excerpt: string, verifiedTargets?: readonly string[]): DocumentFact['kind'] {
  const text = normaliseForMatch(stripAiAnalysis(excerpt));
  const cues = effectiveCues(text);
  const explicit = explicitValueKinds(text);
  const target = cues.some(c => c.kind === 'target') || explicit.some(x => x.kind === 'target')
    || (verifiedTargets ?? []).some(t => containsVerifiedTarget(excerpt, t));
  const baseline = cues.some(c => c.kind === 'baseline') || explicit.some(x => x.kind === 'baseline');
  if (target && baseline) return 'mixed';
  if (target) return 'target';
  if (baseline) return 'baseline';
  return null;
}

/** Ranking score: 3 per cue, 5 when a verified target is in the segment, 1 per "%". */
function factScore(excerpt: string, verifiedTargets: readonly string[]): number {
  const cues = factCuePositions(excerpt).length;
  const verified = verifiedTargets.some(t => containsVerifiedTarget(excerpt, t)) ? 5 : 0;
  const percents = (normaliseForMatch(excerpt).match(/%/g) ?? []).length;
  return 3 * cues + verified + percents;
}

/** A number as written in the document (Latin or Arabic-Indic digits, separators inside). */
const RAW_NUMBER = /[0-9٠-٩۰-۹]+(?:[.,٫٬][0-9٠-٩۰-۹]+)*/gu;
/** A cut may follow whitespace only when the character before it is not a digit ("1 200", "45 %" stay whole). */
const canStartAt = (segment: string, at: number) => at === 0
  || (/\s/u.test(segment[at - 1]) && !/\s/u.test(segment[at]) && (at < 2 || !/[\s\p{Nd}]/u.test(segment[at - 2])));
const canEndAt = (segment: string, at: number) => at === segment.length || (/\s/u.test(segment[at]) && !/[\s\p{Nd}]/u.test(segment[at - 1]));

/**
 * The excerpts of one segment (AI-3: a value after character 300 of a long sentence must still reach the facts): the
 * segment itself when it fits MAX_EXCERPT_CHARS; otherwise one window of at most MAX_EXCERPT_CHARS per number that is
 * not a year and not in an earlier window, with the number about two thirds into the window (cue words mostly precede
 * the value). Windows start and end at whitespace that does not follow a digit, so no edge cuts a number such as
 * "1 200" or "45 %"; each is a substring of the segment of at least MIN_EXCERPT_CHARS characters.
 */
function clipExcerpts(segment: string): string[] {
  if (segment.length <= MAX_EXCERPT_CHARS) return [segment];
  const out: string[] = [];
  let coveredUntil = -1;
  for (const m of segment.matchAll(RAW_NUMBER)) {
    const at = m.index ?? 0;
    const numberEnd = at + m[0].length;
    if (numberEnd <= coveredUntil || isYear(normaliseForMatch(m[0]))) continue;
    let start = Math.max(0, at - Math.floor((MAX_EXCERPT_CHARS * 2) / 3));
    while (start < at && !canStartAt(segment, start)) start++;
    if (!canStartAt(segment, start)) continue;
    let end = Math.min(segment.length, start + MAX_EXCERPT_CHARS);
    while (end > numberEnd && !canEndAt(segment, end)) end--;
    if (!canEndAt(segment, end) || end <= numberEnd) continue;
    const excerpt = segment.slice(start, end).trim();
    if (excerpt.length < MIN_EXCERPT_CHARS) continue;
    out.push(excerpt);
    coveredUntil = end;
  }
  return out;
}

const PLACEHOLDERS = Object.values(REDACTION_PLACEHOLDERS);

interface RankedFact { fact: DocumentFact; score: number; docIndex: number; position: number }

const byRank = (a: RankedFact, b: RankedFact) => b.score - a.score || a.docIndex - b.docIndex || a.position - b.position;

/**
 * docs[].text must already be documentTextForAi(parsedText).text and docs[].fileName redacted. verifiedTargets =
 * target strings of aiAnalysis.targetsMentioned with verified === true (pointers only: model output never becomes
 * evidence, it only points at a sentence of the document itself).
 *
 * Algorithm (design 4.3): splitSentences; drop segments holding a redaction placeholder (most likely a personal record)
 * or the AI analysis marker; keep 20–300 characters (longer: one window around each number, clipExcerpts); keep
 * excerpts with a number that is not a year alone; kind = factKind; score = 3 × cues + 5 for a verified target + 1 per "%"; best first (ties in
 * document order); ≤ 15 per document, ≤ 40 in all; repeated excerpts once.
 */
export function extractDocumentFacts(docs: ReadonlyArray<{ id: string; fileName: string; text: string; verifiedTargets?: readonly string[] }>): DocumentFact[] {
  const ranked: RankedFact[] = [];
  const seen = new Set<string>();
  docs.forEach((doc, docIndex) => {
    const verified = (doc.verifiedTargets ?? []).filter(t => typeof t === 'string' && usableTargetFigures(t).length > 0);
    const own: RankedFact[] = [];
    splitSentences(stripAiAnalysis(doc.text)).forEach((segment, position) => {
      if (segment.length < MIN_EXCERPT_CHARS || segment.includes(AI_ANALYSIS_MARKER)) return;
      if (PLACEHOLDERS.some(p => segment.includes(p))) return;
      for (const excerpt of clipExcerpts(segment)) {
        if (!hasFactNumber(excerpt) || seen.has(excerpt)) continue;
        seen.add(excerpt);
        own.push({
          fact: { documentId: doc.id, fileName: doc.fileName, excerpt, kind: factKind(excerpt, verified) },
          score: factScore(excerpt, verified),
          docIndex,
          position,
        });
      }
    });
    ranked.push(...own.sort(byRank).slice(0, MAX_FACTS_PER_DOCUMENT));
  });
  return ranked.sort(byRank).slice(0, MAX_DOCUMENT_FACTS).map(r => r.fact);
}

/**
 * Generation path (design 1.3, 6.4): one fact per quote of the structure step's verified figures (excerpt = quote,
 * fileName = source, documentId ''), with the figures it holds (value, verified kind, result code) so the prompt can
 * name them and rules 8–9 accept only them, of their verified kind unless the value's own clause says otherwise (D14;
 * Phase 3 parity: only verified figures supply document values). Kind: 'mixed' when the quote holds a baseline and a
 * target figure, else the figures' kind. A quote holding a redaction placeholder is left out, as on the request path
 * (extractDocumentFacts: most likely a personal record; docs/SECURITY_SETUP.md).
 */
export function factsFromVerifiedFigures(figures: readonly VerifiedFigure[]): DocumentFact[] {
  const byQuote = new Map<string, DocumentFact & { figures: NonNullable<DocumentFact['figures']> }>();
  for (const f of figures) {
    if (PLACEHOLDERS.some(p => f.quote.includes(p) || f.value.includes(p))) continue;
    const key = `${f.source}\u0000${f.quote}`;
    const figure = { value: f.value, kind: f.kind, resultCode: f.resultCode };
    const fact = byQuote.get(key);
    if (!fact) {
      byQuote.set(key, { documentId: '', fileName: f.source, excerpt: f.quote, kind: f.kind, figures: [figure] });
      continue;
    }
    if (!fact.figures.some(g => g.value === figure.value && g.kind === figure.kind && g.resultCode === figure.resultCode)) fact.figures.push(figure);
    if (fact.kind !== f.kind) fact.kind = 'mixed';
  }
  return Array.from(byQuote.values());
}
