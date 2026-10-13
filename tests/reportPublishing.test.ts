import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import {
  isFinishedReport,
  REPORT_PUBLISHED_NOTIFICATION,
  reportPublishedNotification,
  UNFINISHED_REPORT_MESSAGE,
} from '../src/services/reports/publication';
import { generateRefreshToken } from '../src/utils/tokens';
import { bearer, createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

/**
 * Org admins and platform admins publish a finished report; donor viewers see published reports only
 * (docs/SECURITY_SETUP.md §8.3).
 */

describe('isFinishedReport', () => {
  it('is true when the narrative or the file exists', () => {
    expect(isFinishedReport({ aiNarrative: '<p>Narrative</p>', fileUrl: null })).toBe(true);
    expect(isFinishedReport({ aiNarrative: null, fileUrl: 'reports/q2.pdf' })).toBe(true);
    expect(isFinishedReport({ aiNarrative: '<p>Narrative</p>', fileUrl: 'reports/q2.pdf' })).toBe(true);
  });

  it('is false while the report is generated, or when generation failed (no narrative and no file)', () => {
    for (const aiNarrative of [null, '', '   \n ']) {
      for (const fileUrl of [null, '', ' ']) expect(isFinishedReport({ aiNarrative, fileUrl })).toBe(false);
    }
  });
});

describe('reportPublishedNotification', () => {
  const report = { projectId: 'p-1', title: 'Q2 summary' };

  it('tells a donor viewer in English by default', () => {
    for (const language of ['en', undefined, null, 'fr']) {
      expect(reportPublishedNotification(report, { name: 'Water for Gaza', nameAr: 'مياه لغزة' }, language)).toEqual({
        type: 'report_generated',
        title: 'Report published: Q2 summary',
        message: '"Q2 summary" for Water for Gaza is ready to read.',
        link: '/projects/p-1?tab=reports',
      });
    }
  });

  it('tells a donor viewer in Arabic, with the Arabic project name when there is one', () => {
    expect(reportPublishedNotification(report, { name: 'Water for Gaza', nameAr: 'مياه لغزة' }, 'ar')).toEqual({
      type: 'report_generated',
      title: 'نُشر تقرير: Q2 summary',
      message: 'أصبح تقرير «Q2 summary» الخاص بمشروع مياه لغزة متاحاً للاطلاع.',
      link: '/projects/p-1?tab=reports',
    });
    for (const nameAr of [null, undefined, ' ']) {
      expect(reportPublishedNotification(report, { name: 'Water for Gaza', nameAr }, 'ar').message).toContain('بمشروع Water for Gaza ');
    }
  });

  it('uses an existing notification type', () => {
    expect(REPORT_PUBLISHED_NOTIFICATION).toBe('report_generated');
  });
});

describe.skipIf(!hasTestDatabase)('publishing reports', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let platformAdminAuth: string;
  let arabicDonorId: string;
  /** Finished drafts (with a narrative), one per organisation. */
  let finished: { id: string };
  let finishedB: { id: string };

  const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);
  const publish = (id: string, auth: string) => request(app).patch(`/api/reports/${id}/publish`).set('Authorization', auth);
  const unpublish = (id: string, auth: string) => request(app).patch(`/api/reports/${id}/unpublish`).set('Authorization', auth);
  const statusOf = async (id: string) => (await prisma.report.findUniqueOrThrow({ where: { id } })).status;
  const donorListIds = async (f: OrgFixture) =>
    (await get(`/api/projects/${f.project.id}/reports`, f.donorAuth)).body.map((r: { id: string }) => r.id);
  const reportNotifications = () => prisma.notification.findMany({ where: { type: 'report_generated' }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    const platformAdmin = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'platform-a@example.org', passwordHash: 'x', fullName: 'Platform a', role: 'platform_admin' },
    });
    platformAdminAuth = bearer(platformAdmin);
    const arabicDonor = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'donor-ar-a@example.org', passwordHash: 'x', fullName: 'Donor ar', role: 'donor_viewer', languagePref: 'ar' },
    });
    arabicDonorId = arabicDonor.id;
    await prisma.project.update({ where: { id: a.project.id }, data: { nameAr: 'مشروع أ' } });
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.report.deleteMany({ where: { id: { notIn: [a.report.id, b.report.id] } } });
    finished = await prisma.report.create({
      data: { projectId: a.project.id, type: 'quarterly_summary', title: 'Q2 summary', aiNarrative: '<p>Q2 narrative</p>' },
    });
    finishedB = await prisma.report.create({
      data: { projectId: b.project.id, type: 'quarterly_summary', title: 'Q2 summary b', aiNarrative: '<p>Q2 narrative b</p>' },
    });
  });

  it('keeps a draft from donor viewers: 404 like another organisation\'s report, and not listed', async () => {
    for (const path of [`/api/reports/${finished.id}`, `/api/reports/${finished.id}/status`]) {
      const res = await get(path, a.donorAuth);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Report not found' });
    }
    expect(await donorListIds(a)).toEqual([]);
    expect((await get(`/api/reports/${finished.id}`, a.officerAuth)).status).toBe(200);
  });

  it('lets an org admin publish a finished report, which donor viewers then see until it is unpublished', async () => {
    const published = await publish(finished.id, a.adminAuth);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ id: finished.id, status: 'published', aiNarrative: '<p>Q2 narrative</p>', fileUrl: null });
    // As staff see it.
    const staffView = await get(`/api/reports/${finished.id}`, a.adminAuth);
    expect(published.body).toEqual(staffView.body);
    expect(published.body.project).toMatchObject({ id: a.project.id });

    expect(await donorListIds(a)).toEqual([finished.id]);
    const donorView = await get(`/api/reports/${finished.id}`, a.donorAuth);
    expect(donorView.status).toBe(200);
    expect(donorView.body).toEqual({
      id: finished.id, projectId: a.project.id, type: 'quarterly_summary', title: 'Q2 summary', donorFormat: null,
      generatedAt: expect.any(String), periodStart: null, periodEnd: null, status: 'published', aiNarrative: '<p>Q2 narrative</p>',
    });
    expect((await get(`/api/reports/${finished.id}/status`, a.donorAuth)).status).toBe(200);
    // Donor viewers of another organisation still see nothing of it.
    expect((await get(`/api/reports/${finished.id}`, b.donorAuth)).status).toBe(404);

    const withdrawn = await unpublish(finished.id, a.adminAuth);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toEqual({ ...staffView.body, status: 'draft' });
    expect(await statusOf(finished.id)).toBe('draft');
    expect(await donorListIds(a)).toEqual([]);
    for (const path of [`/api/reports/${finished.id}`, `/api/reports/${finished.id}/status`]) {
      const res = await get(path, a.donorAuth);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Report not found' });
    }
    // Staff keep the draft.
    expect((await get(`/api/projects/${a.project.id}/reports`, a.officerAuth)).body.map((r: { id: string }) => r.id)).toContain(finished.id);
  });

  it('lets a platform admin publish and unpublish within their organisation', async () => {
    expect((await publish(finished.id, platformAdminAuth)).status).toBe(200);
    expect(await statusOf(finished.id)).toBe('published');
    expect((await unpublish(finished.id, platformAdminAuth)).status).toBe(200);
    expect(await statusOf(finished.id)).toBe('draft');
  });

  it('refuses M&E officers and donor viewers with 403, and changes nothing', async () => {
    for (const auth of [a.officerAuth, a.donorAuth]) {
      const res = await publish(finished.id, auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: 'Insufficient permissions' });
    }
    expect(await statusOf(finished.id)).toBe('draft');

    expect((await publish(finished.id, a.adminAuth)).status).toBe(200);
    for (const auth of [a.officerAuth, a.donorAuth]) {
      const res = await unpublish(finished.id, auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: 'Insufficient permissions' });
    }
    expect(await statusOf(finished.id)).toBe('published');
  });

  it('refuses to publish a report that is not finished (409) and notifies nobody', async () => {
    const blank = await prisma.report.create({ data: { projectId: a.project.id, type: 'monthly_progress', title: 'Blank', aiNarrative: '  ' } });
    for (const id of [a.report.id, blank.id]) {
      const res = await publish(id, a.adminAuth);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ message: UNFINISHED_REPORT_MESSAGE });
      expect(await statusOf(id)).toBe('draft');
    }
    expect(await reportNotifications()).toEqual([]);
    expect(await donorListIds(a)).toEqual([]);
    // Unpublishing an unfinished draft is harmless.
    expect((await unpublish(a.report.id, a.adminAuth)).status).toBe(200);
    expect(await statusOf(a.report.id)).toBe('draft');
  });

  it('answers 404 for another organisation\'s report, finished or published, and for an unknown id', async () => {
    const res = await publish(finishedB.id, a.adminAuth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Report not found' });
    expect(await statusOf(finishedB.id)).toBe('draft');

    expect((await publish(finishedB.id, b.adminAuth)).status).toBe(200);
    const withdraw = await unpublish(finishedB.id, platformAdminAuth);
    expect(withdraw.status).toBe(404);
    expect(await statusOf(finishedB.id)).toBe('published');
    expect(await donorListIds(b)).toEqual([finishedB.id]);

    for (const send of [publish, unpublish]) {
      const unknown = await send('00000000-0000-0000-0000-000000000000', a.adminAuth);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ message: 'Report not found' });
    }
  });

  it('tells the organisation\'s donor viewers once, in their language, when a draft is published', async () => {
    expect((await publish(finished.id, a.adminAuth)).status).toBe(200);
    // Publishing again changes nothing and notifies nobody again.
    const again = await publish(finished.id, a.adminAuth);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('published');

    const notes = await reportNotifications();
    expect(notes.map(n => n.userId).sort()).toEqual([a.donor.id, arabicDonorId].sort());
    expect(notes.find(n => n.userId === a.donor.id)).toMatchObject({
      title: 'Report published: Q2 summary', message: '"Q2 summary" for Project a is ready to read.', link: `/projects/${a.project.id}?tab=reports`, isRead: false,
    });
    expect(notes.find(n => n.userId === arabicDonorId)).toMatchObject({
      title: 'نُشر تقرير: Q2 summary', message: 'أصبح تقرير «Q2 summary» الخاص بمشروع مشروع أ متاحاً للاطلاع.',
    });
    // The donor reads it through their own notifications.
    const own = await get('/api/notifications', a.donorAuth);
    expect(own.body.map((n: { title: string }) => n.title)).toEqual(['Report published: Q2 summary']);

    // Unpublishing notifies nobody; publishing the draft again tells donor viewers again.
    expect((await unpublish(finished.id, a.adminAuth)).status).toBe(200);
    expect(await reportNotifications()).toHaveLength(2);
    expect((await publish(finished.id, a.adminAuth)).status).toBe(200);
    expect(await reportNotifications()).toHaveLength(4);
    // Never staff, and never another organisation's donor viewers.
    expect((await reportNotifications()).every(n => [a.donor.id, arabicDonorId].includes(n.userId))).toBe(true);
  });

  it('still lets an org admin remove a donor viewer who was told about a published report', async () => {
    const leaving = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'donor-leaving-a@example.org', passwordHash: 'x', fullName: 'Donor leaving', role: 'donor_viewer' },
    });
    const refreshToken = generateRefreshToken(leaving);
    expect((await publish(finished.id, a.adminAuth)).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: leaving.id } })).toBe(1);

    // Notification.userId restricts deletes: the route removes the user's own notifications with the user.
    const removed = await request(app).delete(`/api/users/${leaving.id}`).set('Authorization', a.adminAuth);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ message: 'User deactivated' });
    expect(await prisma.user.findUnique({ where: { id: leaving.id } })).toBeNull();
    expect(await prisma.notification.count({ where: { userId: leaving.id } })).toBe(0);
    // Everyone else keeps their notifications.
    expect((await reportNotifications()).map(n => n.userId).sort()).toEqual([a.donor.id, arabicDonorId].sort());
    // The removed viewer cannot get a new access token (the one already issued expires within 15 minutes).
    const refreshed = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshed.status).toBe(401);
    expect(refreshed.body).toEqual({ message: 'Your session has ended. Sign in again.', code: 'session_ended' });
  });

  it('tells each donor viewer once when two publish requests race', async () => {
    const results = await Promise.all([publish(finished.id, a.adminAuth), publish(finished.id, platformAdminAuth)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(results.map(r => r.body.status)).toEqual(['published', 'published']);
    expect((await reportNotifications()).map(n => n.userId).sort()).toEqual([a.donor.id, arabicDonorId].sort());
  });
});
