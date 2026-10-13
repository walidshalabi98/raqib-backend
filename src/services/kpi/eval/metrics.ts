/**
 * Metrics and targets of the KPI evaluation (knowledge/kpi-assistant-spec.md §A8; design section 10.2). The value
 * matching here is written independently of frameworkNormalize/validate (m1), so a validator bug shows up. Pure and
 * env-free.
 */
import type { KpiCallInfo, KpiWarning, ValidatedSuggestion } from '../types';
import type { AssertionResult } from './assertions';

/** §A8 targets (design 10.2). The numbers are the defaults; a run may pass its own. */
export interface EvalTargets {
  /** Share of answers that parsed (success / (success + invalid + truncated)); spec §A8 "100% required". */
  schemaValidity: number;
  /** Spec §A8 "target ≥ 90% across cases". */
  assertionPassRate: number;
  /** Spec §A8 "target ≥ 70% where candidates exist". */
  libraryUsage: number;
  /** Spec §A8 "target 0 after validation". */
  hallucinatedAfter: number;
  /** Document baselines taken from target sentences after validation (D14; design M1): 0. */
  baselinesFromTargetSentences: number;
  /** Standard-threshold targets after validation that are not a recognised threshold of the linked entry (rule 11): 0. */
  thresholdsOutsideList: number;
  /** Spec §A8 "target ≥ 80". */
  avgQuality: number;
  /** Median of result-scope calls must be below this (spec §A8 "result-level call under 15 seconds"). */
  resultLatencyP50Ms: number;
  /** No result-scope call may take this long (BUILD_GUIDE Phase 4 criterion 3 "under 30 seconds"). */
  resultLatencyMaxMs: number;
}

/** The spec §A8 targets (design 10.2), with the BUILD_GUIDE Phase 4 latency limits; summarise uses them by default. */
export const DEFAULT_EVAL_TARGETS: Readonly<EvalTargets> = {
  schemaValidity: 1, assertionPassRate: 0.9, libraryUsage: 0.7, hallucinatedAfter: 0,
  baselinesFromTargetSentences: 0, thresholdsOutsideList: 0, avgQuality: 80, resultLatencyP50Ms: 15_000, resultLatencyMaxMs: 30_000,
};

/** One case of an evaluation run (design 10.3 "cases[]"). */
export interface EvalCaseRun {
  id: string;
  /** Class name and AiError message only; null when the case ran. */
  error: string | null;
  /** Validated suggestions of the framework-scope run (the report drops their drafts). */
  suggestions: ValidatedSuggestion[];
  frameworkWarnings: KpiWarning[];
  assertions: AssertionResult[];
  /** Raw model suggestions before validation. */
  rawCount: number;
  hallucinatedBefore: number;
  hallucinatedAfter: number;
  baselinesFromTargetSentences: number;
  /** Validated standard-threshold targets outside the recognised list (thresholdsOutsideList). */
  thresholdsOutsideList: number;
  /** Candidate ids per result id of the framework-scope run (library usage counts results with ≥ 1 candidate). */
  candidateIdsByResult: Record<string, string[]>;
  /** Calls of the framework-scope run. */
  calls: KpiCallInfo[];
  /** Calls of the result-scope latency check ([] with --no-result-check). */
  resultCalls: KpiCallInfo[];
  /** Raw model suggestions of the result-scope run (output tokens per suggestion); 0 without it. */
  resultRawCount: number;
}

type Latency = { p50Ms: number | null; maxMs: number | null };

/** Summary of a run (design 10.2 summarise; printed by formatSummaryTable). */
export interface EvalSummary {
  status: 'complete' | 'incomplete';
  /** Why the run is incomplete (thrown case, budget stop, result_failed, refused or errored call). */
  incompleteReasons: string[];
  /** Cases summarised (cases a budget stop skipped are not in the run). */
  caseCount: number;
  calls: Record<KpiCallInfo['outcome'], number>;
  /** success / (success + invalid + truncated); null without calls. */
  schemaValidity: number | null;
  assertions: { passed: number; total: number; rate: number | null };
  /** origin 'model' suggestions with a libraryId / origin 'model' suggestions of results with ≥ 1 candidate. */
  libraryUsage: number | null;
  /** Suggestions of the framework-scope runs: origin 'model' and appended accountability indicators. */
  modelSuggestions: number;
  appendedAccountability: number;
  /** Mean qualityScore over origin 'model' suggestions. */
  avgQuality: number | null;
  /** Mean qualityScore of the appended accountability indicators (reported separately). */
  appendedAvgQuality: number | null;
  hallucinatedBefore: number;
  hallucinatedAfter: number;
  baselinesFromTargetSentences: number;
  thresholdsOutsideList: number;
  costUsd: number;
  /** Σ outputTokens of result-scope calls / their raw suggestions; null without result-scope calls. */
  outputTokensPerSuggestion: number | null;
  resultLatency: Latency;
  batchLatency: Latency;
  /** False with --no-result-check: latency was not measured (the latency flag then passes as "not measured"). */
  latencyMeasured: boolean;
  passed: Record<'schemaValidity' | 'assertions' | 'library' | 'hallucinated' | 'baselines' | 'thresholds' | 'quality' | 'latency', boolean>;
}

// ------------------------------------------------------------------ independent value matching (m1)

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Normalised text for the independent match: Arabic-Indic and Persian digits → ASCII, Arabic decimal and thousands
 * separators → "." and ",", Arabic percent → "%", every space-like character → one space, lower case.
 */
function normaliseIndependent(text: string): string {
  let out = '';
  for (const ch of text) {
    const ai = ARABIC_INDIC.indexOf(ch);
    const pe = PERSIAN.indexOf(ch);
    if (ai >= 0) out += String(ai);
    else if (pe >= 0) out += String(pe);
    else if (ch === '٫') out += '.';
    else if (ch === '٬' || ch === '،') out += ',';
    else if (ch === '٪') out += '%';
    else out += ch;
  }
  return out.replace(/[\s\u00a0\u2009\u202f]+/g, ' ').trim().toLowerCase();
}

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';
const isSeparator = (ch: string | undefined) => ch === '.' || ch === ',';

/**
 * Independent of the validator (m1; spec §A8 "value is absent from the documents"): the normalised value (Arabic-Indic
 * digits, separators, case) occurs in a fact excerpt with a non-digit, non-separator character (or the text edge) on
 * both sides. A separator counts only where it joins digits ("22" is not in "22.5%", "4" not in "4,000"), so a value at
 * the end of a sentence ("… is 75.") is still found. Written separately in metrics.ts; shares no code with
 * frameworkNormalize/validate. An empty value is never found.
 */
export function valueInFactsIndependent(value: string, facts: readonly { excerpt: string }[]): boolean {
  const needle = normaliseIndependent(value ?? '');
  if (needle === '') return false;
  for (const fact of facts) {
    const hay = normaliseIndependent(fact.excerpt ?? '');
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      from = at + 1;
      const before = hay[at - 1];
      const after = hay[at + needle.length];
      const joinedBefore = isDigit(needle[0]) && (isDigit(before) || (isSeparator(before) && isDigit(hay[at - 2])));
      const joinedAfter = isDigit(needle[needle.length - 1]) && (isDigit(after) || (isSeparator(after) && isDigit(hay[at + needle.length + 1])));
      if (!joinedBefore && !joinedAfter) return true;
    }
  }
  return false;
}

/**
 * Hallucinated values (spec §A8 "targetBasis = document but the value is absent from the documents"; also baselines):
 * per suggestion, one for a document target and one for a document baseline whose value valueInFactsIndependent does
 * not find. Empty values are not counted (no number was claimed). Used on raw (before) and validated (after) suggestions.
 */
export function hallucinatedTargets(suggestions: readonly { baselineBasis: string; baselineSuggestion: string; targetBasis: string; targetSuggestion: string }[],
  facts: readonly { excerpt: string }[]): number {
  let count = 0;
  for (const s of suggestions) {
    if (s.targetBasis === 'document' && (s.targetSuggestion ?? '').trim() !== '' && !valueInFactsIndependent(s.targetSuggestion, facts)) count += 1;
    if (s.baselineBasis === 'document' && (s.baselineSuggestion ?? '').trim() !== '' && !valueInFactsIndependent(s.baselineSuggestion, facts)) count += 1;
  }
  return count;
}

/** Arabic letter variants folded for the cue lists (alef forms, taa marbuta, alef maqsura, tatweel and diacritics). */
function foldArabic(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064A');
}

/** The metric's own small cue lists (design 10.2), independent of documentFacts.FACT_CUES. */
const TARGET_WORDS_EN = /\b(targets?|targeted|will|aims?|by the end|plans?|planned|intends?|intended)\b/i;
const BASELINE_WORDS_EN = /\b(baseline|currently|survey found)\b/i;
const TARGET_WORDS_AR = ['المستهدف', 'سيتم'].map(foldArabic);
const BASELINE_WORDS_AR = ['خط الأساس'].map(foldArabic);
/** "currently plans to", "as of … will": a date word that introduces a plan is no baseline word. */
const PLAN_AFTER_DATE_WORD = /\b(?:currently|at present|as of)\s+(?:(?!(?:and|which|that|while|but)\b)[\w%,.'-]+\s+){0,6}?(?:plans?|planned|will|expects?|expected|aims?|intends?)\b/gi;

function targetOnlySentence(excerpt: string): boolean {
  const folded = foldArabic(excerpt);
  const target = TARGET_WORDS_EN.test(excerpt) || TARGET_WORDS_AR.some(w => folded.includes(w));
  const baseline = BASELINE_WORDS_EN.test(excerpt.replace(PLAN_AFTER_DATE_WORD, ' ')) || BASELINE_WORDS_AR.some(w => folded.includes(w));
  return target && !baseline;
}

/** Numbers as the metric reads them: ASCII digits (normaliseIndependent), separators inside, an optional "%". */
const METRIC_NUMBER = '\\d+(?:[.,]\\d+)*%?';

/**
 * The roles the metric's own patterns give the numbers of a sentence: "from X … to Y" (X baseline, Y target), "up from
 * X", a dated comparison point ("compared with/against/versus X in 2025, at baseline, today"), "(X in 2025)" after
 * another number, and "X … in 2025" in a sentence that plans "by 2027" (X baseline).
 */
function explicitRoles(excerpt: string): { baselines: string[]; targets: string[] } {
  const text = normaliseIndependent(excerpt);
  const baselines: string[] = [];
  const targets: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\bfrom\\s+(?:(?:a|the)\\s+baseline\\s+of\\s+)?(${METRIC_NUMBER})[^;.]{0,60}?\\sto\\s+(?:at least\\s+)?(${METRIC_NUMBER})`, 'g'))) {
    baselines.push(m[1]);
    targets.push(m[2]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:up|down|rose|fell|increased|decreased)\\s+from\\s+(${METRIC_NUMBER})`, 'g'))) baselines.push(m[1]);
  // A dated comparison point: "compared with 45% in 2025", "against 45% at baseline", "versus 1,200 households reached in 2025".
  const dated = '(?:\\s+[a-z\'-]+){0,4}?\\s*(?:\\((?:19|20)\\d\\d\\)|(?:in|as of|during)\\s+(?:19|20)\\d\\d|at (?:the )?baseline|currently|today|now)\\b';
  for (const m of text.matchAll(new RegExp(`\\b(?:compared (?:with|to)|against|versus|vs\\.?)\\s+(?:(?:a|the) baseline of\\s+)?(${METRIC_NUMBER})(?=${dated})`, 'g'))) baselines.push(m[1]);
  // "(45% in 2025)" after another number.
  for (const m of text.matchAll(new RegExp(`\\d[^(]*\\(\\s*(${METRIC_NUMBER})\\s+(?:in|at)\\s+(?:(?:19|20)\\d\\d|baseline)\\s*\\)`, 'g'))) baselines.push(m[1]);
  // "45% in 2025 … by 2027": a value dated before the year the sentence plans for.
  const planned = Array.from(text.matchAll(/\bby (?:the end of )?((?:19|20)\d\d)\b/g), m => Number(m[1]));
  if (planned.length > 0) {
    for (const m of text.matchAll(new RegExp(`(${METRIC_NUMBER})(?:\\s+[a-z'-]+){0,4}?\\s+(?:in|during)\\s+((?:19|20)\\d\\d)\\b`, 'g'))) {
      if (Number(m[2]) < Math.max(...planned) && !/^(?:19|20)\d\d$/.test(m[1])) baselines.push(m[1]);
    }
  }
  return { baselines, targets };
}

/**
 * Document baselines taken from target sentences (D14; design M1, 10.2): validated suggestions with baselineBasis
 * 'document' whose value occurs (independent match) only in excerpts where it is a target: the Y of "from X … to Y", or
 * a sentence that contains a target word (target, will, aim, plan, by the end, المستهدف, سيتم) and no baseline word
 * (baseline, currently, survey found, خط الأساس; "currently plans", "as of … will", "currently intends" are plans) where
 * explicitRoles does not make the value a baseline. Its own small lists and patterns.
 */
export function baselinesFromTargetSentences(suggestions: readonly ValidatedSuggestion[], facts: readonly { excerpt: string }[]): number {
  let count = 0;
  for (const s of suggestions) {
    if (s.baselineBasis !== 'document' || (s.baselineSuggestion ?? '').trim() === '') continue;
    const value = normaliseIndependent(s.baselineSuggestion);
    const holding = facts.filter(f => valueInFactsIndependent(s.baselineSuggestion, [f]));
    const fromTarget = (excerpt: string) => {
      const roles = explicitRoles(excerpt);
      if (roles.targets.includes(value)) return true;
      if (roles.baselines.includes(value)) return false;
      return targetOnlySentence(excerpt);
    };
    if (holding.length > 0 && holding.every(f => fromTarget(f.excerpt))) count += 1;
  }
  return count;
}

/** The recognised standard thresholds the metric accepts (its own list: Sphere water minimum and aim on WA-01). */
const RECOGNISED_THRESHOLDS: Readonly<Record<string, readonly string[]>> = { 'WA-01': ['15', '20'] };

/**
 * Standard-threshold targets outside the recognised list (rule 11; me-foundations §6 (c)): validated suggestions with
 * targetBasis 'standard_threshold' whose value is not one number of RECOGNISED_THRESHOLDS for their libraryId (a recall
 * period, a score cut-off, a year or a code copied as a "threshold"). Its own list, independent of standardThresholds.ts.
 */
export function thresholdsOutsideList(suggestions: readonly { libraryId: string | null; targetBasis: string; targetSuggestion: string }[]): number {
  let count = 0;
  for (const s of suggestions) {
    if (s.targetBasis !== 'standard_threshold' || (s.targetSuggestion ?? '').trim() === '') continue;
    const numbers = normaliseIndependent(s.targetSuggestion).match(/\d+(?:[.,]\d+)*%?/g) ?? [];
    const allowed = RECOGNISED_THRESHOLDS[(s.libraryId ?? '').trim().toUpperCase()] ?? [];
    if (numbers.length !== 1 || !allowed.includes(numbers[0])) count += 1;
  }
  return count;
}

/** People words of the eval's own (me-foundations §2.7 "any indicator counting or measuring people"), EN. */
const PEOPLE_EN = /\b(people|persons?|individuals?|households?|famil(?:y|ies)|women|woman|men|man|girls?|boys?|child(?:ren)?|adolescents?|infants?|newborns?|babies|mothers?|youths?|young people|students?|pupils?|learners?|teachers?|staff|employees?|workers?|volunteers?|members?|residents?|citizens?|parents?|caregivers?|entrepreneurs?|farmers?|smallholders?|herders?|participants?|beneficiar(?:y|ies)|recipients?|trainees?|graduates?|patients?|refugees?|idps?|displaced|returnees?|migrants?|survivors?|orphans?|widows?)\b/i;
/** Arabic people stems (after foldArabic): persons, households and families, women, children, adolescents, youth, students … */
const PEOPLE_AR = ['اشخاص', 'افراد', 'اسر', 'اسره', 'عائلات', 'عائله', 'نساء', 'امراه', 'رجال', 'اطفال', 'طفل', 'مراهق', 'شباب', 'طلاب', 'طالبات',
  'معلم', 'موظف', 'عمال', 'عاملين', 'مستفيد', 'متدرب', 'خريج', 'مرضي', 'لاجئ', 'نازح', 'عائدين', 'امهات', 'رضع', 'مزارع', 'سكان', 'المشاركين', 'ناجين', 'ناجيات']
  .map(foldArabic);

/** The eval's own stop words for the counted noun phrase after "Number of" / "% of". */
const METRIC_PHRASE_END = /^(?:with|in|at|on|from|for|to|by|of|among|per|under|over|who|that|which|whose|where|aged|using|is|are|was|were|has|have|fully|directly|\p{L}{3,}ing|\p{L}{3,}ed)$/iu;

/**
 * True when the name counts or measures people (the eval's own list, independent of frameworkNormalize.isPeopleLevelIndicator):
 * for "Number of …" / "% of …" names, the last word of the counted phrase (before a preposition, a relative or a verb
 * form after the first word) or a phrase "among <people>"; otherwise any people word (EN, then AR).
 */
export function peopleLevelIndependent(name: string, nameAr?: string | null): boolean {
  const counted = /^(?:number|%|percentage|proportion|share)\s+of\s+(?:the\s+)?(.*)$/i.exec((name ?? '').trim());
  if (counted) {
    const words = counted[1].split(/[\s,;:()]+/).filter(Boolean);
    let last = '';
    for (const [i, word] of words.entries()) {
      if (i > 0 && METRIC_PHRASE_END.test(word)) break;
      if (/^(?:and|or)$/i.test(word)) {
        if (PEOPLE_EN.test(last)) return true;
        continue;
      }
      last = word;
    }
    return PEOPLE_EN.test(last) || /\bheads? of households?\b/i.test(name) || PEOPLE_EN.test(name.split(/\bamong(?:st)?\b/i)[1] ?? '');
  }
  if (PEOPLE_EN.test(name)) return true;
  const folded = foldArabic(nameAr ?? '');
  return PEOPLE_AR.some(w => folded.includes(w));
}

/**
 * A target or direction in a name (the eval's own check, independent of nameRules.ts): a number with "%" or "٪"; "target"
 * followed by ":" or a number; a name starting with a number (or "at least N"); "N by (the) end" or "N by <year>";
 * "increase(d)/reduce(d)/decrease(d)/raise(d)/improve(d) to|by"; a leading verb of change (increase, reduce, improve,
 * achieve, ensure, enhance, strengthen, double, halve, triple; Arabic زيادة، تحسين، خفض، رفع، تعزيز، مضاعفة) except the standard "Reduced Coping
 * Strategies Index", "Enhanced Vegetation Index" and JMP "improved water source/sanitation"; "reach" as a word; a count
 * at the end of the name ("(over 500)", ", between 3,000 and 3,500").
 */
export function nameHasTargetIndependent(name: string, nameAr?: string | null): boolean {
  const en = normaliseIndependent(name ?? '').replace(/[‐-―−]/g, '-');
  const ar = foldArabic(normaliseIndependent(nameAr ?? ''));
  const standard = /^(reduced coping strateg|enhanced vegetation index|improved (drinking[ -]+)?water source|improved sanitation)/.test(en);
  const english = /\d\s?%/.test(en)
    || /\btargets?\s*(:|=|of\s+\d|\d)/.test(en)
    || /^((at least|more than|over|up to)\s+)?\d/.test(en)
    || /\d\s+by\s+(the\s+)?(end\b|(19|20)\d\d\b)/.test(en)
    || /\b(increase|reduce|decrease|raise|improve)d?\s+(to|by)\b/.test(en)
    || (!standard && /^(to\s+)?(increas|reduc|decreas|improv|achiev|ensur|enhanc|strengthen|higher|more|fewer|doubl|halv|tripl)/.test(en))
    || /(^|[^\w-])reach([^\w-]|$)/.test(en.replace(/(hard|difficult)[ -]to[ -]reach/g, ' '));
  const arabic = /\d\s?%/.test(ar) || /^(زياده|تحسين|خفض|رفع|تعزيز|تقليل|مضاعفه)/.test(ar) || /مستهدف[هة]?\s*[:=]?\s*\d/.test(ar) || /^\d/.test(ar);
  return english || arabic || trailingCount(en) || trailingCount(ar);
}

/**
 * A count at the end of a name, after "(", "," or ":" with an optional comparative: "(over 500)", "(above 3,500)",
 * ", between 3,000 and 3,500", ": over 500", "(500 or more)" (years and single digits are not counts).
 */
function trailingCount(text: string): boolean {
  const m = /(?:\(|,|:)\s*(?:over|above|under|below|more than|at least|up to|between|minimum|maximum|about|approximately|اكثر من|اقل من|حوالي|بين)?\s*(\d[\d,.]*)(?:\s*(?:and|to|-|or|و|الي)\s*(\d[\d,.]*))?\s*(?:or more|or less|\+)?\s*\)?\s*$/.exec(text.trim());
  if (!m) return false;
  return [m[1], m[2]].filter((n): n is string => !!n).some(n => !/^(19|20)\d\d$/.test(n) && n.replace(/[,.]/g, '').length > 1);
}

// ------------------------------------------------------------------ summary

/** Median (the lower middle value for an even count) and maximum; nulls for no values. */
function latency(values: readonly number[]): Latency {
  if (values.length === 0) return { p50Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.floor((sorted.length - 1) / 2)], maxMs: sorted[sorted.length - 1] };
}

const mean = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** Rounds to 6 decimals (costs, rates) so sums of floats print and compare cleanly. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The run's summary and target flags (spec §A8; design 10.2):
 * - calls by outcome; schemaValidity = success / (success + invalid + truncated) (a cut-off answer is not valid);
 * - assertionPassRate = passed / all assertion results (a case that threw reports all its assertions as failed);
 * - libraryUsage = origin 'model' suggestions with a libraryId / origin 'model' suggestions of results with ≥ 1
 *   candidate (same suggestions in both); appended accountability suggestions reported separately;
 * - avgQuality over origin 'model' suggestions; hallucinated before (raw) and after (validated); baselines from target
 *   sentences and standard thresholds outside the recognised list after validation; cost = Σ estimatedCostUsd (failed
 *   calls included: the client reports their usage); output tokens per suggestion of the result-scope calls;
 * - latency p50/max of result-scope calls (PASS: p50 < 15 s and max < 30 s) and of framework (batch) calls (reported);
 * - status incomplete when a case threw, the budget stopped the run (opts.budgetReachedAfter), a result got
 *   result_failed or ended without suggestions (result_empty), or a call was refused or errored.
 * opts.resultCheck false (--no-result-check): latency is not measured and its flag passes as "not measured".
 */
export function summarise(cases: readonly EvalCaseRun[], targets: EvalTargets = DEFAULT_EVAL_TARGETS,
  opts: { budgetReachedAfter?: number | null; resultCheck?: boolean } = {}): EvalSummary {
  const allCalls = cases.flatMap(c => [...c.calls, ...c.resultCalls]);
  const calls: Record<KpiCallInfo['outcome'], number> = { success: 0, invalid: 0, truncated: 0, refused: 0, error: 0 };
  for (const call of allCalls) calls[call.outcome] += 1;
  const answered = calls.success + calls.invalid + calls.truncated;
  const schemaValidity = answered === 0 ? null : round6(calls.success / answered);

  const assertionResults = cases.flatMap(c => c.assertions);
  const passedAssertions = assertionResults.filter(a => a.passed).length;
  const assertionRate = assertionResults.length === 0 ? null : round6(passedAssertions / assertionResults.length);

  const model = cases.flatMap(c => c.suggestions.filter(s => s.origin === 'model').map(s => ({ s, c })));
  const appended = cases.flatMap(c => c.suggestions.filter(s => s.origin === 'appended_accountability'));
  const withCandidates = model.filter(({ s, c }) => (c.candidateIdsByResult[s.resultId] ?? []).length > 0);
  const libraryUsage = withCandidates.length === 0 ? null : round6(withCandidates.filter(({ s }) => s.libraryId !== null).length / withCandidates.length);
  const avgQuality = mean(model.map(({ s }) => s.qualityScore));
  const appendedAvgQuality = mean(appended.map(s => s.qualityScore));

  const hallucinatedBefore = cases.reduce((n, c) => n + c.hallucinatedBefore, 0);
  const hallucinatedAfter = cases.reduce((n, c) => n + c.hallucinatedAfter, 0);
  const fromTargets = cases.reduce((n, c) => n + c.baselinesFromTargetSentences, 0);
  const unlistedThresholds = cases.reduce((n, c) => n + (c.thresholdsOutsideList ?? 0), 0);
  const costUsd = round6(allCalls.reduce((n, call) => n + (call.estimatedCostUsd ?? 0), 0));

  const resultCalls = cases.flatMap(c => c.resultCalls);
  const resultRaw = cases.reduce((n, c) => n + c.resultRawCount, 0);
  const outputTokensPerSuggestion = resultCalls.length === 0 || resultRaw === 0
    ? null
    : Math.round(resultCalls.reduce((n, call) => n + call.outputTokens, 0) / resultRaw);
  const resultLatency = latency(resultCalls.map(call => call.latencyMs));
  const batchLatency = latency(cases.flatMap(c => c.calls).map(call => call.latencyMs));
  const latencyMeasured = opts.resultCheck !== false;

  const incompleteReasons: string[] = [];
  const threw = cases.filter(c => c.error !== null).length;
  if (threw > 0) incompleteReasons.push(`${threw} case(s) failed`);
  if (opts.budgetReachedAfter !== undefined && opts.budgetReachedAfter !== null) {
    incompleteReasons.push(`budget reached after ${opts.budgetReachedAfter} case(s)`);
  }
  const failedResults = cases.reduce((n, c) => n + c.frameworkWarnings.filter(w => w.code === 'result_failed').length, 0);
  if (failedResults > 0) incompleteReasons.push(`${failedResults} result(s) failed`);
  const emptyResults = cases.reduce((n, c) => n + c.frameworkWarnings.filter(w => w.code === 'result_empty').length, 0);
  if (emptyResults > 0) incompleteReasons.push(`${emptyResults} result(s) without suggestions`);
  if (calls.refused > 0) incompleteReasons.push(`${calls.refused} call(s) refused`);
  if (calls.error > 0) incompleteReasons.push(`${calls.error} call(s) errored`);
  if (cases.length === 0) incompleteReasons.push('no case ran');

  const latencyPassed = latencyMeasured
    ? resultLatency.p50Ms !== null && resultLatency.maxMs !== null
      && resultLatency.p50Ms < targets.resultLatencyP50Ms && resultLatency.maxMs < targets.resultLatencyMaxMs
    : true;

  return {
    status: incompleteReasons.length === 0 ? 'complete' : 'incomplete',
    incompleteReasons,
    caseCount: cases.length,
    calls,
    schemaValidity,
    assertions: { passed: passedAssertions, total: assertionResults.length, rate: assertionRate },
    libraryUsage,
    modelSuggestions: model.length,
    appendedAccountability: appended.length,
    avgQuality: avgQuality === null ? null : round6(avgQuality),
    appendedAvgQuality: appendedAvgQuality === null ? null : round6(appendedAvgQuality),
    hallucinatedBefore,
    hallucinatedAfter,
    baselinesFromTargetSentences: fromTargets,
    thresholdsOutsideList: unlistedThresholds,
    costUsd,
    outputTokensPerSuggestion,
    resultLatency,
    batchLatency,
    latencyMeasured,
    passed: {
      schemaValidity: schemaValidity !== null && schemaValidity >= targets.schemaValidity,
      assertions: assertionRate !== null && assertionRate >= targets.assertionPassRate,
      library: libraryUsage !== null && libraryUsage >= targets.libraryUsage,
      hallucinated: hallucinatedAfter <= targets.hallucinatedAfter,
      baselines: fromTargets <= targets.baselinesFromTargetSentences,
      thresholds: unlistedThresholds <= (targets.thresholdsOutsideList ?? 0),
      quality: avgQuality !== null && avgQuality >= targets.avgQuality,
      latency: latencyPassed,
    },
  };
}

/** True when the run may exit 0 (design 10.3): complete, and every target passed. */
export function evalPassed(summary: EvalSummary): boolean {
  return summary.status === 'complete' && Object.values(summary.passed).every(Boolean);
}
