import { describe, expect, it } from 'vitest';
import { DONOR_RULES } from '../src/services/ai/donorRules';
import {
  DEFAULT_TARGET_METHOD, TO_BE_CONFIRMED, codeKey, excerptSupportsValue, isGenericMeansOfVerification, isPeopleLevelIndicator,
  isPercentUnit, matchingFigure, normaliseForMatch, standaloneValueOffsets, verifyDocumentFigures,
} from '../src/services/ai/frameworkNormalize';
import type { VerifiedFigure } from '../src/services/ai/frameworkNormalize';
import { STANDARD_THRESHOLDS, recognisedThreshold } from '../src/services/ai/standardThresholds';
import { FRAMEWORK_DIRECTIONS, FRAMEWORK_FREQUENCIES, FRAMEWORK_METHODS, INDICATOR_UNITS } from '../src/services/ai/prompts/framework';
import { parseIndicatorCreate } from '../src/services/indicators/validation';
import { loadLibraryFile } from '../src/services/library/load';
import {
  ACCOUNTABILITY_APPEND_ORDER, ACCOUNTABILITY_IDS, isAccountabilityEntry, isAccountabilityIndicator, isAccountabilityText,
} from '../src/services/kpi/accountability';
import { extractDocumentFacts, factKind, factsFromVerifiedFigures } from '../src/services/kpi/documentFacts';
import { draftToCreateInput } from '../src/services/kpi/draft';
import { allowanceFor, exclusionsFor, scopedResults } from '../src/services/kpi/scope';
import { KPI_PENALTIES, KPI_WARNING_CODES } from '../src/services/kpi/types';
import type {
  ContextIndicator, ContextResult, DocumentFact, DocumentText, KpiLibraryEntry, KpiRawSuggestion, KpiWarning,
  KpiWarningCode, ProjectContext, ValidatedSuggestion,
} from '../src/services/kpi/types';
import {
  NEAR_DUPLICATE_COSINE, QUALITY_THRESHOLDS, applyResultCaps, documentValueSupported, dropDuplicates, ensureAccountability,
  factsFiguresFor, methodHasAbsoluteFigure, qualityBand, qualityScore, rawSuggestionFromLibrary, scoreExistingIndicator,
  nameFiguresUnsupported, validateAndScore, validateSuggestion, valueKindInFact, warning, withoutUnverifiedSentences,
} from '../src/services/kpi/validate';
import type { ValidateDeps } from '../src/services/kpi/validate';
import { nameHasTargetIndependent, peopleLevelIndependent } from '../src/services/kpi/eval/metrics';

/**
 * KPI Assistant validation core (knowledge/kpi-assistant-spec.md §A4 step 3; me-foundations §2, §3, §6; design sections
 * 1.5 and 4.2). One `it` per rule row of design 1.5, named after the rule number. Pure, no database, no AI call.
 */

// ------------------------------------------------------------------ fixtures (made-up project, no personal data)

const LIBRARY: ReadonlyMap<string, KpiLibraryEntry> = new Map(loadLibraryFile().entries.map(e => [e.id, {
  id: e.id, sector: e.sector, tags: e.tags, level: e.level, name: e.name, nameAr: e.nameAr, definition: e.definition,
  unit: e.unit, calculation: e.calculation, direction: e.direction, disaggregation: e.disaggregation, methods: e.methods,
  frequency: e.frequency, meansOfVerification: e.meansOfVerification, standardReference: e.standardReference,
  standardFramework: e.standardReference?.framework ?? null, isStandard: e.isStandard, notes: e.notes.trim() === '' ? null : e.notes,
} satisfies KpiLibraryEntry]));

const entry = (id: string): KpiLibraryEntry => {
  const found = LIBRARY.get(id);
  if (!found) throw new Error(`no library entry ${id}`);
  return found;
};

const RESULTS: ContextResult[] = [
  { id: 'n-g', code: 'G', level: 'impact', text: 'Reduced risk of water-borne disease among displaced families', textAr: null, parentId: null },
  { id: 'n-o1', code: 'O1', level: 'outcome', text: 'Displaced households have access to sufficient safe water', textAr: 'تحصل الأسر النازحة على مياه آمنة كافية', parentId: 'n-g' },
  { id: 'n-o1.1', code: 'O1.1', level: 'output', text: 'Safe water delivered through trucking and rehabilitated water points', textAr: null, parentId: 'n-o1' },
  { id: 'n-o2', code: 'O2', level: 'outcome', text: 'Displaced households practise key hygiene behaviours', textAr: null, parentId: 'n-g' },
  { id: 'n-o2.1', code: 'O2.1', level: 'output', text: 'Hygiene kits distributed and hygiene promotion sessions conducted', textAr: null, parentId: 'n-o2' },
];

function context(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: {
      id: 'p-1', name: 'Emergency water and hygiene for displaced families', sectors: ['wash'], donor: 'Example donor', donorType: 'other',
      startDate: '2026-11-01', endDate: '2027-10-31', geographicScope: 'Khan Younis governorate', targetBeneficiaries: 24000,
      humanitarian: false, description: 'Water trucking, water point rehabilitation and hygiene promotion.',
    },
    resultsChain: RESULTS,
    scope: { type: 'framework' },
    existingIndicators: [],
    pendingSuggestions: [],
    documentFacts: [],
    documentTexts: [],
    orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] },
    donorRules: { donorType: 'other', ...DONOR_RULES.other },
    alternativesFor: null,
    ...overrides,
  };
}

const humanitarian = (overrides: Partial<ProjectContext> = {}) => {
  const base = context(overrides);
  return { ...base, project: { ...base.project, humanitarian: true } };
};
const echo = (overrides: Partial<ProjectContext> = {}) => context({ donorRules: { donorType: 'echo', ...DONOR_RULES.echo }, ...overrides });

const DEFAULT_CANDIDATES = ['WA-01', 'WA-02', 'WA-03', 'WA-05', 'WA-06', 'FS-01', 'LV-01', 'AC-01', 'AC-03', 'AC-04', 'AC-05'];
const deps = (overrides: Partial<ValidateDeps> = {}): ValidateDeps => ({ library: LIBRARY, candidateIds: new Set(DEFAULT_CANDIDATES), ...overrides });

/** A clean library suggestion (WA-02 on O1) that passes every rule without a warning. */
function raw(overrides: Partial<KpiRawSuggestion> = {}): KpiRawSuggestion {
  return {
    resultCode: 'O1',
    level: 'outcome',
    libraryId: 'WA-02',
    isCustom: false,
    customReason: '',
    name: '% of target households using at least a basic drinking water service',
    nameAr: 'نسبة الأسر المستهدفة التي تستخدم خدمة مياه شرب أساسية على الأقل',
    definition: 'Share of target households whose main drinking water comes from an improved source close to home.',
    unit: 'percent',
    numerator: 'Households on the basic or safely managed rung',
    denominator: 'All surveyed target households',
    direction: 'increase',
    disaggregation: ['sex_of_household_head', 'location'],
    method: 'hh_survey',
    frequency: 'biannual',
    meansOfVerification: 'Household survey using the JMP core questions on source and collection time',
    baselineSuggestion: '',
    baselineBasis: 'none',
    targetSuggestion: 'baseline + 10 percentage points',
    targetBasis: 'method_only',
    standardReferenceCode: null,
    rationale: 'Measures access to safe drinking water, which is what this outcome is about.',
    qualityNotes: [],
    confidence: 'high',
    ...overrides,
  };
}

/** A clean custom suggestion on O1.1 (count). */
function customRaw(overrides: Partial<KpiRawSuggestion> = {}): KpiRawSuggestion {
  return raw({
    resultCode: 'O1.1', level: 'output', libraryId: null, isCustom: true,
    customReason: 'No library indicator counts trucked water deliveries.',
    name: 'Number of water trucking deliveries completed', nameAr: 'عدد عمليات نقل المياه بالصهاريج المنجزة',
    definition: 'Deliveries of trucked water to target sites confirmed by a signed delivery note.',
    unit: 'number', numerator: '', denominator: '', disaggregation: ['location'], method: 'document_review', frequency: 'monthly',
    meansOfVerification: 'Signed delivery notes and the trucking log', targetSuggestion: 'baseline + 10 percentage points',
    ...overrides,
  });
}

function validate(r: KpiRawSuggestion, ctx: ProjectContext = context(), d: ValidateDeps = deps(), meta = { rank: 1 }): ValidatedSuggestion {
  const out = validateSuggestion(r, ctx, d, meta);
  if (!('suggestion' in out)) throw new Error(`dropped: ${out.dropped.code}`);
  return out.suggestion;
}

function dropped(r: KpiRawSuggestion, ctx: ProjectContext = context(), d: ValidateDeps = deps()): KpiWarning {
  const out = validateSuggestion(r, ctx, d, { rank: 1 });
  if (!('dropped' in out)) throw new Error('not dropped');
  return out.dropped;
}

const codes = (warnings: readonly KpiWarning[]) => warnings.map(w => w.code);
const find = (warnings: readonly KpiWarning[], code: KpiWarningCode) => warnings.find(w => w.code === code);

const indicator = (overrides: Partial<ContextIndicator> = {}): ContextIndicator => ({
  id: 'ind-1', resultId: 'n-o1', name: 'Existing indicator', nameAr: null, level: 'outcome', unit: 'number', libraryId: null, method: 'hh_survey',
  ...overrides,
});

// Documents (design 1.5 rules 8–9; eval CASE-01 and CASE-02 sentences).
const CASE02_FACT: DocumentFact = {
  documentId: 'doc-lf', fileName: 'logframe.xlsx', kind: 'target',
  excerpt: 'Target: 900 youth (50% women) complete training; 60% employed within six months.',
};
const CASE01_FACT: DocumentFact = {
  documentId: 'doc-pr', fileName: 'proposal.pdf', kind: 'target',
  excerpt: 'The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits.',
};
const MIXED_FACT: DocumentFact = {
  documentId: 'doc-bl', fileName: 'baseline.pdf', kind: 'mixed',
  excerpt: 'The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.',
};
const DOCUMENTS: DocumentText[] = [
  { documentId: 'doc-lf', fileName: 'logframe.xlsx', text: `Results framework\n${CASE02_FACT.excerpt}\nBudget lines follow.` },
  { documentId: 'doc-pr', fileName: 'proposal.pdf', text: `Summary of the action. ${CASE01_FACT.excerpt} Hygiene promotion follows.` },
  { documentId: 'doc-bl', fileName: 'baseline.pdf', text: `Water, sanitation and hygiene baseline.\n${MIXED_FACT.excerpt}` },
];
const withDocuments = (overrides: Partial<ProjectContext> = {}) => context({
  documentFacts: [CASE02_FACT, CASE01_FACT, MIXED_FACT], documentTexts: DOCUMENTS, ...overrides,
});

/** LV-01 (percent) on O1 with a document target or baseline. */
const lv01 = (overrides: Partial<KpiRawSuggestion> = {}) => raw({
  libraryId: 'LV-01', name: '% of trainees employed or self-employed six months after completing training',
  nameAr: 'نسبة المتدربين الذين يعملون بأجر أو لحسابهم الخاص بعد ستة أشهر من إنهاء التدريب',
  numerator: 'Graduates employed or self-employed at six months', denominator: 'Graduates reached by the tracer survey',
  disaggregation: ['sex', 'age'], ...overrides,
});
/** A custom count on O1.1. */
const youthCount = (overrides: Partial<KpiRawSuggestion> = {}) => customRaw({
  name: 'Number of youth completing vocational training', nameAr: 'عدد الشباب الذين أتموا التدريب المهني',
  customReason: 'No library indicator fits this training.', disaggregation: ['sex', 'age'], ...overrides,
});

// ------------------------------------------------------------------ frameworkNormalize additions (design 4.2)

describe('frameworkNormalize export additions', () => {
  it('standaloneValueOffsets never finds a value inside a larger number', () => {
    expect(standaloneValueOffsets('22.5%', '22')).toEqual([]);
    expect(standaloneValueOffsets('22.5%', '5')).toEqual([]);
    expect(standaloneValueOffsets('4.5 kg per dunum', '4')).toEqual([]);
    expect(standaloneValueOffsets('1.200 households', '1')).toEqual([]);
    expect(standaloneValueOffsets('42 schools', '4')).toEqual([]);
    expect(standaloneValueOffsets('1,200 households', '200')).toEqual([]);
  });

  it('standaloneValueOffsets skips dates and ranges', () => {
    expect(standaloneValueOffsets('Starts on 15 March 2026.', '15')).toEqual([]);
    expect(standaloneValueOffsets('Starts on March 15.', '15')).toEqual([]);
    expect(standaloneValueOffsets('Report due 15/03/2026.', '15')).toEqual([]);
    expect(standaloneValueOffsets('Between 10-15 sessions.', '10')).toEqual([]);
    expect(standaloneValueOffsets('١٥ آذار ٢٠٢٦', '15')).toEqual([]);
  });

  it('standaloneValueOffsets reads Arabic-Indic digits, ٫ and ٪, and marks percent values', () => {
    const [hit] = standaloneValueOffsets('١٢٫٥٪ من الأسر', '12.5');
    expect(hit).toMatchObject({ percent: true });
    expect(standaloneValueOffsets('60% employed', '60')).toEqual([{ start: 0, end: 2, percent: true }]);
    expect(standaloneValueOffsets('900 youth', '900')).toEqual([{ start: 0, end: 3, percent: false }]);
    expect(standaloneValueOffsets('60 percent of graduates', '60')[0].percent).toBe(true);
    expect(standaloneValueOffsets('60 per cent of graduates', '60')[0].percent).toBe(true);
    expect(standaloneValueOffsets('٦٠ بالمئة من الخريجين', '60')[0].percent).toBe(true);
    expect(standaloneValueOffsets('٦٠ بالمائة من الخريجين', '60')[0].percent).toBe(true);
    expect(standaloneValueOffsets('60 percentage points above', '60')[0].percent).toBe(false);
    expect(standaloneValueOffsets('the value is 60%', '60%')[0].percent).toBe(true);
  });

  it('standaloneValueOffsets measures offsets in normaliseForMatch(text) and ignores the AI analysis', () => {
    const text = 'The  2025 baseline   survey found ٤٥٪ of households.';
    const [hit] = standaloneValueOffsets(text, '45');
    expect(normaliseForMatch(text).slice(hit.start, hit.end)).toBe('45');
    expect(standaloneValueOffsets('Own text without the value.\n---AI_ANALYSIS---\nThe target is 75%.', '75')).toEqual([]);
    expect(standaloneValueOffsets('No digits here', 'yes')).toEqual([]);
  });

  it('excerptSupportsValue checks the unit when asked', () => {
    expect(excerptSupportsValue('60% employed within six months', '60', true)).toBe(true);
    expect(excerptSupportsValue('60% employed within six months', '60', false)).toBe(false);
    expect(excerptSupportsValue('900 youth complete training', '900', true)).toBe(false);
    expect(excerptSupportsValue('900 youth complete training', '900', false)).toBe(true);
    expect(excerptSupportsValue('900 youth complete training', '900')).toBe(true);
    expect(excerptSupportsValue('22.5% of households', '22')).toBe(false);
  });

  it('codeKey and isPercentUnit are the existing helpers', () => {
    expect(codeKey(' o 1.2 ')).toBe('O1.2');
    expect(isPercentUnit('percent', 'Anything')).toBe(true);
    expect(isPercentUnit('number', '% of households')).toBe(true);
    expect(isPercentUnit('number', 'Number of households')).toBe(false);
  });
});

// ------------------------------------------------------------------ accountability.ts, scope.ts

describe('accountability entries and wording (rule 19, D11)', () => {
  it('AC-01…AC-05 are accountability entries; AC-06, FS-06 and HE-04 are not', () => {
    for (const id of ACCOUNTABILITY_IDS) expect(isAccountabilityEntry({ id })).toBe(true);
    expect(isAccountabilityEntry({ id: ' ac-01 ' })).toBe(true);
    for (const id of ['AC-06', 'FS-06', 'HE-04', 'WA-01']) expect(isAccountabilityEntry({ id })).toBe(false);
    expect(entry('FS-06').tags).toContain('accountability');
    expect(entry('HE-04').tags).toContain('accountability');
    expect([...ACCOUNTABILITY_APPEND_ORDER]).toEqual(['AC-01', 'AC-03', 'AC-04', 'AC-05']);
  });

  it('a library-linked indicator never counts by its text; a custom one counts by English or Arabic wording', () => {
    expect(isAccountabilityIndicator({ libraryId: 'FS-06', name: '% of people who know how to give feedback' })).toBe(false);
    expect(isAccountabilityIndicator({ libraryId: 'AC-04', name: 'Anything' })).toBe(true);
    expect(isAccountabilityIndicator({ libraryId: null, name: '% of assisted people who know how to make a complaint' })).toBe(true);
    expect(isAccountabilityIndicator({ libraryId: '', name: 'Number of hygiene kits distributed' })).toBe(false);
    expect(isAccountabilityIndicator({ libraryId: null, name: 'Share of people', nameAr: 'نسبة المستفيدين الذين يعرفون آلية تقديم الشكاوى' })).toBe(true);
    for (const text of ['Complaints answered on time', 'Accountability score', '% of people consulted on the design',
      '% treated with respect by staff', 'Assistance met priority needs', 'Feedback channels known']) {
      expect(isAccountabilityText(text)).toBe(true);
    }
    for (const ar of ['آلية الشكاوى والملاحظات', 'آلية التغذية الراجعة', 'المساءلة أمام المجتمعات', 'عوملوا باحترام', 'التشاور مع المجتمع', 'تقديم شكوى']) {
      expect(isAccountabilityText('x', ar)).toBe(true);
    }
    expect(isAccountabilityText('Number of water points rehabilitated', 'عدد نقاط المياه')).toBe(false);
    // SPEC-7: routine process wording is not accountability to affected people (single words no longer count).
    for (const text of ['Number of voucher distributions with post-distribution feedback forms completed', 'Training feedback score',
      'Number of complaints about water quality from municipalities']) {
      expect(isAccountabilityText(text), text).toBe(false);
    }
    for (const ar of ['الملاحظات الصفية', 'تقييم التغذية الراجعة من المتدربين', 'احترام المواعيد']) expect(isAccountabilityText('x', ar), ar).toBe(false);
  });
});

describe('scope: allowance, scoped results, exclusions (design 4.2, D5, D10, M5)', () => {
  const o1 = RESULTS[1];
  const o11 = RESULTS[2];
  const g = RESULTS[0];

  it('framework scope subtracts existing indicators from the level maximum', () => {
    expect(allowanceFor(g, context())).toEqual({ min: 1, max: 2 });
    expect(allowanceFor(o1, context())).toEqual({ min: 2, max: 4 });
    expect(allowanceFor(o11, context())).toEqual({ min: 2, max: 3 });
    expect(allowanceFor(o1, context({ existingIndicators: [indicator()] }))).toEqual({ min: 2, max: 3 });
    const full = context({ existingIndicators: [1, 2, 3, 4].map(i => indicator({ id: `i${i}` })) });
    expect(allowanceFor(o1, full)).toEqual({ min: 0, max: 0 });
    expect(scopedResults(full).map(r => r.code)).toEqual(['G', 'O1.1', 'O2', 'O2.1']);
  });

  it('result scope keeps the level range; the scoped result only', () => {
    const ctx = context({ scope: { type: 'result', resultId: 'n-o1' }, existingIndicators: [1, 2, 3, 4].map(i => indicator({ id: `i${i}` })) });
    expect(allowanceFor(o1, ctx)).toEqual({ min: 2, max: 4 });
    expect(scopedResults(ctx).map(r => r.code)).toEqual(['O1']);
    expect(scopedResults(context({ scope: { type: 'result', resultId: 'missing' } }))).toEqual([]);
  });

  it('the ECHO cap counts existing indicators', () => {
    const ctx = echo({ existingIndicators: [indicator()] });
    expect(allowanceFor(o1, ctx)).toEqual({ min: 2, max: 2 });
    expect(allowanceFor(o11, ctx)).toEqual({ min: 2, max: 3 });
    const resultScope = echo({ scope: { type: 'result', resultId: 'n-o1' }, existingIndicators: [indicator(), indicator({ id: 'i2' })] });
    expect(allowanceFor(o1, resultScope)).toEqual({ min: 1, max: 1 });
  });

  it('alternatives: ALTERNATIVES_RANGE, the replaced indicator not counted against the donor cap, max 0 → nothing to suggest', () => {
    const three = [indicator({ id: 'src' }), indicator({ id: 'i2' }), indicator({ id: 'i3' })];
    const source = { kind: 'indicator' as const, id: 'src', resultId: 'n-o1', name: 'Existing indicator', nameAr: null, definition: null, unit: 'number', method: 'hh_survey' as const, libraryId: null, reason: 'requested' as const, rejectReason: null, problems: [] };
    expect(allowanceFor(o1, context({ scope: { type: 'alternatives', indicatorId: 'src', suggestionId: null }, alternativesFor: source, existingIndicators: three })))
      .toEqual({ min: 2, max: 3 });
    // ECHO result at its cap of 3: replacing one of the 3 leaves room for cap − 2 others = 1 (formula of design 4.2).
    const ofIndicator = echo({ scope: { type: 'alternatives', indicatorId: 'src', suggestionId: null }, alternativesFor: source, existingIndicators: three });
    expect(allowanceFor(o1, ofIndicator)).toEqual({ min: 1, max: 1 });
    expect(scopedResults(ofIndicator).map(r => r.code)).toEqual(['O1']);
    const ofSuggestion = echo({
      scope: { type: 'alternatives', indicatorId: null, suggestionId: 's-1' },
      alternativesFor: { ...source, kind: 'suggestion', id: 's-1', reason: 'rejected', rejectReason: 'wording' },
      existingIndicators: three,
    });
    expect(allowanceFor(o1, ofSuggestion)).toEqual({ min: 0, max: 0 });
    expect(scopedResults(ofSuggestion)).toEqual([]);
    expect(scopedResults(context({ scope: { type: 'alternatives', indicatorId: 'src', suggestionId: null }, alternativesFor: null }))).toEqual([]);
  });

  it('exclusions per scope', () => {
    const existing = [indicator({ libraryId: 'wa-02' }), indicator({ id: 'i2', resultId: 'n-o2', libraryId: 'WA-05' })];
    const pending = [{ id: 's-1', resultId: 'n-o1', libraryId: 'WA-03', name: 'x' }, { id: 's-2', resultId: 'n-o2', libraryId: 'WA-01', name: 'y' }];
    const prefs = { rejectedLibraryIds: ['fs-03'], preferredMethods: [] };
    expect([...exclusionsFor(context({ existingIndicators: existing, pendingSuggestions: pending, orgPreferences: prefs }))].sort())
      .toEqual(['FS-03', 'WA-02', 'WA-05']);
    expect([...exclusionsFor(context({ scope: { type: 'result', resultId: 'n-o1' }, existingIndicators: existing, pendingSuggestions: pending, orgPreferences: prefs }))].sort())
      .toEqual(['FS-03', 'WA-02']);
    const alternatives = context({
      scope: { type: 'alternatives', indicatorId: null, suggestionId: 's-9' }, existingIndicators: existing, pendingSuggestions: pending, orgPreferences: prefs,
      alternativesFor: { kind: 'suggestion', id: 's-9', resultId: 'n-o1', name: 'x', nameAr: null, definition: null, unit: null, method: null, libraryId: 'WA-06', reason: 'rejected', rejectReason: 'wording', problems: [] },
    });
    expect([...exclusionsFor(alternatives)].sort()).toEqual(['FS-03', 'WA-02', 'WA-03', 'WA-06']);
  });
});

// ------------------------------------------------------------------ warnings, score, band

describe('warnings, quality score and band', () => {
  /** The English texts of design section 9.6 (the frontend's en.json must hold the same strings). */
  const EXPECTED: Array<[KpiWarningCode, Record<string, string | number>, string]> = [
    ['library_id_unknown', { libraryId: 'XX-99' }, 'Library id XX-99 does not exist, so this is treated as a custom indicator.'],
    ['custom_reason_missing', {}, 'Custom indicator without a reason.'],
    ['target_in_name', {}, 'Move the target out of the name.'],
    ['double_barrelled', {}, 'The name may measure two things at once.'],
    ['percent_without_calculation', {}, 'A percentage needs a numerator and a denominator.'],
    ['sex_keys_from_library', { keys: 'sex_of_household_head' }, 'Sex disaggregation added from the library entry (sex_of_household_head).'],
    ['sex_added', {}, 'Sex disaggregation added because the indicator counts people.'],
    ['baseline_not_found', {}, 'The baseline was not found in the documents and was removed (pending baseline).'],
    ['target_not_found', {}, 'The target was not found in the documents; a target-setting method is proposed instead.'],
    ['standard_threshold_not_found', {}, 'The standard threshold was not found in the library entry; a target-setting method is proposed instead.'],
    ['target_method_default', {}, 'The target-setting method was replaced by the default: set after the baseline.'],
    ['output_survey_method', {}, 'Outputs are usually counted from records.'],
    ['impact_not_secondary', {}, 'Impact indicators usually use secondary data.'],
    ['arabic_name_missing', {}, 'The Arabic name is missing.'],
    ['arabic_name_from_library', {}, 'The Arabic name was taken from the library entry.'],
    ['donor_cap_exceeded', { code: 'O1', count: 4, cap: 3 }, 'O1 now has 4 indicators; the donor allows 3.'],
    ['generic_means_of_verification', {}, 'The means of verification is too general; to be confirmed by the M&E officer.'],
    ['figures_unverified', { figures: '37%' }, 'Text with numbers not found in the documents or the library was removed: 37%.'],
    ['level_adjusted', { level: 'outcome', code: 'O1' }, 'Level changed to outcome to match result O1.'],
    ['level_mismatch_library', { libraryId: 'FS-04', entryLevel: 'output', level: 'outcome', code: 'O1' },
      'Library indicator FS-04 is an output indicator; O1 is an outcome. Check that it measures this level.'],
    ['model_note', { message: 'O2 has no measurable change.' }, 'AI note: O2 has no measurable change.'],
    ['unknown_result', { code: 'O9' }, 'A suggestion for an unknown result (O9) was dropped.'],
    ['rejected_library_dropped', { libraryId: 'WA-03' }, 'A suggestion using WA-03 was dropped because your organisation rejected it.'],
    ['duplicate_in_run', { code: 'O1' }, 'A repeated suggestion for O1 was dropped.'],
    ['near_duplicate', { name: 'Number of kits' }, '“Number of kits” was dropped because it repeats an existing indicator.'],
    ['result_cap', { code: 'O1', cap: 3, dropped: 1 }, 'O1: kept 3 indicators per result (donor or level limit); 1 more dropped.'],
    ['accountability_added', { libraryId: 'AC-01', code: 'O1' }, 'Humanitarian project without an accountability indicator: AC-01 was added to O1.'],
    ['accountability_missing', {}, 'Humanitarian project without an accountability indicator.'],
    ['result_failed', { code: 'O2' }, 'No suggestions for O2: the AI answer could not be used or came too late. Try this result again.'],
    ['result_empty', { code: 'O2.1' }, 'No suggestions were kept for O2.1. Ask for suggestions for this result again or add an indicator yourself.'],
    ['keyword_fallback', {}, 'Semantic search is not available, so candidates were matched by keywords.'],
  ];

  it('warning(code, params).message equals the English text of design 9.6 for every code', () => {
    expect(EXPECTED.map(([code]) => code).sort()).toEqual([...KPI_WARNING_CODES].sort());
    for (const [code, params, message] of EXPECTED) expect(warning(code, params).message).toBe(message);
  });

  it('penalties are exactly the spec four; info notes are marked info', () => {
    for (const code of KPI_WARNING_CODES) expect(warning(code).penalty).toBe(KPI_PENALTIES[code] ?? 0);
    expect(warning('custom_reason_missing').penalty).toBe(10);
    expect(warning('target_in_name').penalty).toBe(15);
    expect(warning('double_barrelled').penalty).toBe(10);
    expect(warning('percent_without_calculation').penalty).toBe(15);
    expect(warning('figures_unverified').penalty).toBe(0);
    for (const code of ['sex_keys_from_library', 'sex_added', 'target_method_default', 'output_survey_method', 'impact_not_secondary', 'level_adjusted', 'arabic_name_from_library', 'keyword_fallback'] as const) {
      expect(warning(code).severity).toBe('info');
    }
    expect(warning('result_cap', { code: 'O1', cap: 3, dropped: 1 })).toEqual({
      code: 'result_cap', severity: 'warning', message: 'O1: kept 3 indicators per result (donor or level limit); 1 more dropped.',
      params: { code: 'O1', cap: 3, dropped: 1 }, penalty: 0,
    });
  });

  it('score = 100 − penalties with a floor of 0; bands at 64/65/84/85', () => {
    expect(qualityScore([])).toBe(100);
    expect(qualityScore([warning('target_in_name'), warning('double_barrelled'), warning('sex_added')])).toBe(75);
    expect(qualityScore(Array.from({ length: 8 }, () => warning('target_in_name')))).toBe(0);
    expect(qualityBand(100)).toBe('strong');
    expect(qualityBand(85)).toBe('strong');
    expect(qualityBand(84)).toBe('review');
    expect(qualityBand(65)).toBe('review');
    expect(qualityBand(64)).toBe('weak');
    expect(qualityBand(0)).toBe('weak');
    expect(QUALITY_THRESHOLDS).toEqual({ strong: 85, review: 65 });
  });

  it('a clean suggestion has no warning and scores 100 (strong)', () => {
    const s = validate(raw());
    expect(s.warnings).toEqual([]);
    expect(s).toMatchObject({ qualityScore: 100, qualityBand: 'strong', resultId: 'n-o1', resultCode: 'O1', level: 'outcome', libraryId: 'WA-02', isCustom: false, origin: 'model', rank: 1 });
  });
});

// ------------------------------------------------------------------ design 1.5, one it per rule row

describe('validateSuggestion: rules x1, 1–16, x2–x5', () => {
  it('rule x1: an unknown or out-of-scope result code is dropped; codes compare by codeKey', () => {
    expect(dropped(raw({ resultCode: 'O9' }))).toMatchObject({ code: 'unknown_result', params: { code: 'O9' }, penalty: 0 });
    expect(dropped(raw({ resultCode: 'O2' }), context({ scope: { type: 'result', resultId: 'n-o1' } })).code).toBe('unknown_result');
    expect(validate(raw({ resultCode: ' o 1 ' })).resultId).toBe('n-o1');
    // A full result is out of scope too (allowance 0).
    const full = context({ existingIndicators: [1, 2, 3, 4].map(i => indicator({ id: `i${i}` })) });
    expect(dropped(raw(), full).code).toBe('unknown_result');
    expect(dropped(raw({ resultCode: 'Call 0599123456' })).params.code).not.toMatch(/0599/);
  });

  it('rule 1: an unknown library id becomes a custom indicator (warning, no penalty); excluded ids drop the suggestion', () => {
    const s = validate(raw({ libraryId: 'XX-99', customReason: 'Nothing in the library fits.' }));
    expect(s).toMatchObject({ libraryId: null, isCustom: true, customReason: 'Nothing in the library fits.' });
    expect(find(s.warnings, 'library_id_unknown')).toMatchObject({ params: { libraryId: 'XX-99' }, penalty: 0 });
    expect(s.qualityScore).toBe(100);
    expect(s.draft.libraryId).toBeNull();
    expect(validate(raw({ libraryId: 'wa-02' })).libraryId).toBe('WA-02');
    // Not in spec: an id the organisation rejected drops the whole suggestion (keeping it as custom would undo the rejection).
    expect(dropped(raw(), context({ orgPreferences: { rejectedLibraryIds: ['WA-02'], preferredMethods: [] } })))
      .toMatchObject({ code: 'rejected_library_dropped', params: { libraryId: 'WA-02' } });
    // An id already used by an indicator of the result repeats it.
    expect(dropped(raw(), context({ existingIndicators: [indicator({ libraryId: 'WA-02' })] })).code).toBe('near_duplicate');
  });

  it('rule 2: a custom indicator without a reason costs 10; a valid library id wins over isCustom', () => {
    const s = validate(customRaw({ customReason: '  ' }));
    expect(find(s.warnings, 'custom_reason_missing')?.penalty).toBe(10);
    expect(s).toMatchObject({ qualityScore: 90, qualityBand: 'strong', isCustom: true, customReason: '' });
    expect(validate(customRaw()).warnings).toEqual([]);
    const linked = validate(raw({ isCustom: true, customReason: 'Model said custom.' }));
    expect(linked).toMatchObject({ isCustom: false, libraryId: 'WA-02', customReason: '' });
    expect(codes(linked.warnings)).not.toContain('custom_reason_missing');
    // A null library id is custom whatever isCustom says.
    expect(validate(customRaw({ isCustom: false, customReason: '' })).isCustom).toBe(true);
  });

  it('rule 3: a target or direction in the name costs 15', () => {
    const s = validate(raw({ name: 'Increase the % of households using a basic drinking water service to 80%' }));
    expect(find(s.warnings, 'target_in_name')?.penalty).toBe(15);
    expect(s).toMatchObject({ qualityScore: 85, qualityBand: 'strong' });
    const ar = validate(raw({ nameAr: 'زيادة نسبة الأسر التي تستخدم خدمة مياه شرب أساسية' }));
    expect(codes(ar.warnings)).toContain('target_in_name');
    expect(codes(validate(raw({ name: '% of households using at least 15 litres of water per person per day' })).warnings)).not.toContain('target_in_name');
  });

  it('rule 4: a double-barrelled name costs 10', () => {
    const s = validate(customRaw({ name: '% of households with water and % with soap', unit: 'percent', numerator: 'Households with both', denominator: 'Households surveyed', resultCode: 'O2', level: 'outcome', method: 'hh_survey' }));
    expect(find(s.warnings, 'double_barrelled')?.penalty).toBe(10);
    expect(s.qualityScore).toBe(90);
  });

  it('rule 5: a percentage with an empty numerator or denominator costs 15 (checked before the calculation is completed)', () => {
    const s = validate(raw({ numerator: '', denominator: 'All surveyed target households' }));
    expect(find(s.warnings, 'percent_without_calculation')?.penalty).toBe(15);
    expect(s.qualityScore).toBe(85);
    expect(s.draft.calculation).toMatchObject({ numerator: TO_BE_CONFIRMED, denominator: 'All surveyed target households', formula: 'numerator ÷ denominator × 100', rounding: TO_BE_CONFIRMED });
    expect(s.numerator).toBe(TO_BE_CONFIRMED);
    expect(codes(validate(customRaw({ numerator: '', denominator: '' })).warnings)).not.toContain('percent_without_calculation');
    // The name decides too ("% of …" with another unit).
    expect(codes(validate(customRaw({ name: '% of deliveries on time', unit: 'number', numerator: '', denominator: '' })).warnings)).toContain('percent_without_calculation');
  });

  it('rule 6: the library sex key replaces the other sex key (D16) with an info note', () => {
    const household = validate(raw({ libraryId: 'FS-01', name: '% of target households with an acceptable Food Consumption Score', nameAr: 'نسبة الأسر المستهدفة التي لديها درجة استهلاك غذائي مقبولة', disaggregation: ['sex', 'location'] }));
    expect(household.disaggregation).toEqual(['sex_of_household_head', 'location']);
    expect(household.draft.disaggregation).toEqual(['sex_of_household_head', 'location']);
    expect(find(household.warnings, 'sex_keys_from_library')).toMatchObject({ severity: 'info', penalty: 0, params: { keys: 'sex_of_household_head' } });
    expect(codes(household.warnings)).not.toContain('sex_added');
    const people = validate(raw({ libraryId: 'AC-01', name: '% of assisted people who know how to give feedback or make a complaint', nameAr: 'نسبة المستفيدين الذين يعرفون كيفية تقديم ملاحظة أو شكوى', disaggregation: ['sex_of_household_head', 'age'] }));
    expect(people.disaggregation).toEqual(['sex', 'age']);
    expect(codes(people.warnings)).toContain('sex_keys_from_library');
    // Nothing to add or replace: no note.
    expect(codes(validate(raw()).warnings)).not.toContain('sex_keys_from_library');
  });

  it('rule 7: a people-level indicator without sex gets sex (info note)', () => {
    const s = validate(youthCount({ disaggregation: ['age'] }));
    expect(s.disaggregation).toEqual(['sex', 'age']);
    expect(find(s.warnings, 'sex_added')).toMatchObject({ severity: 'info', penalty: 0 });
    expect(codes(validate(customRaw()).warnings)).not.toContain('sex_added'); // deliveries are not people
    const arabicOnly = validate(customRaw({ name: 'Trained per cohort', nameAr: 'عدد المتدربين في كل دورة', disaggregation: [] }));
    expect(arabicOnly.disaggregation).toEqual(['sex']);
  });

  it('rule 8: a document target is kept only from a target (or mixed) fact, unit-consistent and standing alone in the full text', () => {
    const ctx = withDocuments();
    const kept = validate(lv01({ targetSuggestion: '60%', targetBasis: 'document' }), ctx);
    expect(kept).toMatchObject({ targetSuggestion: '60%', targetBasis: 'document', sources: { baseline: null, target: 'logframe.xlsx' } });
    expect(kept.targetJustification).toContain('(source: logframe.xlsx)');
    expect(kept.draft.targetValue).toBe('60%');
    expect(kept.warnings).toEqual([]);
    expect(validate(lv01({ targetSuggestion: '60', targetBasis: 'document' }), ctx).targetSuggestion).toBe('60');

    // CASE-02 "900" is a count: never a target of a percent indicator.
    const wrongUnit = validate(lv01({ targetSuggestion: '900', targetBasis: 'document' }), ctx);
    expect(wrongUnit).toMatchObject({ targetBasis: 'method_only', targetSuggestion: `Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.` });
    expect(wrongUnit.draft.targetValue).toBeNull();
    expect(find(wrongUnit.warnings, 'target_not_found')).toMatchObject({ penalty: 0, severity: 'warning' });
    expect(codes(wrongUnit.warnings)).not.toContain('target_method_default');
    // …and "60%" never the target of a count.
    expect(codes(validate(youthCount({ targetSuggestion: '60', targetBasis: 'document' }), ctx).warnings)).toContain('target_not_found');
    expect(validate(youthCount({ targetSuggestion: '900', targetBasis: 'document' }), ctx).targetSuggestion).toBe('900');
    // CASE-01: "18" water points is a target.
    expect(validate(customRaw({ libraryId: 'WA-06', name: 'Number of water points constructed or rehabilitated and functional at handover', targetSuggestion: '18', targetBasis: 'document' }), ctx).targetSuggestion).toBe('18');
    // Mixed fact: 75 is the target part, 45 the baseline part.
    expect(validate(raw({ targetSuggestion: '75%', targetBasis: 'document' }), ctx).targetSuggestion).toBe('75%');
    expect(codes(validate(raw({ targetSuggestion: '45%', targetBasis: 'document' }), ctx).warnings)).toContain('target_not_found');
    // A value not in any fact.
    expect(codes(validate(raw({ targetSuggestion: '80%', targetBasis: 'document' }), ctx).warnings)).toContain('target_not_found');
  });

  it('rule 9: a document baseline is kept only from a baseline (or mixed) fact; a target sentence never supplies a baseline', () => {
    const ctx = withDocuments();
    const fromTarget = validate(lv01({ baselineSuggestion: '60%', baselineBasis: 'document' }), ctx);
    expect(fromTarget).toMatchObject({ baselineSuggestion: '', baselineBasis: 'none', sources: { baseline: null, target: null } });
    expect(fromTarget.baselineMethod).toBe(`${TO_BE_CONFIRMED}. Baseline date: to be confirmed.`);
    expect(find(fromTarget.warnings, 'baseline_not_found')?.penalty).toBe(0);
    // CASE-01 "18" is a target, never a baseline.
    const eighteen = validate(customRaw({ libraryId: 'WA-06', name: 'Number of water points constructed or rehabilitated and functional at handover', baselineSuggestion: '18', baselineBasis: 'document' }), ctx);
    expect(eighteen.baselineBasis).toBe('none');
    expect(codes(eighteen.warnings)).toContain('baseline_not_found');
    // Mixed: 45 is the baseline part, 75 the target part.
    expect(validate(raw({ baselineSuggestion: '45%', baselineBasis: 'document' }), ctx).baselineSuggestion).toBe('45%');
    expect(codes(validate(raw({ baselineSuggestion: '75%', baselineBasis: 'document' }), ctx).warnings)).toContain('baseline_not_found');
  });

  it('rules 8–9 (D14): a hand-cut excerpt never supplies a cut number; null-kind facts and missing full texts supply nothing', () => {
    const docText = 'Water access baseline report. The household survey found that 22.5% of households had access to safe water.';
    const cut: DocumentFact = { documentId: 'doc-c', fileName: 'survey.pdf', kind: 'baseline', excerpt: 'The household survey found that 22' };
    const ctx = context({ documentFacts: [cut], documentTexts: [{ documentId: 'doc-c', fileName: 'survey.pdf', text: docText }] });
    const count = validate(customRaw({ resultCode: 'O1', level: 'outcome', name: 'Number of households with access to safe water', baselineSuggestion: '22', baselineBasis: 'document', method: 'hh_survey' }), ctx);
    expect(count.baselineBasis).toBe('none');
    expect(codes(count.warnings)).toContain('baseline_not_found');
    expect(documentValueSupported('22', 'baseline', false, [cut], ctx.documentTexts)).toBeNull();
    const whole: DocumentFact = { ...cut, excerpt: 'The household survey found that 22.5% of households had access to safe water.' };
    expect(documentValueSupported('22.5%', 'baseline', true, [whole], ctx.documentTexts)).toEqual({ fact: whole, source: 'survey.pdf' });
    expect(documentValueSupported('22', 'baseline', true, [whole], ctx.documentTexts)).toBeNull();
    const contextOnly: DocumentFact = { ...whole, kind: null };
    expect(documentValueSupported('22.5%', 'baseline', true, [contextOnly], ctx.documentTexts)).toBeNull();
    expect(documentValueSupported('22.5%', 'baseline', true, [whole], [])).toBeNull();
    // The excerpt must be in the full text.
    expect(documentValueSupported('22.5%', 'baseline', true, [{ ...whole, excerpt: 'A survey we never uploaded found 22.5% of households.' }], ctx.documentTexts)).toBeNull();
  });

  it('valueKindInFact: each value takes the kind of the nearest cue in its clause, before it first (EN and AR)', () => {
    const at = (fact: DocumentFact, value: string) => standaloneValueOffsets(fact.excerpt, value)[0].start;
    expect(valueKindInFact(MIXED_FACT, at(MIXED_FACT, '45'))).toBe('baseline');
    expect(valueKindInFact(MIXED_FACT, at(MIXED_FACT, '75'))).toBe('target');
    // No cue before the value in its clause: the nearest cue after it ("45% … currently treat water").
    const after: DocumentFact = { ...MIXED_FACT, excerpt: '45% of households currently treat water and the project will raise this to 75%.' };
    expect(valueKindInFact(after, at(after, '45'))).toBe('baseline');
    expect(valueKindInFact(after, at(after, '75'))).toBe('target');
    expect(valueKindInFact(CASE02_FACT, 0)).toBe('target');
    expect(valueKindInFact({ ...CASE02_FACT, kind: null }, 40)).toBeNull();
    const arabic: DocumentFact = { documentId: 'd', fileName: 'f.pdf', kind: 'mixed', excerpt: 'أظهر المسح أن ٤٥٪ من الأسر تعالج المياه، والمستهدف ٧٥٪ بحلول عام ٢٠٢٧.' };
    expect(valueKindInFact(arabic, at(arabic, '45'))).toBe('baseline');
    expect(valueKindInFact(arabic, at(arabic, '75'))).toBe('target');
    // "المستهدفة" (targeted) is not the cue "المستهدف".
    const targeted: DocumentFact = { ...arabic, excerpt: 'حاليا تحصل الأسر المستهدفة على ٤٥٪ من حاجتها.' };
    expect(valueKindInFact(targeted, at(targeted, '45'))).toBe('baseline');
    // "target households" is an adjective, not a target cue: the 45 stays a baseline (same matcher as factKind).
    const adjective: DocumentFact = { documentId: 'd', fileName: 'f.pdf', kind: 'mixed',
      excerpt: 'The baseline survey found that among target households 45% treat water; the target is 75% by 2027.' };
    expect(factKind(adjective.excerpt)).toBe('mixed');
    expect(valueKindInFact(adjective, at(adjective, '45'))).toBe('baseline');
    expect(valueKindInFact(adjective, at(adjective, '75'))).toBe('target');
  });

  it('factsFiguresFor returns one verified figure per supported document value, with the kind of the field', () => {
    const figures = factsFiguresFor(raw({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '75%', targetBasis: 'document' }), withDocuments());
    expect(figures).toEqual([
      { resultCode: 'O1', kind: 'baseline', value: '45%', description: '', quote: MIXED_FACT.excerpt, source: 'baseline.pdf' },
      { resultCode: 'O1', kind: 'target', value: '75%', description: '', quote: MIXED_FACT.excerpt, source: 'baseline.pdf' },
    ]);
    expect(factsFiguresFor(raw({ baselineSuggestion: '45%', baselineBasis: 'none', targetSuggestion: '75%', targetBasis: 'method_only' }), withDocuments())).toEqual([]);
  });

  it('rule 10: a kept document value cites its file (then the Phase 3 tails, D15)', () => {
    const s = validate(raw({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '75%', targetBasis: 'document' }), withDocuments());
    expect(s.baselineMethod).toContain('(source: baseline.pdf)');
    expect(s.baselineMethod).toContain('Baseline date: to be confirmed.');
    expect(s.targetJustification).toContain('(source: baseline.pdf)');
    expect(s.targetJustification).toContain('Intermediate targets: to be confirmed after the baseline.');
    expect(s).toMatchObject({ baselineBasis: 'document', targetBasis: 'document', sources: { baseline: 'baseline.pdf', target: 'baseline.pdf' } });
    expect(s.draft).toMatchObject({ baselineValue: '45%', targetValue: '75%', baselineDate: null, intermediateTargets: [] });
  });

  it('rule 11: a standard threshold must appear in the linked entry\'s own text; the model\'s code is never evidence', () => {
    const wa01 = (overrides: Partial<KpiRawSuggestion>) => raw({ libraryId: 'WA-01', name: 'Average volume of water available per person per day in target households', nameAr: 'متوسط كمية المياه المتاحة للفرد يومياً في الأسر المستهدفة', unit: 'litres_per_person_per_day', numerator: '', denominator: '', disaggregation: ['location', 'sex'], ...overrides });
    const kept = validate(wa01({ targetSuggestion: '15', targetBasis: 'standard_threshold' }));
    expect(kept).toMatchObject({ targetSuggestion: '15', targetBasis: 'standard_threshold', standardReferenceCode: 'Sphere Water supply standard — minimum 15 l/p/d (aim for 20)', sources: { target: null } });
    expect(kept.targetJustification).toMatch(/^Proposed standard threshold \(Sphere Water supply standard/);
    const notInEntry = validate(wa01({ targetSuggestion: '25', targetBasis: 'standard_threshold' }));
    expect(notInEntry).toMatchObject({ targetBasis: 'method_only' });
    expect(find(notInEntry.warnings, 'standard_threshold_not_found')?.penalty).toBe(0);
    const custom = validate(customRaw({ targetSuggestion: '15', targetBasis: 'standard_threshold', standardReferenceCode: 'Sphere minimum 15 litres' }));
    expect(custom.targetBasis).toBe('method_only');
    expect(codes(custom.warnings)).toContain('standard_threshold_not_found');
  });

  it('rule 12: a method that is not based on the baseline, or holds an absolute figure, becomes the default (info note)', () => {
    const absolute = validate(raw({ targetSuggestion: 'Increase from baseline to 75% by 2027', targetBasis: 'method_only' }));
    const defaultSentence = `Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`;
    expect(absolute.targetSuggestion).toBe(defaultSentence);
    expect(absolute.targetJustification.startsWith(defaultSentence)).toBe(true);
    expect(absolute.targetJustification).not.toContain('75');
    expect(absolute.draft.targetJustification).not.toContain('75');
    expect(find(absolute.warnings, 'target_method_default')).toMatchObject({ severity: 'info', penalty: 0 });
    const relative = validate(raw({ targetSuggestion: 'baseline + 10 percentage points', targetBasis: 'method_only' }));
    expect(relative.targetSuggestion).toBe('Proposed method: baseline + 10 percentage points — confirm after baseline.');
    expect(relative).toMatchObject({ targetBasis: 'method_only', warnings: [] });
    expect(codes(validate(raw({ targetSuggestion: 'improve access over the project', targetBasis: 'method_only' })).warnings)).toContain('target_method_default');
    expect(codes(validate(raw({ targetSuggestion: '75', targetBasis: 'method_only' })).warnings)).toContain('target_method_default');
    const empty = validate(raw({ targetSuggestion: '', targetBasis: 'method_only' }));
    expect(empty.targetSuggestion).toBe(defaultSentence);
    expect(codes(empty.warnings)).not.toContain('target_method_default');
  });

  it('rule 12: methodHasAbsoluteFigure', () => {
    expect(methodHasAbsoluteFigure('Increase from baseline to 75% by 2027')).toBe(true);
    expect(methodHasAbsoluteFigure('baseline value, then 80 households')).toBe(true);
    expect(methodHasAbsoluteFigure('baseline + 10 percentage points')).toBe(false);
    expect(methodHasAbsoluteFigure('baseline ± 5 percentage points by 2027')).toBe(false);
    expect(methodHasAbsoluteFigure('15 percentage points above the baseline')).toBe(false);
    expect(methodHasAbsoluteFigure('10% above baseline, consistent with similar programmes')).toBe(false);
    expect(methodHasAbsoluteFigure('١٠ نقاط مئوية فوق خط الأساس')).toBe(false);
    expect(methodHasAbsoluteFigure('خط الأساس + ١٠')).toBe(false);
    expect(methodHasAbsoluteFigure('الوصول إلى ٧٥٪ من خط الأساس')).toBe(true);
    expect(methodHasAbsoluteFigure('reach 75%')).toBe(false); // no baseline: resolveBaselineAndTarget replaces it already
    expect(methodHasAbsoluteFigure('set after the baseline survey, using comparable programmes')).toBe(false);
  });

  it('rule 13: the linked entry\'s standard reference wins over the model\'s code', () => {
    const wa04 = validate(raw({ resultCode: 'O1.1', level: 'output', libraryId: 'WA-04', name: 'Number of people with access to improved drinking water and/or sanitation as a result of the project', nameAr: 'عدد الأشخاص الذين حصلوا على مياه شرب و/أو خدمات صرف صحي محسّنة بفضل المشروع', unit: 'number', numerator: '', denominator: '', disaggregation: ['sex', 'location'], method: 'document_review', standardReferenceCode: 'GERF 9.99' }));
    expect(wa04.standardReferenceCode).toBe('EU GERF 2.38');
    expect(wa04.draft.standardReferenceCode).toBe('EU GERF 2.38');
    // SPEC-4: a custom suggestion never keeps the model's code (it would show as donor-standard).
    expect(validate(customRaw({ standardReferenceCode: 'IASC MHPSS O5.4' })).standardReferenceCode).toBeNull();
    expect(validate(customRaw({ standardReferenceCode: '' })).standardReferenceCode).toBeNull();
  });

  it('rule 14: text after ---AI_ANALYSIS--- is never evidence', () => {
    const fact: DocumentFact = { documentId: 'doc-x', fileName: 'notes.pdf', kind: 'target', excerpt: 'Training plan for the cohort.\n---AI_ANALYSIS---\nThe target is 75% employment.' };
    const ctx = context({ documentFacts: [fact], documentTexts: [{ documentId: 'doc-x', fileName: 'notes.pdf', text: fact.excerpt }] });
    expect(excerptSupportsValue(fact.excerpt, '75%')).toBe(false);
    expect(codes(validate(lv01({ targetSuggestion: '75%', targetBasis: 'document' }), ctx).warnings)).toContain('target_not_found');
  });

  it('rule 15: an output measured by household survey gets an info note', () => {
    const s = validate(customRaw({ method: 'hh_survey' }));
    expect(find(s.warnings, 'output_survey_method')).toMatchObject({ severity: 'info', penalty: 0 });
    expect(codes(validate(customRaw()).warnings)).not.toContain('output_survey_method');
  });

  it('rule 16: an impact indicator not using secondary data gets an info note', () => {
    const impact = (method: KpiRawSuggestion['method']) => validate(customRaw({ resultCode: 'G', level: 'impact', name: 'Incidence of acute watery diarrhoea in target localities', nameAr: 'معدل الإصابة بالإسهال المائي الحاد في المناطق المستهدفة', method, unit: 'number' }));
    expect(find(impact('hh_survey').warnings, 'impact_not_secondary')).toMatchObject({ severity: 'info', penalty: 0 });
    expect(codes(impact('secondary_data').warnings)).not.toContain('impact_not_secondary');
  });

  it('rule x2: the result\'s level wins (info note)', () => {
    const s = validate(raw({ level: 'output' }));
    expect(s.level).toBe('outcome');
    expect(s.draft.level).toBe('outcome');
    expect(find(s.warnings, 'level_adjusted')).toMatchObject({ severity: 'info', params: { level: 'outcome', code: 'O1' } });
  });

  it('rule x3: a missing or non-Arabic Arabic name comes from the linked entry, else a warning', () => {
    const fromLibrary = validate(raw({ nameAr: '' }));
    expect(fromLibrary.nameAr).toBe(entry('WA-02').nameAr);
    expect(fromLibrary.draft.indicatorTextAr).toBe(entry('WA-02').nameAr);
    expect(find(fromLibrary.warnings, 'arabic_name_from_library')?.severity).toBe('info');
    expect(validate(raw({ nameAr: 'Households using basic water' })).nameAr).toBe(entry('WA-02').nameAr);
    const custom = validate(customRaw({ nameAr: 'Number of deliveries' }));
    expect(custom.nameAr).toBe('');
    expect(custom.draft.indicatorTextAr).toBeNull();
    expect(find(custom.warnings, 'arabic_name_missing')).toMatchObject({ severity: 'warning', penalty: 0 });
  });

  it('rule x4: a generic means of verification is flagged and left to the M&E officer', () => {
    const s = validate(customRaw({ meansOfVerification: 'Project reports' }));
    expect(find(s.warnings, 'generic_means_of_verification')?.penalty).toBe(0);
    expect(s.meansOfVerification).toBe(TO_BE_CONFIRMED);
    expect(s.draft.meansOfVerification).toBe(TO_BE_CONFIRMED);
  });

  it('rule x5: model free text is redacted and sentences with unverified figures are removed (no penalty)', () => {
    const s = validate(customRaw({
      rationale: 'Fits this output. About 37% of households lack water. It covers the 24,000 people the project targets.',
      customReason: 'No library indicator counts deliveries. Costs 1250 shekels per truck.',
      qualityNotes: ['Check the log weekly.', 'Expect 812 deliveries.'],
      definition: 'Deliveries confirmed by 3 signatures and 450 litres each.',
      meansOfVerification: 'Delivery notes; call 0599123456 for copies',
    }));
    expect(s.rationale).toBe('Fits this output. It covers the 24,000 people the project targets.');
    expect(s.customReason).toBe('No library indicator counts deliveries.');
    expect(s.qualityNotes).toEqual(['Check the log weekly.']);
    expect(s.definition).toBe(TO_BE_CONFIRMED);
    expect(s.draft.definition).toBe(TO_BE_CONFIRMED);
    expect(s.meansOfVerification).toBe('Delivery notes; call [phone removed] for copies');
    const note = find(s.warnings, 'figures_unverified');
    expect(note).toMatchObject({ penalty: 0, severity: 'warning' });
    expect(String(note?.params.figures).split(', ')).toEqual(expect.arrayContaining(['37%', '1250', '812', '450']));
    expect(s.qualityScore).toBe(100);
    // A phone number never reaches the suggestion or its draft.
    const phone = validate(customRaw({ name: 'Number of deliveries reported to 0599123456', rationale: 'Call 0599 123 456 to confirm. Fits this output.', customReason: 'Reason with +970599123456.' }));
    expect(JSON.stringify(phone)).not.toMatch(/0599|970599/);
    expect(phone.rationale).toContain('[phone removed]');
    // Figures the model was shown are allowed: a candidate's text, the documents, the project.
    expect(validate(raw({ rationale: 'Uses the JMP collection time of 30 minutes.' })).rationale).toBe('Uses the JMP collection time of 30 minutes.');
    expect(validate(raw({ rationale: 'The proposal plans 18 water points.' }), withDocuments()).rationale).toBe('The proposal plans 18 water points.');
  });

  it('withoutUnverifiedSentences keeps sentences with allowed figures, years and single digits', () => {
    expect(withoutUnverifiedSentences('Started in 2026. Has 3 parts. Covers 75% of sites. Covers 40 sites.', ['40 sites'])).toEqual({
      text: 'Started in 2026. Has 3 parts. Covers 40 sites.', removed: ['75%'],
    });
    expect(withoutUnverifiedSentences('', [])).toEqual({ text: '', removed: [] });
    expect(withoutUnverifiedSentences('Line one has 77.\nLine two is fine', [])).toEqual({ text: 'Line two is fine', removed: ['77'] });
  });

  it('builds the suggestion and its draft from the payload (design 4.2 step 8)', () => {
    const s = validate(raw(), context(), deps(), { rank: 3 });
    expect(s).toMatchObject({
      name: raw().name, unit: 'percent', direction: 'increase', method: 'hh_survey', frequency: 'biannual', confidence: 'high', rank: 3,
      baselineSuggestion: '', baselineBasis: 'none', baselineMethod: `${TO_BE_CONFIRMED}. Baseline date: to be confirmed.`,
    });
    expect(s.draft).toMatchObject({
      indicatorText: raw().name, resultId: 'n-o1', level: 'outcome', libraryId: 'WA-02', standardReferenceCode: 'WHO/UNICEF JMP Drinking water service ladder',
      startDate: '2026-11-01', endDate: '2027-10-31', assumptions: TO_BE_CONFIRMED, responsibility: TO_BE_CONFIRMED,
      aiRationale: raw().rationale, dataCollectionMethod: 'hh_survey',
    });
    expect(() => draftToCreateInput(s.draft)).not.toThrow();
    expect(validate(raw(), context(), deps(), { rank: 1, origin: 'appended_accountability' } as never).origin).toBe('appended_accountability');
  });
});

// ------------------------------------------------------------------ run-level rules

describe('run-level rules 17, 18, 19 and x6 (validateAndScore)', () => {
  const answer = (suggestions: KpiRawSuggestion[], frameworkWarnings: string[] = []) => ({ suggestions, frameworkWarnings });

  it('rule 17: per result keep the allowance, best first (confidence, score, library before custom, model order)', () => {
    const a = customRaw({ resultCode: 'O1', level: 'outcome', method: 'hh_survey', name: 'Custom A, high', confidence: 'high' });
    const b = customRaw({ resultCode: 'O1', level: 'outcome', method: 'hh_survey', name: 'Custom B, medium', confidence: 'medium' });
    const c = raw({ confidence: 'medium' });
    const d = customRaw({ resultCode: 'O1', level: 'outcome', method: 'hh_survey', name: 'Custom D increased to 90', confidence: 'medium' });
    const e = raw({ libraryId: 'WA-05', name: '% of target households with a handwashing facility with soap and water observed', nameAr: 'نسبة الأسر المستهدفة التي لديها مرفق لغسل اليدين', confidence: 'low' });
    const out = validateAndScore({ context: echo(), answer: answer([e, d, c, b, a]), deps: deps() });
    expect(out.suggestions.map(s => [s.name, s.rank])).toEqual([['Custom A, high', 1], [raw().name, 2], ['Custom B, medium', 3]]);
    expect(find(out.frameworkWarnings, 'result_cap')).toMatchObject({ params: { code: 'O1', cap: 3, dropped: 2 }, penalty: 0 });

    // applyResultCaps on its own: a framework run subtracts existing indicators (D10).
    const validated = [a, b, c].map((r, i) => validate(r, context(), deps(), { rank: i + 1 }));
    const capped = applyResultCaps(validated, context({ existingIndicators: [indicator(), indicator({ id: 'i2' }), indicator({ id: 'i3' })] }));
    expect(capped.kept.map(s => s.name)).toEqual(['Custom A, high']);
    expect(capped.warnings).toEqual([warning('result_cap', { code: 'O1', cap: 1, dropped: 2 })]);
    expect(applyResultCaps(validated, context()).warnings).toEqual([]);
  });

  it('rule 18: near-duplicates of existing indicators are dropped (normalised name, same library id, cosine ≥ 0.92)', () => {
    const sameName = indicator({ resultId: 'n-o2', name: '% of target households using at least a basic drinking-water service.' });
    const s = validate(raw());
    expect(dropDuplicates([s], context({ existingIndicators: [sameName] }))).toEqual({ kept: [], warnings: [warning('near_duplicate', { name: s.name })] });
    // Same library id on another result (result scope: not an exclusion, still a duplicate in the framework).
    const resultScope = context({ scope: { type: 'result', resultId: 'n-o1' }, existingIndicators: [indicator({ resultId: 'n-o2', libraryId: 'WA-02', name: 'Other wording' })] });
    const inResultScope = validate(raw(), resultScope);
    expect(dropDuplicates([inResultScope], resultScope).kept).toEqual([]);
    // Cosine of the English names.
    const similar = indicator({ resultId: 'n-o2', name: 'Share of households with basic drinking water' });
    const similarity = (x: string, y: string) => (y === similar.name && x === s.name ? NEAR_DUPLICATE_COSINE + 0.01 : 0.5);
    expect(dropDuplicates([s], context({ existingIndicators: [similar] }), similarity).kept).toEqual([]);
    expect(dropDuplicates([s], context({ existingIndicators: [similar] }), () => 0.5).kept).toEqual([s]);
    expect(dropDuplicates([s], context({ existingIndicators: [similar] }), () => null).kept).toEqual([s]);
    expect(dropDuplicates([s], context({ existingIndicators: [similar] })).kept).toEqual([s]);
  });

  it('TQ-06: the near-duplicate threshold is the spec\'s cosine 0.92, inclusive', () => {
    expect(NEAR_DUPLICATE_COSINE).toBe(0.92);
    const s = validate(raw());
    const similar = indicator({ resultId: 'n-o2', name: 'Share of households with basic drinking water' });
    const at = (cosine: number) => dropDuplicates([s], context({ existingIndicators: [similar] }), () => cosine).kept;
    expect(at(0.92)).toEqual([]);
    expect(at(0.9199)).toEqual([s]);
    expect(at(0.95)).toEqual([]);
  });

  it('rule 18: repeats within the run keep the better one; one library id measures one result (D12)', () => {
    const medium = validate(raw({ confidence: 'medium' }), context(), deps(), { rank: 1 });
    const high = validate(raw({ confidence: 'high', name: '% of households using a basic drinking water service' }), context(), deps(), { rank: 2 });
    const out = dropDuplicates([medium, high], context());
    expect(out.kept).toEqual([high]);
    expect(out.warnings).toEqual([warning('duplicate_in_run', { code: 'O1' })]);
    const sameName = validate(customRaw({ confidence: 'low' }), context(), deps(), { rank: 3 });
    const sameNameBetter = validate(customRaw({ confidence: 'high', libraryId: null }), context(), deps(), { rank: 4 });
    expect(dropDuplicates([sameName, sameNameBetter], context()).kept).toEqual([sameNameBetter]);
    // Same library id for O2 (model order first) and O1: the first in chain order (O1) is kept (D12, in applyResultCaps).
    const onO2 = validate(raw({ resultCode: 'O2' }), context(), deps(), { rank: 1 });
    const onO1 = validate(raw(), context(), deps(), { rank: 2 });
    expect(dropDuplicates([onO2, onO1], context()).kept).toEqual([onO2, onO1]);
    const across = applyResultCaps([onO2, onO1], context());
    expect(across.kept).toEqual([onO1]);
    expect(across.warnings).toEqual([warning('duplicate_in_run', { code: 'O2' })]);
  });

  it('rule 18: alternatives runs drop repeats of pending suggestions of the result; other runs expire those cards', () => {
    const source = { kind: 'suggestion' as const, id: 's-src', resultId: 'n-o1', name: 'Rejected wording', nameAr: null, definition: null, unit: 'percent', method: 'hh_survey' as const, libraryId: null, reason: 'rejected' as const, rejectReason: 'wording' as const, problems: [] };
    const pending = [{ id: 's-other', resultId: 'n-o1', libraryId: null, name: 'Number of water trucking deliveries completed' }];
    const alternatives = context({ scope: { type: 'alternatives', indicatorId: null, suggestionId: 's-src' }, alternativesFor: source, pendingSuggestions: pending });
    const repeat = validate(customRaw({ resultCode: 'O1', level: 'outcome', method: 'hh_survey' }), alternatives);
    expect(dropDuplicates([repeat], alternatives).kept).toEqual([]);
    const framework = context({ pendingSuggestions: pending });
    const kept = validate(customRaw(), framework);
    expect(dropDuplicates([kept], framework).kept).toEqual([kept]);
  });

  it('rule 19: a humanitarian framework without an accountability indicator gets AC-01 on the first outcome with room', () => {
    const out = validateAndScore({ context: humanitarian(), answer: answer([raw(), customRaw()]), deps: deps() });
    const appended = out.suggestions.find(s => s.origin === 'appended_accountability');
    expect(appended).toMatchObject({ libraryId: 'AC-01', resultCode: 'O1', resultId: 'n-o1', level: 'outcome', rank: 2, isCustom: false, targetBasis: 'method_only', confidence: 'medium' });
    expect(appended?.disaggregation).toContain('sex');
    expect(appended?.qualityScore).toBe(100);
    expect(find(out.frameworkWarnings, 'accountability_added')).toMatchObject({ params: { libraryId: 'AC-01', code: 'O1' }, penalty: 0 });
    expect(() => draftToCreateInput(appended!.draft)).not.toThrow();
  });

  it('rule 19: existing or kept accountability indicators count by id (not FS-06 or HE-04) or by custom wording', () => {
    const none = (ctx: ProjectContext, suggestions: KpiRawSuggestion[]) => validateAndScore({ context: ctx, answer: answer(suggestions), deps: deps() });
    const withExisting = none(humanitarian({ existingIndicators: [indicator({ resultId: 'n-o2', libraryId: 'AC-03', name: 'x' })] }), [raw()]);
    expect(withExisting.suggestions.some(s => s.origin === 'appended_accountability')).toBe(false);
    expect(codes(withExisting.frameworkWarnings)).not.toContain('accountability_missing');
    const fs06 = raw({ resultCode: 'O1.1', level: 'output', libraryId: 'FS-06', name: '% of assisted households reporting they received their full entitlement', nameAr: 'نسبة الأسر المستفيدة التي أفادت بحصولها على كامل استحقاقها', method: 'hh_survey', disaggregation: ['sex_of_household_head'] });
    const he04 = raw({ resultCode: 'O2', libraryId: 'HE-04', name: '% of patients reporting satisfaction with services at supported facilities', nameAr: 'نسبة المرضى الذين أفادوا برضاهم عن الخدمات', disaggregation: ['sex'] });
    expect(none(humanitarian(), [fs06, he04]).suggestions.some(s => s.libraryId === 'AC-01')).toBe(true);
    const customFeedback = customRaw({ resultCode: 'O2', level: 'outcome', method: 'hh_survey', name: '% of assisted people who know how to make a complaint', unit: 'percent', numerator: 'People who know', denominator: 'People sampled' });
    expect(none(humanitarian(), [customFeedback]).suggestions.some(s => s.origin === 'appended_accountability')).toBe(false);
  });

  it('rule 19: rejected AC entries are skipped; all rejected or no outcome in scope → accountability_missing', () => {
    const prefs = (ids: string[]) => ({ rejectedLibraryIds: ids, preferredMethods: [] });
    const next = validateAndScore({ context: humanitarian({ orgPreferences: prefs(['AC-01']) }), answer: answer([raw()]), deps: deps() });
    expect(next.suggestions.find(s => s.origin === 'appended_accountability')?.libraryId).toBe('AC-03');
    const all = validateAndScore({ context: humanitarian({ orgPreferences: prefs(['AC-01', 'AC-03', 'AC-04', 'AC-05']) }), answer: answer([raw()]), deps: deps() });
    expect(all.suggestions.some(s => s.origin === 'appended_accountability')).toBe(false);
    expect(codes(all.frameworkWarnings)).toContain('accountability_missing');
    const outputsOnly = humanitarian({ resultsChain: [RESULTS[2], RESULTS[4]].map(r => ({ ...r, parentId: null })) });
    const noOutcome = ensureAccountability([], outputsOnly, deps());
    expect(noOutcome).toEqual({ suggestions: [], warnings: [warning('accountability_missing')] });
  });

  it('rule 19: when every scoped outcome is full, the lowest-ranked suggestion of the fullest outcome is replaced', () => {
    const o1 = [raw({ confidence: 'high' }), raw({ libraryId: 'WA-01', name: 'Average volume of water available per person per day in target households', nameAr: 'متوسط كمية المياه المتاحة للفرد يومياً', unit: 'litres_per_person_per_day', numerator: '', denominator: '', disaggregation: ['location', 'sex'], confidence: 'medium' }), raw({ libraryId: 'WA-03', name: '% of water samples at point of delivery free of faecal coliforms', nameAr: 'نسبة عينات المياه الخالية من البكتيريا القولونية', disaggregation: ['location'], confidence: 'low' })];
    const o2 = [1, 2, 3].map(i => customRaw({ resultCode: 'O2', level: 'outcome', method: 'hh_survey', name: `Hygiene practice measure ${['one', 'two', 'three'][i - 1]}` }));
    const out = validateAndScore({ context: echo({ project: { ...context().project, humanitarian: true } }), answer: answer([...o1, ...o2]), deps: deps() });
    const onO1 = out.suggestions.filter(s => s.resultId === 'n-o1');
    expect(onO1.map(s => s.libraryId)).toEqual(['WA-02', 'WA-01', 'AC-01']);
    expect(out.suggestions.filter(s => s.resultId === 'n-o2')).toHaveLength(3);
    expect(codes(out.frameworkWarnings)).toEqual(expect.arrayContaining(['result_cap', 'accountability_added']));
  });

  it('rule 19: result scope only on an outcome; never for alternatives or non-humanitarian projects', () => {
    const onOutput = validateAndScore({ context: humanitarian({ scope: { type: 'result', resultId: 'n-o1.1' } }), answer: answer([customRaw()]), deps: deps() });
    expect(onOutput.suggestions.map(s => s.origin)).toEqual(['model']);
    expect(onOutput.frameworkWarnings).toEqual([]);
    const onOutcome = validateAndScore({ context: humanitarian({ scope: { type: 'result', resultId: 'n-o1' } }), answer: answer([raw()]), deps: deps() });
    expect(onOutcome.suggestions.map(s => s.libraryId)).toEqual(['WA-02', 'AC-01']);
    const source = { kind: 'indicator' as const, id: 'ind-1', resultId: 'n-o1', name: 'Existing indicator', nameAr: null, definition: null, unit: 'number', method: 'hh_survey' as const, libraryId: null, reason: 'requested' as const, rejectReason: null, problems: [] };
    const alternatives = validateAndScore({ context: humanitarian({ scope: { type: 'alternatives', indicatorId: 'ind-1', suggestionId: null }, alternativesFor: source, existingIndicators: [indicator()] }), answer: answer([raw()]), deps: deps() });
    expect(alternatives.suggestions.map(s => s.origin)).toEqual(['model']);
    expect(alternatives.frameworkWarnings).toEqual([]);
    expect(validateAndScore({ context: context(), answer: answer([raw()]), deps: deps() }).frameworkWarnings).toEqual([]);
  });

  it('rule x6: the model\'s notes become AI notes (≤ 10, redacted, ≤ 300 characters, unverified sentences removed)', () => {
    const notes = [
      'Outcome O2 has no measurable change.',
      'About 37% of households lack data. Consider a survey.',
      'Ask the field team at 0599123456.',
      '   ',
      `Long note ${'word '.repeat(100)}`,
      ...Array.from({ length: 10 }, (_, i) => `Extra note ${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'][i]}.`),
    ];
    const out = validateAndScore({ context: context(), answer: answer([], notes), deps: deps() });
    const aiNotes = out.frameworkWarnings.filter(w => w.code === 'model_note');
    expect(aiNotes.length).toBeLessThanOrEqual(10);
    expect(aiNotes[0]).toMatchObject({ message: 'AI note: Outcome O2 has no measurable change.', params: { message: 'Outcome O2 has no measurable change.' }, penalty: 0 });
    expect(aiNotes[1].params.message).toBe('Consider a survey.');
    expect(JSON.stringify(aiNotes)).not.toMatch(/0599/);
    expect(aiNotes.every(n => String(n.params.message).length <= 300)).toBe(true);
    expect(aiNotes.some(n => n.params.message === '')).toBe(false);
  });

  it('drops are framework warnings; suggestions come grouped by result in chain order and ranked 1..n', () => {
    const out = validateAndScore({
      context: context({ orgPreferences: { rejectedLibraryIds: ['WA-03'], preferredMethods: [] } }),
      answer: answer([customRaw(), raw({ resultCode: 'O7' }), raw({ libraryId: 'WA-03' }), raw({ resultCode: 'G', level: 'impact', libraryId: null, isCustom: true, customReason: 'Impact context.', name: 'Incidence of acute watery diarrhoea', nameAr: 'معدل الإصابة بالإسهال المائي الحاد', unit: 'number', numerator: '', denominator: '', disaggregation: ['location'], method: 'secondary_data' }), raw()]),
      deps: deps(),
    });
    expect(out.suggestions.map(s => [s.resultCode, s.rank])).toEqual([['G', 1], ['O1', 1], ['O1.1', 1]]);
    expect(codes(out.frameworkWarnings)).toEqual(['unknown_result', 'rejected_library_dropped']);
  });

  it('rawSuggestionFromLibrary copies the entry', () => {
    const r = rawSuggestionFromLibrary(entry('WA-02'), RESULTS[1], 'Why it fits.');
    expect(r).toMatchObject({
      resultCode: 'O1', level: 'outcome', libraryId: 'WA-02', isCustom: false, customReason: '', name: entry('WA-02').name, nameAr: entry('WA-02').nameAr,
      unit: 'percent', numerator: 'Households on the basic or safely managed rung', denominator: 'All surveyed target households',
      method: 'hh_survey', frequency: 'baseline_endline', baselineBasis: 'none', targetSuggestion: '', targetBasis: 'method_only',
      confidence: 'medium', rationale: 'Why it fits.', standardReferenceCode: 'WHO/UNICEF JMP Drinking water service ladder', qualityNotes: [],
    });
    expect(rawSuggestionFromLibrary(entry('WA-01'), RESULTS[1], '').numerator).toBe('');
  });

  it('drafts of 200 generated suggestions all pass parseIndicatorCreate', () => {
    let seed = 20261012;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const entries = Array.from(LIBRARY.values());
    const ctx = context({ documentFacts: [CASE02_FACT, CASE01_FACT, MIXED_FACT], documentTexts: DOCUMENTS, project: { ...context().project, humanitarian: true } });
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const result = pick(RESULTS);
      const base = rawSuggestionFromLibrary(pick(entries), result, pick(['Fits.', 'Fits the result. Uses 3 sources.', '']));
      const r: KpiRawSuggestion = {
        ...base,
        libraryId: pick([base.libraryId, null, 'xx-99', base.libraryId?.toLowerCase() ?? null]),
        name: pick([base.name, `${base.name} increased to 80%`, 'x'.repeat(1200), `Custom measure ${i}`, '']),
        nameAr: pick([base.nameAr, '', 'English only', 'ا'.repeat(1100)]),
        definition: pick([base.definition, '', 'Has 1234 units.']),
        unit: pick(INDICATOR_UNITS),
        numerator: pick(['', 'Some numerator', 'n'.repeat(1500)]),
        denominator: pick(['', 'Some denominator']),
        direction: pick(FRAMEWORK_DIRECTIONS),
        disaggregation: pick([[], ['Gender', 'PwD', 'bad key!', 'Age group'], ['x'.repeat(60)], Array.from({ length: 25 }, (_, k) => `group_${k}`), ['sex', 'sex', 'location']]),
        method: pick(FRAMEWORK_METHODS),
        frequency: pick(FRAMEWORK_FREQUENCIES),
        meansOfVerification: pick(['Project reports', '', 'Survey tool', 'm'.repeat(2500)]),
        baselineSuggestion: pick(['', '45%', '18', '60', 'yes']),
        baselineBasis: pick(['document', 'none'] as const),
        targetSuggestion: pick(['', '75%', '900', '15', 'baseline + 5 percentage points', 'Increase from baseline to 75% by 2027', 't'.repeat(300)]),
        targetBasis: pick(['document', 'standard_threshold', 'method_only', 'none'] as const),
        standardReferenceCode: pick([null, '', 'GERF 2.1', 's'.repeat(150)]),
        qualityNotes: pick([[], ['Note one.', 'Note with 999 figures.']]),
        confidence: pick(['high', 'medium', 'low'] as const),
        level: pick(['impact', 'outcome', 'output'] as const),
      };
      const out = validateSuggestion(r, ctx, deps(), { rank: i + 1 });
      if (!('suggestion' in out)) continue;
      checked++;
      expect(out.suggestion.draft.resultId).toBe(result.id);
      expect(out.suggestion.draft.level).toBe(result.level);
      expect(() => parseIndicatorCreate(out.suggestion.draft)).not.toThrow();
      expect(() => draftToCreateInput(out.suggestion.draft)).not.toThrow();
    }
    expect(checked).toBeGreaterThanOrEqual(150);
  });
});

// ------------------------------------------------------------------ trigger 3

describe('scoreExistingIndicator (trigger 3, M4)', () => {
  const clean = {
    indicatorText: '% of target households using at least a basic drinking water service', indicatorTextAr: entry('WA-02').nameAr,
    unit: 'percent', calculation: { numerator: 'Households on the basic rung', denominator: 'Households surveyed' }, meansOfVerification: 'JMP household survey',
  };

  it('a target in the name scores 85 (strong) and needs alternatives', () => {
    const out = scoreExistingIndicator({ ...clean, indicatorText: 'Increase households using a basic drinking water service to 80%' });
    expect(out).toMatchObject({ qualityScore: 85, qualityBand: 'strong', needsAlternatives: true });
    expect(codes(out.warnings)).toEqual(['target_in_name']);
  });

  it('info notes and zero-penalty warnings only: no alternatives', () => {
    expect(scoreExistingIndicator(clean)).toEqual({ qualityScore: 100, qualityBand: 'strong', warnings: [], needsAlternatives: false });
    const out = scoreExistingIndicator({ ...clean, indicatorTextAr: null, meansOfVerification: 'Project reports' });
    expect(codes(out.warnings)).toEqual(['arabic_name_missing', 'generic_means_of_verification']);
    expect(out).toMatchObject({ qualityScore: 100, needsAlternatives: false });
  });

  it('rules 4 and 5 on the stored name and calculation (to be confirmed counts as empty)', () => {
    const out = scoreExistingIndicator({ ...clean, indicatorText: '% of youth employed and satisfied', calculation: { numerator: TO_BE_CONFIRMED, denominator: 'Graduates' } });
    expect(codes(out.warnings)).toEqual(['double_barrelled', 'percent_without_calculation']);
    expect(out).toMatchObject({ qualityScore: 75, qualityBand: 'review', needsAlternatives: true });
    expect(codes(scoreExistingIndicator({ ...clean, calculation: null }).warnings)).toEqual(['percent_without_calculation']);
    expect(codes(scoreExistingIndicator({ ...clean, unit: 'number', indicatorText: 'Number of kits', calculation: null }).warnings)).toEqual([]);
  });
});

// ------------------------------------------------------------------ fixes of the Phase 4 review (13 October 2026)

describe('Phase 4 review fixes: thresholds, value kinds, names, standard codes, levels, accountability, MoV, caps', () => {
  /** A library suggestion copied from the entry (name, unit, calculation), on `resultCode`, with `overrides`. */
  const lib = (id: string, resultCode: string, overrides: Partial<KpiRawSuggestion> = {}): KpiRawSuggestion => {
    const result = RESULTS.find(r => r.code === resultCode)!;
    return { ...rawSuggestionFromLibrary(entry(id), result, 'Measures this result directly.'), ...overrides };
  };

  it('SPEC-1: only a recognised threshold of the linked entry is kept (FS-01 "35"/"7"/"42", AC-01 "2024"/"5", LV-01 "6" removed)', () => {
    for (const [id, value] of [['FS-01', '35'], ['FS-01', '7'], ['FS-01', '42'], ['AC-01', '2024'], ['AC-01', '5'], ['LV-01', '6'],
      ['WA-03', '0'], ['WA-02', '30'], ['HE-02', '4']] as const) {
      const s = validate(lib(id, 'O1', { targetSuggestion: value, targetBasis: 'standard_threshold' }));
      expect(s.targetBasis, `${id} ${value}`).toBe('method_only');
      expect(s.targetSuggestion).toMatch(/^Proposed method: /);
      expect(s.draft.targetValue).toBeNull();
      expect(draftToCreateInput(s.draft).targetValue ?? null).toBeNull();
      expect(codes(s.warnings)).toContain('standard_threshold_not_found');
    }
    const sphere = validate(lib('WA-01', 'O1', { targetSuggestion: '15', targetBasis: 'standard_threshold' }));
    expect(sphere).toMatchObject({ targetSuggestion: '15', targetBasis: 'standard_threshold' });
    expect(sphere.targetJustification).toMatch(/^Proposed standard threshold \(Sphere Water supply standard/);
    // Every listed threshold is in its entry's own text and unit (knowledge/indicator-library.json).
    for (const [id, thresholds] of Object.entries(STANDARD_THRESHOLDS)) {
      const e = entry(id);
      for (const t of thresholds) {
        expect(e.unit).toBe(t.unit);
        expect(standaloneValueOffsets([e.definition, e.notes ?? '', JSON.stringify(e.standardReference)].join(' '), t.value).length).toBeGreaterThan(0);
        expect(recognisedThreshold(id, t.value, t.unit)).toEqual(t);
      }
    }
    expect(recognisedThreshold('WA-01', 'at least 15 l/p/d')).not.toBeNull();
    expect(recognisedThreshold('WA-01', '15 or 20')).toBeNull();
  });

  describe('SPEC-2: the kind of each document value comes from its own clause', () => {
    const docContext = (text: string, extra: Partial<ProjectContext> = {}) => context({
      documentFacts: extractDocumentFacts([{ id: 'd1', fileName: 'proposal.pdf', text }]),
      documentTexts: [{ documentId: 'd1', fileName: 'proposal.pdf', text }],
      ...extra,
    });
    const count = (overrides: Partial<KpiRawSuggestion>) => customRaw({ name: 'Number of young people trained', nameAr: 'عدد الشباب المدربين', ...overrides });

    it('"currently plans to train 600": a plan, never a baseline', () => {
      const ctx = docContext('The organisation currently plans to train 600 young women and men in Hebron.');
      const baseline = validate(count({ baselineSuggestion: '600', baselineBasis: 'document' }), ctx);
      expect(baseline).toMatchObject({ baselineSuggestion: '', baselineBasis: 'none' });
      expect(codes(baseline.warnings)).toContain('baseline_not_found');
      const target = validate(count({ targetSuggestion: '600', targetBasis: 'document' }), ctx);
      expect(target).toMatchObject({ targetSuggestion: '600', targetBasis: 'document', sources: { target: 'proposal.pdf' } });
    });

    it('"As of the end of year two, 450 graduates will have found work": a target, never a baseline', () => {
      const ctx = docContext('As of the end of year two, 450 graduates will have found work.');
      expect(validate(count({ baselineSuggestion: '450', baselineBasis: 'document' }), ctx).baselineBasis).toBe('none');
      expect(validate(count({ targetSuggestion: '450', targetBasis: 'document' }), ctx).targetBasis).toBe('document');
    });

    it('"75% …, up from 45% in the 2025 survey, will …": 45% is the baseline, never the target', () => {
      const ctx = docContext('By the end of the project, 75% of households, up from 45% in the 2025 survey, will treat their drinking water.');
      expect(ctx.documentFacts[0].kind).toBe('mixed');
      const wrong = validate(raw({ targetSuggestion: '45%', targetBasis: 'document' }), ctx);
      expect(wrong.targetBasis).toBe('method_only');
      expect(codes(wrong.warnings)).toContain('target_not_found');
      const right = validate(raw({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '75%', targetBasis: 'document' }), ctx);
      expect(right).toMatchObject({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '75%', targetBasis: 'document' });
    });

    it('"from 30% at baseline to 60% by the end of 2027": the logframe pattern keeps 30% as baseline and 60% as target', () => {
      const text = 'The target is to raise the share of households treating water from 30% at baseline to 60% by the end of 2027.';
      const ctx = docContext(text);
      const right = validate(raw({ baselineSuggestion: '30%', baselineBasis: 'document', targetSuggestion: '60%', targetBasis: 'document' }), ctx);
      expect(right).toMatchObject({ baselineSuggestion: '30%', baselineBasis: 'document', targetSuggestion: '60%', targetBasis: 'document' });
      expect(right.warnings).toEqual([]);
      const swapped = validate(raw({ baselineSuggestion: '60%', baselineBasis: 'document', targetSuggestion: '30%', targetBasis: 'document' }), ctx);
      expect(swapped).toMatchObject({ baselineBasis: 'none', targetBasis: 'method_only' });
      expect(codes(swapped.warnings)).toEqual(expect.arrayContaining(['baseline_not_found', 'target_not_found']));

      // Framework generation: the structure step's verified kinds are kept (the Phase 3 behaviour).
      const figures = verifyDocumentFigures([
        { resultCode: 'O1', kind: 'baseline', value: '30%', description: '', quote: text },
        { resultCode: 'O1', kind: 'target', value: '60%', description: '', quote: text },
      ], [{ fileName: 'proposal.pdf', text }]);
      const facts = factsFromVerifiedFigures(figures);
      const docs: DocumentText[] = [{ documentId: '', fileName: 'proposal.pdf', text }];
      expect(documentValueSupported('30%', 'baseline', true, facts, docs)).not.toBeNull();
      expect(documentValueSupported('60%', 'target', true, facts, docs)).not.toBeNull();
      expect(documentValueSupported('60%', 'baseline', true, facts, docs)).toBeNull();
      expect(documentValueSupported('30%', 'target', true, facts, docs)).toBeNull();
    });

    it('generation facts supply only their verified figures, and a clause stating the other kind wins over a wrong verified kind', () => {
      const text = 'By the end of the project, 75% of households, up from 45% in the 2025 survey, will treat their drinking water.';
      const docs: DocumentText[] = [{ documentId: '', fileName: 'proposal.pdf', text }];
      const wrongKind = factsFromVerifiedFigures([{ resultCode: 'O1', kind: 'target', value: '45%', description: '', quote: text, source: 'proposal.pdf' }]);
      expect(documentValueSupported('45%', 'target', true, wrongKind, docs)).toBeNull();
      const onlyTarget = factsFromVerifiedFigures([{ resultCode: 'O1', kind: 'target', value: '75%', description: '', quote: text, source: 'proposal.pdf' }]);
      expect(documentValueSupported('75%', 'target', true, onlyTarget, docs)).not.toBeNull();
      // 45% is in the quote but was not a verified figure: it supplies nothing.
      expect(documentValueSupported('45%', 'baseline', true, onlyTarget, docs)).toBeNull();
    });

    it('re-check (a): a time cue without a comma never makes a planned number a baseline', () => {
      for (const text of [
        'As of the end of year two 450 graduates will have found work.',
        'Currently 600 young people are planned to be trained.',
        'The organisation currently intends to train 600 young people.',
      ]) {
        const value = text.includes('450') ? '450' : '600';
        const ctx = docContext(text);
        const baseline = validate(count({ baselineSuggestion: value, baselineBasis: 'document' }), ctx);
        expect(baseline.baselineBasis, text).toBe('none');
        expect(codes(baseline.warnings), text).toContain('baseline_not_found');
        expect(validate(count({ targetSuggestion: value, targetBasis: 'document' }), ctx).targetBasis, text).toBe('document');
      }
    });

    it('re-check (b): a baseline inside a target sentence is a baseline and never a target', () => {
      for (const text of [
        'By 2027, 75% of households will have acceptable FCS compared with 45% in 2025.',
        'By 2027, 75% of households will have acceptable FCS against 45% in 2025.',
        'The project will raise acceptable FCS to 75% (45% in 2025).',
        'Acceptable FCS stood at 45% in 2025 and is expected to reach 75% by 2027.',
      ]) {
        const ctx = docContext(text);
        const wrong = validate(raw({ targetSuggestion: '45%', targetBasis: 'document' }), ctx);
        expect(wrong.targetBasis, text).toBe('method_only');
        expect(codes(wrong.warnings), text).toContain('target_not_found');
        const right = validate(raw({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '75%', targetBasis: 'document' }), ctx);
        expect(right, text).toMatchObject({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '75%', targetBasis: 'document' });
      }
      // The DB path keeps the endline target too.
      const endline = validate(raw({ baselineSuggestion: '45%', baselineBasis: 'document', targetSuggestion: '70%', targetBasis: 'document' }),
        docContext('45% at baseline, 70% at endline.'));
      expect(endline).toMatchObject({ baselineBasis: 'document', targetSuggestion: '70%', targetBasis: 'document' });
    });

    it('re-check (c): framework generation keeps a verified baseline that a later cue of another value follows (Phase 3 parity)', () => {
      for (const [text, baseline, target] of [
        ['By 2027, 75% of households will have an acceptable FCS compared with 45% in 2025.', '45%', '75%'],
        ['Acceptable FCS stood at 45% in 2025 and is expected to reach 75% by 2027.', '45%', '75%'],
        ['Acceptable FCS was 45% in 2025 and is expected to reach 75% by 2027.', '45%', '75%'],
        ['The project aims to reach 3,500 households, compared with 1,200 households reached in 2025.', '1,200', '3,500'],
      ] as const) {
        const figures: VerifiedFigure[] = [
          { resultCode: 'O1', kind: 'baseline', value: baseline, description: '', quote: text, source: 'proposal.pdf' },
          { resultCode: 'O1', kind: 'target', value: target, description: '', quote: text, source: 'proposal.pdf' },
        ];
        const facts = factsFromVerifiedFigures(figures);
        const docs: DocumentText[] = [{ documentId: '', fileName: 'proposal.pdf', text: `Summary.\n${text}` }];
        const percent = baseline.endsWith('%');
        expect(documentValueSupported(baseline, 'baseline', percent, facts, docs), text).not.toBeNull();
        expect(documentValueSupported(target, 'target', percent, facts, docs), text).not.toBeNull();
        expect(matchingFigure(baseline, 'baseline', figures), text).not.toBeNull();
      }
      // A label right after the value still refuses a wrong verified kind ("45% at baseline" is never a target).
      const text = '45% at baseline, 70% at endline.';
      const wrong = factsFromVerifiedFigures([{ resultCode: 'O1', kind: 'target', value: '45%', description: '', quote: text, source: 'proposal.pdf' }]);
      expect(documentValueSupported('45%', 'target', true, wrong, [{ documentId: '', fileName: 'proposal.pdf', text }])).toBeNull();
    });
  });

  it('SPEC-3: a number in a model-written name that no library text supports costs target_in_name', () => {
    for (const name of [
      'Number of displaced households receiving food vouchers (target: 3,500)', '3,500 displaced households receiving food vouchers',
      'Number of households with acceptable FCS (from 40 to 70)', 'At least 3,500 households receive food vouchers',
      'Number of youth trained, 500 by end of project',
    ]) {
      const s = validate(customRaw({ name }));
      expect(codes(s.warnings), name).toContain('target_in_name');
      expect(s.qualityScore).toBeLessThanOrEqual(85);
    }
    const arabic = validate(customRaw({ nameAr: 'عدد عمليات نقل المياه بالصهاريج المنجزة (المطلوب ٣٥٠٠)' }));
    expect(codes(arabic.warnings)).toContain('target_in_name');
    // Definitional numbers pass: ages, units of measure, numbers of the library names and definitions, single digits.
    for (const name of [
      '% of pregnant women receiving at least 4 antenatal care visits', 'Number of children aged 6–59 months screened for acute malnutrition',
      '% of households using at least 15 litres of water per person per day', '% of women aged 15–49 using a modern method',
      'Number of households within 30 minutes of a water point', 'Number of water trucking deliveries completed',
    ]) {
      expect(codes(validate(customRaw({ name })).warnings), name).not.toContain('target_in_name');
    }
    expect(nameFiguresUnsupported('Number of youth trained, 500 by end of project', [])).toEqual(['500']);
    expect(nameFiguresUnsupported('Average litres of water per person per day (Sphere minimum 15 litres)', [])).toEqual([]);
  });

  it('SPEC-3 (re-check): "over/above/between N" is a target unless it follows people or counts people; codes, amounts, ratios pass', () => {
    for (const name of [
      'Number of youth trained (over 500)', 'Number of displaced households receiving food vouchers (above 3,500)',
      'Number of youth trained: over 500', 'Number of households receiving vouchers, between 3,000 and 3,500',
    ]) {
      const s = validate(customRaw({ name }));
      expect(codes(s.warnings), name).toContain('target_in_name');
      expect(s.qualityScore, name).toBeLessThanOrEqual(85);
      expect(nameHasTargetIndependent(name), name).toBe(true);
    }
    for (const name of [
      'Number of health facilities certified to ISO 9001', 'Number of schools meeting the 1:40 teacher-pupil ratio',
      'Number of households receiving the USD 150 monthly transfer', 'Number of callers served by the 24/7 hotline',
      'Number of shelters housing no more than 20 people', 'Number of children under 18 attending psychosocial sessions',
      'Number of people over 60 receiving home visits', '% of women between 15 and 49 using a modern method',
      'Number of people aged over 60 receiving home visits', 'Number of children aged under 5 screened',
    ]) {
      const s = validate(customRaw({ name }));
      expect(codes(s.warnings), name).not.toContain('target_in_name');
      expect(nameHasTargetIndependent(name), name).toBe(false);
    }
    expect(nameFiguresUnsupported('Number of youth trained (over 500)', [])).toEqual(['500']);
    expect(nameFiguresUnsupported('Number of children under 18 reached', [])).toEqual([]);
    expect(nameFiguresUnsupported('Number of people aged over 60 reached', [])).toEqual([]);
  });

  it('AI-5 side effect: rule 7 adds sex only when the counted noun is people', () => {
    for (const name of ['Number of water points serving displaced communities', 'Number of family tents distributed',
      'Number of IDP sites with functioning latrines', 'Number of mother-and-baby spaces established']) {
      const s = validate(customRaw({ name, nameAr: 'عدد المرافق', disaggregation: ['location'] }));
      expect(s.disaggregation, name).not.toContain('sex');
      expect(codes(s.warnings), name).not.toContain('sex_added');
      expect(peopleLevelIndependent(name), name).toBe(false);
    }
    const people = validate(customRaw({ name: 'Number of displaced families receiving hygiene kits', nameAr: 'عدد العائلات النازحة التي تلقت حقائب النظافة' }));
    expect(people.disaggregation).toContain('sex');
  });

  it('SPEC-4: a custom suggestion never carries the model\'s standard code (no donor-standard badge)', () => {
    const custom = validate(customRaw({ standardReferenceCode: 'EU GERF 2.99' }));
    expect(custom).toMatchObject({ isCustom: true, standardReferenceCode: null });
    expect(custom.draft.standardReferenceCode).toBeNull();
    const unknownId = validate(customRaw({ libraryId: 'GERF-2.38', isCustom: false, customReason: '', standardReferenceCode: 'EU GERF 2.38' }));
    expect(unknownId).toMatchObject({ libraryId: null, isCustom: true, standardReferenceCode: null });
    expect(unknownId.draft.standardReferenceCode).toBeNull();
    expect(codes(unknownId.warnings)).toEqual(expect.arrayContaining(['library_id_unknown', 'custom_reason_missing']));
    // A linked entry's own reference is still used.
    expect(validate(lib('WA-04', 'O1.1', { standardReferenceCode: 'GERF 9.99' })).standardReferenceCode).toBe('EU GERF 2.38');
    // Re-check: a linked entry without a standard reference (FS-06, isStandard false) never takes the model's code.
    expect(entry('FS-06').standardReference).toBeNull();
    const fs06 = validate(lib('FS-06', 'O1', { standardReferenceCode: 'EU GERF 2.99' }));
    expect(fs06).toMatchObject({ libraryId: 'FS-06', isCustom: false, standardReferenceCode: null });
    expect(fs06.draft.standardReferenceCode).toBeNull();
    expect(draftToCreateInput(fs06.draft).standardReferenceCode ?? null).toBeNull();
  });

  it('SPEC-6: a library entry of another level than its result is flagged and ranked below same-level suggestions', () => {
    const outputOnOutcome = validate(lib('FS-04', 'O1'));
    expect(find(outputOnOutcome.warnings, 'level_mismatch_library')).toMatchObject({
      severity: 'warning', penalty: 0, params: { libraryId: 'FS-04', entryLevel: 'output', level: 'outcome', code: 'O1' },
    });
    expect(codes(validate(lib('FS-01', 'O1.1')).warnings)).toContain('level_mismatch_library');
    expect(codes(validate(lib('FS-06', 'G')).warnings)).toContain('level_mismatch_library');
    expect(codes(validate(lib('FS-01', 'O1')).warnings)).not.toContain('level_mismatch_library');
    // Same confidence and score: the same-level entry wins the last place under the ECHO cap.
    const ctx = echo({ existingIndicators: [indicator({ id: 'i1' }), indicator({ id: 'i2', name: 'Second existing indicator' })] });
    const out = validateAndScore({ context: ctx, answer: { suggestions: [lib('FS-04', 'O1', { confidence: 'high' }), lib('FS-01', 'O1', { confidence: 'high' })], frameworkWarnings: [] }, deps: deps() });
    expect(out.suggestions.filter(s => s.resultCode === 'O1').map(s => s.libraryId)).toEqual(['FS-01']);
  });

  it('SPEC-7: a routine feedback-form indicator does not stand in for accountability; AC-01 is still added', () => {
    const feedbackForms = indicator({ id: 'i-ff', resultId: 'n-o1.1', level: 'output', libraryId: null,
      name: 'Number of voucher distributions with post-distribution feedback forms completed' });
    const out = validateAndScore({ context: humanitarian({ existingIndicators: [feedbackForms] }), answer: { suggestions: [raw()], frameworkWarnings: [] }, deps: deps() });
    expect(out.suggestions.some(s => s.origin === 'appended_accountability' && s.libraryId === 'AC-01')).toBe(true);
    expect(codes(out.frameworkWarnings)).toContain('accountability_added');
    const classroom = indicator({ id: 'i-obs', libraryId: null, name: 'Number of classroom observations', nameAr: 'عدد الملاحظات الصفية' });
    expect(isAccountabilityIndicator({ libraryId: classroom.libraryId, name: classroom.name, nameAr: classroom.nameAr })).toBe(false);
  });

  it('SPEC-9: standard names that start with a participle are not penalised on existing indicators', () => {
    for (const indicatorText of ['Reduced Coping Strategies Index (rCSI) score of target households', 'Enhanced Vegetation Index (EVI) of rehabilitated rangeland',
      'Improved drinking water sources: % of households using one']) {
      const scored = scoreExistingIndicator({ indicatorText, indicatorTextAr: 'مؤشر', unit: 'score', calculation: null, meansOfVerification: 'Household survey (rCSI module)' });
      expect(scored, indicatorText).toMatchObject({ qualityScore: 100, needsAlternatives: false });
    }
  });

  it('SPEC-10: report and record nouns with qualifiers only are generic means of verification', () => {
    for (const mov of ['Project progress reports', 'Quarterly project reports', 'Partner reports', 'Field reports', 'Monitoring data',
      'Project M&E records', 'Distribution reports', "Partner's monthly reports"]) {
      expect(isGenericMeansOfVerification(mov), mov).toBe(true);
      const s = validate(customRaw({ meansOfVerification: mov }));
      expect(codes(s.warnings)).toContain('generic_means_of_verification');
      expect(s.meansOfVerification).toBe(TO_BE_CONFIRMED);
    }
    for (const mov of ['Distribution lists signed by recipients', 'Training attendance sheets and completion records', 'Household survey (KoboToolbox)',
      'Signed delivery notes and the trucking log']) {
      expect(isGenericMeansOfVerification(mov), mov).toBe(false);
    }
    expect(loadLibraryFile().entries.filter(e => isGenericMeansOfVerification(e.meansOfVerification)).map(e => e.id)).toEqual([]);
  });

  it('AI-1: a copy dropped by an earlier result\'s cap does not take the library id from a later result', () => {
    const answer = {
      suggestions: [
        lib('WA-02', 'O1', { confidence: 'high' }), lib('WA-01', 'O1', { confidence: 'high' }), lib('AC-01', 'O1', { confidence: 'high' }),
        lib('WA-05', 'O1', { confidence: 'low' }), lib('WA-05', 'O2', { confidence: 'high' }),
      ],
      frameworkWarnings: [],
    };
    const out = validateAndScore({ context: echo(), answer, deps: deps() });
    expect(out.suggestions.filter(s => s.resultCode === 'O1').map(s => s.libraryId)).toEqual(['WA-02', 'WA-01', 'AC-01']);
    expect(out.suggestions.filter(s => s.resultCode === 'O2').map(s => s.libraryId)).toEqual(['WA-05']);
    expect(find(out.frameworkWarnings, 'result_cap')).toMatchObject({ params: { code: 'O1', cap: 3, dropped: 1 } });
    expect(codes(out.frameworkWarnings)).not.toContain('duplicate_in_run');
    // Both copies within their caps: the first in chain order keeps it (D12).
    const both = validateAndScore({ context: context(), answer: { suggestions: [lib('WA-05', 'O2'), lib('WA-05', 'O1')], frameworkWarnings: [] }, deps: deps() });
    expect(both.suggestions.map(s => [s.resultCode, s.libraryId])).toEqual([['O1', 'WA-05']]);
    expect(find(both.frameworkWarnings, 'duplicate_in_run')).toMatchObject({ params: { code: 'O2' } });
  });

  it('AI-1 (re-check): the suggestion rule 19 replaces in a full outcome never takes its library id from a later result', () => {
    const answer = {
      suggestions: [
        lib('WA-02', 'O1', { confidence: 'high' }), lib('WA-01', 'O1', { confidence: 'high' }), lib('WA-05', 'O1', { confidence: 'low' }),
        lib('WA-05', 'O2', { confidence: 'high' }), lib('WA-03', 'O2', { confidence: 'high' }), lib('WA-04', 'O2', { confidence: 'high' }),
        lib('WA-06', 'O2', { confidence: 'medium' }),
      ],
      frameworkWarnings: [],
    };
    const base = echo();
    const ctx = { ...base, project: { ...base.project, humanitarian: true } };
    const out = validateAndScore({ context: ctx, answer, deps: deps() });
    const kept = out.suggestions.map(s => `${s.resultCode}:${s.libraryId}`);
    expect(kept.filter(k => k.startsWith('O1:'))).toEqual(['O1:WA-02', 'O1:WA-01', 'O1:AC-01']);
    // WA-05 stays measured: O2 keeps its own (high) copy instead of losing it to O1's replaced (low) copy.
    expect(kept).toContain('O2:WA-05');
    expect(codes(out.frameworkWarnings)).not.toContain('duplicate_in_run');
    expect(find(out.frameworkWarnings, 'accountability_added')).toMatchObject({ params: { libraryId: 'AC-01', code: 'O1' } });
    expect(out.frameworkWarnings.filter(w => w.code === 'result_cap').map(w => w.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'O1', cap: 3, dropped: 1 }),
    ]));
    // A non-humanitarian run is unchanged: O1 keeps its three, the low WA-05 copy wins by chain order (D12).
    const plain = validateAndScore({ context: { ...ctx, project: { ...ctx.project, humanitarian: false } }, answer, deps: deps() });
    expect(plain.suggestions.filter(s => s.resultCode === 'O1').map(s => s.libraryId)).toEqual(['WA-02', 'WA-01', 'WA-05']);
  });

  it('AI-5: families, adolescents, IDPs, returnees, mothers, infants and smallholders are people (sex added)', () => {
    for (const name of ['Number of displaced families receiving hygiene kits', 'Number of adolescents attending hygiene sessions',
      'Number of IDPs reached', 'Number of returnees supported', 'Number of mothers counselled', 'Number of infants vaccinated', '% of smallholders adopting drip irrigation']) {
      expect(isPeopleLevelIndicator(name), name).toBe(true);
    }
    expect(isPeopleLevelIndicator('x', 'عدد العائلات النازحة التي تلقت حقائب النظافة')).toBe(true);
    expect(isPeopleLevelIndicator('x', 'عدد المراهقين الذين حضروا جلسات النظافة')).toBe(true);
    const families = validate(customRaw({ name: 'Number of displaced families receiving hygiene kits', nameAr: 'عدد العائلات النازحة التي تلقت حقائب النظافة' }));
    expect(families.disaggregation).toContain('sex');
    expect(codes(families.warnings)).toContain('sex_added');
  });
});
