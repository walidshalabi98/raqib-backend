import crypto from 'crypto';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

const sign = (body: string) => `sha256=${crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')}`;

describe.skipIf(!hasTestDatabase)('webhook authentication', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let tokenA: string;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    const res = await request(app).post(`/api/organizations/${a.org.id}/webhook-tokens`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(201);
    tokenA = res.body.token;
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const kobo = (projectId: string, indicatorId: string) => ({
    _project_id: projectId,
    _submission_time: '2026-05-01T10:00:00Z',
    _indicator_mappings: { q1: indicatorId },
    q1: 42,
  });

  it('stores only a hash of the token and never returns it again', async () => {
    const stored = await prisma.webhookToken.findFirstOrThrow({ where: { organizationId: a.org.id } });
    expect(stored.tokenHash).not.toContain(tokenA);
    expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(tokenA).digest('hex'));

    const list = await request(app).get(`/api/organizations/${a.org.id}/webhook-tokens`).set('Authorization', a.adminAuth);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(tokenA);
    expect(list.body[0].tokenPrefix).toBe(tokenA.slice(0, 13));
  });

  it('only lets org admins manage tokens', async () => {
    const res = await request(app).post(`/api/organizations/${a.org.id}/webhook-tokens`).set('Authorization', a.officerAuth);
    expect(res.status).toBe(403);
  });

  it.each(['kobotoolbox', 'manasati'])('returns 401 without a token (%s)', async source => {
    const res = await request(app).post(`/api/webhooks/${source}`).send(kobo(a.project.id, a.indicator.id));
    expect(res.status).toBe(401);
    expect(console.warn).toHaveBeenCalledWith('[Webhook] Rejected', expect.stringContaining('missing_token'));
  });

  it('returns 401 with an invalid token', async () => {
    const res = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', 'rqb_wh_not-a-real-token')
      .send(kobo(a.project.id, a.indicator.id));
    expect(res.status).toBe(401);
  });

  it("cannot write to another organisation's project with a valid token", async () => {
    const before = await prisma.dataPoint.count({ where: { projectId: b.project.id } });

    const koboRes = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send(kobo(b.project.id, b.indicator.id));
    expect(koboRes.status).toBe(404);

    const qualRes = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send({ _project_id: b.project.id, _type: 'qualitative', title: 'Injected' });
    expect(qualRes.status).toBe(404);

    const manasatiRes = await request(app)
      .post('/api/webhooks/manasati')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send({ projectId: b.project.id, indicators: [{ indicatorMatch: 'Indicator b', value: 5 }] });
    expect(manasatiRes.status).toBe(404);

    expect(await prisma.dataPoint.count({ where: { projectId: b.project.id } })).toBe(before);
    expect(await prisma.qualitativeEntry.count({ where: { projectId: b.project.id, title: 'Injected' } })).toBe(0);
    expect(console.warn).toHaveBeenCalledWith('[Webhook] Rejected', expect.stringContaining('project_not_in_organization'));
  });

  it("cannot map a submission onto another organisation's indicator", async () => {
    const res = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send(kobo(a.project.id, b.indicator.id));
    expect(res.status).toBe(400);
    expect(await prisma.dataPoint.count({ where: { indicatorId: b.indicator.id } })).toBe(1);
  });

  it('imports into its own project and attributes data to the token creator', async () => {
    const res = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send(kobo(a.project.id, a.indicator.id));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);

    const point = await prisma.dataPoint.findFirstOrThrow({ where: { indicatorId: a.indicator.id, value: '42' } });
    expect(point.createdBy).toBe(a.admin.id);
    expect(point.dataSource).toBe('KoboToolbox');

    const manasati = await request(app)
      .post('/api/webhooks/manasati')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send({ projectId: a.project.id, indicators: [{ indicatorMatch: 'Indicator a', value: 7 }, { indicatorMatch: 'Indicator b', value: 8 }] });
    expect(manasati.status).toBe(200);
    expect(manasati.body.count).toBe(1); // "Indicator b" belongs to another organisation and is not matched
  });

  it('verifies an HMAC signature when one is sent', async () => {
    const body = JSON.stringify(kobo(a.project.id, a.indicator.id));

    const bad = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('Content-Type', 'application/json')
      .set('X-Raqib-Webhook-Token', tokenA)
      .set('X-Raqib-Signature', sign(body + 'tampered'))
      .send(body);
    expect(bad.status).toBe(401);

    const good = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('Content-Type', 'application/json')
      .set('X-Raqib-Webhook-Token', tokenA)
      .set('X-Raqib-Signature', sign(body))
      .send(body);
    expect(good.status).toBe(200);
  });

  it('rejects a revoked token', async () => {
    const created = await request(app).post(`/api/organizations/${a.org.id}/webhook-tokens`).set('Authorization', a.adminAuth);
    const revoke = await request(app)
      .delete(`/api/organizations/${a.org.id}/webhook-tokens/${created.body.id}`)
      .set('Authorization', a.adminAuth);
    expect(revoke.status).toBe(200);

    const res = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', created.body.token)
      .send(kobo(a.project.id, a.indicator.id));
    expect(res.status).toBe(401);
  });
});
