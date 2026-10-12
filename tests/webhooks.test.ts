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

  it('stores imported numbers in canonical form, like manual data entry', async () => {
    const fromKobo = await request(app)
      .post('/api/webhooks/kobotoolbox')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send({ ...kobo(a.project.id, a.indicator.id), _submission_time: '2026-05-02T10:00:00Z', q1: '١٬٢٠٠' });
    expect(fromKobo.status).toBe(200);
    const manasati = await request(app)
      .post('/api/webhooks/manasati')
      .set('X-Raqib-Webhook-Token', tokenA)
      .send({ projectId: a.project.id, indicators: [
        { indicatorMatch: 'Indicator a', value: '2,500', date: '2026-05-03' },
        { indicatorMatch: 'Indicator a', value: 'Yes', date: '2026-05-04' },
      ] });
    expect(manasati.status).toBe(200);

    const values = async (date: string) => (await prisma.dataPoint.findMany({
      where: { indicatorId: a.indicator.id, collectionDate: new Date(date) }, select: { value: true },
    })).map(p => p.value);
    expect(await values('2026-05-02T10:00:00Z')).toEqual(['1200']);
    expect(await values('2026-05-03')).toEqual(['2500']);
    expect(await values('2026-05-04')).toEqual(['Yes']);
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

  it('stores KoboToolbox qualitative entries without phone numbers, ID numbers or email addresses, and logs ids and counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post('/api/webhooks/kobotoolbox')
        .set('X-Raqib-Webhook-Token', tokenA)
        .send({
          _project_id: a.project.id,
          _type: 'qualitative',
          _id: 312345678,
          _submission_time: '2026-05-05T09:00:00Z',
          _geolocation: [31.5326, 35.0998],
          entry_type: 'kii_notes',
          title: 'KII Dura 0599123456',
          notes: 'The respondent (ID 401234567) asked for a reply to someone@example.org.',
          notes_ar: 'قالت المستفيدة إن رقم هاتفها ٠٥٦٩٨٧٦٥٤٣ ورقم هويتها ٤٠١٢٣٤٥٦٧.',
          households: '1200',
        });
      expect(res.status).toBe(200);

      const entry = await prisma.qualitativeEntry.findFirstOrThrow({ where: { projectId: a.project.id, entryType: 'kii_notes' } });
      expect(entry.title).toBe('KII Dura [phone removed]');
      expect(entry.location).toBe('31.5326, 35.0998');
      expect(entry.content).toContain('"notes":"The respondent (ID [ID number removed]) asked for a reply to [email removed]."');
      expect(entry.content).toContain('"notes_ar":"قالت المستفيدة إن رقم هاتفها [phone removed] ورقم هويتها [ID number removed]."');
      expect(entry.content).toContain('"title":"KII Dura [phone removed]"');
      expect(entry.content).toContain('"households":"1200"');
      expect(entry.content).toContain('"_submission_time":"2026-05-05T09:00:00Z"');
      // The submission is redacted as text: a 9-digit submission id inside it goes too.
      expect(entry.content).toContain('"_id":[ID number removed]');
      for (const value of ['0599123456', '401234567', 'someone@example.org', '٠٥٦٩٨٧٦٥٤٣', '٤٠١٢٣٤٥٦٧', '312345678']) {
        expect(JSON.stringify(entry)).not.toContain(value);
      }

      // Summed over the fields: the title's phone number is counted in the title and in the content.
      expect(log.mock.calls).toEqual([[`[Webhook] KoboToolbox qualitative entry ${entry.id}: removed 3 phone numbers, 3 ID numbers, 1 email addresses`]]);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the KoboToolbox submission id in the fallback title of a qualitative entry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post('/api/webhooks/kobotoolbox')
        .set('X-Raqib-Webhook-Token', tokenA)
        .send({ _project_id: a.project.id, _type: 'qualitative', _id: 312345679, entry_type: 'msc_story', story: 'Water trucking resumed.' });
      expect(res.status).toBe(200);
      const entry = await prisma.qualitativeEntry.findFirstOrThrow({ where: { projectId: a.project.id, entryType: 'msc_story' } });
      expect(entry.title).toBe('KoboToolbox Submission 312345679');
      expect(entry.location).toBeNull();
      expect(entry.content).toContain('"story":"Water trucking resumed."');
      // Only the submission id was removed from the content; it is logged as a count with the entry id.
      expect(log.mock.calls).toEqual([[`[Webhook] KoboToolbox qualitative entry ${entry.id}: removed 0 phone numbers, 1 ID numbers, 0 email addresses`]]);
    } finally {
      log.mockRestore();
    }
  });

  it('refuses an unknown entry type or date before saving, without the submission in any log line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const before = await prisma.qualitativeEntry.count({ where: { projectId: a.project.id } });
      const cases: [Record<string, unknown>, string][] = [
        [{ entry_type: 'kii' }, 'entry_type must be one of:'],
        [{ _submission_time: 'yesterday' }, '_submission_time must be a date'],
      ];
      for (const [override, message] of cases) {
        const res = await request(app)
          .post('/api/webhooks/kobotoolbox')
          .set('X-Raqib-Webhook-Token', tokenA)
          .send({ _project_id: a.project.id, _type: 'qualitative', title: 'KII with Fatima Ahmad Saleh', notes: 'Fatima Ahmad Saleh said the distribution was late', ...override });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain(message);
      }
      expect(await prisma.qualitativeEntry.count({ where: { projectId: a.project.id } })).toBe(before);
      const logged = [...error.mock.calls, ...log.mock.calls].map(args => args.map(String).join(' ')).join('\n');
      expect(logged).not.toContain('Fatima');
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
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
