import { describe, expect, it } from 'vitest';
import {
  BASELINE_DATE_TO_BE_CONFIRMED, INTERMEDIATE_TARGETS_TO_BE_CONFIRMED, TO_BE_CONFIRMED, normalizeIndicator,
} from '../src/services/ai/frameworkNormalize';
import type { IndicatorCreatePayload, NormalizeIndicatorsContext } from '../src/services/ai/frameworkNormalize';
import { AppError } from '../src/middleware/errorHandler';
import { DRAFT_EDITABLE_KEYS, draftToCreateInput, editedFields, indicatorDraftFromPayload } from '../src/services/kpi/draft';
import type { IndicatorDraft } from '../src/services/kpi/types';

/**
 * KPI Assistant drafts (knowledge/kpi-assistant-spec.md §A1 "accept in one click", §A5; me-foundations §3 reference
 * sheet; design sections 4.2 and 8.1 field mapping). Pure, no database.
 */

const NODES: NormalizeIndicatorsContext['resultNodes'] = [
  { id: 'n-o1', code: 'O1', level: 'outcome', parentId: null },
  { id: 'n-o1.1', code: 'O1.1', level: 'output', parentId: 'n-o1' },
];

const WA02 = {
  id: 'WA-02', definition: 'Share of target households using a basic drinking water service.', notes: null,
  meansOfVerification: 'Household survey', calculation: null, disaggregation: ['sex_of_household_head', 'location'],
  standardReference: { framework: 'WHO/UNICEF JMP', code: 'Drinking water service ladder' },
};

const NORMALIZE_CONTEXT: NormalizeIndicatorsContext = {
  frameworkId: 'fw-1', resultNodes: NODES, knownLibraryIds: new Set(['WA-02']), libraryEntries: new Map([['WA-02', WA02]]),
  verifiedFigures: [{ resultCode: 'O1', kind: 'baseline', value: '45%', description: '', quote: 'The survey found 45% of households.', source: 'baseline.pdf' }],
  aiModel: 'model-x', promptVersion: 'kpi-v1',
};

/** The payload validateSuggestion builds (D22: empty model method, date, assumptions and responsibility). */
function payload(overrides: Record<string, unknown> = {}): IndicatorCreatePayload {
  const out = normalizeIndicator({
    resultCode: 'O1', level: 'outcome', libraryId: 'WA-02', name: '% of target households using at least a basic drinking water service',
    nameAr: 'نسبة الأسر المستهدفة التي تستخدم خدمة مياه شرب أساسية', definition: 'Households using a basic drinking water service.',
    unit: 'percent', direction: 'increase', disaggregation: ['location'], dataCollectionMethod: 'hh_survey', frequency: 'biannual',
    meansOfVerification: 'JMP household survey', baselineValue: '45%', baselineBasis: 'document', baselineMethod: '', baselineDate: '',
    intermediateTargets: [], targetValue: 'baseline + 10 percentage points', targetBasis: 'method_only', targetJustification: '',
    standardReferenceCode: 'GERF 9.99', aiRationale: 'Fits the outcome.', assumptions: '', responsibility: '',
    calculation: { numerator: 'Households on the basic rung', denominator: '' },
    ...overrides,
  }, 4, NORMALIZE_CONTEXT);
  if (!out) throw new Error('no payload');
  return out;
}

const DATES = { startDate: '2026-11-01', endDate: '2027-10-31' };

describe('indicatorDraftFromPayload: the field mapping of design 8.1', () => {
  it('maps every reference-sheet field, filled or explicitly to be confirmed', () => {
    const draft = indicatorDraftFromPayload(payload(), 'n-o1', DATES);
    expect(draft).toEqual({
      indicatorText: '% of target households using at least a basic drinking water service',
      indicatorTextAr: 'نسبة الأسر المستهدفة التي تستخدم خدمة مياه شرب أساسية',
      level: 'outcome',
      resultId: 'n-o1',
      libraryId: 'WA-02',
      standardReferenceCode: 'WHO/UNICEF JMP Drinking water service ladder',
      definition: 'Households using a basic drinking water service.',
      unit: 'percent',
      calculation: { numerator: 'Households on the basic rung', denominator: TO_BE_CONFIRMED, formula: 'numerator ÷ denominator × 100', rounding: TO_BE_CONFIRMED },
      direction: 'increase',
      disaggregation: ['sex_of_household_head', 'location'],
      dataCollectionMethod: 'hh_survey',
      frequency: 'biannual',
      meansOfVerification: 'JMP household survey',
      baselineValue: '45%',
      baselineDate: null,
      baselineMethod: `Baseline taken from the project documents (source: baseline.pdf). ${BASELINE_DATE_TO_BE_CONFIRMED}`,
      targetValue: null,
      targetJustification: `Proposed method: baseline + 10 percentage points — confirm after baseline. ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}`,
      intermediateTargets: [],
      assumptions: TO_BE_CONFIRMED,
      responsibility: TO_BE_CONFIRMED,
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      aiRationale: 'Fits the outcome.',
    } satisfies IndicatorDraft);
    // Server-only fields are dropped.
    for (const key of ['frameworkId', 'sortOrder', 'provenance', 'aiModel', 'promptVersion', 'phases', 'milestones']) {
      expect(draft).not.toHaveProperty(key);
    }
  });

  it('empty model text becomes "to be confirmed"; a generic means of verification too; no Arabic name → null', () => {
    const draft = indicatorDraftFromPayload(payload({
      libraryId: null, name: 'Number of households using a basic drinking water service', nameAr: '', definition: '',
      meansOfVerification: 'Project reports', unit: 'number', calculation: {},
      baselineValue: '', baselineBasis: 'none', targetValue: '', aiRationale: '', disaggregation: ['Gender', 'PwD'],
    }), 'n-o1', { startDate: null, endDate: null });
    expect(draft).toMatchObject({
      indicatorTextAr: null, libraryId: null, standardReferenceCode: 'GERF 9.99', definition: TO_BE_CONFIRMED, unit: 'number', calculation: null,
      meansOfVerification: TO_BE_CONFIRMED, baselineValue: null, baselineMethod: `${TO_BE_CONFIRMED}. ${BASELINE_DATE_TO_BE_CONFIRMED}`,
      disaggregation: ['sex', 'disability'], startDate: null, endDate: null, aiRationale: null,
    });
    expect(draft.targetJustification.startsWith('Proposed method:')).toBe(true);
  });

  it('dates become YYYY-MM-DD; an activity level never reaches a draft; an unknown unit falls back by the name', () => {
    const p = { ...payload(), baselineDate: new Date('2026-03-15T00:00:00.000Z'), level: 'activity' as const, unit: 'kilos', intermediateTargets: [{ date: '2027-03-31', value: '50%' }, { date: '', value: 'x' }] };
    const draft = indicatorDraftFromPayload(p, 'n-o1.1', { startDate: '2026-11-01T00:00:00.000Z', endDate: '2027-10-31' });
    expect(draft).toMatchObject({ baselineDate: '2026-03-15', level: 'output', unit: 'percent', startDate: '2026-11-01', intermediateTargets: [{ date: '2027-03-31', value: '50%' }] });
    expect(indicatorDraftFromPayload({ ...payload({ name: 'Number of kits' }), unit: null }, 'n-o1', DATES).unit).toBe('number');
  });

  it('every draft passes parseIndicatorCreate', () => {
    expect(() => draftToCreateInput(indicatorDraftFromPayload(payload(), 'n-o1', DATES))).not.toThrow();
  });
});

describe('draftToCreateInput and editedFields (design 8.1 steps 4 and 6)', () => {
  const draft = indicatorDraftFromPayload(payload(), 'n-o1', DATES);

  it('every draft key is editable; provenance, status, currentValue and sortOrder never', () => {
    expect([...DRAFT_EDITABLE_KEYS].sort()).toEqual(Object.keys(draft).sort());
    for (const key of ['provenance', 'status', 'currentValue', 'sortOrder', 'aiModel', 'promptVersion']) {
      expect(DRAFT_EDITABLE_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it('merges edits over the draft and parses once', () => {
    const input = draftToCreateInput(draft, { indicatorText: '  % of households with a basic water service ', targetValue: 60, baselineDate: '2026-02-01' });
    expect(input).toMatchObject({
      indicatorText: '% of households with a basic water service', targetValue: '60', libraryId: 'WA-02', resultId: 'n-o1',
      baselineDate: new Date('2026-02-01T00:00:00.000Z'), startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'),
      assumptions: TO_BE_CONFIRMED, dataCollectionMethod: 'hh_survey', level: 'outcome',
    });
    expect(draftToCreateInput(draft)).toMatchObject({ indicatorText: draft.indicatorText, intermediateTargets: [] });
    expect(draftToCreateInput(draft, { libraryId: 'wa-05' }).libraryId).toBe('WA-05');
  });

  it('strips keys a client may not set (provenance, status, currentValue, sortOrder, unknown keys)', () => {
    const input = draftToCreateInput(draft, { provenance: 'ai_generated', status: 'completed', currentValue: '99', sortOrder: 7, aiModel: 'x', frameworkId: 'other' });
    expect(input).not.toHaveProperty('provenance');
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('currentValue');
    expect(input).not.toHaveProperty('sortOrder');
    expect(input).not.toHaveProperty('aiModel');
    expect(input).not.toHaveProperty('frameworkId');
    expect(draftToCreateInput(draft, null as never)).toMatchObject({ indicatorText: draft.indicatorText });
  });

  it('throws AppError 400 naming every failing field', () => {
    let error: unknown;
    try {
      draftToCreateInput(draft, { level: 'goal', baselineDate: '2026-02-30', disaggregation: ['Bad Key'] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(400);
    expect((error as AppError).message).toMatch(/level must be one of/);
    expect((error as AppError).message).toMatch(/baselineDate must be a real date/);
    expect((error as AppError).message).toMatch(/disaggregation\.0 must be a snake_case key/);
  });

  it('editedFields lists the keys whose parsed value changed, in draft-key order', () => {
    expect(editedFields(draft, {})).toEqual([]);
    expect(editedFields(draft, { indicatorText: `  ${draft.indicatorText}  `, baselineDate: '', targetValue: '', disaggregation: [...draft.disaggregation] })).toEqual([]);
    expect(editedFields(draft, { targetValue: '60%', indicatorText: 'New wording', provenance: 'manual' })).toEqual(['indicatorText', 'targetValue']);
    expect(editedFields(draft, { calculation: { ...draft.calculation, denominator: 'All surveyed households' } })).toEqual(['calculation']);
    expect(editedFields(draft, { calculation: { rounding: TO_BE_CONFIRMED, formula: draft.calculation?.formula, denominator: TO_BE_CONFIRMED, numerator: draft.calculation?.numerator } })).toEqual([]);
    expect(editedFields(draft, { endDate: '2028-06-30' })).toEqual(['endDate']);
    expect(() => editedFields(draft, { level: 'goal' })).toThrow(AppError);
  });
});
