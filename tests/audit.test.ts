import bcrypt from 'bcrypt';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { AUDIT_VALUE_ROUTES, auditValues, bodyFieldNames } from '../src/middleware/audit';
import { createOrgFixture, hasTestDatabase, OrgFixture, PDF_BYTES, resetDatabase } from './helpers';
import { ROLE_MATRIX } from './roleMatrix';
import { routeLayers } from './routeStack';

/** Audit rows are written when the response finishes: wait for them. */
async function waitForRows(where: { action?: string; userId?: string }, count = 1) {
  for (let i = 0; i < 100; i++) {
    const rows = await prisma.auditLog.findMany({ where, orderBy: { timestamp: 'asc' } });
    if (rows.length >= count) return rows;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`audit rows for ${JSON.stringify(where)} did not appear`);
}

describe('bodyFieldNames', () => {
  it('lists the top-level field names, sorted, never values', () => {
    expect(bodyFieldNames({ targetValue: '300', baselineValue: '120', notes: 'Layla Testname' })).toEqual(['baselineValue', 'notes', 'targetValue']);
    expect(bodyFieldNames({ phone_number: '0599123456' })).toEqual(['phone_number']);
  });

  it('leaves out keys that are not field names, and anything but a plain object', () => {
    expect(bodyFieldNames({ 'Layla Testname': 1, '0599123456': 2, 'a-b': 3, ['x'.repeat(65)]: 4, ok: 5 })).toEqual(['ok']);
    for (const body of [undefined, null, 'text', 42, [{ fullName: 'x' }]]) expect(bodyFieldNames(body)).toEqual([]);
    expect(bodyFieldNames(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${String(i).padStart(2, '0')}`, i])))).toHaveLength(50);
  });
});

describe('audit values (allow-listed fields of M&E records)', () => {
  it('are kept only for writes to projects, frameworks, results, indicators, data points and report publishing, and every key is a staff route', () => {
    const registered = new Set(routeLayers(app).map(r => r.key));
    for (const key of Object.keys(AUDIT_VALUE_ROUTES)) {
      const [method, path] = key.split(' ');
      const routeKey = `${method.toLowerCase()} ${path}`;
      expect(registered.has(routeKey), key).toBe(true);
      expect(Array.isArray(ROLE_MATRIX[routeKey]), key).toBe(true);
      expect(path, key).not.toMatch(/beneficiar|qualitative|documents|users|organizations|webhook|notifications|templates|auth/);
    }
    const fields = Object.values(AUDIT_VALUE_ROUTES).flat();
    // Free text that can name people, places finer than a governorate, or files: never kept.
    for (const field of ['notes', 'geographicArea', 'attachments', 'dataSource', 'fullName', 'phoneNumber', 'nationalId', 'content', 'location', 'description', 'aiRationale', 'token', 'aiNarrative', 'fileUrl', 'title']) {
      expect(fields, field).not.toContain(field);
    }
  });

  it('pick the listed fields of a plain object only', () => {
    expect(auditValues(['id', 'targetValue'], { id: 'i-1', targetValue: '300', notes: 'Layla Testname' })).toEqual({ id: 'i-1', targetValue: '300' });
    expect(auditValues(['targetValue'], { notes: 'x' })).toBeNull();
    for (const body of [undefined, null, 'text', [{ targetValue: '1' }]]) expect(auditValues(['targetValue'], body)).toBeNull();
  });
});

describe.skipIf(!hasTestDatabase)('audit log', () => {
  let a: OrgFixture;
  let b: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
  });

  it('records who, what, the status and the field names of a write, never a value', async () => {
    const path = `/api/projects/${a.project.id}/beneficiaries`;
    const res = await request(app).post(`${path}?source=test`).set('Authorization', a.officerAuth)
      .send({ fullName: 'Audit Testperson', gender: 'female', phoneNumber: '0599777666', nationalId: '409876543' });
    expect(res.status).toBe(201);

    const [row] = await waitForRows({ userId: a.officer.id });
    expect(row).toMatchObject({
      userId: a.officer.id,
      action: `POST ${path}`,
      entity: 'projects',
      entityId: a.project.id,
      previousValue: null,
    });
    // A beneficiary write keeps field names only.
    expect(row.newValue).toEqual({ status: 201, fields: ['fullName', 'gender', 'nationalId', 'phoneNumber'] });
    expect(JSON.stringify(row)).not.toMatch(/Audit Testperson|0599777666|409876543|source=test/);
  });

  it('records who changed an indicator target, when, and to what: the history of the value', async () => {
    const first = await request(app).patch(`/api/indicators/${a.indicator.id}`).set('Authorization', a.officerAuth).send({ targetValue: '500' });
    expect(first.status).toBe(200);
    const second = await request(app).patch(`/api/indicators/${a.indicator.id}`).set('Authorization', a.adminAuth)
      .send({ targetValue: '300', targetJustification: 'Revised after the midterm' });
    expect(second.status).toBe(200);
    const rows = await waitForRows({ action: `PATCH /api/indicators/${a.indicator.id}` }, 2);
    expect(rows.map(r => ({ userId: r.userId, entity: r.entity, entityId: r.entityId, newValue: r.newValue }))).toMatchObject([
      {
        userId: a.officer.id, entity: 'indicators', entityId: a.indicator.id,
        newValue: { status: 200, fields: ['targetValue'], values: { id: a.indicator.id, targetValue: '500', baselineValue: null } },
      },
      {
        userId: a.admin.id, entity: 'indicators', entityId: a.indicator.id,
        newValue: { status: 200, fields: ['targetJustification', 'targetValue'], values: { targetValue: '300', targetJustification: 'Revised after the midterm' } },
      },
    ]);
    // Only the listed fields: not the indicator's result or any other part of the response.
    for (const row of rows) {
      expect(Object.keys((row.newValue as { values: object }).values).every(k => AUDIT_VALUE_ROUTES['PATCH /api/indicators/:id'].includes(k))).toBe(true);
    }
  });

  it('records the values of project and result writes too', async () => {
    const project = await request(app).patch(`/api/projects/${a.project.id}`).set('Authorization', a.officerAuth).send({ targetBeneficiaries: 1200 });
    expect(project.status).toBe(200);
    const result = await request(app).post(`/api/frameworks/${a.framework.id}/results`).set('Authorization', a.officerAuth)
      .send({ level: 'output', code: 'O1.1', parentId: a.result.id, text: 'Teachers trained in inclusive methods' });
    expect(result.status).toBe(201);
    const [projectRow] = await waitForRows({ action: `PATCH /api/projects/${a.project.id}` });
    expect(projectRow.newValue).toMatchObject({ values: { id: a.project.id, targetBeneficiaries: 1200, name: 'Project a' } });
    const [resultRow] = await waitForRows({ action: `POST /api/frameworks/${a.framework.id}/results` });
    expect(resultRow.newValue).toMatchObject({ values: { id: result.body.id, code: 'O1.1', level: 'output', text: 'Teachers trained in inclusive methods', parentId: a.result.id } });
  });

  it('records the value of a new data point, never its notes, area or source', async () => {
    const res = await request(app).post(`/api/indicators/${a.indicator.id}/data`).set('Authorization', a.officerAuth)
      .send({ value: '42', collectionDate: '2026-05-31', collectionMethod: 'document_review', notes: 'Checked with Layla Testname', geographicArea: '31.531234, 35.095678', dataSource: 'Clinic register of Layla Testname' });
    expect(res.status).toBe(201);
    const [row] = await waitForRows({ action: `POST /api/indicators/${a.indicator.id}/data` });
    expect(row.newValue).toEqual({
      status: 201,
      fields: ['collectionDate', 'collectionMethod', 'dataSource', 'geographicArea', 'notes', 'value'],
      values: { id: res.body.id, indicatorId: a.indicator.id, assessmentId: null, value: '42', collectionDate: '2026-05-31T00:00:00.000Z', collectionMethod: 'document_review' },
    });
    expect(JSON.stringify(row)).not.toMatch(/Testname|31\.53/);
  });

  it('records who published a report to donors and who took it back, never the narrative or the title', async () => {
    const report = await prisma.report.create({
      data: { projectId: a.project.id, type: 'quarterly_summary', title: 'Audit Testtitle', aiNarrative: '<p>Narrative Testtext</p>', periodStart: new Date('2026-04-01'), periodEnd: new Date('2026-06-30') },
    });
    const published = await request(app).patch(`/api/reports/${report.id}/publish`).set('Authorization', a.adminAuth);
    expect(published.status).toBe(200);
    const withdrawn = await request(app).patch(`/api/reports/${report.id}/unpublish`).set('Authorization', a.adminAuth);
    expect(withdrawn.status).toBe(200);
    const refused = await request(app).patch(`/api/reports/${report.id}/publish`).set('Authorization', a.officerAuth);
    expect(refused.status).toBe(403);

    const values = (status: string) => ({
      id: report.id, projectId: a.project.id, type: 'quarterly_summary', status,
      generatedAt: report.generatedAt.toISOString(), periodStart: '2026-04-01T00:00:00.000Z', periodEnd: '2026-06-30T00:00:00.000Z',
    });
    const [publishRow, refusedRow] = await waitForRows({ action: `PATCH /api/reports/${report.id}/publish` }, 2);
    expect(publishRow).toMatchObject({ userId: a.admin.id, entity: 'reports', entityId: report.id, newValue: { status: 200, fields: [], values: values('published') } });
    expect(refusedRow).toMatchObject({ userId: a.officer.id, newValue: { status: 403, fields: [] } });
    expect(refusedRow.newValue).not.toHaveProperty('values');
    const [unpublishRow] = await waitForRows({ action: `PATCH /api/reports/${report.id}/unpublish` });
    expect(unpublishRow).toMatchObject({ userId: a.admin.id, entity: 'reports', entityId: report.id, newValue: { status: 200, fields: [], values: values('draft') } });
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toMatch(/Testtext|Testtitle|Project a/);
  });

  it('keeps no values when a write is refused or fails', async () => {
    const refused = await request(app).patch(`/api/indicators/${a.indicator.id}`).set('Authorization', a.donorAuth).send({ targetValue: '1' });
    expect(refused.status).toBe(403);
    const invalid = await request(app).patch(`/api/indicators/${a.indicator.id}`).set('Authorization', a.officerAuth).send({ level: 'nonsense' });
    expect(invalid.status).toBe(400);
    const rows = await waitForRows({ action: `PATCH /api/indicators/${a.indicator.id}` }, 2);
    for (const row of rows) expect(row.newValue).not.toHaveProperty('values');
  });

  it('records refused requests with their status', async () => {
    const res = await request(app).post(`/api/projects/${a.project.id}/beneficiaries`).set('Authorization', a.donorAuth)
      .send({ fullName: 'Donor Testperson', gender: 'male' });
    expect(res.status).toBe(403);
    const [row] = await waitForRows({ userId: a.donor.id });
    expect(row).toMatchObject({ action: `POST /api/projects/${a.project.id}/beneficiaries`, newValue: { status: 403, fields: ['fullName', 'gender'] } });
    expect(JSON.stringify(row)).not.toContain('Donor Testperson');
  });

  it('takes the id from the path when an error answered the request', async () => {
    const res = await request(app).patch(`/api/beneficiaries/${b.beneficiary.id}`).set('Authorization', a.officerAuth).send({ fullName: 'Hijacked' });
    expect(res.status).toBe(404);
    const [row] = await waitForRows({ userId: a.officer.id });
    expect(row).toMatchObject({ entity: 'beneficiaries', entityId: b.beneficiary.id, newValue: { status: 404, fields: ['fullName'] } });
  });

  it('records document uploads (the row used to fail on the BigInt file size)', async () => {
    const res = await request(app).post(`/api/projects/${a.project.id}/documents`).set('Authorization', a.officerAuth)
      .field('fileType', 'logframe')
      .attach('file', PDF_BYTES, { filename: 'logframe.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    const [row] = await waitForRows({ action: `POST /api/projects/${a.project.id}/documents` });
    expect(row).toMatchObject({ userId: a.officer.id, entity: 'projects', newValue: { status: 201, fields: ['fileType'] } });
    expect(JSON.stringify(row)).not.toContain('logframe.pdf');
  });

  it('never stores a new webhook token or the caller\'s access token', async () => {
    const res = await request(app).post(`/api/organizations/${a.org.id}/webhook-tokens`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    const [row] = await waitForRows({ userId: a.admin.id });
    expect(row).toMatchObject({ entity: 'organizations', entityId: a.org.id });
    expect(row.newValue).toEqual({ status: 201, fields: [] });
    const all = JSON.stringify(await prisma.auditLog.findMany());
    expect(all).not.toContain(res.body.token);
    expect(all).not.toContain(a.adminAuth.replace('Bearer ', ''));
  });

  it('does not write rows for sign-in or other requests without a signed-in user', async () => {
    const passwordHash = await bcrypt.hash('Correct-horse-battery-1', 4);
    await prisma.user.create({ data: { organizationId: a.org.id, email: 'audit-login@example.org', passwordHash, fullName: 'Login Test', role: 'me_officer' } });
    const login = await request(app).post('/api/auth/login').send({ email: 'audit-login@example.org', password: 'Correct-horse-battery-1' });
    expect(login.status).toBe(200);
    const anonymous = await request(app).post(`/api/projects/${a.project.id}/beneficiaries`).send({ fullName: 'x', gender: 'male' });
    expect(anonymous.status).toBe(401);

    // A later audited request: once its row exists, the earlier requests have finished too.
    await request(app).delete(`/api/documents/${a.document.id}`).set('Authorization', a.donorAuth);
    await waitForRows({ userId: a.donor.id });
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/Correct-horse|audit-login|accessToken/);
  });

  it('does not audit reads', async () => {
    await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.officerAuth);
    await request(app).delete(`/api/documents/${a.document.id}`).set('Authorization', a.donorAuth);
    await waitForRows({ userId: a.donor.id });
    expect(await prisma.auditLog.count({ where: { userId: a.officer.id } })).toBe(0);
  });
});
