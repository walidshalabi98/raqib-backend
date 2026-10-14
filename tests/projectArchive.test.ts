import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { assertProjectWritable, PROJECT_ARCHIVED_MESSAGE } from '../src/middleware/access';
import { AppError } from '../src/middleware/errorHandler';
import {
  archiveAuditAction, confirmNameMatches, derivedRestoreStatus, projectAuditTarget, statusBeforeArchive,
} from '../src/services/projects/lifecycle';
import { parseProjectUpdate } from '../src/services/projects/validation';
import { buildDocumentKey, getLocalStorage, getStorage } from '../src/services/storage';
import { bearer, createOrgFixture, hasTestDatabase, OrgFixture, PDF_BYTES, resetDatabase } from './helpers';
import { routeLayers } from './routeStack';

/**
 * Archive, restore and delete forever (owner decision of 13 October 2026; docs/SECURITY_SETUP.md §8,
 * docs/DATA_MODEL.md §5): archived projects are hidden from the list and read-only, can be restored to the
 * status they had; a permanent delete removes every row of the project in one transaction, then its files.
 */

const ARCHIVED = { message: PROJECT_ARCHIVED_MESSAGE, code: 'project_archived' };

describe('confirmNameMatches', () => {
  it('accepts the exact name, ignoring spaces around either', () => {
    expect(confirmNameMatches('Water for Gaza', 'Water for Gaza')).toBe(true);
    expect(confirmNameMatches('  Water for Gaza\n', 'Water for Gaza')).toBe(true);
    expect(confirmNameMatches('Water for Gaza', ' Water for Gaza ')).toBe(true);
    expect(confirmNameMatches('مياه غزة', 'مياه غزة')).toBe(true);
  });

  it('refuses other capitals, extra or missing text, and anything but text', () => {
    for (const typed of ['water for gaza', 'WATER FOR GAZA', 'Water for Gaza 2', 'Water for', 'Water  for Gaza', '', '   ', null, undefined, 42, ['Water for Gaza'], { name: 'Water for Gaza' }]) {
      expect(confirmNameMatches(typed, 'Water for Gaza'), JSON.stringify(typed)).toBe(false);
    }
  });
});

describe('statusBeforeArchive', () => {
  it('reads a project status from an archive audit row', () => {
    expect(statusBeforeArchive({ status: 'active' })).toBe('active');
    expect(statusBeforeArchive({ status: 'completed', other: 1 })).toBe('completed');
  });

  it('ignores anything that is not a status a project can be restored to', () => {
    for (const value of [null, undefined, 'active', ['active'], {}, { status: 'archived' }, { status: 'paused' }, { status: 3 }]) {
      expect(statusBeforeArchive(value as never), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('derivedRestoreStatus', () => {
  it('is active with an approved framework, framework_review with any framework, else setup', () => {
    expect(derivedRestoreStatus([])).toBe('setup');
    expect(derivedRestoreStatus([{ status: 'draft' }])).toBe('framework_review');
    expect(derivedRestoreStatus([{ status: 'client_review' }, { status: 'expert_review' }])).toBe('framework_review');
    expect(derivedRestoreStatus([{ status: 'draft' }, { status: 'approved' }])).toBe('active');
    expect(derivedRestoreStatus([{ status: 'active' }])).toBe('active');
  });
});

describe('assertProjectWritable', () => {
  const req = (method: string) => ({ method }) as Request;

  it('refuses every write to an archived project with 409 project_archived', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'TRACE']) {
      const error = (() => { try { assertProjectWritable(req(method), { status: 'archived' }); } catch (err) { return err; } })();
      expect(error, method).toBeInstanceOf(AppError);
      expect(error, method).toMatchObject({ statusCode: 409, ...ARCHIVED });
    }
  });

  it('allows reads of an archived project, and every request to a project that is not archived', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(() => assertProjectWritable(req(method), { status: 'archived' })).not.toThrow();
    for (const status of ['setup', 'framework_review', 'active', 'completed'] as const) {
      expect(() => assertProjectWritable(req('DELETE'), { status })).not.toThrow();
    }
  });
});

describe('PATCH /api/projects/:id status', () => {
  it('cannot archive a project (archiving is its own admin route)', () => {
    const stored = { sector: 'education', sectors: ['education'], startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') } as const;
    const result = parseProjectUpdate({ status: 'archived' }, { ...stored, sectors: [...stored.sectors] });
    expect(result).toEqual({ ok: false, errors: ['status cannot be set to archived here: archive the project instead'] });
    expect(parseProjectUpdate({ status: 'completed' }, { ...stored, sectors: [...stored.sectors] })).toEqual({ ok: true, data: { status: 'completed' } });
  });
});

/** Project-owned resources by the path segment before `:id`, so every write route can be called on the fixture. */
type IdOf = (f: OrgFixture) => string;
const ID_BY_SEGMENT: Record<string, IdOf> = {
  projects: f => f.project.id,
  frameworks: f => f.framework.id,
  results: f => f.result.id,
  indicators: f => f.indicator.id,
  documents: f => f.document.id,
  assessments: f => f.assessment.id,
  qualitative: f => f.qualitative.id,
  reports: f => f.report.id,
  beneficiaries: f => f.beneficiary.id,
};
/** Routes with an id that are not project-owned. */
const NOT_PROJECT_OWNED = /^\/api\/(organizations|users|notifications|templates|indicator-library)\//;
/** The only writes to an archived project that are not refused with project_archived. */
const EXEMPT = new Set(['post /api/projects/:id/restore', 'delete /api/projects/:id', 'post /api/projects/:id/archive']);

function projectOwnedRoutes() {
  return routeLayers(app)
    .filter(r => r.path.includes(':id') && !NOT_PROJECT_OWNED.test(r.path))
    .map(r => {
      const segments = r.path.split('/');
      const resource = segments[segments.indexOf(':id') - 1];
      return { ...r, resource };
    });
}

function pathFor(route: { path: string; resource: string }, f: OrgFixture): string {
  const idOf = ID_BY_SEGMENT[route.resource];
  if (!idOf) throw new Error(`No fixture id for ${route.path}: add its resource to ID_BY_SEGMENT`);
  return route.path.replace(':id', idOf(f));
}

async function makeProject(org: OrgFixture, name: string, status: 'setup' | 'framework_review' | 'active' | 'completed' | 'archived' = 'active') {
  return prisma.project.create({
    data: {
      organizationId: org.org.id, name, sector: 'health', donor: 'ECHO', donorType: 'echo', status,
      startDate: new Date('2026-01-01'), endDate: new Date('2027-06-30'),
    },
  });
}

const auditRows = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: { timestamp: 'asc' } });

/** The audit middleware writes its rows when the response finishes: give it time, then read. */
async function settledAuditRows(entityId: string, atLeast: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await auditRows(entityId);
    if (rows.length >= atLeast) {
      await new Promise(resolve => setTimeout(resolve, 150));
      return auditRows(entityId);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`audit rows for ${entityId} did not appear`);
}

describe.skipIf(!hasTestDatabase)('archive, restore and delete forever', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let platformAuth: string;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    const platformAdmin = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'platform-a@example.org', passwordHash: 'x', fullName: 'Platform A', role: 'platform_admin' },
    });
    platformAuth = bearer(platformAdmin);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('project list', () => {
    it('hides archived projects by default and lists only them with ?archived=true, for every role', async () => {
      const shelved = await makeProject(a, 'List: shelved', 'archived');
      const running = await makeProject(a, 'List: running', 'completed');
      for (const auth of [a.adminAuth, a.officerAuth, a.donorAuth]) {
        const current = await request(app).get('/api/projects').set('Authorization', auth);
        expect(current.status).toBe(200);
        const currentIds = current.body.map((p: { id: string }) => p.id);
        expect(currentIds).toEqual(expect.arrayContaining([a.project.id, running.id]));
        expect(currentIds).not.toContain(shelved.id);
        expect(current.body.every((p: { status: string }) => p.status !== 'archived')).toBe(true);

        const archived = await request(app).get('/api/projects?archived=true').set('Authorization', auth);
        expect(archived.status).toBe(200);
        expect(archived.body.map((p: { id: string }) => p.id)).toEqual([shelved.id]);
        // Same shape as the default list: the project with its counts.
        expect(archived.body[0]).toMatchObject({ id: shelved.id, name: 'List: shelved', status: 'archived', _count: expect.any(Object) });
      }
      await prisma.project.deleteMany({ where: { id: { in: [shelved.id, running.id] } } });
    });

    it('treats any other value of archived as false', async () => {
      const shelved = await makeProject(a, 'List: other values', 'archived');
      for (const query of ['archived=TRUE', 'archived=1', 'archived=yes', 'archived=false', 'archived=', 'archived=true&archived=true', 'archived[]=true']) {
        const res = await request(app).get(`/api/projects?${query}`).set('Authorization', a.adminAuth);
        expect(res.status, query).toBe(200);
        expect(res.body.map((p: { id: string }) => p.id), query).not.toContain(shelved.id);
        expect(res.body.map((p: { id: string }) => p.id), query).toContain(a.project.id);
      }
      await prisma.project.delete({ where: { id: shelved.id } });
    });

    it('keeps the donor counting rules for archived projects, and never lists another organisation\'s', async () => {
      const shelved = await makeProject(a, 'List: donor counts', 'archived');
      const framework = await prisma.framework.create({ data: { projectId: shelved.id } });
      const indicator = await prisma.indicator.create({
        data: { frameworkId: framework.id, indicatorText: 'Counted', level: 'output', dataCollectionMethod: 'hh_survey', frequency: 'monthly', phases: [] },
      });
      await prisma.dataPoint.createMany({
        data: [
          { indicatorId: indicator.id, projectId: shelved.id, value: '1', collectionDate: new Date('2026-02-01'), collectionMethod: 'hh_survey', createdBy: a.officer.id },
          { indicatorId: indicator.id, projectId: shelved.id, value: '1', collectionDate: new Date('2026-02-01'), collectionMethod: 'hh_survey', dataSource: 'KoboToolbox', createdBy: a.officer.id },
        ],
      });
      const staff = await request(app).get('/api/projects?archived=true').set('Authorization', a.adminAuth);
      const donor = await request(app).get('/api/projects?archived=true').set('Authorization', a.donorAuth);
      expect(staff.body.find((p: { id: string }) => p.id === shelved.id)._count.dataPoints).toBe(2);
      expect(donor.body.find((p: { id: string }) => p.id === shelved.id)._count.dataPoints).toBe(1);

      const other = await request(app).get('/api/projects?archived=true').set('Authorization', b.adminAuth);
      expect(other.body.map((p: { id: string }) => p.id)).not.toContain(shelved.id);
      await prisma.dataPoint.deleteMany({ where: { projectId: shelved.id } });
      await prisma.indicator.deleteMany({ where: { frameworkId: framework.id } });
      await prisma.framework.delete({ where: { id: framework.id } });
      await prisma.project.delete({ where: { id: shelved.id } });
    });

    it('leaves archived projects out of the dashboard overview', async () => {
      const shelved = await makeProject(a, 'Overview: shelved', 'archived');
      const overview = await request(app).get('/api/dashboard/overview').set('Authorization', a.adminAuth);
      expect(overview.status).toBe(200);
      const ids = overview.body.projects.map((p: { id: string }) => p.id);
      expect(ids).toContain(a.project.id);
      expect(ids).not.toContain(shelved.id);
      expect(overview.body.totalProjects).toBe(ids.length);
      await prisma.project.delete({ where: { id: shelved.id } });
    });
  });

  describe('archive and restore', () => {
    it('archives a project: 200 with the project, hidden from the list, readable, one audit row with the status before', async () => {
      const project = await makeProject(a, 'Archive: happy path', 'active');
      const res = await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: project.id, name: 'Archive: happy path', status: 'archived', organizationId: a.org.id });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('archived');

      const list = await request(app).get('/api/projects').set('Authorization', a.adminAuth);
      expect(list.body.map((p: { id: string }) => p.id)).not.toContain(project.id);
      const detail = await request(app).get(`/api/projects/${project.id}`).set('Authorization', a.donorAuth);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ id: project.id, status: 'archived' });

      // One row, written with the change (no second row from the audit middleware).
      const rows = await settledAuditRows(project.id, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: a.admin.id,
        action: archiveAuditAction(project.id),
        entity: 'projects',
        entityId: project.id,
        previousValue: { status: 'active' },
        newValue: { status: 200, fields: [], values: expect.objectContaining({ id: project.id, status: 'archived', name: 'Archive: happy path' }) },
      });
    });

    it('archives from any status, and platform admins can too', async () => {
      for (const status of ['setup', 'framework_review', 'completed'] as const) {
        const project = await makeProject(a, `Archive from ${status}`, status);
        const res = await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', platformAuth);
        expect(res.status, status).toBe(200);
        expect(res.body.status).toBe('archived');
      }
    });

    it('answers 409 project_already_archived when the project is already archived, and changes nothing', async () => {
      const project = await makeProject(a, 'Archive: twice', 'completed');
      expect((await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth)).status).toBe(200);
      const again = await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth);
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ message: 'This project is already archived.', code: 'project_already_archived' });

      const rows = await settledAuditRows(project.id, 2);
      expect(rows.map(r => (r.newValue as { status: number }).status)).toEqual([200, 409]);
      // The refused attempt has no previous value, so restore still finds the status the first archive recorded.
      expect(rows[1].previousValue).toBeNull();
      const restored = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      expect(restored.body.status).toBe('completed');
    });

    it('restores the status recorded when it was archived, with an audit row', async () => {
      const project = await makeProject(a, 'Restore: recorded', 'active');
      await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth);
      const res = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: project.id, status: 'active' });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('active');

      const list = await request(app).get('/api/projects').set('Authorization', a.adminAuth);
      expect(list.body.map((p: { id: string }) => p.id)).toContain(project.id);

      const rows = await settledAuditRows(project.id, 2);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        userId: a.admin.id,
        action: `POST /api/projects/${project.id}/restore`,
        entity: 'projects',
        entityId: project.id,
        previousValue: { status: 'archived' },
        newValue: { status: 200, restoredFrom: 'archive_audit', values: expect.objectContaining({ status: 'active' }) },
      });
    });

    it('restores the status of the latest archive', async () => {
      const project = await makeProject(a, 'Restore: latest', 'framework_review');
      await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth);
      await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      const patched = await request(app).patch(`/api/projects/${project.id}`).set('Authorization', a.officerAuth).send({ status: 'completed' });
      expect(patched.status).toBe(200);
      await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', platformAuth);
      const res = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', platformAuth);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    it('without an archive audit row, derives the status from the frameworks', async () => {
      const cases: { name: string; frameworks: { status: 'draft' | 'approved' | 'active' | 'client_review'; generationError?: string }[]; expected: string }[] = [
        { name: 'no framework', frameworks: [], expected: 'setup' },
        { name: 'failed generation only', frameworks: [{ status: 'draft', generationError: 'AI generation failed' }], expected: 'setup' },
        { name: 'draft framework', frameworks: [{ status: 'draft' }], expected: 'framework_review' },
        { name: 'framework in review', frameworks: [{ status: 'client_review' }], expected: 'framework_review' },
        { name: 'approved framework', frameworks: [{ status: 'draft' }, { status: 'approved' }], expected: 'active' },
        { name: 'framework in use', frameworks: [{ status: 'active' }], expected: 'active' },
      ];
      for (const c of cases) {
        // Archived before 13 October 2026 (old DELETE or a status edit): no archive audit row.
        const project = await makeProject(a, `Derived: ${c.name}`, 'archived');
        let version = 1;
        for (const fw of c.frameworks) await prisma.framework.create({ data: { projectId: project.id, version: version++, ...fw } });
        const res = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
        expect(res.status, c.name).toBe(200);
        expect(res.body.status, c.name).toBe(c.expected);
        const rows = await settledAuditRows(project.id, 1);
        expect(rows.at(-1)?.newValue, c.name).toMatchObject({ status: 200, restoredFrom: 'derived' });
      }
    });

    it('ignores refused archive attempts when deriving (they record no previous status)', async () => {
      const project = await makeProject(a, 'Derived: refused attempt', 'archived');
      const refused = await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.officerAuth);
      expect(refused.status).toBe(403);
      await settledAuditRows(project.id, 1);
      const res = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      expect(res.body.status).toBe('setup');
    });

    it('answers 409 project_not_archived to a restore of a project that is not archived', async () => {
      const project = await makeProject(a, 'Restore: not archived', 'active');
      const res = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ message: 'This project is not archived.', code: 'project_not_archived' });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('active');
    });

    it('refuses M&E officers and donor viewers (403), and another organisation (404)', async () => {
      const project = await makeProject(a, 'Archive: roles', 'active');
      for (const auth of [a.officerAuth, a.donorAuth]) {
        for (const action of ['archive', 'restore']) {
          const res = await request(app).post(`/api/projects/${project.id}/${action}`).set('Authorization', auth);
          expect(res.status, action).toBe(403);
          expect(res.body).toEqual({ message: 'Insufficient permissions' });
        }
      }
      for (const action of ['archive', 'restore']) {
        const res = await request(app).post(`/api/projects/${project.id}/${action}`).set('Authorization', b.adminAuth);
        expect(res.status, action).toBe(404);
        expect(res.body.message).toBe('Project not found');
      }
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('active');

      await prisma.project.update({ where: { id: project.id }, data: { status: 'archived' } });
      const otherOrgRestore = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', b.adminAuth);
      expect(otherOrgRestore.status).toBe(404);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('archived');
    });

    it('does not let a project be archived through PATCH (that would skip the admin check and the record)', async () => {
      const project = await makeProject(a, 'Archive: through patch', 'active');
      for (const auth of [a.officerAuth, a.adminAuth]) {
        const res = await request(app).patch(`/api/projects/${project.id}`).set('Authorization', auth).send({ status: 'archived' });
        expect(res.status).toBe(400);
        expect(res.body.errors).toEqual(['status cannot be set to archived here: archive the project instead']);
      }
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('active');
    });

    it('records archive, restore and delete under entity projects whatever the capitals of the path, and restores the recorded status', async () => {
      // Completed, with an approved framework: the derived status would be active, the recorded one is completed.
      const project = await makeProject(a, 'Archive: other capitals', 'completed');
      await prisma.framework.create({ data: { projectId: project.id, version: 1, status: 'approved' } });
      // Express routes these paths whatever their capitals.
      const archived = await request(app).post(`/API/Projects/${project.id}/Archive`).set('Authorization', a.adminAuth);
      expect(archived.status).toBe(200);
      expect(archived.body.status).toBe('archived');
      const restored = await request(app).post(`/Api/PROJECTS/${project.id}/RESTORE`).set('Authorization', a.adminAuth);
      expect(restored.status).toBe(200);
      expect(restored.body.status).toBe('completed');
      expect((await request(app).post(`/API/projects/${project.id}/archive`).set('Authorization', a.adminAuth)).status).toBe(200);
      const deleted = await request(app).delete(`/API/PROJECTS/${project.id}`).set('Authorization', a.adminAuth).send({ confirmName: project.name });
      expect(deleted.status).toBe(200);

      const rows = await settledAuditRows(project.id, 4);
      expect(rows.map(row => ({ action: row.action, entity: row.entity, entityId: row.entityId }))).toEqual([
        projectAuditTarget('archive', project.id),
        projectAuditTarget('restore', project.id),
        projectAuditTarget('archive', project.id),
        projectAuditTarget('delete', project.id),
      ]);
      expect(rows.map(row => row.action)).toEqual([
        `POST /api/projects/${project.id}/archive`, `POST /api/projects/${project.id}/restore`,
        `POST /api/projects/${project.id}/archive`, `DELETE /api/projects/${project.id}`,
      ]);
      expect(rows[0].previousValue).toEqual({ status: 'completed' });
      expect(rows[1].newValue).toMatchObject({ status: 200, restoredFrom: 'archive_audit' });
      expect(rows[3].previousValue).toMatchObject({ name: project.name, status: 'archived' });
      // A review of the audit log by entity finds the permanent delete.
      expect(await prisma.auditLog.count({ where: { entity: 'projects', entityId: project.id, action: { startsWith: 'DELETE' } } })).toBe(1);
    });

    it('a project edit that was checked before an archive committed waits for it, then answers 409 and leaves the project archived', async () => {
      const project = await makeProject(a, 'Archive: racing edit', 'active');
      const realFindFirst = prisma.project.findFirst.bind(prisma.project) as (args: unknown) => Promise<unknown>;
      let held = false;
      let archive: request.Response | undefined;
      // The M&E officer's edit passes its access check (not archived yet); the admin's archive then commits.
      vi.spyOn(prisma.project, 'findFirst').mockImplementation((async (args: { where?: { id?: unknown } }) => {
        const found = await realFindFirst(args);
        if (!held && args?.where?.id === project.id) {
          held = true;
          archive = await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth);
        }
        return found;
      }) as never);

      const edit = await request(app).patch(`/api/projects/${project.id}`).set('Authorization', a.officerAuth).send({ status: 'completed' });
      expect(archive?.status).toBe(200);
      expect(edit.status).toBe(409);
      expect(edit.body).toEqual(ARCHIVED);
      vi.restoreAllMocks();
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('archived');
      const list = await request(app).get('/api/projects?archived=true').set('Authorization', a.adminAuth);
      expect(list.body.map((p: { id: string }) => p.id)).toContain(project.id);
      // Only restore un-archives it, to the status it had.
      const restored = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      expect(restored.body.status).toBe('active');
    });

    it('a framework approval that was checked before an archive committed waits for it, then answers 409 and changes nothing', async () => {
      const project = await makeProject(a, 'Archive: racing approval', 'framework_review');
      const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1, status: 'expert_review' } });
      const indicator = await prisma.indicator.create({
        data: { frameworkId: framework.id, indicatorText: 'Racing approval', level: 'output', dataCollectionMethod: 'hh_survey', frequency: 'monthly', phases: [] },
      });
      const realFindFirst = prisma.framework.findFirst.bind(prisma.framework) as (args: unknown) => Promise<unknown>;
      let held = false;
      let archive: request.Response | undefined;
      // The admin's approval passes its access check (not archived yet); an archive then commits.
      vi.spyOn(prisma.framework, 'findFirst').mockImplementation((async (args: { where?: { id?: unknown } }) => {
        const found = await realFindFirst(args);
        if (!held && args?.where?.id === framework.id) {
          held = true;
          archive = await request(app).post(`/api/projects/${project.id}/archive`).set('Authorization', a.adminAuth);
        }
        return found;
      }) as never);

      const approve = await request(app).patch(`/api/frameworks/${framework.id}/approve`).set('Authorization', a.adminAuth);
      expect(archive?.status).toBe(200);
      expect(approve.status).toBe(409);
      expect(approve.body).toEqual(ARCHIVED);
      vi.restoreAllMocks();
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('archived');
      expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', approvedAt: null, approvedBy: null });
      expect((await prisma.indicator.findUniqueOrThrow({ where: { id: indicator.id } })).isApproved).toBe(false);
      const restored = await request(app).post(`/api/projects/${project.id}/restore`).set('Authorization', a.adminAuth);
      expect(restored.body.status).toBe('framework_review');
      // Once restored, the approval goes through as before.
      const approved = await request(app).patch(`/api/frameworks/${framework.id}/approve`).set('Authorization', a.adminAuth);
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('active');
    });
  });

  describe('an archived project is read-only', () => {
    let r: OrgFixture;
    let webhookToken: string;

    beforeAll(async () => {
      r = await createOrgFixture('r');
      const token = await request(app).post(`/api/organizations/${r.org.id}/webhook-tokens`).set('Authorization', r.adminAuth);
      expect(token.status).toBe(201);
      webhookToken = token.body.token;
      const archived = await request(app).post(`/api/projects/${r.project.id}/archive`).set('Authorization', r.adminAuth);
      expect(archived.status).toBe(200);
    });

    /** Every row of the archived fixture project, to show a refused write changed nothing. */
    async function snapshot() {
      const projectId = r.project.id;
      return {
        project: await prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
        frameworks: await prisma.framework.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        results: await prisma.resultNode.findMany({ where: { framework: { projectId } }, orderBy: { id: 'asc' } }),
        indicators: await prisma.indicator.findMany({ where: { framework: { projectId } }, orderBy: { id: 'asc' } }),
        dataPoints: await prisma.dataPoint.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        assessments: await prisma.assessment.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        qualitative: await prisma.qualitativeEntry.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        reports: await prisma.report.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        beneficiaries: await prisma.beneficiary.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        services: await prisma.beneficiaryService.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
        documents: await prisma.document.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
      };
    }

    it('answers 409 project_archived to every write route of the project except restore and delete', async () => {
      const writes = projectOwnedRoutes().filter(route => route.method !== 'get' && !EXEMPT.has(route.key));
      // Guard: the walk found the project-owned write routes (a new one is checked automatically).
      expect(writes.length).toBeGreaterThanOrEqual(25);
      expect(writes.map(w => w.key)).toEqual(expect.arrayContaining([
        'patch /api/projects/:id', 'post /api/frameworks/:id/indicators', 'patch /api/indicators/:id', 'delete /api/documents/:id',
        'post /api/indicators/:id/data', 'post /api/beneficiaries/:id/services', 'patch /api/reports/:id/publish',
      ]));
      const before = await snapshot();
      for (const route of writes) {
        const res = await request(app)[route.method as 'post' | 'patch' | 'delete'](pathFor(route, r)).set('Authorization', r.adminAuth).send({});
        expect(res.status, route.key).toBe(409);
        expect(res.body, route.key).toEqual(ARCHIVED);
      }
      expect(await snapshot()).toEqual(before);
    });

    it('refuses real writes with valid bodies, and nothing is written', async () => {
      const before = await snapshot();
      const p = r.project.id;
      const attempts = [
        request(app).patch(`/api/indicators/${r.indicator.id}`).send({ targetValue: '500' }),
        request(app).delete(`/api/indicators/${r.indicator.id}`),
        request(app).post(`/api/frameworks/${r.framework.id}/indicators`).send({ indicatorText: 'New indicator', level: 'outcome', resultId: r.result.id }),
        request(app).post(`/api/frameworks/${r.framework.id}/results`).send({ level: 'output', code: 'O1.1', text: 'New output', parentId: r.result.id }),
        request(app).patch(`/api/results/${r.result.id}`).send({ text: 'Renamed outcome' }),
        request(app).patch(`/api/frameworks/${r.framework.id}/approve`),
        request(app).post(`/api/projects/${p}/framework/manual`).send({ name: 'Manual' }),
        request(app).post(`/api/projects/${p}/documents`).attach('file', PDF_BYTES, { filename: 'late.pdf', contentType: 'application/pdf' }).field('fileType', 'proposal'),
        request(app).delete(`/api/documents/${r.document.id}`),
        request(app).post(`/api/indicators/${r.indicator.id}/data`).send({ value: '12', collectionDate: '2026-04-01', collectionMethod: 'hh_survey' }),
        request(app).post(`/api/projects/${p}/data/bulk`).send({ dataPoints: [{ indicatorId: r.indicator.id, value: '12', collectionDate: '2026-04-01', collectionMethod: 'hh_survey' }] }),
        request(app).post(`/api/projects/${p}/assessments`).send({ type: 'midterm', autoGenerate: false }),
        request(app).patch(`/api/assessments/${r.assessment.id}`).send({ status: 'delivered' }),
        request(app).post(`/api/projects/${p}/reports/generate`).send({ type: 'quarterly_summary', title: 'Q3' }),
        request(app).patch(`/api/reports/${r.report.id}/publish`),
        request(app).post(`/api/projects/${p}/beneficiaries`).send({ fullName: 'Late Registration', gender: 'female' }),
        request(app).patch(`/api/beneficiaries/${r.beneficiary.id}`).send({ status: 'completed' }),
        request(app).post(`/api/beneficiaries/${r.beneficiary.id}/services`).send({ serviceType: 'training', dateProvided: '2026-04-01' }),
        request(app).post(`/api/projects/${p}/qualitative`).send({ entryType: 'field_notes', title: 'Visit', content: 'Notes' }),
        request(app).post(`/api/projects/${p}/qualitative/upload`).attach('file', PDF_BYTES, { filename: 'fgd.pdf', contentType: 'application/pdf' }),
        request(app).post(`/api/qualitative/${r.qualitative.id}/code`),
        request(app).patch(`/api/projects/${p}`).send({ name: 'Renamed while archived' }),
        request(app).patch(`/api/projects/${p}`).send({ status: 'active' }),
      ];
      for (const [i, attempt] of attempts.entries()) {
        const res = await attempt.set('Authorization', r.adminAuth);
        expect(res.status, `attempt ${i + 1}`).toBe(409);
        expect(res.body, `attempt ${i + 1}`).toEqual(ARCHIVED);
      }
      // M&E officers get the same answer on staff routes.
      const officer = await request(app).patch(`/api/indicators/${r.indicator.id}`).set('Authorization', r.officerAuth).send({ targetValue: '500' });
      expect(officer.status).toBe(409);
      expect(officer.body).toEqual(ARCHIVED);
      expect(await snapshot()).toEqual(before);
      // The document's file is still stored, and the refused uploads stored nothing.
      const storedFile = getLocalStorage()!.resolve(r.document.fileUrl);
      expect(fs.existsSync(storedFile)).toBe(true);
      expect(fs.readdirSync(path.dirname(storedFile))).toEqual([path.basename(storedFile)]);
    });

    it('still serves every read of the project', async () => {
      const reads = projectOwnedRoutes().filter(route => route.method === 'get');
      expect(reads.length).toBeGreaterThanOrEqual(20);
      for (const route of reads) {
        for (const auth of [r.adminAuth, r.officerAuth]) {
          const res = await request(app).get(pathFor(route, r)).set('Authorization', auth);
          expect(res.status, route.key).toBeLessThan(300);
        }
      }
      const donorView = await request(app).get(`/api/projects/${r.project.id}`).set('Authorization', r.donorAuth);
      expect(donorView.status).toBe(200);
      const donorExport = await request(app).get(`/api/projects/${r.project.id}/export`).set('Authorization', r.donorAuth);
      expect(donorExport.status).toBe(200);
    });

    it('refuses webhook imports into an archived project (409 project_archived), and logs the rejection', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const before = await snapshot();
      const sends = [
        request(app).post('/api/webhooks/manasati').send({ projectId: r.project.id, indicators: [{ indicatorMatch: 'Indicator r', value: 5, date: '2026-05-01' }] }),
        request(app).post('/api/webhooks/kobotoolbox').send({
          _project_id: r.project.id, _submission_time: '2026-05-01T10:00:00Z', _indicator_mappings: { q1: r.indicator.id }, q1: 42,
        }),
        request(app).post('/api/webhooks/kobotoolbox').send({ _project_id: r.project.id, _type: 'qualitative', title: 'Late submission' }),
      ];
      for (const send of sends) {
        const res = await send.set('X-Raqib-Webhook-Token', webhookToken);
        expect(res.status).toBe(409);
        expect(res.body).toEqual(ARCHIVED);
      }
      expect(await snapshot()).toEqual(before);
      expect(warn).toHaveBeenCalledWith('[Webhook] Rejected', expect.stringContaining('"reason":"project_archived"'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(webhookToken);
    });

    it('accepts writes again once the project is restored', async () => {
      const restored = await request(app).post(`/api/projects/${r.project.id}/restore`).set('Authorization', r.adminAuth);
      expect(restored.status).toBe(200);
      expect(restored.body.status).toBe('setup');
      const patch = await request(app).patch(`/api/indicators/${r.indicator.id}`).set('Authorization', r.officerAuth).send({ targetValue: '500' });
      expect(patch.status).toBe(200);
      const webhook = await request(app).post('/api/webhooks/kobotoolbox').set('X-Raqib-Webhook-Token', webhookToken).send({
        _project_id: r.project.id, _submission_time: '2026-05-01T10:00:00Z', _indicator_mappings: { q1: r.indicator.id }, q1: 42,
      });
      expect(webhook.status).toBe(200);
    });
  });

  describe('delete forever', () => {
    /** A project of organisation A with rows in every project-owned table, files in storage and an AI call. */
    async function seedFullProject(label: string, status: 'active' | 'archived' = 'active') {
      const project = await makeProject(a, `Full ${label}`, status);
      const approved = await prisma.framework.create({ data: { projectId: project.id, version: 1, status: 'approved' } });
      const failed = await prisma.framework.create({ data: { projectId: project.id, version: 2, generationError: 'AI generation failed' } });
      const goal = await prisma.resultNode.create({ data: { frameworkId: approved.id, level: 'impact', code: 'Goal', text: 'Goal' } });
      const outcome = await prisma.resultNode.create({ data: { frameworkId: approved.id, parentId: goal.id, level: 'outcome', code: 'O1', text: 'Outcome' } });
      const output = await prisma.resultNode.create({ data: { frameworkId: approved.id, parentId: outcome.id, level: 'output', code: 'O1.1', text: 'Output' } });
      const indicator = (resultId: string, text: string) => prisma.indicator.create({
        data: { frameworkId: approved.id, resultId, indicatorText: text, level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
      });
      const ind1 = await indicator(outcome.id, `Outcome indicator ${label}`);
      const ind2 = await indicator(output.id, `Output indicator ${label}`);
      const assessment = await prisma.assessment.create({ data: { projectId: project.id, type: 'baseline', methodsIncluded: ['hh_survey'] } });
      const point = (indicatorId: string, extra: object = {}) => ({
        indicatorId, projectId: project.id, value: '5', collectionDate: new Date('2026-03-01'), collectionMethod: 'hh_survey' as const, createdBy: a.officer.id, ...extra,
      });
      await prisma.dataPoint.createMany({ data: [point(ind1.id), point(ind1.id, { assessmentId: assessment.id }), point(ind2.id, { dataSource: 'KoboToolbox' })] });
      await prisma.qualitativeEntry.createMany({
        data: [
          { projectId: project.id, entryType: 'fgd_transcript', title: 'FGD', content: 'Transcript', assessmentId: assessment.id },
          { projectId: project.id, entryType: 'field_notes', title: 'Visit', content: 'Notes' },
        ],
      });
      const person1 = await prisma.beneficiary.create({ data: { projectId: project.id, fullName: 'Delete Testperson', gender: 'female', phoneNumber: '0599111222' } });
      const person2 = await prisma.beneficiary.create({ data: { projectId: project.id, fullName: 'Second Testperson', gender: 'male' } });
      await prisma.beneficiaryService.createMany({
        data: [
          { beneficiaryId: person1.id, projectId: project.id, serviceType: 'training', dateProvided: new Date('2026-03-02'), indicatorId: ind1.id },
          { beneficiaryId: person1.id, projectId: project.id, serviceType: 'cash_assistance', dateProvided: new Date('2026-03-03') },
          { beneficiaryId: person2.id, projectId: project.id, serviceType: 'training', dateProvided: new Date('2026-03-04') },
        ],
      });
      await prisma.report.createMany({
        data: [
          { projectId: project.id, type: 'quarterly_summary', title: 'Q1' },
          { projectId: project.id, type: 'monthly_progress', title: 'March', status: 'published', fileUrl: 'reports/x.pdf', aiNarrative: 'Narrative' },
        ],
      });
      const documents = [];
      for (const fileName of ['proposal.pdf', 'Delete Testperson 0599111222 register.pdf']) {
        const key = buildDocumentKey(project.id, fileName);
        await getStorage().put(key, PDF_BYTES, 'application/pdf');
        documents.push(await prisma.document.create({
          data: { projectId: project.id, uploadedBy: a.officer.id, fileName, fileUrl: key, fileType: 'proposal', fileSizeBytes: PDF_BYTES.length },
        }));
      }
      await prisma.notification.createMany({
        data: [
          { userId: a.admin.id, type: 'framework_approved', title: 'Approved', message: 'Approved', link: `/projects/${project.id}` },
          { userId: a.donor.id, type: 'report_generated', title: 'Report', message: 'Report', link: `/projects/${project.id}?tab=reports` },
        ],
      });
      const aiCall = await prisma.aiCall.create({
        data: {
          feature: 'framework.indicators', model: 'claude-sonnet-5-5', promptVersion: 'framework-v4', status: 'success', latencyMs: 1200,
          inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.0123, organizationId: a.org.id, projectId: project.id,
        },
      });
      return { project, frameworks: [approved, failed], results: [goal, outcome, output], indicators: [ind1, ind2], assessment, documents, aiCall };
    }

    async function rowsOf(projectId: string, frameworkIds: string[]) {
      return {
        project: await prisma.project.count({ where: { id: projectId } }),
        frameworks: await prisma.framework.count({ where: { projectId } }),
        resultNodes: await prisma.resultNode.count({ where: { frameworkId: { in: frameworkIds } } }),
        indicators: await prisma.indicator.count({ where: { frameworkId: { in: frameworkIds } } }),
        assessments: await prisma.assessment.count({ where: { projectId } }),
        dataPoints: await prisma.dataPoint.count({ where: { projectId } }),
        qualitativeEntries: await prisma.qualitativeEntry.count({ where: { projectId } }),
        beneficiaries: await prisma.beneficiary.count({ where: { projectId } }),
        beneficiaryServices: await prisma.beneficiaryService.count({ where: { projectId } }),
        reports: await prisma.report.count({ where: { projectId } }),
        documents: await prisma.document.count({ where: { projectId } }),
        notifications: await prisma.notification.count({ where: { link: { contains: projectId } } }),
      };
    }

    const FULL_COUNTS = {
      project: 1, frameworks: 2, resultNodes: 3, indicators: 2, assessments: 1, dataPoints: 3, qualitativeEntries: 2,
      beneficiaries: 2, beneficiaryServices: 3, reports: 2, documents: 2, notifications: 2,
    };
    const fileExists = (key: string) => fs.existsSync(getLocalStorage()!.resolve(key));

    it('refuses a confirmation that is not the exact project name (400 confirm_name_mismatch), and deletes nothing', async () => {
      const seed = await seedFullProject('mismatch');
      const fwIds = seed.frameworks.map(f => f.id);
      const remove = vi.spyOn(getStorage(), 'remove');
      const name = seed.project.name;
      const bodies: (object | undefined)[] = [
        undefined, {}, { confirmName: '' }, { confirmName: name.toLowerCase() }, { confirmName: name.toUpperCase() },
        { confirmName: `${name} 2` }, { confirmName: `delete ${name}` }, { confirmName: name.slice(0, -1) }, { confirmName: 42 },
        { confirmName: [name] }, { name },
      ];
      for (const body of bodies) {
        const req = request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', a.adminAuth);
        const res = body === undefined ? await req : await req.send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body).toEqual({ message: 'Type the project name exactly as it is shown to delete the project.', code: 'confirm_name_mismatch' });
      }
      expect(await rowsOf(seed.project.id, fwIds)).toEqual(FULL_COUNTS);
      expect(remove).not.toHaveBeenCalled();
      for (const doc of seed.documents) expect(fileExists(doc.fileUrl)).toBe(true);
      expect((await prisma.aiCall.findUniqueOrThrow({ where: { id: seed.aiCall.id } })).projectId).toBe(seed.project.id);
    });

    it('refuses M&E officers and donor viewers (403) and another organisation (404), even with the right name', async () => {
      const seed = await seedFullProject('roles');
      const fwIds = seed.frameworks.map(f => f.id);
      for (const auth of [a.officerAuth, a.donorAuth]) {
        const res = await request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', auth).send({ confirmName: seed.project.name });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
      }
      const other = await request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', b.adminAuth).send({ confirmName: seed.project.name });
      expect(other.status).toBe(404);
      expect(other.body.message).toBe('Project not found');
      expect(await rowsOf(seed.project.id, fwIds)).toEqual(FULL_COUNTS);
    });

    it('deletes every row of the project in one go, removes its files, keeps AI cost history, and leaves other projects alone', async () => {
      const seed = await seedFullProject('happy');
      const fwIds = seed.frameworks.map(f => f.id);
      // Another project of the same organisation, with a notification about it, and organisation B.
      const keepNotification = await prisma.notification.create({
        data: { userId: a.admin.id, type: 'new_data', title: 'Other', message: 'Other', link: `/projects/${a.project.id}` },
      });
      const otherBefore = await rowsOf(a.project.id, [a.framework.id]);
      const orgBBefore = await rowsOf(b.project.id, [b.framework.id]);
      const remove = vi.spyOn(getStorage(), 'remove');
      const errors = vi.spyOn(console, 'error');

      const res = await request(app)
        .delete(`/api/projects/${seed.project.id}`)
        .set('Authorization', a.adminAuth)
        .send({ confirmName: `  ${seed.project.name}  ` });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        deleted: true,
        removed: {
          frameworks: 2, resultNodes: 3, indicators: 2, assessments: 1, dataPoints: 3, qualitativeEntries: 2, beneficiaries: 2,
          beneficiaryServices: 3, reports: 2, documents: 2, notifications: 2, storageFilesRemoved: 2, storageFilesFailed: 0,
        },
      });

      // Every row of the project is gone.
      expect(await rowsOf(seed.project.id, fwIds)).toEqual(Object.fromEntries(Object.keys(FULL_COUNTS).map(k => [k, 0])));
      expect(await prisma.indicator.count({ where: { id: { in: seed.indicators.map(i => i.id) } } })).toBe(0);
      expect(await prisma.resultNode.count({ where: { id: { in: seed.results.map(n => n.id) } } })).toBe(0);
      expect(await prisma.dataPoint.count({ where: { indicatorId: { in: seed.indicators.map(i => i.id) } } })).toBe(0);
      // Files: removal attempted for each document, and gone from storage.
      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove.mock.calls.map(call => call[0]).sort()).toEqual(seed.documents.map(d => d.fileUrl).sort());
      for (const doc of seed.documents) expect(fileExists(doc.fileUrl)).toBe(false);
      expect(errors).not.toHaveBeenCalled();
      // AI cost history stays, without the project.
      expect(await prisma.aiCall.findUniqueOrThrow({ where: { id: seed.aiCall.id } })).toMatchObject({
        projectId: null, organizationId: a.org.id, feature: 'framework.indicators', inputTokens: 1000,
      });

      // The other project of the organisation, and organisation B, are untouched.
      expect(await rowsOf(a.project.id, [a.framework.id])).toEqual(otherBefore);
      expect(await rowsOf(b.project.id, [b.framework.id])).toEqual(orgBBefore);
      expect(otherBefore).toMatchObject({ project: 1, frameworks: 1, indicators: 1, resultNodes: 1, documents: 1, notifications: 1 });
      expect(await prisma.notification.findUnique({ where: { id: keepNotification.id } })).not.toBeNull();
      expect(fileExists(a.document.fileUrl)).toBe(true);
      expect(fileExists(b.document.fileUrl)).toBe(true);
      expect((await prisma.user.count({ where: { organizationId: a.org.id } }))).toBeGreaterThanOrEqual(4);

      // One audit row, with what was deleted: names, status and counts only.
      const rows = await settledAuditRows(seed.project.id, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: a.admin.id,
        action: `DELETE /api/projects/${seed.project.id}`,
        entity: 'projects',
        entityId: seed.project.id,
        previousValue: {
          name: seed.project.name,
          status: 'active',
          removed: {
            frameworks: 2, resultNodes: 3, indicators: 2, assessments: 1, dataPoints: 3, qualitativeEntries: 2, beneficiaries: 2,
            beneficiaryServices: 3, reports: 2, documents: 2, notifications: 2,
          },
        },
        newValue: { status: 200, fields: ['confirmName'] },
      });
      const stored = JSON.stringify(rows[0]);
      expect(stored).not.toMatch(/Testperson|0599111222|register\.pdf/);
      for (const doc of seed.documents) expect(stored).not.toContain(doc.fileUrl);

      // The project is gone for every route.
      const gone = await request(app).get(`/api/projects/${seed.project.id}`).set('Authorization', a.adminAuth);
      expect(gone.status).toBe(404);
      const again = await request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', a.adminAuth).send({ confirmName: seed.project.name });
      expect(again.status).toBe(404);
    });

    it('deletes an archived project too (from any status), and platform admins can', async () => {
      const seed = await seedFullProject('archived', 'archived');
      const res = await request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', platformAuth).send({ confirmName: seed.project.name });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(await rowsOf(seed.project.id, seed.frameworks.map(f => f.id))).toEqual(Object.fromEntries(Object.keys(FULL_COUNTS).map(k => [k, 0])));
      const rows = await settledAuditRows(seed.project.id, 1);
      expect(rows[0].previousValue).toMatchObject({ status: 'archived' });
    });

    it('a storage failure does not fail the delete: counted, and logged with the document id only', async () => {
      const seed = await seedFullProject('storage failure');
      const [kept, failing] = seed.documents;
      const storage = getStorage();
      const realRemove = storage.remove.bind(storage);
      vi.spyOn(storage, 'remove').mockImplementation(async (key: string) => {
        if (key === failing.fileUrl) throw new Error(`EACCES: permission denied, unlink '/srv/storage/${key}' (${failing.fileName})`);
        return realRemove(key);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', a.adminAuth).send({ confirmName: seed.project.name });
      expect(res.status).toBe(200);
      expect(res.body.removed).toMatchObject({ documents: 2, storageFilesRemoved: 1, storageFilesFailed: 1 });
      expect(await rowsOf(seed.project.id, seed.frameworks.map(f => f.id))).toEqual(Object.fromEntries(Object.keys(FULL_COUNTS).map(k => [k, 0])));
      expect(fileExists(kept.fileUrl)).toBe(false);

      const logged = errors.mock.calls.map(call => call.join(' '));
      expect(logged).toEqual([`[Projects] Could not remove the stored file of deleted document ${failing.id} (Error)`]);
      const all = JSON.stringify(errors.mock.calls);
      expect(all).not.toContain(failing.fileName);
      expect(all).not.toContain('Testperson');
      expect(all).not.toContain(failing.fileUrl);
      expect(all).not.toContain('EACCES');
    });

    it('an upload whose project is deleted while its file is being stored leaves no file behind (documents and transcripts)', async () => {
      const storage = getStorage();
      const realPut = storage.put.bind(storage);
      for (const route of ['documents', 'qualitative/upload'] as const) {
        const project = await makeProject(a, `Upload race ${route}`);
        const keys: string[] = [];
        let deleted: request.Response | undefined;
        // The admin deletes the project forever while the upload is between storing its file and saving its row.
        const put = vi.spyOn(storage, 'put').mockImplementation(async (key, body, contentType) => {
          await realPut(key, body, contentType);
          keys.push(key);
          deleted = await request(app).delete(`/api/projects/${project.id}`).set('Authorization', a.adminAuth).send({ confirmName: project.name });
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const upload = request(app).post(`/api/projects/${project.id}/${route}`).set('Authorization', a.officerAuth)
          .attach('file', PDF_BYTES, { filename: 'Register 0599111222.pdf', contentType: 'application/pdf' });
        const res = route === 'documents' ? await upload.field('fileType', 'other') : await upload;

        expect(deleted?.status, route).toBe(200);
        expect(deleted?.body.removed, route).toMatchObject({ documents: 0, storageFilesRemoved: 0, storageFilesFailed: 0 });
        // The row could not be saved (the project is gone), and the file stored for it was removed again.
        expect(res.status, route).toBe(400);
        expect(keys, route).toHaveLength(1);
        expect(keys[0].startsWith(`projects/${project.id}/`), route).toBe(true);
        expect(fileExists(keys[0]), route).toBe(false);
        expect(await prisma.document.count({ where: { projectId: project.id } }), route).toBe(0);
        expect(JSON.stringify(errors.mock.calls), route).not.toMatch(/Register|0599111222/);
        put.mockRestore();
        errors.mockRestore();
      }
    });

    it('a failed clean-up of such a file is logged with the project id only, and the upload still answers its error', async () => {
      const storage = getStorage();
      const realPut = storage.put.bind(storage);
      const realRemove = storage.remove.bind(storage);
      const project = await makeProject(a, 'Upload race: clean-up fails');
      const keys: string[] = [];
      vi.spyOn(storage, 'put').mockImplementation(async (key, body, contentType) => {
        await realPut(key, body, contentType);
        keys.push(key);
        await request(app).delete(`/api/projects/${project.id}`).set('Authorization', a.adminAuth).send({ confirmName: project.name });
      });
      vi.spyOn(storage, 'remove').mockImplementation(async (key: string) => {
        throw new Error(`EACCES: permission denied, unlink '/srv/storage/${key}' (Register 0599111222.pdf)`);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).post(`/api/projects/${project.id}/documents`).set('Authorization', a.officerAuth)
        .attach('file', PDF_BYTES, { filename: 'Register 0599111222.pdf', contentType: 'application/pdf' }).field('fileType', 'other');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'A related record does not exist (it may have been deleted).' });
      const logged = errors.mock.calls.map(call => call.join(' ')).filter(line => line.startsWith('[Storage]'));
      expect(logged).toEqual([`[Storage] Could not remove the stored file of an upload to project ${project.id} whose record was not saved (Error)`]);
      const all = JSON.stringify(errors.mock.calls);
      for (const secret of ['Register', '0599111222', keys[0], 'EACCES']) expect(all).not.toContain(secret);
      await realRemove(keys[0]);
    });

    it('rolls back completely when a row outside the project still refers to it', async () => {
      const seed = await seedFullProject('blocked');
      // A data point of another project that refers to this project's indicator (the API never creates one).
      const stray = await prisma.dataPoint.create({
        data: {
          indicatorId: seed.indicators[0].id, projectId: a.project.id, value: '1', collectionDate: new Date('2026-03-01'),
          collectionMethod: 'hh_survey', createdBy: a.officer.id,
        },
      });
      const remove = vi.spyOn(getStorage(), 'remove');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).delete(`/api/projects/${seed.project.id}`).set('Authorization', a.adminAuth).send({ confirmName: seed.project.name });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ message: 'This project could not be deleted: records outside it still refer to it. Nothing was deleted.' });
      expect(await rowsOf(seed.project.id, seed.frameworks.map(f => f.id))).toEqual(FULL_COUNTS);
      expect(remove).not.toHaveBeenCalled();
      for (const doc of seed.documents) expect(fileExists(doc.fileUrl)).toBe(true);
      // No audit row claims a delete that did not happen.
      const rows = await settledAuditRows(seed.project.id, 1);
      expect(rows.every(row => row.previousValue === null)).toBe(true);
      expect((rows[0].newValue as { status: number }).status).toBe(res.status);
      await prisma.dataPoint.delete({ where: { id: stray.id } });
    });
  });
});
