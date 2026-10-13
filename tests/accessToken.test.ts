import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { env } from '../src/config/env';
import { assertProjectAccess } from '../src/middleware/access';
import { accessTokenUser } from '../src/middleware/auth';
import { AppError } from '../src/middleware/errorHandler';
import { generateAccessToken, generateResetToken } from '../src/utils/tokens';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

/** Hardening: access tokens must carry an organisation and a role; reset tokens are refused. */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const CLAIMS = {
  id: ZERO_UUID, email: 'token-test@example.org', organizationId: ZERO_UUID, role: 'me_officer', fullName: 'Token test',
} as const;
const signed = (payload: object) => `Bearer ${jwt.sign(payload, env.jwtSecret, { expiresIn: '15m' })}`;
const without = (key: keyof typeof CLAIMS) => Object.fromEntries(Object.entries(CLAIMS).filter(([k]) => k !== key));

describe('accessTokenUser', () => {
  it('keeps the five claims of an access token and nothing else', () => {
    expect(accessTokenUser({ ...CLAIMS, iat: 1, exp: 2, extra: 'x' })).toEqual(CLAIMS);
  });

  it.each([
    ['a purpose claim', { ...CLAIMS, purpose: 'reset' }],
    ['a purpose claim of any value', { ...CLAIMS, purpose: undefined }],
    ['no organisation', without('organizationId')],
    ['an empty organisation', { ...CLAIMS, organizationId: '' }],
    ['an organisation that is not a UUID', { ...CLAIMS, organizationId: 'org-1' }],
    ['no role', without('role')],
    ['an unknown role', { ...CLAIMS, role: 'admin' }],
    ['a role in another case', { ...CLAIMS, role: 'ORG_ADMIN' }],
    ['no user id', without('id')],
    ['no email', without('email')],
    ['no full name', without('fullName')],
    ['a reset token payload', { id: ZERO_UUID, purpose: 'reset' }],
    ['an audience claim (the reset audience)', { ...CLAIMS, aud: 'raqib:password-reset' }],
    ['an audience claim of any value', { ...CLAIMS, aud: 'raqib' }],
    ['a reset token payload with its audience and fingerprint', { id: ZERO_UUID, purpose: 'reset', pwd: '0123456789abcdef', aud: 'raqib:password-reset' }],
    ['a refresh token payload (refresh audience)', { ...CLAIMS, pwd: '0123456789abcdef', aud: 'raqib:refresh' }],
    ['a string', 'token'],
    ['null', null],
  ])('refuses a payload with %s', (_label, payload) => {
    expect(accessTokenUser(payload)).toBeNull();
  });
});

describe('authenticate', () => {
  const paths = ['/api/projects', `/api/projects/${ZERO_UUID}/export`];

  it.each(paths)('answers 401 to a reset token on GET %s', async path => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${generateResetToken({ id: ZERO_UUID, passwordHash: 'x' })}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Invalid or expired token' });
  });

  it.each(paths)('answers 401 to a signed token without an organisation or a role on GET %s', async path => {
    for (const auth of [
      signed(without('organizationId')), signed(without('role')), signed({ ...CLAIMS, purpose: 'reset' }),
      signed({ ...CLAIMS, aud: 'raqib:password-reset' }),
    ]) {
      const res = await request(app).get(path).set('Authorization', auth);
      expect(res.status).toBe(401);
    }
  });

  it('answers 401 to a token signed with another secret', async () => {
    const res = await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${jwt.sign(CLAIMS, 'another-secret-0123456789abcdef0123456789')}`);
    expect(res.status).toBe(401);
  });
});

describe('organisation scope', () => {
  it('answers 401, without a query, when the signed-in user has no organisation', async () => {
    const req = { user: { ...CLAIMS, organizationId: undefined } } as unknown as Request;
    const error = await assertProjectAccess(req, ZERO_UUID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 401 });
  });
});

describe.skipIf(!hasTestDatabase)('authenticate with a database', () => {
  let a: OrgFixture;
  let b: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
  });

  it('accepts a valid access token, scoped to its organisation', async () => {
    const list = await request(app).get('/api/projects').set('Authorization', a.officerAuth);
    expect(list.status).toBe(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([a.project.id]);
    const exported = await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.officerAuth);
    expect(exported.status).toBe(200);
    expect(exported.body.project.id).toBe(a.project.id);
  });

  it('refuses a reset token for a real user on both routes', async () => {
    const auth = `Bearer ${generateResetToken(a.officer)}`;
    for (const path of ['/api/projects', `/api/projects/${a.project.id}/export`, `/api/projects/${b.project.id}/export`]) {
      const res = await request(app).get(path).set('Authorization', auth);
      expect(res.status, path).toBe(401);
    }
  });

  it('still lets a reset token reset the password (the reset route verifies it itself)', async () => {
    const res = await request(app).post('/api/auth/reset-password')
      .send({ token: generateResetToken(a.officer), newPassword: 'Another-long-password-1' });
    expect(res.status).toBe(200);
    // An access token cannot be used as a reset token either.
    const refused = await request(app).post('/api/auth/reset-password')
      .send({ token: generateAccessToken({ ...CLAIMS, id: a.officer.id }), newPassword: 'Another-long-password-2' });
    expect(refused.status).toBe(401);
  });
});
