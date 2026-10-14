import request from 'supertest';
import { UserRole } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The risk analyser itself is loaded with vi.importActual below (setup.ts mocks it for the routes); its model call
// goes to this mock, never to the SDK.
const mocks = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../src/services/ai/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/ai/client')>()),
  generateStructured: mocks.generateStructured,
}));

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { analyzeProjectRisks } from '../src/services/ai/riskAnalyzer';
import { canSeeIndicator, dataPointVisibilityWhere, indicatorVisibilityWhere } from '../src/services/indicators/visibility';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

/**
 * Donor viewers see approved indicators only, never raw suggestions or unreviewed AI indicators
 * (knowledge/kpi-assistant-spec.md §A1; design section 4.7). The frameworks.ts cases are implemented by E5.
 */

const ROLES = Object.values(UserRole);

describe('visibility rule (src/services/indicators/visibility.ts)', () => {
  it('donor viewers get the approved-only filter; every other role gets none', () => {
    expect(indicatorVisibilityWhere({ role: 'donor_viewer' })).toEqual({ isApproved: true });
    for (const role of ROLES.filter(r => r !== 'donor_viewer')) {
      expect(indicatorVisibilityWhere({ role })).toEqual({});
    }
  });

  it('data points: of approved indicators for donor viewers, no condition (no join) for every other role', () => {
    expect(dataPointVisibilityWhere({ role: 'donor_viewer' })).toEqual({ indicator: { isApproved: true } });
    for (const role of ROLES.filter(r => r !== 'donor_viewer')) {
      expect(dataPointVisibilityWhere({ role })).toEqual({});
    }
  });

  it('canSeeIndicator: every role sees an approved indicator; only donor viewers are refused an unapproved one', () => {
    for (const role of ROLES) {
      expect(canSeeIndicator({ role }, { isApproved: true })).toBe(true);
      expect(canSeeIndicator({ role }, { isApproved: false })).toBe(role !== 'donor_viewer');
    }
  });

  it('fails closed without a user (a route that forgot authenticate shows approved indicators only)', () => {
    expect(indicatorVisibilityWhere(undefined)).toEqual({ isApproved: true });
    expect(dataPointVisibilityWhere(undefined)).toEqual({ indicator: { isApproved: true } });
    expect(canSeeIndicator(undefined, { isApproved: false })).toBe(false);
    expect(canSeeIndicator(undefined, { isApproved: true })).toBe(true);
  });

  it('denies by default: a missing, empty or unknown role sees approved indicators only (hasStaffRole, src/middleware/roles.ts)', () => {
    for (const user of [{}, { role: undefined }, { role: '' }, { role: 'admin' }, { role: 'ORG_ADMIN' }, null]) {
      expect(indicatorVisibilityWhere(user)).toEqual({ isApproved: true });
      expect(dataPointVisibilityWhere(user)).toEqual({ indicator: { isApproved: true } });
      expect(canSeeIndicator(user, { isApproved: false })).toBe(false);
    }
  });

  it('agrees with itself: the where filter keeps exactly the indicators canSeeIndicator allows', () => {
    const indicators = [{ isApproved: true }, { isApproved: false }];
    for (const user of [...ROLES.map(role => ({ role })), undefined]) {
      const where = indicatorVisibilityWhere(user);
      const kept = indicators.filter(ind => where.isApproved === undefined || ind.isApproved === where.isApproved);
      expect(kept).toEqual(indicators.filter(ind => canSeeIndicator(user, ind)));
    }
  });
});

describe.skipIf(!hasTestDatabase)('donor viewers see approved indicators only (routes)', () => {
  let fx: OrgFixture;
  /** Approved, at risk, with a data point in Hebron. */
  let approved: { id: string; indicatorText: string };
  let approvedPoint: { id: string };
  /** Accepted from a KPI suggestion into the framework, not yet approved (design D18). */
  let aiSuggested: { id: string; indicatorText: string };
  let services: { approved: string; unapproved: string; none: string };

  const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();
  const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);

  beforeAll(async () => {
    await resetDatabase();
    fx = await createOrgFixture('vis');
    // The fixture indicator stays unapproved; it is off track, with its data point in Gaza.
    await prisma.indicator.update({ where: { id: fx.indicator.id }, data: { status: 'off_track', isApproved: false } });
    await prisma.dataPoint.update({ where: { id: fx.dataPoint.id }, data: { geographicArea: 'Gaza' } });
    approved = await prisma.indicator.create({
      data: {
        frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'Approved indicator (visibility)', level: 'outcome',
        dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline'], isApproved: true, status: 'at_risk', sortOrder: 1,
      },
    });
    approvedPoint = await prisma.dataPoint.create({
      data: {
        indicatorId: approved.id, projectId: fx.project.id, value: '20', collectionDate: new Date('2026-04-01'),
        collectionMethod: 'hh_survey', geographicArea: 'Hebron', createdBy: fx.officer.id,
      },
    });
    aiSuggested = await prisma.indicator.create({
      data: {
        frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'AI-suggested indicator awaiting approval', level: 'outcome',
        dataCollectionMethod: 'observation', frequency: 'biannual', phases: [], provenance: 'ai_suggested', aiModel: 'claude-sonnet-5-5',
        promptVersion: 'kpi-v2', status: 'off_track', sortOrder: 2,
      },
    });
    const service = (indicatorId: string | null, day: string) => prisma.beneficiaryService.create({
      data: {
        beneficiaryId: fx.beneficiary.id, projectId: fx.project.id, serviceType: 'training', dateProvided: new Date(day),
        quantity: 1, unit: 'session', indicatorId,
      },
    });
    services = {
      approved: (await service(approved.id, '2026-05-03')).id,
      unapproved: (await service(fx.indicator.id, '2026-05-02')).id,
      none: (await service(null, '2026-05-01')).id,
    };
  });

  describe('projects.ts', () => {
    it('GET /api/projects/:id lists the current framework\'s approved indicators only for a donor viewer', async () => {
      const donor = await get(`/api/projects/${fx.project.id}`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(ids(donor.body.frameworks[0].indicators)).toEqual([approved.id]);

      const officer = await get(`/api/projects/${fx.project.id}`, fx.officerAuth);
      expect(ids(officer.body.frameworks[0].indicators)).toEqual(ids([fx.indicator, approved, aiSuggested]));
    });

    it('GET /api/projects/:id/export holds approved indicators (with their data points) only for a donor viewer', async () => {
      const donor = await get(`/api/projects/${fx.project.id}/export`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(donor.body.indicators.map((i: { indicatorId: string }) => i.indicatorId)).toEqual([approved.id]);
      expect(donor.body.indicators[0].dataPoints.map((dp: { id: string }) => dp.id)).toEqual([approvedPoint.id]);
      expect(JSON.stringify(donor.body.indicators)).not.toContain(aiSuggested.indicatorText);
      // The results chain is not filtered.
      expect(donor.body.frameworks[0].resultNodes.map((n: { id: string }) => n.id)).toEqual([fx.result.id]);

      const officer = await get(`/api/projects/${fx.project.id}/export`, fx.officerAuth);
      expect(officer.body.indicators.map((i: { indicatorId: string }) => i.indicatorId).sort())
        .toEqual(ids([fx.indicator, approved, aiSuggested]));
    });
  });

  describe('exports.ts', () => {
    it('GET /api/projects/:id/export/indicators holds approved indicators only for a donor viewer', async () => {
      const donor = await get(`/api/projects/${fx.project.id}/export/indicators`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(donor.body.indicators.map((i: { indicator: string }) => i.indicator)).toEqual([approved.indicatorText]);
      expect(donor.body.indicators[0].dataPoints).toHaveLength(1);

      const officer = await get(`/api/projects/${fx.project.id}/export/indicators`, fx.officerAuth);
      expect(officer.body.indicators).toHaveLength(3);
    });
  });

  describe('dashboard.ts', () => {
    it('project dashboard: counts, trends, geographic data and recent activity come from approved indicators only', async () => {
      const donor = await get(`/api/dashboard/projects/${fx.project.id}/dashboard`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(donor.body.framework.totalIndicators).toBe(1);
      expect(donor.body.indicatorStatus).toEqual({ on_track: 0, at_risk: 1, off_track: 0, not_started: 0, completed: 0 });
      expect(donor.body.indicatorLevels).toEqual({ impact: 0, outcome: 1, output: 0, activity: 0 });
      expect(donor.body.trends.map((t: { indicatorId: string }) => t.indicatorId)).toEqual([approved.id]);
      // Donors get listed places with their Arabic name (src/services/privacy/places.ts).
      expect(donor.body.geographic.map((g: { area: string; dataPointCount: number }) => [g.area, g.dataPointCount])).toEqual([['Hebron', 1]]);
      // Recent activity: data points of unapproved indicators are left out.
      expect(ids(donor.body.recentActivity)).toEqual([approvedPoint.id]);
      expect(donor.body.recentActivity[0].indicator).toEqual({ indicatorText: approved.indicatorText });

      const officer = await get(`/api/dashboard/projects/${fx.project.id}/dashboard`, fx.officerAuth);
      expect(officer.body.framework.totalIndicators).toBe(3);
      expect(officer.body.indicatorStatus.off_track).toBe(2);
      expect(ids(officer.body.recentActivity)).toEqual(ids([fx.dataPoint, approvedPoint]));
      expect(officer.body.geographic.map((g: { area: string }) => g.area).sort()).toEqual(['Gaza', 'Hebron']);
    });

    it('overview: indicator counts and off-track alerts from approved indicators only', async () => {
      const donor = await get('/api/dashboard/overview', fx.donorAuth);
      expect(donor.status).toBe(200);
      const donorProject = donor.body.projects.find((p: { id: string }) => p.id === fx.project.id);
      expect(donorProject.totalIndicators).toBe(1);
      expect(donorProject.indicatorStatus).toEqual({ on_track: 0, at_risk: 1, off_track: 0, not_started: 0, completed: 0 });
      expect(donor.body.alerts).toEqual([]);

      const officer = await get('/api/dashboard/overview', fx.officerAuth);
      const officerProject = officer.body.projects.find((p: { id: string }) => p.id === fx.project.id);
      expect(officerProject.totalIndicators).toBe(3);
      expect(officer.body.alerts.map((a: { indicatorId: string }) => a.indicatorId).sort()).toEqual(ids([fx.indicator, aiSuggested]));
    });

    // The donor-data-access PR closes the AI risk analysis to donor viewers (403), which supersedes the Phase 4
    // approved-only donor analysis (design SDA-06; docs/SECURITY_SETUP.md §8.2).
    describe('GET /api/dashboard/projects/:id/risks', () => {
      beforeEach(() => vi.mocked(analyzeProjectRisks).mockClear());

      it('refuses a donor viewer (403) before any analysis runs', async () => {
        const res = await get(`/api/dashboard/projects/${fx.project.id}/risks`, fx.donorAuth);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
        expect(analyzeProjectRisks).not.toHaveBeenCalled();
      });

      it('officers and admins get the analysis of every indicator of the current framework', async () => {
        await get(`/api/dashboard/projects/${fx.project.id}/risks`, fx.officerAuth).expect(200);
        await get(`/api/dashboard/projects/${fx.project.id}/risks`, fx.adminAuth).expect(200);
        expect(vi.mocked(analyzeProjectRisks).mock.calls).toEqual([[fx.project.id], [fx.project.id]]);
      });
    });
  });

  describe('dataPoints.ts', () => {
    it('GET /api/indicators/:id/data answers 404 to a donor viewer for an unapproved indicator', async () => {
      for (const hidden of [fx.indicator, aiSuggested]) {
        const res = await get(`/api/indicators/${hidden.id}/data`, fx.donorAuth);
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Indicator not found');
      }
    });

    it('serves an approved indicator to a donor viewer and every indicator to an officer', async () => {
      const donor = await get(`/api/indicators/${approved.id}/data`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(ids(donor.body.dataPoints)).toEqual([approvedPoint.id]);

      const officer = await get(`/api/indicators/${fx.indicator.id}/data`, fx.officerAuth);
      expect(officer.status).toBe(200);
      expect(ids(officer.body.dataPoints)).toEqual([fx.dataPoint.id]);
    });
  });

  // Beneficiary records are staff only since the donor-data-access PR (docs/SECURITY_SETUP.md §8.3): donor viewers
  // get 403 on the list and the detail, so no service of an unapproved indicator can reach them there.
  describe('beneficiaries.ts', () => {
    it('GET /api/beneficiaries/:id and the list refuse a donor viewer (403)', async () => {
      for (const path of [`/api/beneficiaries/${fx.beneficiary.id}`, `/api/projects/${fx.project.id}/beneficiaries`]) {
        const donor = await get(path, fx.donorAuth);
        expect(donor.status, path).toBe(403);
        expect(JSON.stringify(donor.body)).not.toContain(fx.indicator.indicatorText);
      }
    });

    it('names each service\'s indicator by id and text only', async () => {
      const officer = await get(`/api/beneficiaries/${fx.beneficiary.id}`, fx.officerAuth);
      expect(officer.body.services.map((s: { id: string }) => s.id)).toEqual([services.approved, services.unapproved, services.none]);
      expect(officer.body.services[1].indicator).toEqual({ id: fx.indicator.id, indicatorText: fx.indicator.indicatorText });
      for (const service of officer.body.services) {
        if (service.indicator) expect(Object.keys(service.indicator).sort()).toEqual(['id', 'indicatorText']);
      }
    });

    it('GET /api/projects/:id/beneficiaries gives staff every service', async () => {
      const officer = await get(`/api/projects/${fx.project.id}/beneficiaries`, fx.officerAuth);
      const all = officer.body.beneficiaries.find((b: { id: string }) => b.id === fx.beneficiary.id);
      expect(all.services).toHaveLength(3);
    });
  });

  // Implemented by E5 in src/routes/frameworks.ts (design section 4.7); written first by E1.
  describe('frameworks.ts', () => {
    it('GET /api/projects/:id/framework lists approved indicators only for a donor viewer (results and their counts unfiltered)', async () => {
      const donor = await get(`/api/projects/${fx.project.id}/framework`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(ids(donor.body.indicators)).toEqual([approved.id]);
      expect(donor.body.resultNodes.map((n: { id: string }) => n.id)).toEqual([fx.result.id]);
      // Documented: `_count.indicators` on result nodes is not filtered.
      expect(donor.body.resultNodes[0]._count.indicators).toBe(3);

      const officer = await get(`/api/projects/${fx.project.id}/framework`, fx.officerAuth);
      expect(ids(officer.body.indicators)).toEqual(ids([fx.indicator, approved, aiSuggested]));
    });

    it('GET /api/frameworks/:id/indicators lists approved indicators only for a donor viewer', async () => {
      const donor = await get(`/api/frameworks/${fx.framework.id}/indicators`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(ids(donor.body)).toEqual([approved.id]);

      const officer = await get(`/api/frameworks/${fx.framework.id}/indicators`, fx.officerAuth);
      expect(officer.body).toHaveLength(3);
    });

    it('GET /api/frameworks/:id/status: same status for every role, approved indicators only in a donor viewer\'s framework', async () => {
      const donor = await get(`/api/frameworks/${fx.framework.id}/status`, fx.donorAuth);
      expect(donor.status).toBe(200);
      expect(donor.body.status).toBe('completed');
      expect(ids(donor.body.framework.indicators)).toEqual([approved.id]);

      const officer = await get(`/api/frameworks/${fx.framework.id}/status`, fx.officerAuth);
      expect(officer.body.status).toBe('completed');
      expect(officer.body.framework.indicators).toHaveLength(3);
    });

    it('a framework whose indicators are all unapproved is still "completed" for a donor viewer, with no indicators', async () => {
      const project = await prisma.project.create({
        data: {
          organizationId: fx.org.id, name: 'Project vis draft', sector: 'health', donor: 'EU', donorType: 'eu',
          startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
        },
      });
      const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
      await prisma.indicator.create({
        data: {
          frameworkId: framework.id, indicatorText: 'Draft indicator (visibility)', level: 'output',
          dataCollectionMethod: 'document_review', frequency: 'monthly', phases: [],
        },
      });

      const donor = await get(`/api/frameworks/${framework.id}/status`, fx.donorAuth);
      expect(donor.body.status).toBe('completed');
      expect(donor.body.framework.indicators).toEqual([]);
      const officer = await get(`/api/frameworks/${framework.id}/status`, fx.officerAuth);
      expect(officer.body.status).toBe('completed');
      expect(officer.body.framework.indicators).toHaveLength(1);
    });

    it('an accepted AI-suggested indicator stays hidden from donor viewers until an org admin approves it (D18)', async () => {
      const before = await get(`/api/projects/${fx.project.id}/framework`, fx.donorAuth);
      expect(ids(before.body.indicators)).not.toContain(aiSuggested.id);

      await request(app).patch(`/api/indicators/${aiSuggested.id}/approve`).set('Authorization', fx.adminAuth).expect(200);
      try {
        const after = await get(`/api/projects/${fx.project.id}/framework`, fx.donorAuth);
        expect(ids(after.body.indicators)).toEqual(ids([approved, aiSuggested]));
        expect((await get(`/api/indicators/${aiSuggested.id}/data`, fx.donorAuth)).status).toBe(200);
      } finally {
        await prisma.indicator.update({ where: { id: aiSuggested.id }, data: { isApproved: false } });
      }
    });
  });
});

describe.skipIf(!hasTestDatabase)('analyzeProjectRisks is a staff tool with no donor option (src/services/ai/riskAnalyzer.ts; TQ-08)', () => {
  let projectId: string;
  let approvedId: string;
  let unapprovedId: string;
  type RiskModule = typeof import('../src/services/ai/riskAnalyzer');
  let realAnalyze: RiskModule['analyzeProjectRisks'];

  /** Everything the model would receive in the user message. */
  const sentPrompt = () => mocks.generateStructured.mock.calls.map(call => call[0].messages[0].content).join('\n');

  beforeAll(async () => {
    ({ analyzeProjectRisks: realAnalyze } = await vi.importActual<RiskModule>('../src/services/ai/riskAnalyzer'));
    await resetDatabase();
    const fx = await createOrgFixture('risk');
    projectId = fx.project.id;
    // An approved framework with an approved off-track indicator, and an unapproved at-risk indicator added after
    // approval (as an accepted KPI suggestion would be).
    await prisma.framework.update({ where: { id: fx.framework.id }, data: { status: 'approved', approvedAt: new Date() } });
    await prisma.indicator.update({
      where: { id: fx.indicator.id },
      data: { isApproved: true, status: 'off_track', indicatorText: 'Approved off-track indicator (risk)' },
    });
    approvedId = fx.indicator.id;
    unapprovedId = (await prisma.indicator.create({
      data: {
        frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'Unapproved at-risk indicator (risk)', level: 'outcome',
        dataCollectionMethod: 'observation', frequency: 'biannual', phases: [], provenance: 'ai_suggested', status: 'at_risk', sortOrder: 1,
      },
    })).id;
  });

  beforeEach(() => {
    mocks.generateStructured.mockReset();
    mocks.generateStructured.mockResolvedValue({ data: { risks: [] } });
  });

  it('analyses every at-risk indicator, approved or not, and takes no donor option (the route refuses donor viewers)', async () => {
    expect((await realAnalyze(projectId)).map(r => r.indicatorId)).toEqual([approvedId, unapprovedId]);
    expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
    expect(sentPrompt()).toContain(approvedId);
    expect(sentPrompt()).toContain(unapprovedId);
    // The donor-only approvedOnly branch is gone (SDA-06 superseded by the donor-access PR): one parameter, the project.
    expect(realAnalyze.length).toBe(1);
  });

  it('returns [] without a model call when nothing is at risk', async () => {
    await prisma.indicator.updateMany({ where: { id: { in: [approvedId, unapprovedId] } }, data: { status: 'on_track' } });
    try {
      expect(await realAnalyze(projectId)).toEqual([]);
      expect(mocks.generateStructured).not.toHaveBeenCalled();
    } finally {
      await prisma.indicator.update({ where: { id: approvedId }, data: { status: 'off_track' } });
      await prisma.indicator.update({ where: { id: unapprovedId }, data: { status: 'at_risk' } });
    }
  });
});

