import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import type { GenerateStructuredParams, StructuredResult } from '../src/services/ai/client';
import { AiRefusalError } from '../src/services/ai/errors';
import {
  BASELINE_DATE_TO_BE_CONFIRMED,
  INTERMEDIATE_TARGETS_TO_BE_CONFIRMED,
  TO_BE_CONFIRMED,
  appearsInDocuments,
  isPeopleLevelIndicator,
  referenceSheetGaps,
} from '../src/services/ai/frameworkNormalize';
import { FRAMEWORK_STRUCTURE_SYSTEM, PROJECT_STRUCTURE_SCHEMA } from '../src/services/ai/prompts/framework';
import { KPI_CALLS, KPI_PROMPT_VERSION, KPI_SUGGESTIONS_SCHEMA, KPI_SYSTEM, type KpiRawSuggestion } from '../src/services/ai/prompts/kpi';
import { redactPersonalData } from '../src/services/ai/redact';
import { seedLibrary } from '../src/services/library/seed';
import {
  AI_CALL_HEADER,
  NOT_SHARED_FLAG,
  SEED_PROJECT_NAME,
  aiCallRows,
  apiKeyProblem,
  databaseProblem,
  formatTable,
  gapRows,
  levelRows,
  parseSmokeArgs,
  runAiSmoke,
  smokeRefusal,
} from '../scripts/ai-smoke';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

/**
 * Phase 3 acceptance criterion (docs/BUILD_GUIDE.md): "A framework generation on the seed project
 * completes and stores indicators with all new fields filled or explicitly marked 'to be confirmed'."
 *
 * The project and the library match the dev seed (prisma/seed.ts: the DG ECHO project without a
 * framework, and knowledge/indicator-library.json). The dev seed has no document, so this test adds a
 * made-up proposal to also run the structure step; `npm run ai:smoke` on the seed project runs the
 * indicator step only. Since Phase 4 the indicator step is the KPI pipeline (design section 4.6, D19): its
 * batches get realistic, schema-valid KPI answers in which some fields are deliberately empty and some
 * figures invented; everything after the model call (retrieval, validation, drafts, storage) is the real
 * code. The real-API run is scripts/ai-smoke.ts.
 */

// tests/setup.ts mocks the generator and the KPI pipeline for route tests; this file runs the real ones.
vi.unmock('../src/services/ai/frameworkGenerator');
vi.unmock('../src/services/kpi/pipeline');

const { generateStructured } = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../src/services/ai/client', () => ({
  generateStructured,
  resolveModel: (tier: 'main' | 'fast') => (tier === 'main' ? 'configured-main-model' : 'configured-fast-model'),
}));

/** The model that served the mocked answers; generateStructured reports it and the generator stores it. */
const SERVED_MODEL = 'claude-sonnet-5-5-20261001';
const DOCUMENT_NAME = 'gaza-wash-cash-proposal.pdf';

/** Made-up proposal text, stored as a legacy row would be: not yet redacted (a phone number, an email and a staff ID). */
const PROPOSAL = [
  'Gaza Emergency WASH and Cash Response: proposal to DG ECHO (2026).',
  'Context. The rapid needs assessment carried out in December 2025 found that displaced households in Khan Younis and Deir al-Balah had access to an average of 6 litres of water per person per day. 38% of assessed households reported having no soap.',
  'Results. Specific objective 1: displaced and host-community households have sufficient safe water and practise safe hygiene. Result 1.1: 12,000 people receive trucked drinking water for nine months (6,000 by the end of March 2026). Result 1.2: 2,400 hygiene kits are distributed to displaced households.',
  'Specific objective 2: households meet their basic needs in dignity. Result 2.1: 1,800 households receive three rounds of multipurpose cash, the first on 15 March 2026.',
  'Budget. Post-distribution monitoring survey: 400 households, 80 ILS per interview, 32,000 ILS.',
  'Field coordinator: 0599 123 456, coordinator@example.org (staff ID 401234567).',
].join('\n\n');
const PERSONAL_DATA = ['0599 123 456', 'coordinator@example.org', '401234567'];

const PERCENT = 'numerator ÷ denominator × 100';

const STRUCTURE_ANSWER = {
  goal: {
    code: 'G',
    text: 'Displaced and host-community households in the southern Gaza Strip meet their basic needs in dignity',
    textAr: 'تلبية الأسر النازحة والمضيفة في جنوب قطاع غزة احتياجاتها الأساسية بكرامة',
  },
  outcomes: [
    {
      code: 'O1',
      text: 'Displaced and host-community households have sufficient safe water and practise safe hygiene',
      textAr: 'حصول الأسر النازحة والمضيفة على كميات كافية من المياه الآمنة وممارستها النظافة الآمنة',
      outputs: [
        { code: 'O1.1', text: 'People in target areas receive trucked drinking water', textAr: 'حصول السكان في المناطق المستهدفة على مياه الشرب المنقولة بالصهاريج', activities: ['Contract water trucking', 'Test water quality at delivery points'] },
        { code: 'O1.2', text: 'Displaced households receive hygiene kits', textAr: 'حصول الأسر النازحة على حقائب النظافة', activities: ['Distribute hygiene kits', ''] },
      ],
    },
    {
      code: 'O2',
      text: 'Households meet their basic needs in dignity',
      textAr: '',
      outputs: [
        { code: 'O2.1', text: 'Households receive multipurpose cash', textAr: 'حصول الأسر على مساعدات نقدية متعددة الأغراض', activities: ['Register households', 'Deliver three cash rounds'] },
      ],
    },
  ],
  beneficiaries: { total: 12000, types: ['Displaced households', 'Host-community households'], disaggregation: ['sex', 'age', 'disability', 'displacement_status'] },
  timeline: { startDate: '2026-01-01', endDate: '', phases: [] },
  donorRequirements: ['Key Result Indicators where available'],
  crossCuttingThemes: ['gender', 'disability_inclusion', 'accountability_to_affected_people'],
  documentFigures: [
    { resultCode: 'O1', kind: 'baseline', value: '6', description: 'litres of water per person per day', quote: 'access to an average of 6 litres of water per person per day' },
    { resultCode: 'O1', kind: 'baseline', value: '38%', description: 'households without soap', quote: '38% of assessed households reported having no soap.' },
    { resultCode: 'O1.1', kind: 'target', value: '12,000', description: 'people receiving trucked water', quote: 'Result 1.1: 12,000 people receive trucked drinking water for nine months' },
    { resultCode: 'O1.1', kind: 'target', value: '6,000', description: 'people receiving trucked water by March 2026', quote: '(6,000 by the end of March 2026)' },
    { resultCode: 'O1.2', kind: 'target', value: '2,400', description: 'hygiene kits', quote: 'Result 1.2: 2,400 hygiene kits are distributed to displaced households.' },
    { resultCode: 'O2.1', kind: 'target', value: '1,800', description: 'households receiving cash', quote: 'Result 2.1: 1,800 households receive three rounds of multipurpose cash' },
    // Invented: not in the document, so it never reaches the indicator prompt.
    { resultCode: 'O2', kind: 'target', value: '70%', description: 'households meeting basic needs', quote: '70% of households meet their basic needs' },
    // A date is no figure: the 15 of "15 March 2026" does not stand alone.
    { resultCode: 'O2.1', kind: 'target', value: '15', description: 'first cash round', quote: 'the first on 15 March 2026' },
  ],
};

/** One suggestion of a KPI answer (KPI_SUGGESTION_SCHEMA: the spec's fields only, D22); each test suggestion overrides what it needs. */
function suggestion(overrides: Partial<KpiRawSuggestion>): KpiRawSuggestion {
  return {
    resultCode: 'O1', level: 'outcome', libraryId: null, isCustom: true, customReason: 'No library candidate measures this result.', name: '', nameAr: '',
    definition: '', unit: 'number', numerator: '', denominator: '', direction: 'increase', disaggregation: [], method: 'document_review',
    frequency: 'quarterly', meansOfVerification: '', baselineSuggestion: '', baselineBasis: 'none', targetSuggestion: '', targetBasis: 'method_only',
    standardReferenceCode: null, rationale: 'Measures the result with a standard, verifiable source.', qualityNotes: [], confidence: 'medium',
    ...overrides,
  };
}

/** A library-linked suggestion. */
const library = (libraryId: string, overrides: Partial<KpiRawSuggestion>) => suggestion({ libraryId, isCustom: false, customReason: '', ...overrides });

/** The model's suggestions for every result; each KPI batch gets those of its own results (see mockAi). */
const SUGGESTIONS: KpiRawSuggestion[] = [
  // 0. Impact, from secondary data; target only as a method.
  suggestion({
    resultCode: 'G', level: 'impact', name: 'Prevalence of acute watery diarrhoea among children under five in target areas',
    nameAr: 'معدل انتشار الإسهال المائي الحاد بين الأطفال دون سن الخامسة في المناطق المستهدفة',
    definition: 'Children under five reported with acute watery diarrhoea in the two weeks before data collection.', unit: 'percent',
    numerator: 'Children under five with acute watery diarrhoea in the past two weeks', denominator: 'Children under five in surveyed households',
    direction: 'decrease', disaggregation: ['sex', 'age', 'location'], method: 'secondary_data', frequency: 'baseline_endline',
    meansOfVerification: 'Health cluster surveillance data and Ministry of Health reports for Khan Younis and Deir al-Balah',
    targetSuggestion: 'baseline - 20 percentage points, set once the baseline is known', targetBasis: 'method_only', confidence: 'high',
  }),
  // 1. Library entry with a document baseline and the Sphere threshold of the linked entry.
  library('WA-01', {
    name: 'Average volume of water available per person per day in target households',
    nameAr: 'متوسط كمية المياه المتاحة للفرد يوميًا في الأسر المستهدفة', standardReferenceCode: 'Sphere',
    definition: 'Litres of water available for drinking, cooking and hygiene per person per day, from all sources.', unit: 'litres_per_person_per_day',
    disaggregation: ['location', 'displacement_status'], method: 'hh_survey', frequency: 'quarterly',
    meansOfVerification: 'Household survey water module and water-trucking delivery logs',
    baselineSuggestion: '6', baselineBasis: 'document', targetSuggestion: '15', targetBasis: 'standard_threshold', confidence: 'high',
  }),
  // 2. Deliberately incomplete: no Arabic name (the linked entry's is used), definition or calculation parts; an invented
  //    target that only matches a budget cell ("80 ILS per interview").
  library('WA-05', {
    name: '% of target households with a handwashing facility with soap and water observed', unit: 'percent',
    method: 'observation', frequency: 'biannual', meansOfVerification: 'Household observation checklist during the post-distribution monitoring survey',
    targetSuggestion: '80', targetBasis: 'document',
  }),
  // 3. Output count from the document; the library entry adds sex disaggregation.
  library('WA-04', {
    resultCode: 'O1.1', level: 'output', name: 'Number of people receiving trucked drinking water',
    nameAr: 'عدد الأشخاص الذين يحصلون على مياه الشرب المنقولة بالصهاريج',
    definition: 'People in households registered at a served delivery point who received water at least once in the month.',
    disaggregation: ['age', 'displacement_status'], frequency: 'monthly', meansOfVerification: 'Water-trucking delivery logs and delivery-point registers',
    targetSuggestion: '12,000', targetBasis: 'document', confidence: 'high',
  }),
  // 4. A custom indicator without an Arabic name and with a generic means of verification.
  suggestion({
    resultCode: 'O1.2', level: 'output', name: 'Number of hygiene kits distributed to displaced households',
    definition: 'Kits signed for by the receiving household.', meansOfVerification: 'Project reports', targetSuggestion: '2,400', targetBasis: 'document',
  }),
  // 5. Unknown library id and an invented baseline; the target is a method.
  library('CA-99', {
    resultCode: 'O2', name: '% of assisted households reporting they can meet their basic needs',
    nameAr: 'نسبة الأسر المستفيدة التي تفيد بقدرتها على تلبية احتياجاتها الأساسية',
    definition: 'Households reporting they can meet all or most of their basic needs as they define them.', unit: 'percent',
    numerator: 'Households reporting they meet all or most basic needs', denominator: 'Households surveyed',
    disaggregation: ['sex_of_household_head', 'displacement_status'], method: 'hh_survey', frequency: 'per_cohort',
    meansOfVerification: 'Post-distribution monitoring survey (phone), sample of assisted households',
    baselineSuggestion: '35%', baselineBasis: 'document', targetSuggestion: 'baseline + 15 percentage points', targetBasis: 'method_only',
  }),
  // 6. A target figure used as a baseline (wrong kind): the target is kept, the baseline removed.
  suggestion({
    resultCode: 'O2.1', level: 'output', name: 'Number of households receiving multipurpose cash transfers',
    nameAr: 'عدد الأسر التي تتلقى تحويلات نقدية متعددة الأغراض',
    definition: 'Households that received at least one full transfer.', disaggregation: ['sex_of_household_head'],
    meansOfVerification: 'Financial service provider payment reconciliation reports', baselineSuggestion: '1,800', baselineBasis: 'document',
    targetSuggestion: '1,800', targetBasis: 'document',
  }),
  // 7. Accountability to affected people (humanitarian project); the model left the Arabic name empty.
  library('AC-01', {
    resultCode: 'O2', name: '% of assisted people who know how to give feedback or make a complaint', standardReferenceCode: 'CHS 5',
    definition: 'Assisted people who can name at least one feedback or complaint channel of the project.', unit: 'percent',
    numerator: 'Respondents naming at least one channel', denominator: 'Respondents surveyed',
    disaggregation: ['sex', 'age', 'disability'], method: 'hh_survey', frequency: 'biannual',
    meansOfVerification: 'Post-distribution monitoring survey, accountability module', targetBasis: 'none',
  }),
  // 8. Linked to an activity code: no result of the run, so it is dropped (rule x1).
  suggestion({
    resultCode: 'A2.1.2', level: 'output', name: 'Number of cash rounds delivered', nameAr: 'عدد جولات المساعدات النقدية المنفذة',
    meansOfVerification: 'Payment reconciliation reports',
  }),
];

/** The result codes of a KPI call: the lines of its SUGGEST FOR section. */
function suggestForCodes(prompt: string): string[] {
  const section = prompt.split('\n\n').find(part => part.startsWith('SUGGEST FOR\n')) ?? '';
  return section.split('\n').slice(1).flatMap(line => {
    const match = /^(.+?) \[(impact|outcome|output)\]:/.exec(line);
    return match ? [match[1]] : [];
  });
}

/** The KPI answer for one indicator-step call: the suggestions of the call's own results. */
const INDICATORS_ANSWER = (params: AnyParams) => {
  const codes = new Set(suggestForCodes(params.messages[0].content));
  return { suggestions: SUGGESTIONS.filter(s => codes.has(s.resultCode)), frameworkWarnings: [] };
};

type AnyParams = GenerateStructuredParams<any>;

/**
 * Mocks generateStructured per feature. Like the real client, answers are validated with the call's
 * schema, and each call writes one AiCall row (numbers and ids only), which the smoke report reads.
 */
function mockAi(replies: Record<string, ((params: AnyParams) => unknown) | unknown>) {
  generateStructured.mockImplementation(async (params: AnyParams): Promise<StructuredResult<unknown>> => {
    if (!(params.feature in replies)) throw new Error(`unexpected AI call: ${params.feature}`);
    const reply = replies[params.feature];
    const log = (status: 'success' | 'refusal', usage = { inputTokens: 4200, outputTokens: 7600, cacheReadTokens: 9800, cacheWriteTokens: 0 }) =>
      prisma.aiCall.create({
        data: {
          feature: params.feature, model: 'configured-main-model', servedModel: SERVED_MODEL, promptVersion: params.promptVersion, status,
          attempts: 1, ...usage, latencyMs: 41_000, estimatedCostUsd: status === 'success' ? 0.0852 : 0.0011,
          organizationId: params.context?.organizationId ?? null, projectId: params.context?.projectId ?? null,
        },
        select: { id: true },
      });
    let data: unknown;
    try {
      data = typeof reply === 'function' ? await (reply as (params: AnyParams) => unknown)(params) : reply;
    } catch (err) {
      if (err instanceof AiRefusalError) await log('refusal', { inputTokens: 4200, outputTokens: 12, cacheReadTokens: 9800, cacheWriteTokens: 0 });
      throw err;
    }
    const parsed = params.schema.parse(data);
    const row = await log('success');
    return {
      data: parsed,
      model: SERVED_MODEL,
      promptVersion: params.promptVersion,
      usage: { inputTokens: 4200, outputTokens: 7600, cacheReadTokens: 9800, cacheWriteTokens: 0 },
      estimatedCostUsd: 0.0852,
      aiCallId: row.id,
    };
  });
}

const calls = () => generateStructured.mock.calls.map(c => c[0] as AnyParams);
const promptOf = (feature: string) => calls().find(p => p.feature === feature)!.messages[0].content;
/** Every indicator-step prompt (one per KPI batch), joined. */
const indicatorPrompts = () => calls().filter(p => p.feature === 'framework.indicators').map(p => p.messages[0].content).join('\n\n');

/** Resets the database and creates an organisation, the seed library and the dev seed's generation project with its proposal. */
async function seedProject(): Promise<{ fx: OrgFixture; projectId: string }> {
  generateStructured.mockReset();
  await resetDatabase();
  const fx = await createOrgFixture('acceptance');
  await seedLibrary(prisma);
  // Same as the dev seed's "try framework generation here" project (prisma/seed.ts).
  const project = await prisma.project.create({
    data: {
      organizationId: fx.org.id,
      name: SEED_PROJECT_NAME,
      nameAr: 'الاستجابة الطارئة في مجالي المياه والصرف الصحي والمساعدات النقدية في غزة',
      description: 'Emergency water trucking, hygiene kits and multipurpose cash assistance for displaced and host-community households in the southern Gaza Strip.',
      sector: 'wash',
      sectors: ['wash', 'cash', 'shelter'],
      humanitarian: true,
      donor: 'DG ECHO',
      donorType: 'echo',
      budgetUsd: 600000,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      targetBeneficiaries: 12000,
      geographicScope: 'Gaza Strip - Khan Younis, Deir al-Balah',
      status: 'setup',
    },
  });
  await prisma.document.create({
    data: {
      projectId: project.id, uploadedBy: fx.officer.id, fileName: DOCUMENT_NAME, fileUrl: `projects/${project.id}/${DOCUMENT_NAME}`,
      fileType: 'proposal', parsedText: PROPOSAL, parsingStatus: 'completed',
    },
  });
  return { fx, projectId: project.id };
}

describe.skipIf(!hasTestDatabase)('Phase 3 acceptance: framework generation on the seed project', () => {
  let fx: OrgFixture;
  let projectId: string;

  beforeEach(async () => {
    ({ fx, projectId } = await seedProject());
  });

  it('completes and stores indicators with every reference-sheet field filled or marked "to be confirmed"', async () => {
    const framework = await prisma.framework.create({ data: { projectId, version: 1, status: 'draft', aiModelUsed: 'configured-main-model' } });
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': INDICATORS_ANSWER });

    const { generateFramework } = await vi.importActual<typeof import('../src/services/ai/frameworkGenerator')>('../src/services/ai/frameworkGenerator');
    await generateFramework(framework.id, projectId);

    // The structure call, then the KPI pipeline's two batches: G with O1 and its outputs, then O2 with its output.
    expect(calls().map(c => c.feature)).toEqual(['framework.structure', 'framework.indicators', 'framework.indicators']);
    expect(calls().slice(1).map(c => suggestForCodes(c.messages[0].content))).toEqual([['G', 'O1', 'O1.1', 'O1.2'], ['O2', 'O2.1']]);
    const context = { organizationId: fx.org.id, projectId };
    expect(calls()[0]).toMatchObject({
      model: 'main', effort: 'medium', maxTokens: 12_000, timeoutMs: 180_000, schema: PROJECT_STRUCTURE_SCHEMA,
      system: FRAMEWORK_STRUCTURE_SYSTEM, promptVersion: 'framework-v4', context,
    });
    for (const call of calls().slice(1)) {
      expect(call).toMatchObject({
        model: 'main', effort: 'low', maxTokens: KPI_CALLS.batch.maxTokens, timeoutMs: KPI_CALLS.batch.timeoutMs, schema: KPI_SUGGESTIONS_SCHEMA,
        system: KPI_SYSTEM, promptVersion: KPI_PROMPT_VERSION, context,
      });
    }

    // Privacy: the legacy document is redacted before it reaches any prompt.
    for (const value of PERSONAL_DATA) {
      expect(promptOf('framework.structure')).not.toContain(value);
      expect(indicatorPrompts()).not.toContain(value);
    }
    expect(promptOf('framework.structure')).toContain('[phone removed]');
    // Invented figures and dates are dropped before the indicator step; the documented ones are passed on as DOCUMENT FACTS.
    expect(indicatorPrompts()).toContain('Result 1.1: 12,000 people receive trucked drinking water for nine months');
    expect(indicatorPrompts()).toContain('(6,000 by the end of March 2026)');
    expect(indicatorPrompts()).not.toContain('70%');
    expect(indicatorPrompts()).not.toContain('the first on 15 March 2026');
    expect(indicatorPrompts()).not.toContain('none: no document values are available');
    expect(indicatorPrompts()).toContain('WA-01 [outcome]');
    expect(indicatorPrompts()).toContain('AC-01 [outcome]');

    // Results chain: goal, outcomes, outputs and activities (the blank activity is dropped).
    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id } });
    const byCode = Object.fromEntries(nodes.map(n => [n.code, n]));
    expect(Object.keys(byCode).sort()).toEqual(['A1.1.1', 'A1.1.2', 'A1.2.1', 'A2.1.1', 'A2.1.2', 'G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
    expect(byCode.O2).toMatchObject({ level: 'outcome', parentId: byCode.G.id, textAr: null });

    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(indicators).toHaveLength(8);
    const redacted = redactPersonalData(PROPOSAL).text;

    for (const i of indicators) {
      const label = i.indicatorText;
      const gaps = referenceSheetGaps(i);
      // Provenance
      expect(i, label).toMatchObject({ provenance: 'ai_generated', aiModel: SERVED_MODEL, promptVersion: KPI_PROMPT_VERSION, isApproved: false });
      expect(i.level, label).not.toBe('activity');
      expect(i.resultId, label).not.toBeNull();
      // Every new reference-sheet field is filled or explicitly "to be confirmed".
      for (const field of ['definition', 'meansOfVerification', 'baselineMethod', 'targetJustification', 'assumptions', 'responsibility', 'unit'] as const) {
        expect(i[field]?.trim(), `${label}: ${field}`).toBeTruthy();
      }
      expect(i.direction, label).not.toBeNull();
      expect(Array.isArray(i.disaggregation), label).toBe(true);
      if (isPeopleLevelIndicator(i.indicatorText, i.indicatorTextAr)) {
        expect((i.disaggregation as string[]).some(k => k === 'sex' || k === 'sex_of_household_head'), `${label}: sex disaggregation`).toBe(true);
      }
      if (i.unit === 'percent') {
        expect(i.calculation, label).toMatchObject({
          numerator: expect.any(String), denominator: expect.any(String), formula: expect.any(String), rounding: expect.any(String),
        });
      }
      // The Arabic name is never invented: an empty one is a listed gap.
      expect(Boolean(i.indicatorTextAr) || gaps.includes('indicatorTextAr'), `${label}: Arabic name`).toBe(true);
      // D22: the model proposes no baseline date, intermediate targets, assumptions or responsibility; the server marks them.
      expect(i.baselineDate, label).toBeNull();
      expect(i.baselineMethod!.endsWith(BASELINE_DATE_TO_BE_CONFIRMED), `${label}: baseline date`).toBe(true);
      expect(i.targetJustification!.endsWith(INTERMEDIATE_TARGETS_TO_BE_CONFIRMED), `${label}: intermediate targets`).toBe(true);
      expect(i, label).toMatchObject({ assumptions: TO_BE_CONFIRMED, responsibility: TO_BE_CONFIRMED });
      // The indicator dates are the project dates (m15).
      expect(i, label).toMatchObject({ startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') });
      // Never invented: every kept value is written in the document or in the linked library entry.
      if (i.baselineValue) expect(appearsInDocuments(i.baselineValue, [redacted]), `${label}: baseline`).toBe(true);
      if (i.targetValue && i.libraryId !== 'WA-01') expect(appearsInDocuments(i.targetValue, [redacted]), `${label}: target`).toBe(true);
    }

    // Chain order (level, then sibling order): the goal, the outcomes O1 and O2, then the outputs.
    const codeOf = (resultId: string | null) => nodes.find(n => n.id === resultId)?.code;
    expect(indicators.map(i => [codeOf(i.resultId), i.libraryId])).toEqual([
      ['G', null], ['O1', 'WA-01'], ['O1', 'WA-05'], ['O2', 'AC-01'], ['O2', null], ['O1.1', 'WA-04'], ['O2.1', null], ['O1.2', null],
    ]);
    const [impact, water, handwashing, feedback, basicNeeds, trucked, cash, kits] = indicators;
    const gaps = Object.fromEntries(indicators.map(i => [i.indicatorText, referenceSheetGaps(i)]));
    // What the officer still has to fill or confirm. Since Phase 4 the model no longer proposes assumptions, responsibility,
    // baseline method or date, intermediate targets or a percentage's rounding (D19, D22): the server marks them.
    const serverMarked = ['intermediateTargets', 'assumptions', 'responsibility'];
    expect(gaps).toEqual({
      [impact.indicatorText]: ['calculation', 'baselineDate', 'baselineMethod', ...serverMarked],
      [water.indicatorText]: ['baselineDate', ...serverMarked],
      [handwashing.indicatorText]: ['definition', 'calculation', 'baselineDate', 'baselineMethod', ...serverMarked],
      [feedback.indicatorText]: ['calculation', 'baselineDate', 'baselineMethod', ...serverMarked],
      [basicNeeds.indicatorText]: ['calculation', 'baselineDate', 'baselineMethod', ...serverMarked],
      [trucked.indicatorText]: ['baselineMethod', ...serverMarked],
      [cash.indicatorText]: ['baselineMethod', ...serverMarked],
      [kits.indicatorText]: ['indicatorTextAr', 'meansOfVerification', 'baselineMethod', ...serverMarked],
    });
    // An empty Arabic name is taken from the linked library entry (rule x3), never invented for a custom indicator.
    expect(handwashing.indicatorTextAr).toMatch(/[\u0600-\u06FF]/);
    expect(feedback.indicatorTextAr).toMatch(/[\u0600-\u06FF]/);
    expect(handwashing).toMatchObject({
      definition: TO_BE_CONFIRMED, baselineMethod: `${TO_BE_CONFIRMED}. ${BASELINE_DATE_TO_BE_CONFIRMED}`,
      calculation: { numerator: TO_BE_CONFIRMED, denominator: TO_BE_CONFIRMED, formula: PERCENT, rounding: TO_BE_CONFIRMED },
    });
    // Kits are counted, not people: rule 7 adds sex only when the counted noun is people (AI-5 re-check).
    expect(kits).toMatchObject({ indicatorTextAr: null, meansOfVerification: TO_BE_CONFIRMED, disaggregation: [] });

    // Document values are kept when they are verified figures of the same kind, and cited; the standard threshold comes from the linked entry.
    expect(water).toMatchObject({
      baselineValue: '6', baselineMethod: `Baseline taken from the project documents (source: ${DOCUMENT_NAME}). ${BASELINE_DATE_TO_BE_CONFIRMED}`,
      targetValue: '15', libraryId: 'WA-01', intermediateTargets: [],
      standardReferenceCode: 'Sphere Water supply standard — minimum 15 l/p/d (aim for 20)', disaggregation: ['sex', 'location', 'displacement_status'],
    });
    expect(water.targetJustification).toMatch(/^Proposed standard threshold \(Sphere Water supply standard.* — confirm it applies to this project\. Intermediate targets: to be confirmed after the baseline\.$/);
    expect(trucked).toMatchObject({
      targetValue: '12,000', libraryId: 'WA-04', intermediateTargets: [],
      targetJustification: `Target taken from the project documents (source: ${DOCUMENT_NAME}). ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}`,
      standardReferenceCode: 'EU GERF 2.38', disaggregation: ['sex', 'age', 'displacement_status'],
    });
    expect(kits).toMatchObject({ targetValue: '2,400', targetJustification: `Target taken from the project documents (source: ${DOCUMENT_NAME}). ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}` });
    expect(cash).toMatchObject({ targetValue: '1,800', baselineValue: null, level: 'output' });
    // 1,800 is a target of the proposal, not a baseline.
    expect(cash.targetJustification).toBe(`Target taken from the project documents (source: ${DOCUMENT_NAME}). `
      + `The baseline proposed by the AI was not found as a baseline in the project documents and was removed (pending baseline). ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}`);

    // Invented numbers are removed, and the justification does not repeat them: 80 is only a budget cell.
    expect(handwashing.targetValue).toBeNull();
    expect(handwashing.targetJustification).toMatch(/^Proposed method: .* — confirm after baseline\. The target proposed by the AI was not found as a target/);
    expect(handwashing.targetJustification).not.toContain('80');
    // An unknown library id becomes a custom indicator; an invented baseline is removed.
    expect(basicNeeds).toMatchObject({ baselineValue: null, libraryId: null });
    expect(basicNeeds.targetJustification).toMatch(/^Proposed method: baseline \+ 15 percentage points — confirm after baseline\. The baseline proposed by the AI was not found/);
    expect(impact).toMatchObject({
      targetValue: null, dataCollectionMethod: 'secondary_data', direction: 'decrease',
      targetJustification: `Proposed method: baseline - 20 percentage points, set once the baseline is known — confirm after baseline. ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}`,
    });
    expect(feedback).toMatchObject({
      libraryId: 'AC-01', standardReferenceCode: 'Core Humanitarian Standard (2024) Commitment 5 (aligned)', targetValue: null,
    });

    // Framework and project status, the served model, and the admin notification.
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', aiModelUsed: SERVED_MODEL, generationError: null });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('framework_review');
    const notes = await prisma.notification.findMany({ where: { userId: fx.admin.id } });
    expect(notes.map(n => n.message)).toEqual([expect.stringContaining('8 indicators across 11 results')]);
    // The organisation's other project is untouched.
    expect(await prisma.indicator.count({ where: { frameworkId: fx.framework.id } })).toBe(1);
  });

  it('runs from the generate route: the new version records the configured model, then the served one', async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    mockAi({
      'framework.structure': async () => { await released; return STRUCTURE_ANSWER; },
      'framework.indicators': INDICATORS_ANSWER,
    });

    const res = await request(app).post(`/api/projects/${projectId}/framework/generate`).set('Authorization', fx.officerAuth);
    expect(res.status).toBe(202);
    const { frameworkId } = res.body as { frameworkId: string };
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: frameworkId } })).toMatchObject({ version: 1, status: 'draft', aiModelUsed: 'configured-main-model' });

    release();
    await vi.waitFor(async () => {
      expect(await prisma.framework.findUniqueOrThrow({ where: { id: frameworkId } })).toMatchObject({ status: 'expert_review', aiModelUsed: SERVED_MODEL });
    }, { timeout: 10_000, interval: 50 });
    expect(await prisma.indicator.count({ where: { frameworkId } })).toBe(8);
  });

  it('marks the new version as failed when the model refuses: the status reports it and the project keeps its framework', async () => {
    // The project's current framework, generated earlier.
    const v1 = await prisma.framework.create({ data: { projectId, version: 1, status: 'expert_review', aiModelUsed: SERVED_MODEL } });
    await prisma.indicator.create({
      data: { frameworkId: v1.id, indicatorText: 'Number of people receiving trucked drinking water', level: 'output', dataCollectionMethod: 'document_review', frequency: 'monthly', phases: [] },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': async () => { throw new AiRefusalError('framework.indicators', null); } });

    const res = await request(app).post(`/api/projects/${projectId}/framework/generate`).set('Authorization', fx.officerAuth);
    expect(res.status).toBe(202);
    const { frameworkId } = res.body as { frameworkId: string };
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 10_000, interval: 50 });

    const failed = await prisma.framework.findUniqueOrThrow({ where: { id: frameworkId } });
    expect(failed).toMatchObject({ version: 2, status: 'draft', generationError: 'The AI model declined the request (framework.indicators).' });
    expect(await prisma.resultNode.count({ where: { frameworkId } })).toBe(0);
    expect(await prisma.indicator.count({ where: { frameworkId } })).toBe(0);

    // The wizard's poll stops with "failed" and a safe message.
    const status = await request(app).get(`/api/frameworks/${frameworkId}/status`).set('Authorization', fx.officerAuth);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ frameworkId, status: 'failed', message: 'The AI model declined the request (framework.indicators).' });
    // The empty failed version does not hide the framework the project already has.
    const current = await request(app).get(`/api/projects/${projectId}/framework`).set('Authorization', fx.officerAuth);
    expect(current.body).toMatchObject({ id: v1.id, version: 1 });
    expect(current.body.indicators).toHaveLength(1);
    // The next generation gets version 3: version numbers are never reused.
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': INDICATORS_ANSWER });
    const again = await request(app).post(`/api/projects/${projectId}/framework/generate`).set('Authorization', fx.officerAuth);
    await vi.waitFor(async () => {
      expect(await prisma.framework.findUniqueOrThrow({ where: { id: again.body.frameworkId } })).toMatchObject({ version: 3, status: 'expert_review' });
    }, { timeout: 10_000, interval: 50 });
    expect((await request(app).get(`/api/projects/${projectId}/framework`).set('Authorization', fx.officerAuth)).body).toMatchObject({ version: 3 });

    const logged = errors.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('AiRefusalError');
    for (const value of [...PERSONAL_DATA, '12,000 people']) expect(logged).not.toContain(value);
    errors.mockRestore();
  });
});

// ---------------------------------------------------------------- scripts/ai-smoke.ts

/** Looks like an Anthropic key to the placeholder check; built at runtime, it is no real key. */
const FAKE_KEY = ['sk', 'ant', 'api03', 'Ab9'.repeat(30)].join('-');

describe('scripts/ai-smoke: helpers', () => {
  it('parses --yes, --project, --i-know-this-is-not-shared and --help, and rejects unknown options', () => {
    expect(parseSmokeArgs([])).toEqual({ yes: false, projectId: null, help: false, notShared: false });
    expect(parseSmokeArgs(['--yes', '--project', 'p-1'])).toEqual({ yes: true, projectId: 'p-1', help: false, notShared: false });
    expect(parseSmokeArgs(['--project=p-2', '-h'])).toEqual({ yes: false, projectId: 'p-2', help: true, notShared: false });
    expect(parseSmokeArgs(['--yes', NOT_SHARED_FLAG])).toMatchObject({ yes: true, notShared: true });
    expect(parseSmokeArgs(['--project', '  '])).toMatchObject({ projectId: null });
    expect(() => parseSmokeArgs(['--force'])).toThrow();
    expect(() => parseSmokeArgs(['p-3'])).toThrow();
  });

  it('recognises missing and placeholder API keys', () => {
    expect(apiKeyProblem(undefined)).toMatch(/not set/);
    expect(apiKeyProblem('  ')).toMatch(/not set/);
    for (const placeholder of ['sk-ant-test-not-a-real-key', 'sk-ant-api03-your-key-here-0000000000', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx', 'sk-ant-api03-placeholder_0000000000000', 'changeme']) {
      expect(apiKeyProblem(placeholder), placeholder).toMatch(/looks like a placeholder/);
    }
    for (const other of ['sk-ant-...', 'sk-ant-short', 'sk-proj-abcdefghijklmnopqrstuvwxyz']) {
      expect(apiKeyProblem(other), other).toMatch(/does not look like an Anthropic API key/);
    }
    expect(apiKeyProblem(FAKE_KEY)).toBeNull();
  });

  it('refuses in production, with a placeholder key, on a database that may be shared and without --yes (in that order)', () => {
    const LOCAL = 'postgresql://raqib:pw@localhost:5432/raqib';
    const SHARED = 'postgresql://postgres.abcd:s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
    expect(smokeRefusal({ nodeEnv: 'production', apiKey: FAKE_KEY, yes: true, databaseUrl: LOCAL })).toMatch(/NODE_ENV is "production"/);
    expect(smokeRefusal({ nodeEnv: 'production', apiKey: 'sk-ant-...', yes: false, databaseUrl: SHARED })).toMatch(/production/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: 'sk-ant-...', yes: true, databaseUrl: LOCAL })).toMatch(/^Refusing to run: ANTHROPIC_API_KEY does not look like/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: 'sk-ant-test-not-a-real-key', yes: true, databaseUrl: LOCAL })).toMatch(/placeholder/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: true, databaseUrl: SHARED })).toMatch(/^Refusing to run: DATABASE_URL points at database "postgres"/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: false, databaseUrl: SHARED })).toMatch(/DATABASE_URL/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: false, databaseUrl: LOCAL })).toMatch(/--yes/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: true, databaseUrl: LOCAL })).toBeNull();
    // The flag allows a database that does not look like a development one.
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: true, databaseUrl: SHARED, notShared: true })).toBeNull();
  });

  it('accepts only databases that look like development databases, and never prints the URL', () => {
    for (const url of [
      'postgresql://raqib:pw@localhost:5432/raqib', 'postgresql://raqib:pw@127.0.0.1/raqib', 'postgresql://raqib:pw@[::1]:5432/raqib',
      'postgresql://u:pw@db.example.com:5432/raqib_dev', 'postgresql://u:pw@db.example.com/raqib-test?sslmode=require', 'postgres://u:pw@LOCALHOST/x',
    ]) expect(databaseProblem(url), url).toBeNull();
    for (const url of ['postgresql://u:s3cret@db.abcd.supabase.co:5432/postgres', 'postgresql://u:s3cret@10.0.0.5/raqib', 'postgresql://u:s3cret@prod-db/']) {
      const problem = databaseProblem(url);
      expect(problem, url).toMatch(/does not look like a development database/);
      expect(problem, url).toContain(NOT_SHARED_FLAG);
      expect(problem, url).not.toContain('s3cret');
    }
    expect(databaseProblem(undefined)).toBe('DATABASE_URL is not a valid database URL.');
    expect(databaseProblem('not a url')).toBe('DATABASE_URL is not a valid database URL.');
  });

  it('formats padded tables and the report rows', () => {
    expect(formatTable(['a', 'bb'], [['1', '2'], ['333', '4']])).toBe('a    bb\n---  --\n1    2\n333  4');
    const sheet = {
      indicatorTextAr: 'مؤشر', unit: 'number', definition: 'd', direction: 'increase', disaggregation: ['sex'], meansOfVerification: 'Registers',
      baselineDate: '2026-01-01', baselineMethod: 'b', targetJustification: 't', intermediateTargets: [{ date: '2026-06-30', value: '5' }],
      assumptions: 'a', responsibility: 'r',
    };
    const rows = [
      { ...sheet, level: 'impact' as const, resultCode: 'G', indicatorText: 'Water points functional' },
      { ...sheet, level: 'output' as const, resultCode: 'O1.1', indicatorText: `Number of people trained in ${'very '.repeat(20)}long courses`, assumptions: TO_BE_CONFIRMED },
      { ...sheet, level: 'output' as const, resultCode: null, indicatorText: 'Kits', definition: null },
    ];
    expect(levelRows(rows)).toEqual([['impact', '1'], ['output', '2'], ['total', '3']]);
    const gaps = gapRows(rows);
    // Columns: result, level, indicator, fields still "to be confirmed", missing fields.
    expect(gaps[0]).toEqual(['G', 'impact', 'Water points functional', 'none', 'none']);
    expect(gaps[1][2]).toHaveLength(70);
    expect(gaps[1][2].endsWith('…')).toBe(true);
    expect(gaps[1].slice(3)).toEqual(['assumptions', 'none']);
    expect(gaps[2]).toEqual(['—', 'output', 'Kits', 'none', 'definition']);

    const call = {
      feature: 'framework.structure', status: 'success' as const, model: 'm', servedModel: 's', attempts: 1, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 100, cacheWriteTokens: 0, latencyMs: 1000, estimatedCostUsd: 0.0123,
    };
    const table = aiCallRows([call, { ...call, feature: 'framework.indicators', servedModel: null, attempts: 2, estimatedCostUsd: 0.0201 }]);
    expect(table[1]).toEqual(['framework.indicators', 'success', 'm', '—', '2', '10', '5', '100', '0', '1000', '0.0201']);
    expect(table[2]).toEqual(['total', '', '', '', '3', '20', '10', '200', '0', '2000', '0.0324']);
    expect(aiCallRows([{ ...call, estimatedCostUsd: null }])[1].at(-1)).toBe('unknown');
    expect(AI_CALL_HEADER).toHaveLength(table[0].length);
  });
});

describe.skipIf(!hasTestDatabase)('scripts/ai-smoke: run (AI client mocked)', () => {
  let fx: OrgFixture;
  let projectId: string;
  let out: string[];
  let err: string[];
  const io = () => ({ log: (line: string) => out.push(line), error: (line: string) => err.push(line) });

  beforeEach(async () => {
    ({ fx, projectId } = await seedProject());
    out = [];
    err = [];
  });

  it('refuses with the test key, in production, on a shared database, without --yes and on bad options, before any AI call or write', async () => {
    expect(await runAiSmoke(['--yes'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/placeholder/);
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'production' })).toBe(1);
    expect(err.join('\n')).toMatch(/NODE_ENV is "production"/);
    const shared = 'postgresql://postgres:s3cret@db.abcd.supabase.co:5432/postgres';
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development', databaseUrl: shared })).toBe(1);
    expect(err.join('\n')).toMatch(/does not look like a development database/);
    expect(err.join('\n')).not.toContain('s3cret');
    expect(await runAiSmoke([], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toMatch(/Re-run with --yes/);
    expect(await runAiSmoke(['--everything'], io())).toBe(1);
    expect(err.join('\n')).toContain('Usage: npm run ai:smoke');
    expect(await runAiSmoke(['--help'], io())).toBe(0);
    expect(out.join('\n')).toContain(SEED_PROJECT_NAME);

    expect(generateStructured).not.toHaveBeenCalled();
    expect(await prisma.framework.count({ where: { projectId } })).toBe(0);
  });

  it('generates a new version of the seed project and prints the levels, the gaps and the AI calls', async () => {
    await prisma.framework.create({ data: { projectId, version: 1, status: 'approved', aiModelUsed: 'an-earlier-model' } });
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': INDICATORS_ANSWER });

    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(0);
    expect(err).toEqual([]);
    const report = out.join('\n');

    const created = await prisma.framework.findFirstOrThrow({ where: { projectId, version: 2 } });
    expect(created).toMatchObject({ status: 'expert_review', aiModelUsed: SERVED_MODEL });
    expect(report).toContain(`Framework: version 2 (${created.id})`);
    expect(report).toContain('Model:     configured-main-model (AI_MODEL_MAIN)');
    expect(report).toContain('Documents: 1 parsed');
    expect(report).toContain(`served model: ${SERVED_MODEL}; 11 results; prompt version ${KPI_PROMPT_VERSION}`);
    expect(report).toMatch(/^impact\s+1$/m);
    expect(report).toMatch(/^outcome\s+4$/m);
    expect(report).toMatch(/^output\s+3$/m);
    expect(report).toMatch(/^total\s+8$/m);
    // D22: the model no longer writes assumptions, responsibility or intermediate targets, so no sheet is complete yet.
    expect(report).toContain('Reference sheets: 0 of 8 indicators complete (every field filled); 8 with fields still "to be confirmed"; 1 with missing fields');
    expect(report).toMatch(/^O1\s+outcome\s+% of target households with a handwashing facility.*\s{2}definition, calculation, baselineDate, baselineMethod, intermediateTargets, targetJustification, assumptions, responsibility\s+none$/m);
    expect(report).toMatch(/^O1\.2\s+output\s+Number of hygiene kits distributed to displaced households\s+meansOfVerification, baselineMethod, intermediateTargets, assumptions, responsibility\s+indicatorTextAr$/m);
    expect(report).toMatch(/^O1\.1\s+output\s+Number of people receiving trucked drinking water\s+baselineMethod, intermediateTargets, assumptions, responsibility\s+none$/m);
    expect(report).toMatch(/^framework\.structure\s+success\s+configured-main-model\s+claude-sonnet-5-5-20261001\s+1\s+4200\s+7600/m);
    // The KPI pipeline's two batches (design 4.6, D19).
    expect(report.match(/^framework\.indicators\s+success/gm)).toHaveLength(2);
    expect(report).toMatch(/^total\s+3\s+12600\s+22800\s+29400\s+0\s+123000\s+0\.2556$/m);
    // Never document text or personal data.
    for (const value of [...PERSONAL_DATA, 'trucked drinking water for nine months']) expect(report).not.toContain(value);
  });

  it('reports a failed generation, marks the version as failed and shows the refused call', async () => {
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': async () => { throw new AiRefusalError('framework.indicators', null); } });

    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toMatch(/^Generation failed: AiRefusalError: The AI model declined the request \(framework\.indicators\)\.$/m);
    expect(err.join('\n')).toMatch(/Framework version 1 \(.+\) is marked as failed and is not the project's current framework: The AI model declined the request/);
    const framework = await prisma.framework.findFirstOrThrow({ where: { projectId } });
    expect(framework).toMatchObject({ status: 'draft', generationError: 'The AI model declined the request (framework.indicators).' });
    expect(await prisma.indicator.count({ where: { frameworkId: framework.id } })).toBe(0);
    expect(out.join('\n')).toMatch(/^framework\.indicators\s+refusal/m);
    expect(out.join('\n')).not.toContain('Reference-sheet gaps');
  });

  it('takes --project: an unknown id fails, a project without parsed documents uses its metadata', async () => {
    expect(await runAiSmoke(['--yes', '--project', 'no-such-project'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toContain('Project no-such-project not found.');

    mockAi({ 'framework.indicators': INDICATORS_ANSWER });
    expect(await runAiSmoke(['--yes', '--project', fx.project.id], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(0);
    expect(out.join('\n')).toContain('Documents: none parsed; the results chain comes from the project metadata');
    // No documents: no structure call, only the KPI pipeline's indicator batches.
    expect(calls().length).toBeGreaterThan(0);
    expect(calls().every(c => c.feature === 'framework.indicators')).toBe(true);
    expect(await prisma.framework.findFirstOrThrow({ where: { projectId: fx.project.id, version: 2 } })).toMatchObject({ status: 'expert_review' });
  });

  it('prints only the class name of an unexpected error', async () => {
    generateStructured.mockImplementation(async () => { throw new Error('relation "Project" row (name)=(Gaza 0599 123 456) violates a check'); });
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toMatch(/^Generation failed: Error$/m);
    expect(err.join('\n')).toContain('Framework generation failed because of an internal error (Error).');
    expect(err.join('\n')).not.toContain('0599');
  });

  it('counts parsed documents without FGD or KII transcripts', async () => {
    await prisma.document.create({
      data: {
        projectId, uploadedBy: fx.officer.id, fileName: 'kii-transcript.txt', fileUrl: `projects/${projectId}/kii.txt`, fileType: 'other',
        parsedText: 'KII transcript.', parsingStatus: 'completed', qualitativeSource: true,
      },
    });
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': INDICATORS_ANSWER });
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(0);
    expect(out.join('\n')).toContain('Documents: 1 parsed');
    expect(promptOf('framework.structure')).not.toContain('KII transcript.');
  });

  it('fails when the dev seed project is missing', async () => {
    await prisma.document.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toContain(`Project "${SEED_PROJECT_NAME}" not found: run npm run seed, or pass --project <id>.`);
  });
});
