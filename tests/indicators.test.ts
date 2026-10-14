import request from 'supertest';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { AppError } from '../src/middleware/errorHandler';
import { levelForResult } from '../src/services/indicators/hierarchy';
import {
  DEFAULT_PHASES, indicatorCreateSchema, isLegacyDate, parseIndicatorCreate, parseIndicatorUpdate, parseIsoDate,
  provenanceAfterUpdate, toIndicatorCreateData, toIndicatorUpdateData,
} from '../src/services/indicators/validation';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

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

  it('rejects impossible dates in ISO date-time form instead of rolling them over', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-02-29T10:00:00.000Z', '2026-04-31T12:00+03:00', '2026-13-01T00:00:00Z', '2026-02-01T25:00:00Z']) {
      expect(isLegacyDate(bad), bad).toBe(false);
      expect(messageOf(() => parseIndicatorUpdate({ endDate: bad }))).toContain('endDate must be a real date in YYYY-MM-DD format');
    }
    expect(isLegacyDate('2028-02-29T10:00:00+03:00')).toBe(true);
    expect(isLegacyDate('2026-02-28T23:59:59.999Z')).toBe(true);
    expect(isLegacyDate('2026-02-28')).toBe(true);
    expect(parseIndicatorUpdate({ actualEndDate: '2028-02-29T00:00:00Z' }).actualEndDate).toEqual(new Date('2028-02-29T00:00:00.000Z'));
  });

  it('parses a full reference sheet', () => {
    const parsed = parseIndicatorUpdate({ ...referenceSheet, libraryId: 'FS-01', resultId: 'r-1' });
    expect(parsed).toMatchObject({
      direction: 'increase',
      disaggregation: ['sex_of_household_head', 'location', 'displacement_status'],
      calculation: referenceSheet.calculation,
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

  it('lets clients set only manual, library or imported provenance, and only on create', () => {
    for (const ok of ['manual', 'library', 'imported']) expect(parseIndicatorCreate({ provenance: ok }).provenance).toBe(ok);
    expect(messageOf(() => parseIndicatorCreate({ provenance: 'ai_suggested' })))
      .toBe("Invalid indicator: provenance ai_suggested is set only by Raqib's AI features; use one of: manual, library, imported");
    expect(messageOf(() => parseIndicatorCreate({ provenance: 'ai_generated' }))).toContain('ai_generated is set only by');
    expect(messageOf(() => parseIndicatorCreate({ provenance: 'copied' }))).toContain('provenance must be one of: manual, library, imported');
    // On update it is stripped like any unknown key: the server works it out (provenanceAfterUpdate).
    for (const sent of ['manual', 'library', 'imported', 'ai_suggested', 'ai_generated', 'copied']) {
      expect(parseIndicatorUpdate({ provenance: sent, indicatorText: 'Kept' })).toEqual({ indicatorText: 'Kept' });
    }
  });

  it('works out provenance after an update from the library link, never changing AI or imported provenance', () => {
    expect(provenanceAfterUpdate('manual', 'FS-01')).toBe('library');
    expect(provenanceAfterUpdate('library', 'FS-01')).toBe('library');
    expect(provenanceAfterUpdate('library', null)).toBe('manual');
    expect(provenanceAfterUpdate('manual', null)).toBe('manual');
    for (const fixed of ['ai_generated', 'ai_suggested', 'imported'] as const) {
      expect(provenanceAfterUpdate(fixed, 'FS-01')).toBe(fixed);
      expect(provenanceAfterUpdate(fixed, null)).toBe(fixed);
    }
  });

  it('trims and upper-cases library ids', () => {
    expect(parseIndicatorUpdate({ libraryId: ' fs-01 ' }).libraryId).toBe('FS-01');
    expect(parseIndicatorCreate({ libraryId: 'fs-01' }).libraryId).toBe('FS-01');
    expect(parseIndicatorUpdate({ libraryId: '  ' }).libraryId).toBeNull();
    expect(toIndicatorCreateData('fw-1', parseIndicatorCreate({ libraryId: 'fs-01' }), { sortOrder: 0 })).toMatchObject({
      libraryId: 'FS-01', provenance: 'library',
    });
  });

  it('requires the level of a linked indicator to match its result', () => {
    expect(levelForResult(undefined, 'outcome')).toEqual({ ok: true, level: 'outcome' });
    expect(levelForResult('outcome', 'outcome')).toEqual({ ok: true, level: 'outcome' });
    expect(levelForResult('output', 'outcome')).toEqual({ ok: false, message: 'level must match the result it measures (outcome)' });
    expect(levelForResult('impact', null)).toEqual({ ok: true, level: 'impact' });
    expect(levelForResult(undefined, undefined)).toEqual({ ok: true, level: undefined });
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
      provenance: 'manual',
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
      calculation: { formula: 'count' }, intermediateTargets: [{ date: '2026-09-30', value: '52' }],
      provenance: 'library', // clients cannot set it; still linked to TS-01
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
      provenance: 'manual', // unlinked from the library
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

  it('rejects AI provenance from clients on create and ignores provenance on update', async () => {
    const created = await create({ indicatorText: 'AI?', provenance: 'ai_generated' });
    expect(created.status).toBe(400);
    expect(created.body.message).toContain("ai_generated is set only by Raqib's AI features");

    for (const provenance of ['ai_suggested', 'library', 'imported']) {
      const patched = await patch(createdId, { provenance });
      expect(patched.status).toBe(200);
      expect(patched.body.provenance).toBe('manual');
    }
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: createdId } })).provenance).toBe('manual');
  });

  it('keeps AI provenance and model fields when an AI indicator is edited', async () => {
    const ai = await prisma.indicator.create({
      data: {
        frameworkId: a.framework.id, indicatorText: 'AI indicator', level: 'output', dataCollectionMethod: 'document_review',
        frequency: 'monthly', phases: ['ongoing'], provenance: 'ai_generated', aiModel: 'claude-sonnet-5-5', promptVersion: 'framework-v2',
      },
    });
    const res = await patch(ai.id, {
      indicatorText: 'Edited AI indicator', aiModel: 'forged', promptVersion: 'forged', provenance: 'manual', aiRationale: 'Reviewed by M&E',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      indicatorText: 'Edited AI indicator', provenance: 'ai_generated', aiModel: 'claude-sonnet-5-5', promptVersion: 'framework-v2',
      aiRationale: 'Reviewed by M&E', // still writable
    });

    // Linking and unlinking a library entry does not change AI provenance either.
    expect((await patch(ai.id, { libraryId: 'TS-01' })).body).toMatchObject({ libraryId: 'TS-01', provenance: 'ai_generated' });
    expect((await patch(ai.id, { libraryId: null })).body).toMatchObject({ libraryId: null, provenance: 'ai_generated' });
    await prisma.indicator.delete({ where: { id: ai.id } });
  });

  it('flips provenance between manual and library as a library entry is linked and unlinked (ids in any case)', async () => {
    const manual = await create({ indicatorText: 'Manual indicator' });
    expect(manual.body).toMatchObject({ provenance: 'manual', libraryId: null });

    const linked = await patch(manual.body.id, { libraryId: ' ts-01 ' });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ libraryId: 'TS-01', provenance: 'library' });

    // Other edits keep the link and the provenance.
    expect((await patch(manual.body.id, { definition: 'Edited' })).body).toMatchObject({ libraryId: 'TS-01', provenance: 'library' });

    const unlinked = await patch(manual.body.id, { libraryId: null });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ libraryId: null, provenance: 'manual' });

    // Imported provenance never changes.
    const imported = await create({ indicatorText: 'Imported indicator', provenance: 'imported' });
    expect((await patch(imported.body.id, { libraryId: 'TS-01' })).body).toMatchObject({ libraryId: 'TS-01', provenance: 'imported' });
    expect((await patch(imported.body.id, { libraryId: null })).body).toMatchObject({ libraryId: null, provenance: 'imported' });

    // Create: a lower-case id links the entry, and a library id without provenance means library.
    const fromLibrary = await create({ indicatorText: 'From library', libraryId: 'ts-01' });
    expect(fromLibrary.status).toBe(201);
    expect(fromLibrary.body).toMatchObject({ libraryId: 'TS-01', provenance: 'library' });

    await prisma.indicator.deleteMany({ where: { id: { in: [manual.body.id, imported.body.id, fromLibrary.body.id] } } });
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
    // The fixture indicator measures the outcome O1, so the dialog shows (and sends back) level outcome.
    const res = await patch(a.indicator.id, { ...legacyEditPayload, level: 'outcome' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      indicatorText: legacyEditPayload.indicatorText, level: 'outcome', dataCollectionMethod: 'document_review', status: 'on_track',
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

  describe('level fits the result', () => {
    let outputResultId: string;

    beforeAll(async () => {
      outputResultId = (await prisma.resultNode.create({
        data: { frameworkId: a.framework.id, parentId: a.result.id, level: 'output', code: 'O1.1', text: 'Output a' },
      })).id;
    });

    it('refuses to create an indicator whose level differs from its result', async () => {
      const before = await prisma.indicator.count({ where: { frameworkId: a.framework.id } });
      const res = await create({ indicatorText: 'Mismatch', level: 'output', resultId: a.result.id });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('level must match the result it measures (outcome)');
      expect(await prisma.indicator.count({ where: { frameworkId: a.framework.id } })).toBe(before);

      const matching = await create({ indicatorText: 'Match', level: 'output', resultId: outputResultId });
      expect(matching.status).toBe(201);
      expect(matching.body).toMatchObject({ level: 'output', result: { code: 'O1.1' } });
      await prisma.indicator.delete({ where: { id: matching.body.id } });
    });

    it('checks the level and result that a PATCH leaves', async () => {
      const ind = await create({ indicatorText: 'Moving indicator', resultId: a.result.id });
      expect(ind.body.level).toBe('outcome');

      // A new level against the stored result.
      const wrongLevel = await patch(ind.body.id, { level: 'output' });
      expect(wrongLevel.status).toBe(400);
      expect(wrongLevel.body.message).toBe('level must match the result it measures (outcome)');

      // A new result against an explicit level.
      const wrongPair = await patch(ind.body.id, { resultId: outputResultId, level: 'outcome' });
      expect(wrongPair.status).toBe(400);
      expect(wrongPair.body.message).toBe('level must match the result it measures (output)');
      expect(await prisma.indicator.findUniqueOrThrow({ where: { id: ind.body.id } })).toMatchObject({ level: 'outcome', resultId: a.result.id });

      // A new result without a level takes the result's level, as on create.
      const moved = await patch(ind.body.id, { resultId: outputResultId });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ level: 'output', resultId: outputResultId });

      // Level and result changed together.
      const back = await patch(ind.body.id, { resultId: a.result.id, level: 'outcome' });
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ level: 'outcome', resultId: a.result.id });

      // Unlinked, any level is fine.
      const unlinked = await patch(ind.body.id, { resultId: null, level: 'impact' });
      expect(unlinked.status).toBe(200);
      expect(unlinked.body).toMatchObject({ level: 'impact', resultId: null });
      expect((await patch(ind.body.id, { level: 'activity' })).status).toBe(200);

      await prisma.indicator.delete({ where: { id: ind.body.id } });
    });

    it('lets a result level change carry its indicators along', async () => {
      const ind = await create({ indicatorText: 'Follows its result', resultId: outputResultId });
      const otherInd = await create({ indicatorText: 'Measures the outcome', resultId: a.result.id });
      const res = await request(app).patch(`/api/results/${outputResultId}`).set('Authorization', a.adminAuth).send({ level: 'activity', parentId: null });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ level: 'activity', updatedIndicators: 1 });
      expect((await prisma.indicator.findUniqueOrThrow({ where: { id: ind.body.id } })).level).toBe('activity');
      expect((await prisma.indicator.findUniqueOrThrow({ where: { id: otherInd.body.id } })).level).toBe('outcome');
      await prisma.indicator.deleteMany({ where: { id: { in: [ind.body.id, otherInd.body.id] } } });
      await prisma.resultNode.delete({ where: { id: outputResultId } });
    });
  });

  it('lets donor viewers read but not write indicators', async () => {
    const auth = a.donorAuth;
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

  it('approves every indicator of a framework when the framework is approved', async () => {
    const fw = await prisma.framework.create({ data: { projectId: a.project.id, version: -3 } });
    const make = (frameworkId: string, indicatorText: string) => prisma.indicator.create({
      data: { frameworkId, indicatorText, level: 'output', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline'] },
    });
    const first = await make(fw.id, 'First');
    const second = await make(fw.id, 'Second');
    const elsewhere = await make(a.framework.id, 'Other framework');

    const res = await request(app).patch(`/api/frameworks/${fw.id}/approve`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.indicators.map((i: any) => [i.indicatorText, i.isApproved])).toEqual([['First', true], ['Second', true]]);
    const stored = await prisma.indicator.findMany({ where: { id: { in: [first.id, second.id] } } });
    expect(stored.every(i => i.isApproved)).toBe(true);
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: elsewhere.id } })).isApproved).toBe(false);
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: b.indicator.id } })).isApproved).toBe(false);

    await prisma.indicator.deleteMany({ where: { id: { in: [first.id, second.id, elsewhere.id] } } });
    await prisma.framework.delete({ where: { id: fw.id } });
  });
});
