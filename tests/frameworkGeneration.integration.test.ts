import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import type { GenerateStructuredParams, StructuredResult } from '../src/services/ai/client';
import { AiRefusalError } from '../src/services/ai/errors';
import { TO_BE_CONFIRMED, appearsInDocuments, isPeopleLevelIndicator, referenceSheetGaps } from '../src/services/ai/frameworkNormalize';
import {
  FRAMEWORK_INDICATORS_SCHEMA,
  FRAMEWORK_INDICATORS_SYSTEM,
  FRAMEWORK_STRUCTURE_SYSTEM,
  PROJECT_STRUCTURE_SCHEMA,
} from '../src/services/ai/prompts/framework';
import { redactPersonalData } from '../src/services/ai/redact';
import { seedLibrary } from '../src/services/library/seed';
import {
  AI_CALL_HEADER,
  SEED_PROJECT_NAME,
  aiCallRows,
  apiKeyProblem,
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
 * The project, document and library match the dev seed (prisma/seed.ts: the DG ECHO project without a
 * framework, and knowledge/indicator-library.json). The AI client is mocked with realistic, schema-valid
 * answers in which some fields are deliberately empty and some figures invented; everything after the
 * model call (normalisation, rules, storage) is the real code. The real-API run is scripts/ai-smoke.ts.
 */

// tests/setup.ts mocks the generator for route tests; this file runs the real one.
vi.unmock('../src/services/ai/frameworkGenerator');

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
  'Results. Specific objective 1: displaced and host-community households have sufficient safe water and practise safe hygiene. Result 1.1: 12,000 people receive trucked drinking water for nine months. Result 1.2: 2,400 hygiene kits are distributed to displaced households.',
  'Specific objective 2: households meet their basic needs in dignity. Result 2.1: 1,800 households receive three rounds of multipurpose cash.',
  'Field coordinator: 0599 123 456, coordinator@example.org (staff ID 401234567).',
].join('\n\n');
const PERSONAL_DATA = ['0599 123 456', 'coordinator@example.org', '401234567'];

const EMPTY_CALCULATION = { numerator: '', denominator: '', formula: '' };
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
    { resultCode: 'O1.1', kind: 'target', value: '12,000', description: 'people receiving trucked water', quote: 'Result 1.1: 12,000 people receive trucked drinking water for nine months.' },
    { resultCode: 'O1.2', kind: 'target', value: '2,400', description: 'hygiene kits', quote: 'Result 1.2: 2,400 hygiene kits are distributed to displaced households.' },
    { resultCode: 'O2.1', kind: 'target', value: '1,800', description: 'households receiving cash', quote: 'Result 2.1: 1,800 households receive three rounds of multipurpose cash.' },
    // Invented: not in the document, so it never reaches the indicator prompt.
    { resultCode: 'O2', kind: 'target', value: '70%', description: 'households meeting basic needs', quote: '' },
  ],
};

/** A complete indicator answer; each test indicator overrides what it needs. */
function indicator(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    resultCode: 'O1', level: 'outcome', indicatorText: '', indicatorTextAr: '', libraryId: '', standardReferenceCode: '', definition: '',
    unit: 'number', calculation: EMPTY_CALCULATION, direction: 'increase', disaggregation: [], dataCollectionMethod: 'document_review',
    frequency: 'quarterly', meansOfVerification: '', baselineValue: '', baselineBasis: 'none', baselineMethod: '', targetValue: '',
    targetBasis: 'none', targetJustification: '', assumptions: '', responsibility: '', phases: ['baseline', 'midterm', 'endline'],
    startDate: '2026-01-15', endDate: '2026-12-31', milestones: [{ label: 'Baseline data collection', date: '2026-02-15', completed: false }],
    aiRationale: 'Measures the result with a standard, verifiable source.',
    ...overrides,
  };
}

const INDICATORS_ANSWER = {
  indicators: [
    // 0. Impact, from secondary data; target only as a method.
    indicator({
      resultCode: 'G', level: 'impact', indicatorText: 'Prevalence of acute watery diarrhoea among children under five in target areas',
      indicatorTextAr: 'معدل انتشار الإسهال المائي الحاد بين الأطفال دون سن الخامسة في المناطق المستهدفة',
      definition: 'Children under five reported with acute watery diarrhoea in the two weeks before data collection.', unit: 'percent',
      calculation: { numerator: 'Children under five with acute watery diarrhoea in the past two weeks', denominator: 'Children under five in surveyed households', formula: PERCENT },
      direction: 'decrease', disaggregation: ['sex', 'age', 'location'], dataCollectionMethod: 'secondary_data', frequency: 'baseline_endline',
      meansOfVerification: 'Health cluster surveillance data and Ministry of Health reports for Khan Younis and Deir al-Balah',
      baselineMethod: 'Health cluster surveillance at project start (January 2026)', targetBasis: 'method_only',
      targetJustification: 'baseline − 20%, set once the baseline is known', assumptions: 'Surveillance data remain available for the target areas.',
      responsibility: 'M&E Manager',
    }),
    // 1. Library entry with a document baseline and the Sphere threshold of the linked entry.
    indicator({
      resultCode: 'O1', indicatorText: 'Average volume of water available per person per day in target households', libraryId: 'WA-01',
      indicatorTextAr: 'متوسط كمية المياه المتاحة للفرد يوميًا في الأسر المستهدفة', standardReferenceCode: 'Sphere',
      definition: 'Litres of water available for drinking, cooking and hygiene per person per day, from all sources.', unit: 'litres_per_person_per_day',
      disaggregation: ['location', 'displacement_status'], dataCollectionMethod: 'hh_survey', frequency: 'quarterly',
      meansOfVerification: 'Household survey water module (n≈380) and water-trucking delivery logs',
      baselineValue: '6', baselineBasis: 'document', baselineMethod: 'Rapid needs assessment, December 2025',
      targetValue: '15', targetBasis: 'standard_threshold', targetJustification: 'Sphere minimum for drinking, cooking and hygiene',
      assumptions: 'Water sources and fuel for trucking remain accessible; remote phone survey if field access is restricted.', responsibility: 'WASH Officer',
    }),
    // 2. Deliberately incomplete: no definition, calculation parts, baseline method or assumptions; an invented target.
    indicator({
      resultCode: 'O1', indicatorText: '% of target households with a handwashing facility with soap and water observed', libraryId: 'WA-05',
      unit: 'percent', calculation: EMPTY_CALCULATION, dataCollectionMethod: 'observation', frequency: 'biannual',
      meansOfVerification: 'Household observation checklist during the post-distribution monitoring survey',
      targetValue: '90%', targetBasis: 'document', targetJustification: 'Target of 90% agreed by the team', responsibility: 'WASH Officer',
    }),
    // 3. Output count from the document; the library entry adds sex disaggregation.
    indicator({
      resultCode: 'O1.1', level: 'output', indicatorText: 'Number of people receiving trucked drinking water', libraryId: 'WA-04',
      indicatorTextAr: 'عدد الأشخاص الذين يحصلون على مياه الشرب المنقولة بالصهاريج',
      definition: 'People in households registered at a served delivery point who received water at least once in the month.',
      disaggregation: ['age', 'displacement_status'], frequency: 'monthly', meansOfVerification: 'Water-trucking delivery logs and delivery-point registers',
      baselineMethod: 'Zero at start: new service', targetValue: '12,000', targetBasis: 'document', targetJustification: 'Result 1.1 of the proposal',
      assumptions: 'Crossings remain open for fuel and spare parts.', responsibility: 'Field Team',
    }),
    // 4. Generic means of verification and no responsibility.
    indicator({
      resultCode: 'O1.2', level: 'output', indicatorText: 'Number of hygiene kits distributed to displaced households',
      definition: 'Kits signed for by the receiving household.', meansOfVerification: 'Project reports', baselineMethod: 'Zero at start: new activity',
      targetValue: '2,400', targetBasis: 'document', targetJustification: 'Result 1.2 of the proposal', assumptions: 'Kits clear customs on time.',
    }),
    // 5. Unknown library id and an invented baseline; the target is a method.
    indicator({
      resultCode: 'O2', indicatorText: '% of assisted households reporting they can meet their basic needs', libraryId: 'CA-99',
      definition: 'Households reporting they can meet all or most of their basic needs as they define them.', unit: 'percent',
      calculation: { numerator: 'Households reporting they meet all or most basic needs', denominator: 'Households surveyed', formula: PERCENT },
      disaggregation: ['sex_of_household_head', 'displacement_status'], dataCollectionMethod: 'hh_survey', frequency: 'per_cohort',
      meansOfVerification: 'Post-distribution monitoring survey (phone), sample of assisted households',
      baselineValue: '35%', baselineBasis: 'document', baselineMethod: 'Baseline phone survey before the first cash round', targetBasis: 'method_only',
      targetJustification: 'baseline + 15 percentage points', assumptions: 'Market prices stay within the transfer value.', responsibility: 'Cash Officer',
    }),
    // 6. Linked to an activity code: it measures the activity's output.
    indicator({
      resultCode: 'A2.1.2', level: 'output', indicatorText: 'Number of households receiving multipurpose cash transfers',
      definition: 'Households that received at least one full transfer.', disaggregation: ['sex_of_household_head'],
      meansOfVerification: 'Financial service provider payment reconciliation reports', baselineMethod: 'Zero at start: new activity',
      targetValue: '1,800', targetBasis: 'document', targetJustification: 'Result 2.1 of the proposal', assumptions: 'The payment network stays operational.',
      responsibility: 'Cash Officer',
    }),
    // 7. Accountability to affected people (humanitarian project).
    indicator({
      resultCode: 'O2', indicatorText: '% of assisted people who know how to give feedback or make a complaint', libraryId: 'AC-01', standardReferenceCode: 'CHS 5',
      definition: 'Assisted people who can name at least one feedback or complaint channel of the project.', unit: 'percent',
      calculation: { numerator: 'Respondents naming at least one channel', denominator: 'Respondents surveyed', formula: PERCENT },
      disaggregation: ['sex', 'age', 'disability'], dataCollectionMethod: 'hh_survey', frequency: 'biannual',
      meansOfVerification: 'Post-distribution monitoring survey, accountability module', baselineMethod: 'First post-distribution monitoring round',
      targetBasis: 'none', assumptions: 'Respondents feel safe answering by phone.', responsibility: 'MEAL Officer',
    }),
  ],
};

type AnyParams = GenerateStructuredParams<any>;

/**
 * Mocks generateStructured per feature. Like the real client, answers are validated with the call's
 * schema, and each call writes one AiCall row (numbers and ids only), which the smoke report reads.
 */
function mockAi(replies: Record<string, (() => Promise<unknown>) | unknown>) {
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
      data = typeof reply === 'function' ? await (reply as () => Promise<unknown>)() : reply;
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

    // Two main-tier structured calls with the framework prompt version and ids for cost attribution.
    expect(calls().map(c => c.feature)).toEqual(['framework.structure', 'framework.indicators']);
    const context = { organizationId: fx.org.id, projectId };
    expect(calls()[0]).toMatchObject({
      model: 'main', effort: 'medium', maxTokens: 12_000, timeoutMs: 180_000, schema: PROJECT_STRUCTURE_SCHEMA,
      system: FRAMEWORK_STRUCTURE_SYSTEM, promptVersion: 'framework-v4', context,
    });
    expect(calls()[1]).toMatchObject({
      model: 'main', effort: 'medium', maxTokens: 32_000, timeoutMs: 300_000, schema: FRAMEWORK_INDICATORS_SCHEMA,
      system: FRAMEWORK_INDICATORS_SYSTEM, promptVersion: 'framework-v4', context,
    });

    // Privacy: the legacy document is redacted before it reaches any prompt.
    for (const value of PERSONAL_DATA) {
      expect(promptOf('framework.structure')).not.toContain(value);
      expect(promptOf('framework.indicators')).not.toContain(value);
    }
    expect(promptOf('framework.structure')).toContain('[phone removed]');
    // The invented figure is dropped before the indicator step; the documented ones are passed on.
    expect(promptOf('framework.indicators')).toContain('"value": "12,000"');
    expect(promptOf('framework.indicators')).not.toContain('70%');
    expect(promptOf('framework.indicators')).toContain('WA-01 [outcome]');
    expect(promptOf('framework.indicators')).toContain('AC-01 [outcome]');

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
      // Provenance
      expect(i, label).toMatchObject({ provenance: 'ai_generated', aiModel: SERVED_MODEL, promptVersion: 'framework-v4', isApproved: false });
      expect(i.level, label).not.toBe('activity');
      expect(i.resultId, label).not.toBeNull();
      // Every new reference-sheet field is filled or explicitly "to be confirmed".
      for (const field of ['definition', 'meansOfVerification', 'baselineMethod', 'targetJustification', 'assumptions', 'responsibility'] as const) {
        expect(i[field]?.trim(), `${label}: ${field}`).toBeTruthy();
      }
      expect(i.direction, label).not.toBeNull();
      expect(Array.isArray(i.disaggregation), label).toBe(true);
      if (isPeopleLevelIndicator(i.indicatorText, i.indicatorTextAr)) {
        expect((i.disaggregation as string[]).some(k => k === 'sex' || k === 'sex_of_household_head'), `${label}: sex disaggregation`).toBe(true);
      }
      if (i.unit === 'percent') {
        expect(i.calculation, label).toMatchObject({ numerator: expect.any(String), denominator: expect.any(String), formula: expect.any(String) });
      }
      // Never invented: every kept value is written in the document or in the linked library entry.
      if (i.baselineValue) expect(appearsInDocuments(i.baselineValue, [redacted]), `${label}: baseline`).toBe(true);
      if (i.targetValue && i.libraryId !== 'WA-01') expect(appearsInDocuments(i.targetValue, [redacted]), `${label}: target`).toBe(true);
    }

    const [impact, water, handwashing, trucked, kits, basicNeeds, cash, feedback] = indicators;
    const gaps = Object.fromEntries(indicators.map(i => [i.indicatorText, referenceSheetGaps(i)]));

    // Complete answers have no gaps; the deliberately incomplete ones are marked "to be confirmed".
    expect(gaps).toEqual({
      [impact.indicatorText]: [],
      [water.indicatorText]: [],
      [handwashing.indicatorText]: ['definition', 'calculation', 'baselineMethod', 'assumptions'],
      [trucked.indicatorText]: [],
      [kits.indicatorText]: ['meansOfVerification', 'responsibility'],
      [basicNeeds.indicatorText]: [],
      [cash.indicatorText]: [],
      [feedback.indicatorText]: [],
    });
    expect(handwashing).toMatchObject({
      definition: TO_BE_CONFIRMED, baselineMethod: TO_BE_CONFIRMED, assumptions: TO_BE_CONFIRMED,
      calculation: { numerator: TO_BE_CONFIRMED, denominator: TO_BE_CONFIRMED, formula: PERCENT },
    });
    expect(kits).toMatchObject({ meansOfVerification: TO_BE_CONFIRMED, responsibility: TO_BE_CONFIRMED, disaggregation: ['sex'] });

    // Document values are kept on an exact match and cited; the standard threshold comes from the linked entry.
    expect(water).toMatchObject({
      baselineValue: '6', baselineMethod: `Rapid needs assessment, December 2025 (source: ${DOCUMENT_NAME})`, targetValue: '15', libraryId: 'WA-01',
      standardReferenceCode: 'Sphere Water supply standard — minimum 15 l/p/d (aim for 20)', disaggregation: ['sex', 'location', 'displacement_status'],
    });
    expect(water.targetJustification).toMatch(/^Proposed standard threshold \(Sphere Water supply standard/);
    expect(trucked).toMatchObject({
      targetValue: '12,000', targetJustification: `Result 1.1 of the proposal (source: ${DOCUMENT_NAME})`, libraryId: 'WA-04',
      standardReferenceCode: 'EU GERF 2.38', disaggregation: ['sex', 'age', 'displacement_status'],
    });
    expect(kits).toMatchObject({ targetValue: '2,400', targetJustification: `Result 1.2 of the proposal (source: ${DOCUMENT_NAME})` });
    expect(cash).toMatchObject({ targetValue: '1,800', resultId: byCode['O2.1'].id, level: 'output' });

    // Invented numbers are removed, and the justification does not repeat them.
    expect(handwashing.targetValue).toBeNull();
    expect(handwashing.targetJustification).toMatch(/^Proposed method: .* — confirm after baseline\. The target proposed by the AI was not found/);
    expect(handwashing.targetJustification).not.toContain('90%');
    expect(basicNeeds).toMatchObject({ baselineValue: null, libraryId: null, baselineMethod: 'Baseline phone survey before the first cash round' });
    expect(basicNeeds.targetJustification).toMatch(/^Proposed method: baseline \+ 15 percentage points — confirm after baseline\. The baseline proposed by the AI was not found/);
    expect(impact).toMatchObject({ targetValue: null, targetJustification: 'Proposed method: baseline − 20%, set once the baseline is known — confirm after baseline.' });
    expect(feedback).toMatchObject({ libraryId: 'AC-01', standardReferenceCode: 'Core Humanitarian Standard (2024) Commitment 5 (aligned)', targetValue: null });

    // Framework and project status, the served model, and the admin notification.
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', aiModelUsed: SERVED_MODEL });
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

  it('leaves the new version as an empty draft when the model refuses, logging no document text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': async () => { throw new AiRefusalError('framework.indicators', null); } });

    const res = await request(app).post(`/api/projects/${projectId}/framework/generate`).set('Authorization', fx.officerAuth);
    expect(res.status).toBe(202);
    const { frameworkId } = res.body as { frameworkId: string };
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 10_000, interval: 50 });

    expect(await prisma.framework.findUniqueOrThrow({ where: { id: frameworkId } })).toMatchObject({ status: 'draft' });
    expect(await prisma.resultNode.count({ where: { frameworkId } })).toBe(0);
    expect(await prisma.indicator.count({ where: { frameworkId } })).toBe(0);
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
  it('parses --yes, --project and --help, and rejects unknown options', () => {
    expect(parseSmokeArgs([])).toEqual({ yes: false, projectId: null, help: false });
    expect(parseSmokeArgs(['--yes', '--project', 'p-1'])).toEqual({ yes: true, projectId: 'p-1', help: false });
    expect(parseSmokeArgs(['--project=p-2', '-h'])).toEqual({ yes: false, projectId: 'p-2', help: true });
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

  it('refuses in production, with a placeholder key and without --yes (in that order)', () => {
    expect(smokeRefusal({ nodeEnv: 'production', apiKey: FAKE_KEY, yes: true })).toMatch(/NODE_ENV is "production"/);
    expect(smokeRefusal({ nodeEnv: 'production', apiKey: 'sk-ant-...', yes: false })).toMatch(/production/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: 'sk-ant-...', yes: true })).toMatch(/^Refusing to run: ANTHROPIC_API_KEY does not look like/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: 'sk-ant-test-not-a-real-key', yes: true })).toMatch(/placeholder/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: false })).toMatch(/--yes/);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: FAKE_KEY, yes: true })).toBeNull();
  });

  it('formats padded tables and the report rows', () => {
    expect(formatTable(['a', 'bb'], [['1', '2'], ['333', '4']])).toBe('a    bb\n---  --\n1    2\n333  4');
    const sheet = {
      unit: 'number', definition: 'd', direction: 'increase', disaggregation: ['sex'], meansOfVerification: 'Registers',
      baselineMethod: 'b', targetJustification: 't', assumptions: 'a', responsibility: 'r',
    };
    const rows = [
      { ...sheet, level: 'impact' as const, resultCode: 'G', indicatorText: 'Water points functional' },
      { ...sheet, level: 'output' as const, resultCode: 'O1.1', indicatorText: `Number of people trained in ${'very '.repeat(20)}long courses`, assumptions: TO_BE_CONFIRMED },
      { ...sheet, level: 'output' as const, resultCode: null, indicatorText: 'Kits', definition: null },
    ];
    expect(levelRows(rows)).toEqual([['impact', '1'], ['output', '2'], ['total', '3']]);
    const gaps = gapRows(rows);
    expect(gaps[0]).toEqual(['G', 'impact', 'Water points functional', 'none']);
    expect(gaps[1][2]).toHaveLength(70);
    expect(gaps[1][2].endsWith('…')).toBe(true);
    expect(gaps[1][3]).toBe('assumptions');
    expect(gaps[2]).toEqual(['—', 'output', 'Kits', 'definition']);

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

  it('refuses with the test key, in production, without --yes and on bad options, before any AI call or write', async () => {
    expect(await runAiSmoke(['--yes'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/placeholder/);
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'production' })).toBe(1);
    expect(err.join('\n')).toMatch(/NODE_ENV is "production"/);
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
    expect(report).toContain(`served model: ${SERVED_MODEL}; 11 results; prompt version framework-v4`);
    expect(report).toMatch(/^impact\s+1$/m);
    expect(report).toMatch(/^outcome\s+4$/m);
    expect(report).toMatch(/^output\s+3$/m);
    expect(report).toMatch(/^total\s+8$/m);
    expect(report).toContain('6 of 8 indicators complete');
    expect(report).toMatch(/^O1\s+outcome\s+% of target households with a handwashing facility.*\s{2}definition, calculation, baselineMethod, assumptions$/m);
    expect(report).toMatch(/^O1\.2\s+output\s+Number of hygiene kits distributed to displaced households\s+meansOfVerification, responsibility$/m);
    expect(report).toMatch(/^framework\.structure\s+success\s+configured-main-model\s+claude-sonnet-5-5-20261001\s+1\s+4200\s+7600/m);
    expect(report).toMatch(/^framework\.indicators\s+success/m);
    expect(report).toMatch(/^total\s+2\s+8400\s+15200\s+19600\s+0\s+82000\s+0\.1704$/m);
    // Never document text or personal data.
    for (const value of [...PERSONAL_DATA, 'trucked drinking water for nine months']) expect(report).not.toContain(value);
  });

  it('reports a failed generation, keeps the empty draft and shows the refused call', async () => {
    mockAi({ 'framework.structure': STRUCTURE_ANSWER, 'framework.indicators': async () => { throw new AiRefusalError('framework.indicators', null); } });

    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toMatch(/^Generation failed: AiRefusalError: The AI model declined the request \(framework\.indicators\)\.$/m);
    expect(err.join('\n')).toMatch(/Framework version 1 is left as an empty draft/);
    const framework = await prisma.framework.findFirstOrThrow({ where: { projectId } });
    expect(framework.status).toBe('draft');
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
    expect(calls().map(c => c.feature)).toEqual(['framework.indicators']);
    expect(await prisma.framework.findFirstOrThrow({ where: { projectId: fx.project.id, version: 2 } })).toMatchObject({ status: 'expert_review' });
  });

  it('fails when the dev seed project is missing', async () => {
    await prisma.document.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    expect(await runAiSmoke(['--yes'], { ...io(), apiKey: FAKE_KEY, nodeEnv: 'development' })).toBe(1);
    expect(err.join('\n')).toContain(`Project "${SEED_PROJECT_NAME}" not found: run npm run seed, or pass --project <id>.`);
  });
});
