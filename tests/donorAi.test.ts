import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real AI services: tests/setup.ts replaces them for the route tests, so a route that called one would go
// unnoticed there. Here only the Anthropic SDK is fake, and it records every request that reaches it.
vi.unmock('../src/services/ai/documentParser');
vi.unmock('../src/services/ai/frameworkGenerator');
vi.unmock('../src/services/ai/qualitativeCoder');
vi.unmock('../src/services/ai/reportNarrative');
vi.unmock('../src/services/ai/assessmentGenerator');
vi.unmock('../src/services/ai/riskAnalyzer');

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { configureAiClientForTests, resetAiClientForTests, type AiSdkClient } from '../src/services/ai/client';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';
import { ROLE_MATRIX } from './roleMatrix';

/**
 * No request a donor viewer can make reaches an AI model (docs/SECURITY_SETUP.md §8.2). tests/roles.test.ts
 * checks the guards of the known AI routes; this test does not rely on knowing which routes call a model: it
 * calls every route open to donor viewers ('all' and 'self' in ROLE_MATRIX) with real ids, through the real
 * services, and checks that the model client was never called.
 */

const modelRequests: string[] = [];
const record = async (body: { model?: unknown }) => {
  modelRequests.push(String(body?.model));
  throw new Error('No model is reachable in this test');
};
const fakeSdk: AiSdkClient = { messages: { create: record }, beta: { messages: { create: record } } };

type Fixture = OrgFixture & { notificationId: string };

/** A request for every route open to donor viewers (method, path). */
const DONOR_ROUTES: Record<string, (f: Fixture) => string> = {
  'get /api/organizations/:id': f => `/api/organizations/${f.org.id}`,
  'get /api/projects/': () => '/api/projects',
  'get /api/projects/:id': f => `/api/projects/${f.project.id}`,
  'get /api/projects/:id/export': f => `/api/projects/${f.project.id}/export`,
  'get /api/projects/:id/documents': f => `/api/projects/${f.project.id}/documents`,
  'get /api/documents/:id/download': f => `/api/documents/${f.document.id}/download`,
  'get /api/documents/:id/status': f => `/api/documents/${f.document.id}/status`,
  'get /api/projects/:id/framework': f => `/api/projects/${f.project.id}/framework`,
  'get /api/frameworks/:id/status': f => `/api/frameworks/${f.framework.id}/status`,
  'get /api/frameworks/:id/indicators': f => `/api/frameworks/${f.framework.id}/indicators`,
  'get /api/frameworks/:id/results': f => `/api/frameworks/${f.framework.id}/results`,
  'get /api/projects/:id/assessments': f => `/api/projects/${f.project.id}/assessments`,
  'get /api/assessments/:id/report': f => `/api/assessments/${f.assessment.id}/report`,
  'get /api/assessments/:id/estimate': f => `/api/assessments/${f.assessment.id}/estimate`,
  'get /api/indicators/:id/data': f => `/api/indicators/${f.indicator.id}/data`,
  'get /api/projects/:id/qualitative': f => `/api/projects/${f.project.id}/qualitative`,
  'get /api/qualitative/:id': f => `/api/qualitative/${f.qualitative.id}`,
  'get /api/projects/:id/reports': f => `/api/projects/${f.project.id}/reports`,
  'get /api/reports/:id': f => `/api/reports/${f.report.id}`,
  'get /api/reports/:id/status': f => `/api/reports/${f.report.id}/status`,
  'get /api/dashboard/projects/:id/dashboard': f => `/api/dashboard/projects/${f.project.id}/dashboard`,
  'get /api/dashboard/overview': () => '/api/dashboard/overview',
  'get /api/notifications/': () => '/api/notifications',
  'patch /api/notifications/:id/read': f => `/api/notifications/${f.notificationId}/read`,
  'patch /api/notifications/read-all': () => '/api/notifications/read-all',
  'get /api/templates/': () => '/api/templates',
  'get /api/projects/:id/beneficiaries/stats': f => `/api/projects/${f.project.id}/beneficiaries/stats`,
  'get /api/projects/:id/export/indicators': f => `/api/projects/${f.project.id}/export/indicators`,
  'get /api/indicator-library/': () => '/api/indicator-library',
  'get /api/indicator-library/:id': () => '/api/indicator-library/NOT-A-LIBRARY-ID',
};

describe('routes open to donor viewers', () => {
  it('are all listed here', () => {
    const open = Object.entries(ROLE_MATRIX).filter(([, access]) => access === 'all' || access === 'self').map(([key]) => key);
    expect(Object.keys(DONOR_ROUTES).sort()).toEqual(open.sort());
  });
});

describe.skipIf(!hasTestDatabase)('no donor request reaches an AI model', () => {
  let f: Fixture;

  beforeAll(async () => {
    await resetDatabase();
    const fixture = await createOrgFixture('a');
    // Everything an AI feature would act on: an approved framework with an off-track indicator (risk analysis),
    // a delivered assessment, a report and a document waiting for analysis.
    await prisma.framework.update({ where: { id: fixture.framework.id }, data: { status: 'approved' } });
    await prisma.indicator.update({ where: { id: fixture.indicator.id }, data: { status: 'off_track', targetValue: '100', currentValue: '10' } });
    await prisma.assessment.update({ where: { id: fixture.assessment.id }, data: { status: 'delivered' } });
    const notification = await prisma.notification.create({
      data: { userId: fixture.donor.id, type: 'report_generated', title: 'Report ready', message: 'A report is ready.' },
    });
    f = { ...fixture, notificationId: notification.id };
    configureAiClientForTests({ anthropic: fakeSdk, sleep: async () => undefined });
  });

  afterAll(() => {
    resetAiClientForTests();
  });

  it.each(Object.keys(DONOR_ROUTES).map(key => [key]))('%s', async key => {
    const method = key.split(' ')[0] as 'get' | 'patch';
    const before = modelRequests.length;
    const res = await request(app)[method](DONOR_ROUTES[key](f)).set('Authorization', f.donorAuth);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    // Work a route starts without waiting for it (a background job) gets time to reach the client.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(modelRequests.length).toBe(before);
  });

  it('would notice a model call: the same fixture reaches the model on a staff AI route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = modelRequests.length;
    const res = await request(app).get(`/api/dashboard/projects/${f.project.id}/risks`).set('Authorization', f.officerAuth);
    expect(res.status).toBe(200);
    expect(modelRequests.length).toBeGreaterThan(before);
  });
});
