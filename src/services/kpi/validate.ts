/**
 * validateAndScore: the deterministic checks around the model's suggestions (knowledge/kpi-assistant-spec.md §A4
 * step 3, rules 1–19; me-foundations §2 quality checklist, §3 reference sheet, §6: the AI never invents numbers;
 * CLAUDE.md rules 5–7; design sections 1.5 and 4.2, D5, D10–D16, D22). Pure: no prisma, no env, no AI client
 * (tests/kpiPurity.test.ts).
 *
 * Every critique fix of the validation (rules 6, 8–9, 12, x3, x5, x6) lives here, never in frameworkNormalize.ts, so
 * framework generation keeps its Phase 3 behaviour where the KPI pipeline does not replace it.
 */
import {
  DEFAULT_TARGET_METHOD, TO_BE_CONFIRMED, codeKey, excerptSupportsValue, isGenericMeansOfVerification, isPercentUnit,
  libraryEntryTexts, normaliseForMatch, normalizeDisaggregation, normalizeIndicator, standaloneValueOffsets,
  standardReferenceLabel, verifyDocumentFigures,
} from '../ai/frameworkNormalize';
import type { IndicatorCreatePayload, VerifiedFigure } from '../ai/frameworkNormalize';
import { unverifiedFigures } from '../ai/indicatorFigures';
import { donorGuidance } from '../ai/prompts/donors';
import { INDICATOR_UNITS } from '../ai/prompts/framework';
import { redactPersonalData } from '../ai/redact';
import { isAccountabilityIndicator, ACCOUNTABILITY_APPEND_ORDER } from './accountability';
import { factCuePositions, type FactCue } from './documentFacts';
import { indicatorDraftFromPayload } from './draft';
import { isDoubleBarrelled, nameHasTargetOrDirection, normalisedIndicatorName } from './nameRules';
import { allowanceFor, exclusionsFor, scopedResults } from './scope';
import { KPI_PENALTIES } from './types';
import type {
  ContextResult, DocumentFact, DocumentText, IndicatorUnit, KpiLibraryEntry, KpiModelAnswer, KpiRawSuggestion,
  KpiWarning, KpiWarningCode, ProjectContext, QualityBand, SuggestionOrigin, ValidatedSuggestion,
} from './types';

// ------------------------------------------------------------------ warnings, score, band

/** Quality bands (spec §A4 step 3): ≥ 85 strong, 65–84 review, < 65 weak. */
export const QUALITY_THRESHOLDS = { strong: 85, review: 65 } as const;

/** Spec §A4 step 3 badge: 85–100 "Strong", 65–84 "Review", below 65 "Weak". */
export function qualityBand(score: number): QualityBand {
  if (score >= QUALITY_THRESHOLDS.strong) return 'strong';
  if (score >= QUALITY_THRESHOLDS.review) return 'review';
  return 'weak';
}

/** Spec §A4 step 3: quality score = 100 minus penalties (floor 0); only the four spec penalties count (KPI_PENALTIES). */
export function qualityScore(warnings: readonly KpiWarning[]): number {
  return Math.max(0, 100 - warnings.reduce((sum, w) => sum + w.penalty, 0));
}

/** English texts of design section 9.6 (the frontend translates by code with params; these are the fallback). */
const WARNING_TEXTS: Readonly<Record<KpiWarningCode, string>> = {
  library_id_unknown: 'Library id {{libraryId}} does not exist, so this is treated as a custom indicator.',
  custom_reason_missing: 'Custom indicator without a reason.',
  target_in_name: 'Move the target out of the name.',
  double_barrelled: 'The name may measure two things at once.',
  percent_without_calculation: 'A percentage needs a numerator and a denominator.',
  sex_keys_from_library: 'Sex disaggregation added from the library entry ({{keys}}).',
  sex_added: 'Sex disaggregation added because the indicator counts people.',
  baseline_not_found: 'The baseline was not found in the documents and was removed (pending baseline).',
  target_not_found: 'The target was not found in the documents; a target-setting method is proposed instead.',
  standard_threshold_not_found: 'The standard threshold was not found in the library entry; a target-setting method is proposed instead.',
  target_method_default: 'The target-setting method was replaced by the default: set after the baseline.',
  output_survey_method: 'Outputs are usually counted from records.',
  impact_not_secondary: 'Impact indicators usually use secondary data.',
  arabic_name_missing: 'The Arabic name is missing.',
  generic_means_of_verification: 'The means of verification is too general; to be confirmed by the M&E officer.',
  figures_unverified: 'Text with numbers not found in the documents or the library was removed: {{figures}}.',
  level_adjusted: 'Level changed to {{level}} to match result {{code}}.',
  arabic_name_from_library: 'The Arabic name was taken from the library entry.',
  model_note: 'AI note: {{message}}',
  unknown_result: 'A suggestion for an unknown result ({{code}}) was dropped.',
  rejected_library_dropped: 'A suggestion using {{libraryId}} was dropped because your organisation rejected it.',
  duplicate_in_run: 'A repeated suggestion for {{code}} was dropped.',
  near_duplicate: '“{{name}}” was dropped because it repeats an existing indicator.',
  result_cap: '{{code}}: kept {{cap}} indicators per result (donor or level limit); {{dropped}} more dropped.',
  accountability_added: 'Humanitarian project without an accountability indicator: {{libraryId}} was added to {{code}}.',
  accountability_missing: 'Humanitarian project without an accountability indicator.',
  result_failed: 'No suggestions for {{code}}: the AI answer could not be used or came too late. Try this result again.',
  keyword_fallback: 'Semantic search is not available, so candidates were matched by keywords.',
  donor_cap_exceeded: '{{code}} now has {{count}} indicators; the donor allows {{cap}}.',
};

/** Info notes (design 1.5 rows marked "info", and keyword_fallback of 4.3); every other code is a warning. */
const INFO_CODES: ReadonlySet<KpiWarningCode> = new Set<KpiWarningCode>([
  'sex_keys_from_library', 'sex_added', 'target_method_default', 'output_survey_method', 'impact_not_secondary',
  'level_adjusted', 'arabic_name_from_library', 'keyword_fallback',
]);

/**
 * Builds a warning (design 4.1, 9.6): message = the English text of design 9.6 with {{param}} filled from `params`,
 * severity info or warning, penalty from KPI_PENALTIES (spec §A4 step 3: only custom_reason_missing 10, target_in_name 15,
 * double_barrelled 10 and percent_without_calculation 15 cost points).
 */
export function warning(code: KpiWarningCode, params: Record<string, string | number> = {}): KpiWarning {
  const message = WARNING_TEXTS[code].replace(/\{\{(\w+)\}\}/g, (_m, key: string) => (key in params ? String(params[key]) : ''));
  return { code, severity: INFO_CODES.has(code) ? 'info' : 'warning', message, params: { ...params }, penalty: KPI_PENALTIES[code] ?? 0 };
}

/** Cosine of two English names, null when unknown (rule 18 near-duplicates). */
export type SimilarityFn = (a: string, b: string) => number | null;

/** What validation reads besides the context (design 4.2); the pipeline builds it from the retrieval result. */
export interface ValidateDeps {
  /** Whole library by id. */
  library: ReadonlyMap<string, KpiLibraryEntry>;
  /** Ids offered to the model (for x5 allowed numbers). */
  candidateIds: ReadonlySet<string>;
  /** Cosine of two EN names, null when unknown. */
  similarity?: SimilarityFn;
}

// ------------------------------------------------------------------ small helpers

const MAX_PARAM_CHARS = 60;
/** Same limit as Indicator.aiRationale (the draft's copy). */
const MAX_RATIONALE_CHARS = 5000;
const MAX_CUSTOM_REASON_CHARS = 2000;
const MAX_QUALITY_NOTES = 5;
const MAX_NOTE_CHARS = 500;
const MAX_MODEL_NOTES = 10;
const MAX_MODEL_NOTE_CHARS = 300;
/** Rule 18: names this similar (cosine of the English names) repeat an existing indicator. */
export const NEAR_DUPLICATE_COSINE = 0.92;

const SEX_KEYS = ['sex', 'sex_of_household_head'] as const;
const ARABIC_LETTER = /[ء-يٱ-ۓ]/;
const UNITS: ReadonlySet<string> = new Set(INDICATOR_UNITS);

const redact = (value: string | null | undefined): string => redactPersonalData((value ?? '').trim()).text.trim();

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trimEnd() : value;
}

/** A model-written value shown in a warning: redacted, one line, at most 60 characters. */
const paramText = (value: string | null | undefined) => clip(redact(value).replace(/\s+/g, ' '), MAX_PARAM_CHARS);

const upperId = (id: string | null | undefined) => (id ?? '').trim().toUpperCase();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Arabic text as compared: no diacritics or tatweel, alif with hamza or madda as bare alif, alif maqsura as yaa. */
function normaliseArabic(text: string): string {
  return text.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
}

// ------------------------------------------------------------------ rules 8–9 (D14): document values

/**
 * Cue positions in a normalised excerpt and the kind of the value at `start` (rules 8–9, D14; design M1): fact.kind
 * 'baseline'/'target' → that kind; 'mixed' → the kind of the nearest cue that ends before `start` (none → null); null →
 * null. Cue positions come from factCuePositions (documentFacts.ts), the same matcher factKind uses, so the fact kind
 * and the per-value kind always agree ("target households" is not a target cue). `start` is an offset in
 * normaliseForMatch(excerpt), as returned by standaloneValueOffsets.
 */
export function valueKindInFact(fact: DocumentFact, start: number): 'baseline' | 'target' | null {
  if (fact.kind === 'baseline' || fact.kind === 'target') return fact.kind;
  if (fact.kind !== 'mixed') return null;
  let nearest: FactCue | null = null;
  for (const cue of factCuePositions(fact.excerpt)) {
    if (cue.end > start) continue;
    if (!nearest || cue.end > nearest.end) nearest = cue;
  }
  return nearest?.kind ?? null;
}

/** The documents an excerpt is checked in: its own document when known, else every document. */
function documentsForFact(fact: DocumentFact, documentTexts: readonly DocumentText[]): DocumentText[] {
  const own = fact.documentId ? documentTexts.filter(d => d.documentId === fact.documentId) : [];
  return own.length > 0 ? own : [...documentTexts];
}

/**
 * The fact that supports `value` as `kind` (rules 8–9, D14; me-foundations §6: copy values found in uploaded documents,
 * citing the document): standalone + unit-consistent (excerptSupportsValue with unitIsPercent), valueKindInFact === kind
 * at that occurrence, and verifyDocumentFigures([{ value, quote: excerpt, kind }], documentTexts) non-empty (the excerpt
 * sits in the full text and the value stands alone there, so a cut excerpt never supplies a cut number). Null otherwise;
 * facts of kind null never count, and a target sentence never supplies a baseline.
 */
export function documentValueSupported(value: string, kind: 'baseline' | 'target', unitIsPercent: boolean,
  facts: readonly DocumentFact[], documentTexts: readonly DocumentText[]): { fact: DocumentFact; source: string } | null {
  if (!value.trim() || documentTexts.length === 0) return null;
  for (const fact of facts) {
    if (fact.kind === null || (fact.kind !== 'mixed' && fact.kind !== kind)) continue;
    if (!excerptSupportsValue(fact.excerpt, value, unitIsPercent)) continue;
    const rightKind = standaloneValueOffsets(fact.excerpt, value)
      .some(o => o.percent === unitIsPercent && valueKindInFact(fact, o.start) === kind);
    if (!rightKind) continue;
    const documents = documentsForFact(fact, documentTexts).map(d => ({ fileName: d.fileName, text: d.text }));
    const verified = verifyDocumentFigures([{ resultCode: null, kind, value: value.trim(), description: '', quote: fact.excerpt }], documents);
    if (verified.length > 0) return { fact, source: verified[0].source };
  }
  return null;
}

/**
 * VerifiedFigures for normalizeIndicator (rules 8–10, D14): one per document value (baseline, target) that
 * documentValueSupported accepts, with the kind of the field and source = the redacted file name; resolveBaselineAndTarget
 * then keeps only these values and cites the file.
 */
export function factsFiguresFor(raw: KpiRawSuggestion, ctx: Pick<ProjectContext, 'documentFacts' | 'documentTexts'>): VerifiedFigure[] {
  const unitIsPercent = isPercentUnit(raw.unit, raw.name);
  const out: VerifiedFigure[] = [];
  const add = (value: string, kind: 'baseline' | 'target') => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const found = documentValueSupported(trimmed, kind, unitIsPercent, ctx.documentFacts, ctx.documentTexts);
    if (found) out.push({ resultCode: raw.resultCode, kind, value: trimmed, description: '', quote: found.fact.excerpt, source: found.source });
  };
  if (raw.baselineBasis === 'document') add(raw.baselineSuggestion, 'baseline');
  if (raw.targetBasis === 'document') add(raw.targetSuggestion, 'target');
  return out;
}

// ------------------------------------------------------------------ rule 12: target-setting methods

/** Relative patterns a baseline method may hold numbers in (rule 12, SDA-02), in normalised text. */
const RELATIVE_FIGURES: readonly RegExp[] = [
  // baseline + 10, baseline ± 5 percentage points, baseline plus 10%
  /baseline\s*(?:\+|±|-|plus|minus)\s*\d[\d.,]*\s*(?:%|percent(?:age points?)?|per cent|pp|points?)?/g,
  // 10 percentage points above the baseline, 10% below baseline, 5 points over the baseline
  /\d[\d.,]*\s*(?:%|percent|per cent|percentage points?|pp|points?)\s*(?:above|below|over|under|higher than|lower than)\s+(?:the\s+)?baseline/g,
  // خط الأساس + 10
  /خط\s*الاساس\s*(?:\+|±|-)\s*\d[\d.,]*\s*%?/g,
  // 10 نقاط مئوية فوق خط الأساس
  /\d[\d.,]*\s*%?\s*(?:نقاط|نقطة)\s*مئوية\s*(?:فوق|دون|اعلي من|اقل من)\s*خط\s*الاساس/g,
];

/** Years 1900–2100 are dates, not figures. */
const YEAR = /(?<![\d.,])(?:19\d\d|20\d\d|2100)(?![\d.,])/g;

/**
 * A "baseline"-based method that also holds a number outside a relative pattern (rule 12, SDA-02; me-foundations §6:
 * a method, never an invented number): "Increase from baseline to 75% by 2027" → true; "baseline + 10 percentage
 * points" → false. Relative patterns: "baseline + N", "baseline ± N", "N percentage points above/below/over the
 * baseline", "N% above/below the baseline", Arabic "N نقاط مئوية فوق/دون خط الأساس"; years 1900–2100 are ignored.
 * A method that does not mention the baseline → false (resolveBaselineAndTarget already replaces it).
 */
export function methodHasAbsoluteFigure(method: string): boolean {
  const text = normaliseArabic(normaliseForMatch(method));
  if (!/baseline/.test(text) && !/خط\s*الاساس/.test(text)) return false;
  let rest = text;
  for (const pattern of RELATIVE_FIGURES) rest = rest.replace(pattern, ' ');
  return /\d/.test(rest.replace(YEAR, ' '));
}

/** "Proposed method: X — confirm after baseline." at the start of a targetJustification written by resolveBaselineAndTarget. */
const PROPOSED_METHOD = /^Proposed method: ([\s\S]*?) — confirm after baseline\./;

// ------------------------------------------------------------------ x5 / x6: figures in model free text

/** Sentence ends: ". ! ? ؟" followed by whitespace, and line breaks (never inside a number such as "22.5"). */
const SENTENCE_BREAK = /(?<=[.!?؟])\s+|\s*\n+\s*/;

/**
 * x5/x6 (me-foundations §6; the riskAnalyzer precedent): removes the sentences holding a figure unverifiedFigures finds
 * (a number of none of the `allowed` texts; years and single digits are not checked); returns the kept text and the
 * removed figures (each once, in text order).
 */
export function withoutUnverifiedSentences(text: string, allowed: readonly string[]): { text: string; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const part of text.split(SENTENCE_BREAK)) {
    const sentence = part.trim();
    if (!sentence) continue;
    const figures = unverifiedFigures(sentence, allowed);
    if (figures.length === 0) {
      kept.push(sentence);
      continue;
    }
    for (const figure of figures) if (!removed.includes(figure)) removed.push(figure);
  }
  return { text: kept.join(' '), removed };
}

function entryTexts(entry: KpiLibraryEntry): string[] {
  return [entry.id, entry.name, entry.nameAr, entry.unit, ...libraryEntryTexts(entry)];
}

/** Allowed figures per context and deps (built once per run; unverifiedFigures caches by array identity). */
const allowedCache = new WeakMap<ProjectContext, WeakMap<ValidateDeps, string[]>>();

/**
 * x5 allowed texts: every number the model was shown (design 1.5 x5, m12): fact excerpts, the candidates' texts, result
 * texts and codes, every PROJECT field as sent (name, donor, description, geographic scope, dates and years, target
 * beneficiaries), donor rules and guidance, existing indicators and the alternatives source.
 */
function allowedFigures(ctx: ProjectContext, deps: ValidateDeps): string[] {
  let byDeps = allowedCache.get(ctx);
  if (!byDeps) {
    byDeps = new WeakMap();
    allowedCache.set(ctx, byDeps);
  }
  const cached = byDeps.get(deps);
  if (cached) return cached;
  const p = ctx.project;
  const source = ctx.alternativesFor;
  const texts = [
    p.name, p.donor, p.description ?? '', p.geographicScope ?? '', p.startDate, p.endDate,
    p.targetBeneficiaries === null ? '' : String(p.targetBeneficiaries),
    ...ctx.resultsChain.flatMap(r => [r.code, r.text, r.textAr ?? '']),
    ...ctx.existingIndicators.flatMap(i => [i.name, i.nameAr ?? '', i.unit ?? '', i.libraryId ?? '']),
    ...ctx.documentFacts.flatMap(f => [f.excerpt, f.fileName]),
    ...ctx.donorRules.requiredFrameworks, ...ctx.donorRules.notes, donorGuidance(ctx.donorRules.donorType),
    String(ctx.donorRules.maxIndicatorsPerResult ?? ''),
    ...(source ? [source.name, source.nameAr ?? '', source.definition ?? '', source.unit ?? '', source.libraryId ?? '', ...source.problems] : []),
    ...Array.from(deps.candidateIds).flatMap(id => {
      const entry = deps.library.get(upperId(id));
      return entry ? entryTexts(entry) : [];
    }),
  ].filter(t => t !== '');
  byDeps.set(deps, texts);
  return texts;
}

/** The allowed figures plus the linked entry's own texts when it was not a candidate. */
function allowedFor(ctx: ProjectContext, deps: ValidateDeps, entry: KpiLibraryEntry | null): readonly string[] {
  const base = allowedFigures(ctx, deps);
  return entry && !deps.candidateIds.has(entry.id) ? [...base, ...entryTexts(entry)] : base;
}

// ------------------------------------------------------------------ one suggestion

/** Exclusions for one result, split by why (rule 1 extension: rejected ids; D12/rule 18: already used on the result). */
function exclusionReason(libraryId: string, ctx: ProjectContext, resultId: string): 'rejected' | 'repeat' | null {
  if (!exclusionsFor(ctx, resultId).has(libraryId)) return null;
  return ctx.orgPreferences.rejectedLibraryIds.some(id => upperId(id) === libraryId) ? 'rejected' : 'repeat';
}

/** The rationale sentence of rule 19's appended indicator (no figures; x5-safe). */
const ACCOUNTABILITY_RATIONALE = 'Humanitarian projects need an indicator of accountability to affected people, and none was suggested or exists in this framework.';

/**
 * Rules x1, 1–16, x2–x5 for one suggestion (design 1.5 and the eight steps of 4.2): unknown or out-of-scope result →
 * dropped (x1); an excluded library id → dropped (rejected_library_dropped for the organisation's rejections,
 * near_duplicate when it repeats an indicator or suggestion already on the result); model free text redacted (CLAUDE.md
 * rule 5) and stripped of unverified figures (x5); document values checked by factsFiguresFor (rules 8–9, D14); the payload
 * from normalizeIndicator with empty model method and date fields (D22); then rule 6 (D16), rule 12 and x3 here.
 */
export function validateSuggestion(raw: KpiRawSuggestion, ctx: ProjectContext, deps: ValidateDeps,
  meta: { rank: number; origin?: SuggestionOrigin }): { suggestion: ValidatedSuggestion } | { dropped: KpiWarning } {
  // x1: the result must be one of the scoped results (codes are unique by codeKey in the context).
  const key = codeKey(raw.resultCode ?? '');
  const result = key ? scopedResults(ctx).find(r => codeKey(r.code) === key) : undefined;
  if (!result) return { dropped: warning('unknown_result', { code: paramText(raw.resultCode) }) };

  // Rule 1 (extension): an excluded library id drops the whole suggestion (keeping it as custom would undo the rejection).
  const rawLibraryId = upperId(raw.libraryId);
  const exclusion = rawLibraryId ? exclusionReason(rawLibraryId, ctx, result.id) : null;
  if (exclusion === 'rejected') return { dropped: warning('rejected_library_dropped', { libraryId: paramText(rawLibraryId) }) };
  const knownEntry = rawLibraryId ? deps.library.get(rawLibraryId) ?? null : null;
  if (exclusion === 'repeat') return { dropped: warning('near_duplicate', { name: paramText(raw.name) || paramText(knownEntry?.name) }) };

  const warnings: KpiWarning[] = [];

  // Step 3: model free text redacted; x5 on rationale, customReason, qualityNotes; definition and MoV cleared when unverified.
  const allowed = allowedFor(ctx, deps, knownEntry);
  const removedFigures: string[] = [];
  const noteRemoved = (figures: string[]) => {
    for (const f of figures) if (!removedFigures.includes(f)) removedFigures.push(f);
  };
  const cleanSentences = (value: string) => {
    const out = withoutUnverifiedSentences(redact(value), allowed);
    noteRemoved(out.removed);
    return out.text;
  };
  const clearIfUnverified = (value: string) => {
    const text = redact(value);
    const figures = unverifiedFigures(text, allowed);
    noteRemoved(figures);
    return figures.length > 0 ? '' : text;
  };
  const name = redact(raw.name) || knownEntry?.name || '';
  const nameAr = redact(raw.nameAr);
  const rationale = clip(cleanSentences(raw.rationale), MAX_RATIONALE_CHARS);
  // A valid library id makes the suggestion a library one (rule 2): its custom reason is cleared, not checked.
  const linked = rawLibraryId !== '' && deps.library.has(rawLibraryId);
  const customReason = linked ? '' : clip(cleanSentences(raw.customReason), MAX_CUSTOM_REASON_CHARS);
  const qualityNotes = (raw.qualityNotes ?? [])
    .map(note => clip(cleanSentences(note), MAX_NOTE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_QUALITY_NOTES);
  const definition = clearIfUnverified(raw.definition);
  const meansRaw = redact(raw.meansOfVerification);
  const meansOfVerification = clearIfUnverified(raw.meansOfVerification);
  const targetSuggestion = redact(raw.targetSuggestion);
  const standardReferenceCode = redact(raw.standardReferenceCode);

  // Step 4: rules 8–9 (D14).
  const figures = factsFiguresFor(raw, ctx);

  // Step 5: the payload, with empty model method/date fields so resolveBaselineAndTarget writes only server text (D22).
  const normalised = normalizeIndicator({
    ...raw,
    resultCode: result.code,
    name,
    nameAr,
    definition,
    customReason,
    meansOfVerification,
    rationale,
    qualityNotes,
    standardReferenceCode,
    libraryId: rawLibraryId,
    baselineValue: raw.baselineSuggestion,
    baselineMethod: '',
    baselineDate: '',
    intermediateTargets: [],
    targetValue: targetSuggestion,
    targetJustification: '',
    dataCollectionMethod: raw.method,
    aiRationale: rationale,
    assumptions: '',
    responsibility: '',
    calculation: { numerator: raw.numerator, denominator: raw.denominator },
  }, meta.rank, {
    frameworkId: '-',
    resultNodes: ctx.resultsChain,
    knownLibraryIds: new Set(deps.library.keys()),
    libraryEntries: deps.library,
    verifiedFigures: figures,
    aiModel: '-',
    promptVersion: '-',
  });
  if (!normalised) return { dropped: warning('model_note', { message: 'A suggestion without a name was dropped.' }) };
  const payload: IndicatorCreatePayload = { ...normalised };
  const entry = payload.libraryId ? deps.library.get(payload.libraryId) ?? null : null;

  // Rule 1: unknown library id → custom.
  if (rawLibraryId && !deps.library.has(rawLibraryId)) warnings.push(warning('library_id_unknown', { libraryId: paramText(rawLibraryId) }));

  // Rule 2: final isCustom = no library id; a valid library id wins over isCustom: true (reason cleared).
  const isCustom = payload.libraryId === null || payload.libraryId === undefined;
  if (isCustom && !customReason) warnings.push(warning('custom_reason_missing'));

  // Step 6, rule 6 (D16) and rule 7: sex keys.
  const rawKeys = normalizeDisaggregation(raw.disaggregation);
  let keys = Array.isArray(payload.disaggregation) ? (payload.disaggregation as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  const entrySexKeys = SEX_KEYS.filter(k => entry?.disaggregation.includes(k));
  let sexFromLibrary = false;
  if (entrySexKeys.length > 0) {
    const other = entrySexKeys.length === 1 ? SEX_KEYS.find(k => k !== entrySexKeys[0]) ?? null : null;
    const replaced = other !== null && keys.includes(other);
    if (other !== null) keys = keys.filter(k => k !== other);
    sexFromLibrary = replaced || entrySexKeys.some(k => !rawKeys.includes(k));
    if (sexFromLibrary) warnings.push(warning('sex_keys_from_library', { keys: entrySexKeys.join(', ') }));
  }
  if (!sexFromLibrary && keys.includes('sex') && !rawKeys.includes('sex')) warnings.push(warning('sex_added'));
  payload.disaggregation = keys;

  // Rule 3, 4, 5 (penalised), on the final names and the raw calculation.
  const percent = isPercentUnit(raw.unit, payload.indicatorText);

  // x3: Arabic name, from the linked entry when missing or not Arabic.
  let finalNameAr = typeof payload.indicatorTextAr === 'string' ? payload.indicatorTextAr : ''; // clipped by normalizeIndicator
  if (!ARABIC_LETTER.test(finalNameAr)) {
    if (entry) {
      finalNameAr = entry.nameAr;
      warnings.push(warning('arabic_name_from_library'));
    } else {
      finalNameAr = '';
      warnings.push(warning('arabic_name_missing'));
    }
  }
  payload.indicatorTextAr = finalNameAr || null;

  if (nameHasTargetOrDirection(payload.indicatorText, finalNameAr)) warnings.push(warning('target_in_name'));
  if (isDoubleBarrelled(payload.indicatorText)) warnings.push(warning('double_barrelled'));
  if (percent && (!(raw.numerator ?? '').trim() || !(raw.denominator ?? '').trim())) warnings.push(warning('percent_without_calculation'));

  // Rules 8, 9, 11: values the checks removed.
  const baselineValue = typeof payload.baselineValue === 'string' && payload.baselineValue !== '' ? payload.baselineValue : null;
  const targetValue = typeof payload.targetValue === 'string' && payload.targetValue !== '' ? payload.targetValue : null;
  if (raw.baselineBasis === 'document' && raw.baselineSuggestion.trim() && baselineValue === null) warnings.push(warning('baseline_not_found'));
  if (raw.targetBasis === 'document' && targetSuggestion && targetValue === null) warnings.push(warning('target_not_found'));
  if (raw.targetBasis === 'standard_threshold' && targetSuggestion && targetValue === null) warnings.push(warning('standard_threshold_not_found'));

  // Rule 12: a baseline method with an absolute figure becomes the default method.
  let targetJustification = typeof payload.targetJustification === 'string' ? payload.targetJustification : '';
  let method: string | null = null;
  if (targetValue === null) {
    const match = PROPOSED_METHOD.exec(targetJustification);
    method = match ? match[1] : null;
    if (method !== null && method !== DEFAULT_TARGET_METHOD && methodHasAbsoluteFigure(method)) {
      targetJustification = targetJustification.replace(match![0], `Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`);
      method = DEFAULT_TARGET_METHOD;
    }
    const modelMethod = (raw.targetBasis === 'method_only' || raw.targetBasis === 'none') && targetSuggestion !== '';
    if (modelMethod && method === DEFAULT_TARGET_METHOD && targetSuggestion !== DEFAULT_TARGET_METHOD) {
      warnings.push(warning('target_method_default'));
    }
  }
  payload.targetJustification = targetJustification;

  // Rules 15, 16 (info), x2 (info), x4, x5.
  const level = result.level;
  const methodValue = payload.dataCollectionMethod;
  if (level === 'output' && methodValue === 'hh_survey') warnings.push(warning('output_survey_method'));
  if (level === 'impact' && methodValue !== 'secondary_data') warnings.push(warning('impact_not_secondary'));
  if (raw.level !== result.level) warnings.push(warning('level_adjusted', { level: result.level, code: result.code }));
  if (meansRaw && isGenericMeansOfVerification(meansRaw)) warnings.push(warning('generic_means_of_verification'));
  if (removedFigures.length > 0) warnings.push(warning('figures_unverified', { figures: removedFigures.join(', ') }));

  // Step 8: the validated suggestion and its draft.
  const calculation: Record<string, unknown> = isObject(payload.calculation) ? payload.calculation : {};
  const baselineFigure = baselineValue !== null ? figures.find(f => f.kind === 'baseline') ?? null : null;
  const targetFigure = targetValue !== null && raw.targetBasis === 'document' ? figures.find(f => f.kind === 'target') ?? null : null;
  const draft = indicatorDraftFromPayload(payload, result.id, { startDate: ctx.project.startDate, endDate: ctx.project.endDate });
  const unit: IndicatorUnit = UNITS.has(raw.unit) ? raw.unit : draft.unit;
  const score = qualityScore(warnings);

  const suggestion: ValidatedSuggestion = {
    resultId: result.id,
    resultCode: result.code,
    level,
    libraryId: isCustom ? null : (payload.libraryId as string),
    isCustom,
    customReason: isCustom ? customReason : '',
    name: payload.indicatorText,
    nameAr: finalNameAr,
    definition: typeof payload.definition === 'string' ? payload.definition : TO_BE_CONFIRMED,
    unit,
    numerator: typeof calculation.numerator === 'string' ? calculation.numerator : '',
    denominator: typeof calculation.denominator === 'string' ? calculation.denominator : '',
    direction: draft.direction,
    disaggregation: keys,
    method: methodValue,
    frequency: payload.frequency,
    meansOfVerification: typeof payload.meansOfVerification === 'string' ? payload.meansOfVerification : TO_BE_CONFIRMED,
    baselineSuggestion: baselineValue ?? '',
    baselineBasis: baselineValue !== null ? 'document' : 'none',
    baselineMethod: draft.baselineMethod,
    targetSuggestion: targetValue ?? (method !== null ? `Proposed method: ${method} — confirm after baseline.` : targetJustification),
    targetBasis: targetValue !== null ? raw.targetBasis : 'method_only',
    targetJustification,
    standardReferenceCode: draft.standardReferenceCode,
    rationale,
    qualityNotes,
    confidence: raw.confidence,
    sources: { baseline: baselineFigure?.source ?? null, target: targetFigure?.source ?? null },
    origin: meta.origin ?? 'model',
    rank: meta.rank,
    qualityScore: score,
    qualityBand: qualityBand(score),
    warnings,
    draft,
  };
  return { suggestion };
}

// ------------------------------------------------------------------ run-level rules

const CONFIDENCE_ORDER: Readonly<Record<ValidatedSuggestion['confidence'], number>> = { high: 0, medium: 1, low: 2 };

/** Rule 17 order: confidence (high > medium > low), then quality score, then library before custom, then model order. */
function betterFirst(a: ValidatedSuggestion, b: ValidatedSuggestion): number {
  return CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]
    || b.qualityScore - a.qualityScore
    || Number(a.libraryId === null) - Number(b.libraryId === null)
    || a.rank - b.rank;
}

function chainIndex(ctx: ProjectContext): (resultId: string) => number {
  const index = new Map(ctx.resultsChain.map((r, i) => [r.id, i]));
  return id => index.get(id) ?? Number.MAX_SAFE_INTEGER;
}

const sameLibrary = (a: string | null, b: string | null) => a !== null && b !== null && upperId(a) === upperId(b);

/**
 * Rule 18 and D12 (spec §A4 step 3 "near-duplicate of an existing indicator"; me-foundations §2 rule 9 not duplicated):
 * - against existingIndicators of the whole framework: normalisedIndicatorName equal, same libraryId, or cosine of the
 *   English names ≥ 0.92 (when `similarity` knows both) → near_duplicate;
 * - alternatives runs: against pending suggestions of the same result (same libraryId or normalised name), which an
 *   alternatives run never expires (framework and result runs expire the pending cards of the results they refill);
 * - within the run: same result and same libraryId or normalised name → the better one is kept (duplicate_in_run); the
 *   same libraryId in two results → the first in chain order is kept (duplicate_in_run).
 * Kept suggestions stay in input order.
 */
export function dropDuplicates(s: ValidatedSuggestion[], ctx: ProjectContext, similarity?: SimilarityFn): { kept: ValidatedSuggestion[]; warnings: KpiWarning[] } {
  const warnings: KpiWarning[] = [];
  const existing = ctx.existingIndicators.map(i => ({ ...i, key: normalisedIndicatorName(i.name) }));
  const pending = ctx.scope.type === 'alternatives'
    ? ctx.pendingSuggestions.map(p => ({ ...p, key: normalisedIndicatorName(p.name) }))
    : [];

  const afterExisting = s.filter(suggestion => {
    const key = normalisedIndicatorName(suggestion.name);
    const repeatsExisting = existing.some(i => (key !== '' && i.key === key)
      || sameLibrary(i.libraryId, suggestion.libraryId)
      || ((similarity?.(suggestion.name, i.name) ?? 0) >= NEAR_DUPLICATE_COSINE));
    const repeatsPending = pending.some(p => p.resultId === suggestion.resultId
      && ((key !== '' && p.key === key) || sameLibrary(p.libraryId, suggestion.libraryId)));
    if (repeatsExisting || repeatsPending) {
      warnings.push(warning('near_duplicate', { name: suggestion.name }));
      return false;
    }
    return true;
  });

  // Within a result: keep the better of two repeats.
  const dropped = new Set<ValidatedSuggestion>();
  const keptByResult = new Map<string, ValidatedSuggestion[]>();
  for (const suggestion of afterExisting) {
    const group = keptByResult.get(suggestion.resultId) ?? [];
    const key = normalisedIndicatorName(suggestion.name);
    const twin = group.find(g => sameLibrary(g.libraryId, suggestion.libraryId) || (key !== '' && normalisedIndicatorName(g.name) === key));
    if (!twin) {
      group.push(suggestion);
    } else if (betterFirst(suggestion, twin) < 0) {
      group[group.indexOf(twin)] = suggestion;
      dropped.add(twin);
      warnings.push(warning('duplicate_in_run', { code: twin.resultCode }));
    } else {
      dropped.add(suggestion);
      warnings.push(warning('duplicate_in_run', { code: suggestion.resultCode }));
    }
    keptByResult.set(suggestion.resultId, group);
  }

  // Across results: one library indicator measures one result (D12), the first in chain order.
  const order = chainIndex(ctx);
  const byChain = afterExisting
    .filter(x => !dropped.has(x))
    .map((x, i) => ({ x, i }))
    .sort((a, b) => order(a.x.resultId) - order(b.x.resultId) || a.i - b.i);
  const libraryOwner = new Map<string, string>();
  for (const { x } of byChain) {
    if (x.libraryId === null) continue;
    const id = upperId(x.libraryId);
    const owner = libraryOwner.get(id);
    if (owner === undefined) {
      libraryOwner.set(id, x.resultId);
    } else if (owner !== x.resultId) {
      dropped.add(x);
      warnings.push(warning('duplicate_in_run', { code: x.resultCode }));
    }
  }

  return { kept: afterExisting.filter(x => !dropped.has(x)), warnings };
}

/**
 * Rule 17 (spec §A4 step 3 "more than maxIndicatorsPerResult"; D5, D10): per result keep allowanceFor(result, ctx).max
 * suggestions (the level maximum, minus existing indicators in framework scope and for donor caps), best first by
 * confidence (high > medium > low), quality score, library before custom, then model order; a result_cap warning names
 * the result, the cap and how many were dropped. Kept suggestions are grouped by result in chain order, best first.
 */
export function applyResultCaps(s: ValidatedSuggestion[], ctx: ProjectContext): { kept: ValidatedSuggestion[]; warnings: KpiWarning[] } {
  const warnings: KpiWarning[] = [];
  const kept: ValidatedSuggestion[] = [];
  const order = chainIndex(ctx);
  const groups = new Map<string, ValidatedSuggestion[]>();
  for (const suggestion of s) groups.set(suggestion.resultId, [...(groups.get(suggestion.resultId) ?? []), suggestion]);
  const resultIds = Array.from(groups.keys()).sort((a, b) => order(a) - order(b));
  for (const resultId of resultIds) {
    const group = [...(groups.get(resultId) ?? [])].sort(betterFirst);
    const result = ctx.resultsChain.find(r => r.id === resultId);
    const cap = result ? allowanceFor(result, ctx).max : group.length;
    kept.push(...group.slice(0, cap));
    if (group.length > cap) warnings.push(warning('result_cap', { code: group[0].resultCode, cap, dropped: group.length - cap }));
  }
  return { kept, warnings };
}

/**
 * A raw suggestion copied from a library entry (rule 19, spec §A4 step 3 "append AC-01"; the eval's fake model, §A8):
 * name/nameAr/definition/unit/
 * calculation/direction/disaggregation/methods[0]/frequency/MoV of the entry, baselineBasis none, targetBasis
 * method_only, targetSuggestion '', confidence 'medium', isCustom false, the given rationale; resultCode and level are
 * the result's, standardReferenceCode the entry's label.
 */
export function rawSuggestionFromLibrary(entry: KpiLibraryEntry, result: ContextResult, rationale: string): KpiRawSuggestion {
  const calculation = isObject(entry.calculation) ? entry.calculation : {};
  const part = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    resultCode: result.code,
    level: result.level,
    libraryId: entry.id,
    isCustom: false,
    customReason: '',
    name: entry.name,
    nameAr: entry.nameAr,
    definition: entry.definition,
    unit: (UNITS.has(entry.unit) ? entry.unit : 'number') as KpiRawSuggestion['unit'],
    numerator: part(calculation.numerator),
    denominator: part(calculation.denominator),
    direction: entry.direction,
    disaggregation: [...entry.disaggregation],
    method: entry.methods[0] ?? 'document_review',
    frequency: entry.frequency,
    meansOfVerification: entry.meansOfVerification,
    baselineSuggestion: '',
    baselineBasis: 'none',
    targetSuggestion: '',
    targetBasis: 'method_only',
    standardReferenceCode: standardReferenceLabel(entry.standardReference),
    rationale,
    qualityNotes: [],
    confidence: 'medium',
  };
}

/**
 * Rule 19 (spec §A4 step 3; me-foundations §9; D11), after rule 17: for a humanitarian project in framework scope, or in
 * result scope on an outcome (never for alternatives), when neither the framework's indicators nor the kept suggestions
 * hold an accountability indicator (isAccountabilityIndicator: AC-01…AC-05 by id, or a custom indicator with accountability
 * wording), appends the first of AC-01, AC-03, AC-04, AC-05 that is in the library and not excluded, to the first scoped
 * outcome (chain order) with room under its allowance; when none has room, it replaces the lowest-ranked suggestion of the
 * scoped outcome with the most suggestions (result_cap notes the drop). No outcome in scope or every entry excluded →
 * accountability_missing only.
 */
export function ensureAccountability(s: ValidatedSuggestion[], ctx: ProjectContext, deps: ValidateDeps): { suggestions: ValidatedSuggestion[]; warnings: KpiWarning[] } {
  const unchanged = { suggestions: s, warnings: [] as KpiWarning[] };
  if (!ctx.project.humanitarian || ctx.scope.type === 'alternatives') return unchanged;
  const scoped = scopedResults(ctx);
  if (ctx.scope.type === 'result' && scoped[0]?.level !== 'outcome') return unchanged;
  const hasOne = ctx.existingIndicators.some(i => isAccountabilityIndicator({ libraryId: i.libraryId, name: i.name, nameAr: i.nameAr }))
    || s.some(x => isAccountabilityIndicator({ libraryId: x.libraryId, name: x.name, nameAr: x.nameAr }));
  if (hasOne) return unchanged;

  const missing = { suggestions: s, warnings: [warning('accountability_missing')] };
  const outcomes = scoped.filter(r => r.level === 'outcome');
  if (outcomes.length === 0) return missing;

  const count = (resultId: string) => s.filter(x => x.resultId === resultId).length;
  let target = outcomes.find(r => count(r.id) < allowanceFor(r, ctx).max) ?? null;
  let list = s;
  const warnings: KpiWarning[] = [];
  if (!target) {
    target = outcomes.reduce((best, r) => (count(r.id) > count(best.id) ? r : best), outcomes[0]);
    const group = s.filter(x => x.resultId === target!.id).sort(betterFirst);
    const worst = group[group.length - 1];
    if (worst) {
      list = s.filter(x => x !== worst);
      warnings.push(warning('result_cap', { code: target.code, cap: allowanceFor(target, ctx).max, dropped: 1 }));
    }
  }

  const excluded = exclusionsFor(ctx, target.id);
  const used = new Set(list.map(x => upperId(x.libraryId)).filter(Boolean));
  const entry = ACCOUNTABILITY_APPEND_ORDER
    .map(id => deps.library.get(id))
    .find((e): e is KpiLibraryEntry => e !== undefined && !excluded.has(e.id) && !used.has(e.id));
  if (!entry) return missing;

  const rank = list.filter(x => x.resultId === target!.id).length + 1;
  const validated = validateSuggestion(rawSuggestionFromLibrary(entry, target, ACCOUNTABILITY_RATIONALE), ctx, deps,
    { rank, origin: 'appended_accountability' });
  if (!('suggestion' in validated)) return missing;
  return {
    suggestions: [...list, validated.suggestion],
    warnings: [...warnings, warning('accountability_added', { libraryId: entry.id, code: target.code })],
  };
}

/** x6: the model's frameworkWarnings as model_note warnings (≤ 10, redacted, ≤ 300 characters, unverified sentences removed). */
function modelNotes(notes: readonly string[], allowed: readonly string[]): KpiWarning[] {
  return notes
    .slice(0, MAX_MODEL_NOTES)
    .map(note => withoutUnverifiedSentences(clip(redact(note).replace(/\s+/g, ' '), MAX_MODEL_NOTE_CHARS), allowed).text)
    .filter(text => text !== '')
    .map(text => warning('model_note', { message: text }));
}

/**
 * Composes everything (spec §A4 step 3; design 1.5): validateSuggestion for each model suggestion (model order = rank),
 * dropDuplicates (rule 18, D12), applyResultCaps (rule 17), ensureAccountability (rule 19), the model's notes (x6); then
 * re-ranks per result (rank 1..n, best first; an appended accountability indicator last). Suggestions come grouped by
 * result in chain order; frameworkWarnings hold the run-level warnings, then the AI notes.
 */
export function validateAndScore(input: { context: ProjectContext; answer: KpiModelAnswer; deps: ValidateDeps }):
  { suggestions: ValidatedSuggestion[]; frameworkWarnings: KpiWarning[] } {
  const { context: ctx, answer, deps } = input;
  const frameworkWarnings: KpiWarning[] = [];
  const validated: ValidatedSuggestion[] = [];
  (answer.suggestions ?? []).forEach((raw, i) => {
    const out = validateSuggestion(raw, ctx, deps, { rank: i + 1 });
    if ('suggestion' in out) validated.push(out.suggestion);
    else frameworkWarnings.push(out.dropped);
  });

  const deduped = dropDuplicates(validated, ctx, deps.similarity);
  const capped = applyResultCaps(deduped.kept, ctx);
  const withAccountability = ensureAccountability(capped.kept, ctx, deps);
  frameworkWarnings.push(...deduped.warnings, ...capped.warnings, ...withAccountability.warnings);
  frameworkWarnings.push(...modelNotes(answer.frameworkWarnings ?? [], allowedFigures(ctx, deps)));

  const order = chainIndex(ctx);
  const ranked = withAccountability.suggestions
    .map((x, i) => ({ x, i }))
    .sort((a, b) => order(a.x.resultId) - order(b.x.resultId) || a.i - b.i)
    .map(({ x }) => x);
  const counters = new Map<string, number>();
  const suggestions = ranked.map(x => {
    const rank = (counters.get(x.resultId) ?? 0) + 1;
    counters.set(x.resultId, rank);
    return { ...x, rank };
  });
  return { suggestions, frameworkWarnings };
}

// ------------------------------------------------------------------ existing indicators (trigger 3)

/** Empty, or still "To be confirmed by the M&E officer". */
const unconfirmed = (value: unknown) => {
  const t = typeof value === 'string' ? value.trim().replace(/\.$/, '') : '';
  return t === '' || t === TO_BE_CONFIRMED;
};

/**
 * Quality check of an existing indicator (spec §A2 trigger 3 "indicator marked weak by the quality check"; design 1.2,
 * M4): rules 3, 4, 5 (on its calculation: a percentage whose numerator or denominator is empty or still to be confirmed),
 * x3 (Arabic name missing or not Arabic), x4 (generic means of verification). needsAlternatives = some warning has
 * penalty > 0 (the band alone cannot drop below 60, so it is not the trigger).
 */
export function scoreExistingIndicator(ind: { indicatorText: string; indicatorTextAr: string | null; unit: string | null;
  calculation: unknown; meansOfVerification: string | null }): { qualityScore: number; qualityBand: QualityBand; warnings: KpiWarning[]; needsAlternatives: boolean } {
  const warnings: KpiWarning[] = [];
  const name = ind.indicatorText ?? '';
  const nameAr = ind.indicatorTextAr ?? '';
  if (nameHasTargetOrDirection(name, nameAr)) warnings.push(warning('target_in_name'));
  if (isDoubleBarrelled(name)) warnings.push(warning('double_barrelled'));
  if (isPercentUnit(ind.unit ?? '', name)) {
    const calculation = isObject(ind.calculation) ? ind.calculation : {};
    if (unconfirmed(calculation.numerator) || unconfirmed(calculation.denominator)) warnings.push(warning('percent_without_calculation'));
  }
  if (!ARABIC_LETTER.test(nameAr)) warnings.push(warning('arabic_name_missing'));
  const means = (ind.meansOfVerification ?? '').trim();
  if (means && isGenericMeansOfVerification(means)) warnings.push(warning('generic_means_of_verification'));
  const score = qualityScore(warnings);
  return { qualityScore: score, qualityBand: qualityBand(score), warnings, needsAlternatives: warnings.some(w => w.penalty > 0) };
}
