import request from 'supertest';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { AppError } from '../src/middleware/errorHandler';
import {
  DEFAULT_PHASES, indicatorCreateSchema, parseIndicatorCreate, parseIndicatorUpdate, parseIsoDate,
  toIndicatorCreateData, toIndicatorUpdateData,
} from '../src/services/indicators/validation';
import { bearer, createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    return (err as AppError).message;
  }
  throw new Error('expected a 400 AppError');
}

/** What the current frontend's "Edit indicator" dialog sends (IndicatorTable.tsx). */
const legacyEditPayload = {
  indicatorText: 'Number of youth completing vocational training',
  level: 'output',
  dataCollectionMethod: 'document_review',
  frequency: 'quarterly',
  baselineValue: '',
  targetValue: '500',
  currentValue: '',
  unit: 'number',
  status: 'on_track',
  responsibility: '',
  startDate: '2026-02-01',
  endDate: null,
  actualStartDate: null,
  actualEndDate: null,
};

/** What the current frontend's "Add indicator" dialog sends. */
const legacyAddPayload = {
  indicatorText: 'Number of women-led businesses supported',
  level: 'output',
  dataCollectionMethod: 'hh_survey',
  frequency: 'quarterly',
  baselineValue: '',
  targetValue: '',
  unit: '',
  responsibility: '',
  startDate: undefined,
  endDate: '2026-12-31',
};

/** A complete indicator reference sheet (knowledge/me-foundations.md §3). */
const referenceSheet = {
  indicatorText: '% of households with acceptable Food Consumption Score',
  indicatorTextAr: 'نسبة الأسر ذات درجة استهلاك غذائي مقبولة',
  definition: 'Households with an FCS above 35 (the acceptable threshold for oil- and sugar-rich diets).',
  calculation: { numerator: 'Households with FCS > 35', denominator: 'Households surveyed', formula: 'numerator / denominator x 100', rounding: '1 decimal place' },
  direction: 'increase',
  disaggregation: ['sex_of_household_head', 'location', 'displacement_status'],
  meansOfVerification: 'Household survey, FCS module, n≈400, representative of target households',
  baselineValue: '42',
  baselineDate: '2026-01-15',
  baselineMethod: 'Baseline household survey (WFP FCS module)',
  targetValue: '60',
  targetJustification: 'Baseline + 18 percentage points, consistent with similar programmes',
  intermediateTargets: [{ date: '2027-06-30', value: '55' }, { date: '2026-12-31', value: '50' }],
  assumptions: 'Market prices remain stable; access to target localities is maintained.',
  standardReferenceCode: 'WFP CRF',
  dataCollectionMethod: 'hh_survey',
  frequency: 'biannual',
  unit: 'percent',
  responsibility: 'M&E Officer',
};

describe('indicator payload validation', () => {
  it('accepts the current frontend edit payload; empty text becomes null', () => {
    const parsed = parseIndicatorUpdate(legacyEditPayload);
    expect(parsed).toMatchObject({
      indicatorText: legacyEditPayload.indicatorText,
      level: 'output',
      baselineValue: null,
      targetValue: '500',
      currentValue: null,
      responsibility: null,
      endDate: null,
      actualStartDate: null,
      actualEndDate: null,
    });
    expect(parsed.startDate).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('accepts the current frontend add payload', () => {
    const parsed = parseIndicatorCreate(legacyAddPayload);
    expect(parsed).toMatchObject({ indicatorText: legacyAddPayload.indicatorText, unit: null, targetValue: null });
    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toEqual(new Date('2026-12-31T00:00:00.000Z'));
  });

  it('accepts ISO date-times for the schedule fields, as stored values are echoed back', () => {
    const parsed = parseIndicatorUpdate({ startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-03-01T10:30:00+03:00' });
    expect(parsed.startDate).toEqual(new Date('2026-02-01T00:00:00.000Z'));
    expect(parsed.endDate).toEqual(new Date('2026-03-01T07:30:00.000Z'));
    expect(messageOf(() => parseIndicatorUpdate({ startDate: 'next week' }))).toContain('startDate must be a real date in YYYY-MM-DD format');
  });

  it('parses a full reference sheet', () => {
    const parsed = parseIndicatorUpdate({ ...referenceSheet, provenance: 'library', libraryId: 'FS-01', resultId: 'r-1' });
    expect(parsed).toMatchObject({
      direction: 'increase',
      disaggregation: ['sex_of_household_head', 'location', 'displacement_status'],
      calculation: referenceSheet.calculation,
      provenance: 'library',
      libraryId: 'FS-01',
      resultId: 'r-1',
      standardReferenceCode: 'WFP CRF',
    });
    expect(parsed.baselineDate).toEqual(new Date('2026-01-15T00:00:00.000Z'));
    // Sorted by date.
    expect(parsed.intermediateTargets).toEqual([{ date: '2026-12-31', value: '50' }, { date: '2027-06-30', value: '55' }]);
  });

  it('trims text and converts numeric values to text', () => {
    const parsed = parseIndicatorUpdate({ indicatorText: '  Trimmed  ', baselineValue: 12.5, targetValue: 0, definition: '  d  ' });
    expect(parsed).toEqual({ indicatorText: 'Trimmed', baselineValue: '12.5', targetValue: '0', definition: 'd' });
    expect(parseIndicatorUpdate({ intermediateTargets: [{ date: '2026-06-30', value: 40 }] }).intermediateTargets)
      .toEqual([{ date: '2026-06-30', value: '40' }]);
  });

  it('clears reference-sheet fields with null or empty strings', () => {
    expect(parseIndicatorUpdate({
      resultId: null, libraryId: '', definition: '', calculation: null, direction: '', disaggregation: null,
      baselineDate: '', intermediateTargets: null, standardReferenceCode: null,
    })).toEqual({
      resultId: null, libraryId: null, definition: null, calculation: null, direction: null, disaggregation: null,
      baselineDate: null, intermediateTargets: null, standardReferenceCode: null,
    });
  });

  it('keeps only the known calculation keys and drops empty ones', () => {
    expect(parseIndicatorUpdate({ calculation: { numerator: 'n', denominator: '', aggregation: 'sum' } }).calculation).toEqual({ numerator: 'n' });
    expect(parseIndicatorUpdate({ calculation: { formula: '  ' } }).calculation).toBeNull();
    expect(messageOf(() => parseIndicatorUpdate({ calculation: 'n / d' }))).toContain('calculation must be an object with numerator, denominator, formula and rounding');
    expect(messageOf(() => parseIndicatorUpdate({ calculation: ['n'] }))).toContain('calculation must be an object');
    expect(messageOf(() => parseIndicatorUpdate({ calculation: { numerator: 5 } }))).toContain('calculation.numerator must be text');
  });

  it('requires unique snake_case disaggregation keys, at most 20', () => {
    expect(parseIndicatorUpdate({ disaggregation: [' sex ', 'age'] }).disaggregation).toEqual(['sex', 'age']);
    expect(parseIndicatorUpdate({ disaggregation: [] }).disaggregation).toEqual([]);
    expect(messageOf(() => parseIndicatorUpdate({ disaggregation: ['Sex'] }))).toContain('disaggregation.0 must be a snake_case key');
    expect(messageOf(() => parseIndicatorUpdate({ disaggregation: ['sex', 'displacement status'] }))).toContain('disaggregation.1 must be a snake_case key');
    expect(messageOf(() => parseIndicatorUpdate({ disaggregation: ['1st'] }))).toContain('disaggregation.0 must be a snake_case key');
    expect(messageOf(() => parseIndicatorUpdate({ disaggregation: ['sex', 'age', 'sex'] }))).toContain('disaggregation lists sex more than once');
    const many = Array.from({ length: 21 }, (_, i) => `group_${i}`);
    expect(messageOf(() => parseIndicatorUpdate({ disaggregation: many }))).toContain('disaggregation can list at most 20 groups');
    expect(messageOf(() => parseIndicatorUpdate({ disaggregation: 'sex' }))).toContain('disaggregation must be a list of keys');
  });

  it('validates intermediate targets', () => {
    expect(messageOf(() => parseIndicatorUpdate({ intermediateTargets: [{ date: '2026-02-30', value: '1' }] })))
      .toContain('intermediateTargets.0.date must be a real date in YYYY-MM-DD format');
    expect(messageOf(() => parseIndicatorUpdate({ intermediateTargets: [{ date: '30/06/2026', value: '1' }] })))
      .toContain('intermediateTargets.0.date must be a real date');
    expect(messageOf(() => parseIndicatorUpdate({ intermediateTargets: [{ date: '2026-06-30' }] })))
      .toContain('intermediateTargets.0.value is required');
    expect(messageOf(() => parseIndicatorUpdate({ intermediateTargets: [{ date: '2026-06-30', value: ' ' }] })))
      .toContain('intermediateTargets.0.value cannot be empty');
    expect(messageOf(() => parseIndicatorUpdate({
      intermediateTargets: [{ date: '2026-06-30', value: '1' }, { date: '2026-06-30', value: '2' }],
    }))).toContain('intermediateTargets has more than one target for 2026-06-30');
    const many = Array.from({ length: 21 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: '1' }));
    expect(messageOf(() => parseIndicatorUpdate({ intermediateTargets: many }))).toContain('intermediateTargets can have at most 20 targets');
  });

  it('validates the baseline date as YYYY-MM-DD', () => {
    expect(parseIndicatorUpdate({ baselineDate: '2024-02-29' }).baselineDate).toEqual(new Date('2024-02-29T00:00:00.000Z'));
    for (const bad of ['2025-02-29', '01/02/2026', '2026-1-5', '2026-01-15T00:00:00Z', 20260115]) {
      expect(messageOf(() => parseIndicatorUpdate({ baselineDate: bad }))).toContain('baselineDate must be a real date in YYYY-MM-DD format');
    }
  });

  it('lets clients set only manual, library or imported provenance', () => {
    for (const ok of ['manual', 'library', 'imported']) expect(parseIndicatorUpdate({ provenance: ok }).provenance).toBe(ok);
    expect(messageOf(() => parseIndicatorUpdate({ provenance: 'ai_suggested' })))
      .toBe("Invalid indicator: provenance ai_suggested is set only by Raqib's AI features; use one of: manual, library, imported");
    expect(messageOf(() => parseIndicatorCreate({ provenance: 'ai_generated' }))).toContain('ai_generated is set only by');
    expect(messageOf(() => parseIndicatorUpdate({ provenance: 'copied' }))).toContain('provenance must be one of: manual, library, imported');
  });

  it('validates enums with the allowed values', () => {
    expect(messageOf(() => parseIndicatorUpdate({ direction: 'up' }))).toContain('direction must be one of: increase, decrease, maintain');
    expect(messageOf(() => parseIndicatorUpdate({ level: 'goal' }))).toContain('level must be one of: impact, outcome, output, activity');
    expect(messageOf(() => parseIndicatorUpdate({ dataCollectionMethod: 'survey' }))).toContain('dataCollectionMethod must be one of: hh_survey');
    expect(messageOf(() => parseIndicatorUpdate({ frequency: 'weekly' }))).toContain('frequency must be one of');
    expect(messageOf(() => parseIndicatorUpdate({ status: 'done' }))).toContain('status must be one of');
  });

  it('names every failing field in one message', () => {
    const message = messageOf(() => parseIndicatorUpdate({ indicatorText: '', direction: 'up', baselineDate: 'soon', sortOrder: -2 }));
    // In schema field order.
    expect(message).toBe(
      'Invalid indicator: indicatorText cannot be empty; sortOrder cannot be negative; '
      + 'direction must be one of: increase, decrease, maintain; baselineDate must be a real date in YYYY-MM-DD format',
    );
  });

  it('limits text lengths', () => {
    expect(messageOf(() => parseIndicatorUpdate({ indicatorText: 'x'.repeat(1001) }))).toContain('indicatorText must be at most 1000 characters');
    expect(messageOf(() => parseIndicatorUpdate({ standardReferenceCode: 'x'.repeat(101) }))).toContain('standardReferenceCode must be at most 100 characters');
  });

  it('validates phases and milestones', () => {
    expect(parseIndicatorUpdate({ phases: ['baseline', ' endline '] }).phases).toEqual(['baseline', 'endline']);
    expect(messageOf(() => parseIndicatorUpdate({ phases: null }))).toContain('phases must be a list of phase names');
    expect(parseIndicatorUpdate({ milestones: [{ label: 'Tool ready', date: '2026-03-01', completed: true, extra: 1 }] }).milestones)
      .toEqual([{ label: 'Tool ready', date: '2026-03-01', completed: true }]);
    expect(messageOf(() => parseIndicatorUpdate({ milestones: [{ date: '2026-03-01' }] }))).toContain('milestones.0.label is required');
  });

  it('strips unknown and AI-only keys', () => {
    const parsed = parseIndicatorUpdate({
      indicatorText: 'Kept', id: 'other', frameworkId: 'other', isApproved: true, aiModel: 'm', promptVersion: 'v9', createdAt: 'x',
    });
    expect(parsed).toEqual({ indicatorText: 'Kept' });
  });

  it('uses defaults on create for empty or null fields that have one', () => {
    const parsed = indicatorCreateSchema.parse({ indicatorText: '', level: null, frequency: '', phases: null });
    expect(parsed.indicatorText).toBeUndefined();
    expect(parsed.level).toBeUndefined();
    expect(parsed.frequency).toBeUndefined();
    expect(parsed.phases).toBeUndefined();
    expect(messageOf(() => parseIndicatorCreate({ level: 'goal' }))).toContain('level must be one of');
  });

  it('rejects a body that is not an object', () => {
    expect(messageOf(() => parseIndicatorUpdate('text'))).toBe('Invalid indicator: the request body must be a JSON object');
  });

  it('parses calendar dates strictly', () => {
    expect(parseIsoDate('2026-10-11')).toEqual(new Date('2026-10-11T00:00:00.000Z'));
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-04-31')).toBeNull();
    expect(parseIsoDate('2026-10-11T00:00:00Z')).toBeNull();
  });
});

describe('indicator Prisma data', () => {
  it('writes only the fields present and stores null JSON as SQL NULL', () => {
    const data = toIndicatorUpdateData(parseIndicatorUpdate({ calculation: null, disaggregation: null, intermediateTargets: null, definition: '' }));
    expect(data).toEqual({ calculation: Prisma.DbNull, disaggregation: Prisma.DbNull, intermediateTargets: Prisma.DbNull, definition: null });
    expect(toIndicatorUpdateData({})).toEqual({});
  });

  it('applies the create defaults', () => {
    const data = toIndicatorCreateData('fw-1', parseIndicatorCreate({}), { sortOrder: 4 });
    expect(data).toEqual({
      frameworkId: 'fw-1', indicatorText: 'New Indicator', level: 'output', dataCollectionMethod: 'hh_survey',
      frequency: 'quarterly', phases: DEFAULT_PHASES, sortOrder: 4, provenance: 'manual',
    });
  });

  it('takes the level from the linked result and provenance from the library link', () => {
    const fromLibrary = toIndicatorCreateData('fw-1', parseIndicatorCreate({ libraryId: 'FS-01', resultId: 'r-1' }), { sortOrder: 0, resultLevel: 'outcome' });
    expect(fromLibrary).toMatchObject({ level: 'outcome', provenance: 'library', libraryId: 'FS-01', resultId: 'r-1' });

    const explicit = toIndicatorCreateData(
      'fw-1',
      parseIndicatorCreate({ libraryId: 'FS-01', provenance: 'imported', level: 'impact', sortOrder: 9 }),
      { sortOrder: 0, resultLevel: 'outcome' },
    );
    expect(explicit).toMatchObject({ level: 'impact', provenance: 'imported', sortOrder: 9 });
  });
});

describe.skipIf(!hasTestDatabase)('indicator reference sheet API', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let otherFrameworkResultId: string;
  let createdId: string;

  const create = (body: object, auth = a.adminAuth) =>
    request(app).post(`/api/frameworks/${a.framework.id}/indicators`).set('Authorization', auth).send(body);
  const patch = (id: string, body: object, auth = a.adminAuth) =>
    request(app).patch(`/api/indicators/${id}`).set('Authorization', auth).send(body);
  const readFramework = async () => {
    const res = await request(app).get(`/api/projects/${a.project.id}/framework`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    await prisma.indicatorLibraryEntry.create({
      data: {
        id: 'TS-01', sector: 'food_security', tags: ['fcs'], level: 'outcome', name: 'Test FCS indicator', nameAr: 'مؤشر اختبار',
        definition: 'Test', unit: 'percent', direction: 'increase', disaggregation: ['sex'], methods: ['hh_survey'],
        frequency: 'biannual', meansOfVerification: 'Household survey', isStandard: true, version: 'test',
      },
    });
    // A result in an older framework of the same project.
    const older = await prisma.framework.create({ data: { projectId: a.project.id, version: 0 } });
    otherFrameworkResultId = (await prisma.resultNode.create({
      data: { frameworkId: older.id, level: 'outcome', code: 'O1', text: 'Older outcome' },
    })).id;
  });

  it('creates an indicator with every reference-sheet field and reads it back from the project framework', async () => {
    const res = await create({ ...referenceSheet, resultId: a.result.id, libraryId: 'TS-01' });
    expect(res.status).toBe(201);
    expect(res.body.result).toEqual({ id: a.result.id, code: 'O1', level: 'outcome', text: 'Outcome a' });
    expect(res.body).toMatchObject({ provenance: 'library', libraryId: 'TS-01', level: 'outcome', sortOrder: 1 });
    createdId = res.body.id;

    const framework = await readFramework();
    const stored = framework.indicators.find((i: any) => i.id === createdId);
    expect(stored).toMatchObject({
      indicatorText: referenceSheet.indicatorText,
      indicatorTextAr: referenceSheet.indicatorTextAr,
      resultId: a.result.id,
      result: { id: a.result.id, code: 'O1', level: 'outcome', text: 'Outcome a' },
      definition: referenceSheet.definition,
      calculation: referenceSheet.calculation,
      direction: 'increase',
      disaggregation: referenceSheet.disaggregation,
      meansOfVerification: referenceSheet.meansOfVerification,
      baselineValue: '42',
      baselineDate: '2026-01-15T00:00:00.000Z',
      baselineMethod: referenceSheet.baselineMethod,
      targetValue: '60',
      targetJustification: referenceSheet.targetJustification,
      intermediateTargets: [{ date: '2026-12-31', value: '50' }, { date: '2027-06-30', value: '55' }],
      assumptions: referenceSheet.assumptions,
      libraryId: 'TS-01',
      standardReferenceCode: 'WFP CRF',
      provenance: 'library',
      aiModel: null,
      promptVersion: null,
      dataCollectionMethod: 'hh_survey',
      frequency: 'biannual',
      unit: 'percent',
      responsibility: 'M&E Officer',
      _count: { dataPoints: 0 },
    });
    expect(framework.resultNodes.map((n: any) => n.id)).toEqual([a.result.id]);
  });

  it('updates and clears reference-sheet fields', async () => {
    const updated = await patch(createdId, {
      direction: 'maintain', disaggregation: ['sex', 'age', 'disability'], baselineDate: '2026-02-01',
      calculation: { formula: 'count' }, intermediateTargets: [{ date: '2026-09-30', value: '52' }], provenance: 'manual',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      direction: 'maintain', disaggregation: ['sex', 'age', 'disability'], baselineDate: '2026-02-01T00:00:00.000Z',
      calculation: { formula: 'count' }, intermediateTargets: [{ date: '2026-09-30', value: '52' }], provenance: 'manual',
      definition: referenceSheet.definition, // untouched
      result: { id: a.result.id, code: 'O1', level: 'outcome', text: 'Outcome a' },
    });

    const cleared = await patch(createdId, {
      resultId: null, libraryId: null, calculation: null, disaggregation: null, intermediateTargets: null,
      baselineDate: '', direction: null, definition: '', assumptions: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      resultId: null, result: null, libraryId: null, calculation: null, disaggregation: null, intermediateTargets: null,
      baselineDate: null, direction: null, definition: null, assumptions: null,
    });
    const row = await prisma.$queryRaw<{ calculation: unknown }[]>`SELECT "calculation" FROM "Indicator" WHERE id = ${createdId}`;
    expect(row[0].calculation).toBeNull(); // SQL NULL, not JSON null
  });

  it('links an indicator to a result in its framework', async () => {
    const res = await patch(createdId, { resultId: a.result.id });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ id: a.result.id, code: 'O1', level: 'outcome', text: 'Outcome a' });
  });

  it('rejects a result from another framework, even of the same project', async () => {
    const sameProject = await patch(createdId, { resultId: otherFrameworkResultId });
    expect(sameProject.status).toBe(400);
    expect(sameProject.body.message).toBe('resultId must be a result in the same framework as the indicator');

    const otherOrg = await create({ indicatorText: 'x', resultId: b.result.id });
    expect(otherOrg.status).toBe(400);

    const unknown = await patch(createdId, { resultId: '00000000-0000-0000-0000-000000000000' });
    expect(unknown.status).toBe(400);
  });

  it('rejects an unknown library entry', async () => {
    const res = await patch(createdId, { libraryId: 'XX-00' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('libraryId "XX-00" is not in the indicator library');
  });

  it('rejects AI provenance from clients', async () => {
    const created = await create({ indicatorText: 'AI?', provenance: 'ai_generated' });
    expect(created.status).toBe(400);
    expect(created.body.message).toContain("ai_generated is set only by Raqib's AI features");

    const patched = await patch(createdId, { provenance: 'ai_suggested' });
    expect(patched.status).toBe(400);
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: createdId } })).provenance).toBe('manual');
  });

  it('keeps AI provenance and model fields when an AI indicator is edited', async () => {
    const ai = await prisma.indicator.create({
      data: {
        frameworkId: a.framework.id, indicatorText: 'AI indicator', level: 'output', dataCollectionMethod: 'document_review',
        frequency: 'monthly', phases: ['ongoing'], provenance: 'ai_generated', aiModel: 'claude-sonnet-5-5', promptVersion: 'framework-v2',
      },
    });
    const res = await patch(ai.id, { indicatorText: 'Edited AI indicator', aiModel: 'forged', promptVersion: 'forged' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      indicatorText: 'Edited AI indicator', provenance: 'ai_generated', aiModel: 'claude-sonnet-5-5', promptVersion: 'framework-v2',
    });
    await prisma.indicator.delete({ where: { id: ai.id } });
  });

  it('reports invalid fields with a 400 and changes nothing', async () => {
    const before = await prisma.indicator.findUniqueOrThrow({ where: { id: createdId } });
    const res = await patch(createdId, {
      indicatorText: 'Should not be saved', disaggregation: ['Sex'], intermediateTargets: [{ date: '2026-02-30', value: '1' }], direction: 'up',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('disaggregation.0 must be a snake_case key');
    expect(res.body.message).toContain('intermediateTargets.0.date must be a real date');
    expect(res.body.message).toContain('direction must be one of');
    expect(await prisma.indicator.findUniqueOrThrow({ where: { id: createdId } })).toEqual(before);
  });

  it('still accepts the current frontend add payload with the old defaults', async () => {
    const res = await create({ ...legacyAddPayload, phases: undefined }, a.officerAuth);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      indicatorText: legacyAddPayload.indicatorText, level: 'output', dataCollectionMethod: 'hh_survey', frequency: 'quarterly',
      phases: ['baseline', 'midterm', 'endline'], baselineValue: null, unit: null, responsibility: null, startDate: null,
      endDate: '2026-12-31T00:00:00.000Z', status: 'not_started', provenance: 'manual', resultId: null, result: null,
    });

    const blank = await create({});
    expect(blank.status).toBe(201);
    expect(blank.body).toMatchObject({ indicatorText: 'New Indicator', level: 'output', provenance: 'manual' });
    expect(blank.body.sortOrder).toBeGreaterThan(res.body.sortOrder);
  });

  it('still accepts the current frontend edit payload', async () => {
    const res = await patch(a.indicator.id, legacyEditPayload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      indicatorText: legacyEditPayload.indicatorText, level: 'output', dataCollectionMethod: 'document_review', status: 'on_track',
      targetValue: '500', baselineValue: null, currentValue: null, responsibility: null,
      startDate: '2026-02-01T00:00:00.000Z', endDate: null, actualStartDate: null, actualEndDate: null,
      resultId: a.result.id, // untouched
    });
  });

  it('takes the level from the linked result when none is given', async () => {
    const res = await create({ indicatorText: 'Linked', resultId: a.result.id });
    expect(res.status).toBe(201);
    expect(res.body.level).toBe('outcome');
  });

  it('lets donor viewers read but not write indicators', async () => {
    const viewer = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'viewer-ind@example.org', passwordHash: 'x', fullName: 'Viewer', role: 'donor_viewer' },
    });
    const auth = bearer(viewer);
    expect((await create({ indicatorText: 'x' }, auth)).status).toBe(403);
    expect((await patch(createdId, { indicatorText: 'x' }, auth)).status).toBe(403);
    const list = await request(app).get(`/api/frameworks/${a.framework.id}/indicators`).set('Authorization', auth);
    expect(list.status).toBe(200);
  });

  it('includes the result in framework indicator lists, status and approval responses', async () => {
    const list = await request(app).get(`/api/frameworks/${a.framework.id}/indicators`).set('Authorization', a.adminAuth);
    expect(list.status).toBe(200);
    const fixtureIndicator = list.body.find((i: any) => i.id === a.indicator.id);
    expect(fixtureIndicator.result).toEqual({ id: a.result.id, code: 'O1', level: 'outcome', text: 'Outcome a' });
    expect(fixtureIndicator._count).toEqual({ dataPoints: 1 });
    expect(list.body.map((i: any) => i.sortOrder)).toEqual([...list.body.map((i: any) => i.sortOrder)].sort((x, y) => x - y));

    const status = await request(app).get(`/api/frameworks/${a.framework.id}/status`).set('Authorization', a.adminAuth);
    expect(status.body.status).toBe('completed');
    expect(status.body.framework.resultNodes.map((n: any) => n.code)).toEqual(['O1']);
    expect(status.body.framework.indicators.find((i: any) => i.id === a.indicator.id).result.code).toBe('O1');

    const approvedIndicator = await request(app).patch(`/api/indicators/${a.indicator.id}/approve`).set('Authorization', a.adminAuth);
    expect(approvedIndicator.status).toBe(200);
    expect(approvedIndicator.body).toMatchObject({ isApproved: true, result: { code: 'O1' } });

    const approved = await request(app).patch(`/api/frameworks/${a.framework.id}/approve`).set('Authorization', a.adminAuth);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.resultNodes).toHaveLength(1);
    expect(approved.body.indicators.every((i: any) => 'result' in i)).toBe(true);
  });
});
