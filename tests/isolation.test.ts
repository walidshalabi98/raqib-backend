import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { createOrgFixture, hasTestDatabase, OrgFixture, PDF_BYTES, resetDatabase } from './helpers';

type TargetOrg = OrgFixture & { notificationId: string };
type Method = 'get' | 'post' | 'patch' | 'delete';
interface RouteCase {
  method: Method;
  route: string; // Express path as registered, used for the coverage check
  path: (b: TargetOrg) => string;
  body?: (b: TargetOrg) => object;
  upload?: boolean;
}

// Every route that takes an id. The coverage test below fails if a new
// route with an id is added without being listed here.
const ROUTES: RouteCase[] = [
  // Projects
  { method: 'get', route: '/api/projects/:id', path: b => `/api/projects/${b.project.id}` },
  { method: 'patch', route: '/api/projects/:id', path: b => `/api/projects/${b.project.id}`, body: () => ({ name: 'Hijacked' }) },
  { method: 'get', route: '/api/projects/:id/export', path: b => `/api/projects/${b.project.id}/export` },
  { method: 'delete', route: '/api/projects/:id', path: b => `/api/projects/${b.project.id}` },
  // Documents
  { method: 'get', route: '/api/projects/:id/documents', path: b => `/api/projects/${b.project.id}/documents` },
  { method: 'post', route: '/api/projects/:id/documents', path: b => `/api/projects/${b.project.id}/documents`, upload: true },
  { method: 'get', route: '/api/documents/:id/download', path: b => `/api/documents/${b.document.id}/download` },
  { method: 'get', route: '/api/documents/:id/status', path: b => `/api/documents/${b.document.id}/status` },
  { method: 'delete', route: '/api/documents/:id', path: b => `/api/documents/${b.document.id}` },
  // Frameworks
  { method: 'get', route: '/api/projects/:id/framework', path: b => `/api/projects/${b.project.id}/framework` },
  { method: 'post', route: '/api/projects/:id/framework/generate', path: b => `/api/projects/${b.project.id}/framework/generate` },
  { method: 'post', route: '/api/projects/:id/framework/manual', path: b => `/api/projects/${b.project.id}/framework/manual` },
  { method: 'get', route: '/api/frameworks/:id/status', path: b => `/api/frameworks/${b.framework.id}/status` },
  { method: 'patch', route: '/api/frameworks/:id/approve', path: b => `/api/frameworks/${b.framework.id}/approve` },
  { method: 'post', route: '/api/frameworks/:id/indicators', path: b => `/api/frameworks/${b.framework.id}/indicators`, body: () => ({ indicatorText: 'Injected' }) },
  { method: 'get', route: '/api/frameworks/:id/indicators', path: b => `/api/frameworks/${b.framework.id}/indicators` },
  // Results chain
  { method: 'get', route: '/api/frameworks/:id/results', path: b => `/api/frameworks/${b.framework.id}/results` },
  {
    method: 'post', route: '/api/frameworks/:id/results', path: b => `/api/frameworks/${b.framework.id}/results`,
    body: () => ({ level: 'output', code: 'X1', text: 'Injected' }),
  },
  { method: 'patch', route: '/api/results/:id', path: b => `/api/results/${b.result.id}`, body: () => ({ text: 'Hijacked', code: 'X9' }) },
  { method: 'delete', route: '/api/results/:id', path: b => `/api/results/${b.result.id}` },
  // Indicators and data
  { method: 'patch', route: '/api/indicators/:id', path: b => `/api/indicators/${b.indicator.id}`, body: () => ({ indicatorText: 'Hijacked' }) },
  { method: 'post', route: '/api/indicators/:id/alternative', path: b => `/api/indicators/${b.indicator.id}/alternative` },
  { method: 'patch', route: '/api/indicators/:id/approve', path: b => `/api/indicators/${b.indicator.id}/approve` },
  { method: 'delete', route: '/api/indicators/:id', path: b => `/api/indicators/${b.indicator.id}` },
  { method: 'get', route: '/api/indicators/:id/data', path: b => `/api/indicators/${b.indicator.id}/data` },
  {
    method: 'post', route: '/api/indicators/:id/data', path: b => `/api/indicators/${b.indicator.id}/data`,
    body: () => ({ value: '99', collectionDate: '2026-04-01', collectionMethod: 'hh_survey' }),
  },
  {
    method: 'post', route: '/api/projects/:id/data/bulk', path: b => `/api/projects/${b.project.id}/data/bulk`,
    body: b => ({ dataPoints: [{ indicatorId: b.indicator.id, value: '99', collectionDate: '2026-04-01', collectionMethod: 'hh_survey' }] }),
  },
  // Assessments
  { method: 'get', route: '/api/projects/:id/assessments', path: b => `/api/projects/${b.project.id}/assessments` },
  { method: 'post', route: '/api/projects/:id/assessments', path: b => `/api/projects/${b.project.id}/assessments`, body: () => ({ type: 'midterm' }) },
  { method: 'patch', route: '/api/assessments/:id', path: b => `/api/assessments/${b.assessment.id}`, body: () => ({ status: 'delivered' }) },
  { method: 'get', route: '/api/assessments/:id/report', path: b => `/api/assessments/${b.assessment.id}/report` },
  { method: 'get', route: '/api/assessments/:id/estimate', path: b => `/api/assessments/${b.assessment.id}/estimate` },
  // Qualitative
  { method: 'get', route: '/api/projects/:id/qualitative', path: b => `/api/projects/${b.project.id}/qualitative` },
  {
    method: 'post', route: '/api/projects/:id/qualitative', path: b => `/api/projects/${b.project.id}/qualitative`,
    body: () => ({ entryType: 'field_notes', title: 'Injected', content: 'x' }),
  },
  { method: 'post', route: '/api/projects/:id/qualitative/upload', path: b => `/api/projects/${b.project.id}/qualitative/upload`, upload: true },
  { method: 'get', route: '/api/qualitative/:id', path: b => `/api/qualitative/${b.qualitative.id}` },
  { method: 'post', route: '/api/qualitative/:id/code', path: b => `/api/qualitative/${b.qualitative.id}/code` },
  // Reports
  { method: 'get', route: '/api/projects/:id/reports', path: b => `/api/projects/${b.project.id}/reports` },
  {
    method: 'post', route: '/api/projects/:id/reports/generate', path: b => `/api/projects/${b.project.id}/reports/generate`,
    body: () => ({ type: 'quarterly_summary', title: 'Injected' }),
  },
  { method: 'get', route: '/api/reports/:id', path: b => `/api/reports/${b.report.id}` },
  { method: 'get', route: '/api/reports/:id/status', path: b => `/api/reports/${b.report.id}/status` },
  // Dashboard and exports
  { method: 'get', route: '/api/dashboard/projects/:id/dashboard', path: b => `/api/dashboard/projects/${b.project.id}/dashboard` },
  { method: 'get', route: '/api/dashboard/projects/:id/risks', path: b => `/api/dashboard/projects/${b.project.id}/risks` },
  { method: 'get', route: '/api/projects/:id/export/indicators', path: b => `/api/projects/${b.project.id}/export/indicators` },
  { method: 'get', route: '/api/projects/:id/export/beneficiaries', path: b => `/api/projects/${b.project.id}/export/beneficiaries` },
  // Beneficiaries
  { method: 'get', route: '/api/projects/:id/beneficiaries', path: b => `/api/projects/${b.project.id}/beneficiaries` },
  {
    method: 'post', route: '/api/projects/:id/beneficiaries', path: b => `/api/projects/${b.project.id}/beneficiaries`,
    body: () => ({ fullName: 'Injected', gender: 'male' }),
  },
  { method: 'get', route: '/api/projects/:id/beneficiaries/stats', path: b => `/api/projects/${b.project.id}/beneficiaries/stats` },
  { method: 'get', route: '/api/beneficiaries/:id', path: b => `/api/beneficiaries/${b.beneficiary.id}` },
  { method: 'patch', route: '/api/beneficiaries/:id', path: b => `/api/beneficiaries/${b.beneficiary.id}`, body: () => ({ fullName: 'Hijacked' }) },
  {
    method: 'post', route: '/api/beneficiaries/:id/services', path: b => `/api/beneficiaries/${b.beneficiary.id}/services`,
    body: () => ({ serviceType: 'training', dateProvided: '2026-04-01' }),
  },
  // Organisation, users, notifications
  { method: 'get', route: '/api/organizations/:id', path: b => `/api/organizations/${b.org.id}` },
  { method: 'patch', route: '/api/organizations/:id', path: b => `/api/organizations/${b.org.id}`, body: () => ({ name: 'Hijacked' }) },
  { method: 'get', route: '/api/organizations/:id/webhook-tokens', path: b => `/api/organizations/${b.org.id}/webhook-tokens` },
  { method: 'post', route: '/api/organizations/:id/webhook-tokens', path: b => `/api/organizations/${b.org.id}/webhook-tokens` },
  {
    method: 'delete', route: '/api/organizations/:id/webhook-tokens/:tokenId',
    path: b => `/api/organizations/${b.org.id}/webhook-tokens/00000000-0000-0000-0000-000000000000`,
  },
  { method: 'patch', route: '/api/users/:id', path: b => `/api/users/${b.officer.id}`, body: () => ({ fullName: 'Hijacked' }) },
  { method: 'delete', route: '/api/users/:id', path: b => `/api/users/${b.officer.id}` },
  { method: 'patch', route: '/api/notifications/:id/read', path: b => `/api/notifications/${b.notificationId}/read` },
];

// Routes with an id that are not organisation-owned: the global indicator template library.
const NOT_ORG_OWNED = new Set(['patch /api/templates/:id', 'delete /api/templates/:id', 'get /api/indicator-library/:id']);

/** Lists every route registered on the app as "method path". */
function registeredRoutes(): string[] {
  const out: string[] = [];
  const mountPath = (layer: any): string => {
    const src: string = layer.regexp?.source ?? '';
    if (src === '^\\/?(?=\\/|$)') return '';
    return src.replace('^', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
  };
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) out.push(`${method} ${prefix}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

describe('route coverage', () => {
  it('lists every route that takes an id', () => {
    const withIds = registeredRoutes().filter(r => /:\w+/.test(r) && !NOT_ORG_OWNED.has(r));
    const covered = new Set(ROUTES.map(r => `${r.method} ${r.route}`));
    const missing = withIds.filter(r => !covered.has(r));
    expect(withIds.length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase)('organisation isolation', () => {
  let a: OrgFixture;
  let b: TargetOrg;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    const fixtureB = await createOrgFixture('b');
    const notification = await prisma.notification.create({
      data: { userId: fixtureB.admin.id, type: 'new_data', title: 'B only', message: 'B only' },
    });
    b = { ...fixtureB, notificationId: notification.id };
  });

  it.each(ROUTES.map(r => [`${r.method.toUpperCase()} ${r.route}`, r] as const))(
    'user from organisation A gets 404 for %s on organisation B',
    async (_name, r) => {
      let req = request(app)[r.method](r.path(b)).set('Authorization', a.adminAuth);
      if (r.upload) req = req.attach('file', PDF_BYTES, { filename: 'injected.pdf', contentType: 'application/pdf' });
      else if (r.body) req = req.send(r.body(b));
      const res = await req;
      expect(res.status).toBe(404);
      // Our JSON 404, not Express's "Cannot GET" page for an unknown route.
      expect(res.body.message).toMatch(/not found/i);
    },
  );

  it('left organisation B untouched', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: b.project.id } });
    expect(project.name).toBe('Project b');
    expect(project.status).toBe('setup');
    const indicator = await prisma.indicator.findUniqueOrThrow({ where: { id: b.indicator.id } });
    expect(indicator.indicatorText).toBe('Indicator b');
    expect(indicator.resultId).toBe(b.result.id);
    const result = await prisma.resultNode.findUniqueOrThrow({ where: { id: b.result.id } });
    expect(result).toMatchObject({ code: 'O1', text: 'Outcome b', level: 'outcome', parentId: null });
    expect(await prisma.resultNode.count({ where: { frameworkId: b.framework.id } })).toBe(1);
    expect((await prisma.framework.findUniqueOrThrow({ where: { id: b.framework.id } })).status).toBe('draft');
    expect(await prisma.document.findUnique({ where: { id: b.document.id } })).not.toBeNull();
    expect((await prisma.beneficiary.findUniqueOrThrow({ where: { id: b.beneficiary.id } })).fullName).toBe('Person b');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: b.org.id } })).name).toBe('Org b');
    expect(await prisma.user.findUnique({ where: { id: b.officer.id } })).not.toBeNull();
    expect(await prisma.dataPoint.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.indicator.count({ where: { frameworkId: b.framework.id } })).toBe(1);
    expect(await prisma.framework.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.qualitativeEntry.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.report.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.assessment.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.beneficiary.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.document.count({ where: { projectId: b.project.id } })).toBe(1);
    expect(await prisma.webhookToken.count({ where: { organizationId: b.org.id } })).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: b.notificationId } })).isRead).toBe(false);
  });

  it.each(ROUTES.filter(r => r.method === 'get').map(r => [r.route, r] as const))(
    'organisation B can still read its own %s',
    async (_name, r) => {
      const res = await request(app).get(r.path(b)).set('Authorization', b.adminAuth);
      expect(res.status).toBeLessThan(300);
    },
  );

  it('rejects ids from another organisation inside a request body', async () => {
    const bulk = await request(app)
      .post(`/api/projects/${a.project.id}/data/bulk`)
      .set('Authorization', a.adminAuth)
      .send({ dataPoints: [{ indicatorId: b.indicator.id, value: '1', collectionDate: '2026-04-01', collectionMethod: 'hh_survey' }] });
    expect(bulk.status).toBe(400);

    const withAssessment = await request(app)
      .post(`/api/indicators/${a.indicator.id}/data`)
      .set('Authorization', a.adminAuth)
      .send({ value: '1', collectionDate: '2026-04-01', collectionMethod: 'hh_survey', assessmentId: b.assessment.id });
    expect(withAssessment.status).toBe(400);

    const qualitative = await request(app)
      .post(`/api/projects/${a.project.id}/qualitative`)
      .set('Authorization', a.adminAuth)
      .send({ entryType: 'field_notes', title: 't', content: 'c', assessmentId: b.assessment.id });
    expect(qualitative.status).toBe(400);

    const service = await request(app)
      .post(`/api/beneficiaries/${a.beneficiary.id}/services`)
      .set('Authorization', a.adminAuth)
      .send({ serviceType: 'training', dateProvided: '2026-04-01', indicatorId: b.indicator.id });
    expect(service.status).toBe(400);

    expect(await prisma.dataPoint.count({ where: { indicatorId: b.indicator.id } })).toBe(1);
  });

  it('rejects result and library ids from another organisation, or unknown ones, inside a request body', async () => {
    const patchResult = await request(app)
      .patch(`/api/indicators/${a.indicator.id}`)
      .set('Authorization', a.adminAuth)
      .send({ resultId: b.result.id });
    expect(patchResult.status).toBe(400);
    expect(patchResult.body.message).toMatch(/resultId/);

    const createWithResult = await request(app)
      .post(`/api/frameworks/${a.framework.id}/indicators`)
      .set('Authorization', a.adminAuth)
      .send({ indicatorText: 'Leak', resultId: b.result.id });
    expect(createWithResult.status).toBe(400);

    const childOfForeign = await request(app)
      .post(`/api/frameworks/${a.framework.id}/results`)
      .set('Authorization', a.adminAuth)
      .send({ level: 'output', code: 'O1.1', text: 'Leak', parentId: b.result.id });
    expect(childOfForeign.status).toBe(400);
    expect(childOfForeign.body.message).toMatch(/parentId/);

    const moveUnderForeign = await request(app)
      .patch(`/api/results/${a.result.id}`)
      .set('Authorization', a.adminAuth)
      .send({ parentId: b.result.id });
    expect(moveUnderForeign.status).toBe(400);

    const unknownLibrary = await request(app)
      .patch(`/api/indicators/${a.indicator.id}`)
      .set('Authorization', a.adminAuth)
      .send({ libraryId: 'ZZ-99' });
    expect(unknownLibrary.status).toBe(400);
    expect(unknownLibrary.body.message).toMatch(/libraryId/);

    const createUnknownLibrary = await request(app)
      .post(`/api/frameworks/${a.framework.id}/indicators`)
      .set('Authorization', a.adminAuth)
      .send({ indicatorText: 'Library leak', libraryId: 'ZZ-99' });
    expect(createUnknownLibrary.status).toBe(400);

    const indicatorA = await prisma.indicator.findUniqueOrThrow({ where: { id: a.indicator.id } });
    expect(indicatorA.resultId).toBe(a.result.id);
    expect(indicatorA.libraryId).toBeNull();
    expect((await prisma.resultNode.findUniqueOrThrow({ where: { id: a.result.id } })).parentId).toBeNull();
    expect(await prisma.indicator.count({ where: { frameworkId: a.framework.id } })).toBe(1);
    expect(await prisma.resultNode.count({ where: { frameworkId: a.framework.id } })).toBe(1);
    expect(await prisma.resultNode.count({ where: { frameworkId: b.framework.id } })).toBe(1);
  });

  it('does not let an org admin grant the platform admin role', async () => {
    const invite = await request(app)
      .post('/api/users/invite')
      .set('Authorization', a.adminAuth)
      .send({ email: 'new@example.org', fullName: 'New', role: 'platform_admin' });
    expect(invite.status).toBe(403);

    const promote = await request(app)
      .patch(`/api/users/${a.officer.id}`)
      .set('Authorization', a.adminAuth)
      .send({ role: 'platform_admin' });
    expect(promote.status).toBe(403);
  });
});
