import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/middleware/audit', () => ({
  auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  auditLog: vi.fn(),
}));

import app from '../src/app';
import { authenticate } from '../src/middleware/auth';
import { authLimiters, createAuthLimiters } from '../src/middleware/rateLimit';
import { appStack } from './routeStack';

/**
 * The /api/auth limits (SR-7): each kind of request has its own count, so testers behind one office address are
 * not signed out by refreshes, sign-in counts failures only, "Forgot password?" is also limited per address and
 * change password per user. The limiters are skipped in tests; here they are built with `skip` off.
 */

const ok = (_req: Request, res: Response) => { res.json({ ok: true }); };

/** A small app with the real limiters: POST /login answers 401 unless the body says ok. */
function limitedApp() {
  const limiters = createAuthLimiters(() => false);
  const probe = express();
  probe.use(express.json());
  probe.post('/login', limiters.signIn, (req: Request, res: Response) => {
    if (req.body?.ok) res.json({ ok: true });
    else res.status(401).json({ message: 'Invalid email or password' });
  });
  probe.post('/refresh', limiters.refresh, ok);
  probe.post('/forgot', limiters.passwordReset, limiters.forgotPasswordPerEmail, ok);
  probe.post('/reset', limiters.passwordReset, ok);
  probe.post('/change', (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: String(req.headers['x-user']), email: 'x@example.org', organizationId: 'o', role: 'me_officer', fullName: 'X' };
    next();
  }, limiters.changePassword, ok);
  return probe;
}

async function statuses(count: number, send: () => request.Test): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await send()).status);
  return out;
}

describe('auth rate limits', () => {
  it('sign-in counts failed attempts only: 30 failures per IP, then 429; successful sign-ins never count', async () => {
    const probe = limitedApp();
    expect(new Set(await statuses(40, () => request(probe).post('/login').send({ ok: true })))).toEqual(new Set([200]));
    expect(new Set(await statuses(30, () => request(probe).post('/login').send({})))).toEqual(new Set([401]));
    const blocked = await request(probe).post('/login').send({ ok: true });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
  });

  it('refresh has its own, larger count: blocked sign-ins and resets do not sign anyone out', async () => {
    const probe = limitedApp();
    await statuses(31, () => request(probe).post('/login').send({}));
    await statuses(31, () => request(probe).post('/reset').send({}));
    expect((await request(probe).post('/reset').send({})).status).toBe(429);
    expect(new Set(await statuses(300, () => request(probe).post('/refresh').send({})))).toEqual(new Set([200]));
    expect((await request(probe).post('/refresh').send({})).status).toBe(429);
  });

  it('"Forgot password?" is limited per address (5 an hour, any case), as well as per IP', async () => {
    const probe = limitedApp();
    const forgot = (email: string) => request(probe).post('/forgot').send({ email });
    expect(await statuses(5, () => forgot('Samira@Example.org'))).toEqual([200, 200, 200, 200, 200]);
    expect((await forgot(' samira@example.org ')).status).toBe(429);
    expect((await forgot('omar@example.org')).status).toBe(200);
  });

  it('forgot-password and reset links share the per-IP count', async () => {
    const probe = limitedApp();
    for (let i = 0; i < 6; i++) await request(probe).post('/forgot').send({ email: `user${i}@example.org` });
    expect(new Set(await statuses(24, () => request(probe).post('/reset').send({})))).toEqual(new Set([200]));
    expect((await request(probe).post('/reset').send({})).status).toBe(429);
  });

  it('change password is limited per user (10 in 15 minutes), not per IP', async () => {
    const probe = limitedApp();
    const change = (user: string) => request(probe).post('/change').set('x-user', user).send({});
    expect(new Set(await statuses(10, () => change('user-a')))).toEqual(new Set([200]));
    expect((await change('user-a')).status).toBe(429);
    expect((await change('user-b')).status).toBe(200);
  });
});

describe('the /api/auth routes use their limiters', () => {
  const routes = new Map(appStack(app).routes.map(route => [route.key, route]));

  it.each([
    ['post /api/auth/login', [authLimiters.signIn]],
    ['post /api/auth/refresh', [authLimiters.refresh]],
    ['post /api/auth/forgot-password', [authLimiters.passwordReset, authLimiters.forgotPasswordPerEmail]],
    ['post /api/auth/reset-password', [authLimiters.passwordReset]],
    ['post /api/auth/change-password', [authenticate, authLimiters.changePassword]],
  ] as const)('%s', (key, before) => {
    const route = routes.get(key);
    expect(route, key).toBeDefined();
    expect(route!.handlers.slice(0, before.length)).toEqual(before);
    expect(route!.handlers).toHaveLength(before.length + 1);
  });

  it('every /api/auth route is listed above', () => {
    expect([...routes.keys()].filter(key => key.includes('/api/auth/')).sort()).toEqual([
      'post /api/auth/change-password', 'post /api/auth/forgot-password', 'post /api/auth/login', 'post /api/auth/refresh',
      'post /api/auth/reset-password',
    ]);
  });
});
