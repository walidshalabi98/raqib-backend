import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { formatIssues, parseDateInput, summariseErrors, validationErrorBody } from '../src/services/dataPoints/fields';
import {
  completeDataPoint, parseBulkRowFields, parseDataPointFields,
} from '../src/services/dataPoints/validation';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

const VALID = { value: '218', collectionDate: '2026-04-01', collectionMethod: 'hh_survey' };

function errorsOf<T>(result: { ok: true; data: T } | { ok: false; errors: string[] }): string[] {
  if (result.ok === true) throw new Error('expected validation errors');
  return result.errors;
}

describe('parseDateInput', () => {
  it('accepts YYYY-MM-DD and ISO date-times', () => {
    expect(parseDateInput('2026-04-01')?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(parseDateInput(' 2028-02-29 ')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(parseDateInput('2026-04-01T10:30:00Z')?.toISOString()).toBe('2026-04-01T10:30:00.000Z');
  });

  it.each(['2026-02-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-04-00', '01/04/2026', 'April 1, 2026', '', 'soon', 20260401, null])(
    'rejects %j',
    input => {
      expect(parseDateInput(input)).toBeNull();
    },
  );
});

describe('validation messages', () => {
  it('names the field and the array index', () => {
    const schema = z.object({ sectors: z.array(z.enum(['a', 'b'])) });
    const parsed = schema.safeParse({ sectors: ['a', 'x'] });
    expect(parsed.success).toBe(false);
    if (parsed.success === false) expect(formatIssues(parsed.error, 'Row 2: ')[0]).toMatch(/^Row 2: sectors\[1\] /);
  });

  it('lists at most ten problems in the summary and keeps all of them in errors', () => {
    const errors = Array.from({ length: 12 }, (_, i) => `problem ${i + 1}`);
    expect(summariseErrors(errors)).toBe(`${errors.slice(0, 10).join('; ')}; and 2 more problems`);
    expect(summariseErrors(errors.slice(0, 11))).toMatch(/; and 1 more problem$/);
    expect(validationErrorBody(['one'])).toEqual({ message: 'one', errors: ['one'] });
  });
});

describe('parseDataPointFields', () => {
  it('accepts the Phase 0 fields and converts a numeric value to text', () => {
    const result = parseDataPointFields({ ...VALID, value: 218, notes: '  ', dataSource: ' Kobo ' });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.data.value).toBe('218');
      expect(result.data.collectionDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect(result.data.notes).toBeNull();
      expect(result.data.dataSource).toBe('Kobo');
    }
  });

  it('accepts a value of 0', () => {
    expect(parseDataPointFields({ ...VALID, value: 0 }).ok).toBe(true);
  });

  it('reports every missing required field', () => {
    expect(errorsOf(parseDataPointFields({}))).toEqual([
      'value is required',
      'collectionDate is required',
      'collectionMethod is required',
    ]);
  });

  it('lists the allowed collection methods', () => {
    expect(errorsOf(parseDataPointFields({ ...VALID, collectionMethod: 'phone' }))).toEqual([
      'collectionMethod must be one of: hh_survey, fgd, kii, observation, document_review, participatory, secondary_data',
    ]);
  });

  it('rejects impossible dates', () => {
    expect(errorsOf(parseDataPointFields({ ...VALID, collectionDate: '2026-02-31' }))).toEqual([
      'collectionDate must be a valid date (YYYY-MM-DD)',
    ]);
  });

  it('rejects a body that is not an object', () => {
    expect(errorsOf(parseDataPointFields([VALID]))).toEqual(['request body must be a JSON object']);
  });
});

describe('parseBulkRowFields and completeDataPoint', () => {
  it('numbers rows from 1 in messages', () => {
    expect(errorsOf(parseBulkRowFields({ ...VALID }, 2))).toEqual(['Row 3: indicatorId is required']);
  });

  it('prefixes breakdown problems with the row and stores a normalised breakdown', () => {
    const row = parseBulkRowFields({ ...VALID, indicatorId: 'x', breakdown: { sex: { female: '120', male: 90 } } }, 2);
    if (row.ok === false) throw new Error(row.errors.join('; '));
    expect(errorsOf(completeDataPoint(row.data, 'people', 'Row 3: '))).toEqual([
      'Row 3: sex: categories add up to 210 but the value is 218',
    ]);
    const ok = completeDataPoint({ ...row.data, breakdown: { sex: { female: '120', male: 98 } } }, 'people');
    expect(ok).toMatchObject({ ok: true, data: { breakdown: { sex: { female: 120, male: 98 } } } });
  });

  it('drops null attachments and keeps other JSON', () => {
    const fields = parseDataPointFields({ ...VALID, attachments: null });
    if (fields.ok === false) throw new Error(fields.errors.join('; '));
    expect(completeDataPoint(fields.data, null)).toMatchObject({ ok: true, data: { attachments: undefined, breakdown: null } });
    const withFiles = parseDataPointFields({ ...VALID, attachments: ['photo-1'] });
    if (withFiles.ok === false) throw new Error(withFiles.errors.join('; '));
    expect(completeDataPoint(withFiles.data, null)).toMatchObject({ ok: true, data: { attachments: ['photo-1'] } });
  });
});

describe.skipIf(!hasTestDatabase)('disaggregated data points (API)', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let peopleId: string;
  let percentId: string;
  let scoreId: string;

  async function createIndicator(org: OrgFixture, text: string, unit: string | null) {
    const indicator = await prisma.indicator.create({
      data: {
        frameworkId: org.framework.id, indicatorText: text, level: 'output', unit,
        dataCollectionMethod: 'document_review', frequency: 'quarterly', phases: ['baseline', 'endline'],
        disaggregation: ['sex', 'disability'],
      },
    });
    return indicator.id;
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    peopleId = await createIndicator(a, 'Number of youth completing vocational training', 'people');
    percentId = await createIndicator(a, '% of households with acceptable food consumption', 'percent');
    scoreId = await createIndicator(a, 'Average coping strategy score', 'score');
  });

  it('stores a valid breakdown and returns it from GET', async () => {
    const breakdown = { sex: { female: '120', male: 98 }, disability: { yes: 12, no: 206 } };
    const res = await request(app)
      .post(`/api/indicators/${peopleId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, breakdown });
    expect(res.status).toBe(201);
    expect(res.body.breakdown).toEqual({ sex: { female: 120, male: 98 }, disability: { yes: 12, no: 206 } });

    const stored = await prisma.dataPoint.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.breakdown).toEqual({ sex: { female: 120, male: 98 }, disability: { yes: 12, no: 206 } });
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: peopleId } })).currentValue).toBe('218');

    const list = await request(app).get(`/api/indicators/${peopleId}/data`).set('Authorization', a.officerAuth);
    expect(list.status).toBe(200);
    expect(list.body.indicator).toMatchObject({ unit: 'people', disaggregation: ['sex', 'disability'] });
    expect(list.body.dataPoints).toHaveLength(1);
    expect(list.body.dataPoints[0].breakdown).toEqual({ sex: { female: 120, male: 98 }, disability: { yes: 12, no: 206 } });
  });

  it('stores data points without a breakdown as before', async () => {
    const res = await request(app).post(`/api/indicators/${a.indicator.id}/data`).set('Authorization', a.officerAuth).send(VALID);
    expect(res.status).toBe(201);
    expect(res.body.breakdown).toBeNull();
    expect(res.body.value).toBe('218');
  });

  it('rejects a count breakdown that does not add up, with a clear message', async () => {
    const before = await prisma.dataPoint.count({ where: { indicatorId: peopleId } });
    const res = await request(app)
      .post(`/api/indicators/${peopleId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, breakdown: { sex: { female: 120, male: 90 } } });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('sex: categories add up to 210 but the value is 218');
    expect(res.body.errors).toEqual(['sex: categories add up to 210 but the value is 218']);
    expect(await prisma.dataPoint.count({ where: { indicatorId: peopleId } })).toBe(before);
  });

  it('treats an indicator without a unit as a count', async () => {
    const res = await request(app)
      .post(`/api/indicators/${a.indicator.id}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, value: 10, breakdown: { sex: { female: 4, male: 5 } } });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('sex: categories add up to 9 but the value is 10');
  });

  it('rejects a malformed breakdown', async () => {
    const res = await request(app)
      .post(`/api/indicators/${peopleId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, breakdown: [120, 98] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^breakdown must be an object of dimensions/);
  });

  it('checks percentages are between 0 and 100 without a sum check', async () => {
    const ok = await request(app)
      .post(`/api/indicators/${percentId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, value: '61', breakdown: { sex_of_household_head: { female: 54.5, male: 63 } } });
    expect(ok.status).toBe(201);
    expect(ok.body.breakdown).toEqual({ sex_of_household_head: { female: 54.5, male: 63 } });

    const tooHigh = await request(app)
      .post(`/api/indicators/${percentId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, value: '61', breakdown: { sex_of_household_head: { female: 120, male: 63 } } });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.message).toBe('sex_of_household_head: "female" must be between 0 and 100 for a percentage (got 120)');
  });

  it('does not check sums for other units', async () => {
    const res = await request(app)
      .post(`/api/indicators/${scoreId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, value: '14.2', breakdown: { sex: { female: 15.1, male: 13.4 } } });
    expect(res.status).toBe(201);
  });

  it('validates the Phase 0 fields with clear messages', async () => {
    const res = await request(app)
      .post(`/api/indicators/${peopleId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ value: '', collectionDate: '2026-02-31', collectionMethod: 'phone' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      'value is required',
      'collectionDate must be a valid date (YYYY-MM-DD)',
      expect.stringMatching(/^collectionMethod must be one of: hh_survey, /),
    ]);
  });

  it('still refuses an assessment from another organisation', async () => {
    const res = await request(app)
      .post(`/api/indicators/${peopleId}/data`)
      .set('Authorization', a.officerAuth)
      .send({ ...VALID, assessmentId: b.assessment.id });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an indicator of another organisation, before validating the body', async () => {
    const res = await request(app)
      .post(`/api/indicators/${b.indicator.id}/data`)
      .set('Authorization', a.officerAuth)
      .send({ breakdown: 'nonsense' });
    expect(res.status).toBe(404);
  });

  describe('bulk import', () => {
    it('stores breakdowns checked against each indicator unit', async () => {
      const before = await prisma.dataPoint.count({ where: { projectId: a.project.id } });
      const res = await request(app)
        .post(`/api/projects/${a.project.id}/data/bulk`)
        .set('Authorization', a.officerAuth)
        .send({
          dataPoints: [
            { ...VALID, indicatorId: peopleId, collectionDate: '2026-06-30', breakdown: { sex: { female: 118, male: 100 } } },
            { ...VALID, indicatorId: percentId, value: '58', breakdown: { sex_of_household_head: { female: 50, male: 61 } } },
            { ...VALID, indicatorId: a.indicator.id, value: '12' },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ count: 3 });
      expect(await prisma.dataPoint.count({ where: { projectId: a.project.id } })).toBe(before + 3);
      const latest = await prisma.dataPoint.findFirstOrThrow({
        where: { indicatorId: peopleId, collectionDate: new Date('2026-06-30') },
      });
      expect(latest.breakdown).toEqual({ sex: { female: 118, male: 100 } });
    });

    it('reports breakdown problems with the row number and stores nothing', async () => {
      const before = await prisma.dataPoint.count({ where: { projectId: a.project.id } });
      const res = await request(app)
        .post(`/api/projects/${a.project.id}/data/bulk`)
        .set('Authorization', a.officerAuth)
        .send({
          dataPoints: [
            { ...VALID, indicatorId: peopleId, breakdown: { sex: { female: 120, male: 98 } } },
            { ...VALID, indicatorId: percentId, value: '61', breakdown: { sex: { female: 64 } } },
            { ...VALID, indicatorId: peopleId, breakdown: { sex: { female: 120, male: 90 } } },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Row 3: sex: categories add up to 210 but the value is 218');
      expect(res.body.errors).toEqual(['Row 3: sex: categories add up to 210 but the value is 218']);
      expect(await prisma.dataPoint.count({ where: { projectId: a.project.id } })).toBe(before);
    });

    it('reports field problems in every row together', async () => {
      const res = await request(app)
        .post(`/api/projects/${a.project.id}/data/bulk`)
        .set('Authorization', a.officerAuth)
        .send({
          dataPoints: [
            { ...VALID, indicatorId: peopleId },
            { ...VALID, indicatorId: peopleId, collectionMethod: 'phone' },
            { ...VALID, indicatorId: peopleId, collectionDate: 'yesterday' },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([
        expect.stringMatching(/^Row 2: collectionMethod must be one of: /),
        'Row 3: collectionDate must be a valid date (YYYY-MM-DD)',
      ]);
    });

    it('requires an indicatorId on every row and names the rows', async () => {
      const res = await request(app)
        .post(`/api/projects/${a.project.id}/data/bulk`)
        .set('Authorization', a.officerAuth)
        .send({ dataPoints: [{ ...VALID, indicatorId: peopleId }, { ...VALID }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Every data point needs an indicatorId (missing in row 2)');
    });

    it('requires a non-empty dataPoints array', async () => {
      const res = await request(app)
        .post(`/api/projects/${a.project.id}/data/bulk`)
        .set('Authorization', a.officerAuth)
        .send({ dataPoints: [] });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('dataPoints array is required');
    });

    it('still refuses indicators from another organisation', async () => {
      const res = await request(app)
        .post(`/api/projects/${a.project.id}/data/bulk`)
        .set('Authorization', a.officerAuth)
        .send({ dataPoints: [{ ...VALID, indicatorId: b.indicator.id, breakdown: { sex: { female: 218 } } }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('One or more indicators do not belong to this project');
      expect(await prisma.dataPoint.count({ where: { indicatorId: b.indicator.id } })).toBe(1);
    });
  });
});
