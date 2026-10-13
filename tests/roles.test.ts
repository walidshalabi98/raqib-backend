import express, { NextFunction, Request, Response, Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@prisma/client';

// No database: the audit middleware would write a row for every refused write.
vi.mock('../src/middleware/audit', () => ({
  auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  auditLog: vi.fn(),
}));

import app from '../src/app';
import { auditMiddleware } from '../src/middleware/audit';
import { authenticate, authorize, RoleGuard } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';
import { aiLimiter, apiLimiter, webhookLimiter } from '../src/middleware/rateLimit';
import { ADMIN_ROLES, hasStaffRole, PLATFORM_ROLES, STAFF_ROLES } from '../src/middleware/roles';
import { authenticateWebhook } from '../src/middleware/webhookAuth';
import { generateAccessToken, generateResetToken } from '../src/utils/tokens';
import { ADMIN, AI_ROUTES, NON_GET_WITHOUT_AUTHORIZE, PA, ROLE_MATRIX, STAFF } from './roleMatrix';
import { AppStack, appStack, RouteLayer } from './routeStack';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const stack = appStack(app);
const routes = stack.routes;
const byKey = new Map(routes.map(r => [r.key, r]));

const isGuard = (handler: unknown): handler is RoleGuard =>
  typeof handler === 'function' && Array.isArray((handler as Partial<RoleGuard>).allowedRoles);
const guardsOf = (route: RouteLayer): RoleGuard[] => route.handlers.filter(isGuard);
const sorted = (roles: readonly string[]) => [...roles].sort();

function tokenFor(role: string): string {
  return `Bearer ${generateAccessToken({
    id: ZERO_UUID, organizationId: ZERO_UUID, email: 'role-test@example.org', fullName: 'Role test', role: role as UserRole,
  })}`;
}

const arrayRoutes = Object.entries(ROLE_MATRIX)
  .filter((entry): entry is [string, readonly UserRole[]] => Array.isArray(entry[1]));

function send(key: string, auth: string) {
  const [method, path] = key.split(' ') as ['get' | 'post' | 'patch' | 'delete', string];
  return request(app)[method](path.replace(/:\w+/g, ZERO_UUID)).set('Authorization', auth);
}

/** Middleware reviewed for src/app.ts, by identity where the module exports it. */
const REVIEWED_BY_IDENTITY = new Map<unknown, string>([
  [apiLimiter, 'apiLimiter'], [webhookLimiter, 'webhookLimiter'],
  [auditMiddleware, 'auditMiddleware'], [authenticateWebhook, 'authenticateWebhook'], [errorHandler, 'errorHandler'],
]);
/** Created inline in src/app.ts (Express's own, helmet, cors, the body parsers): reviewed by name, and only for every path. */
const REVIEWED_GLOBAL_BY_NAME = new Set(['query', 'expressInit', 'helmetMiddleware', 'corsMiddleware', 'jsonParser', 'urlencodedParser']);

/** Every layer that is not a route or a router, as "path name"; anything not reviewed is marked UNREVIEWED. */
function layerReview({ middleware }: AppStack): string[] {
  return middleware.map(m => {
    const name = REVIEWED_BY_IDENTITY.get(m.handle) ?? (m.path === '' && REVIEWED_GLOBAL_BY_NAME.has(m.name) ? m.name : `UNREVIEWED ${m.name}`);
    return `${m.path || '/'} ${name}`;
  });
}

describe('every layer of the app is reviewed', () => {
  it('has only routes, routers and the reviewed middleware, in this order', () => {
    // A new app.use / router.use layer fails here until it is reviewed: an endpoint written as middleware,
    // a sub-app or a wrapped router would otherwise escape the role matrix and the checks below.
    expect(layerReview(stack)).toEqual([
      '/ query', '/ expressInit', '/ helmetMiddleware', '/ corsMiddleware', '/ jsonParser', '/ urlencodedParser',
      // /api/auth has no shared limiter: each of its routes has its own (tests/rateLimit.test.ts).
      '/api apiLimiter', '/api auditMiddleware', '/api/webhooks webhookLimiter',
      '/api/webhooks authenticateWebhook', '/ errorHandler',
    ]);
  });

  it('flags endpoints that are not routes: middleware endpoints, sub-apps, wrapped routers and static files', () => {
    const handler = (_req: Request, res: Response) => { res.json({ ok: true }); };
    const probe = express();
    probe.use('/api/zz/projects/:id/beneficiary-list', authenticate, handler);
    const sub = express();
    sub.delete('/documents/:id', authenticate, handler);
    probe.use('/api/zz/v2', sub);
    const wrapped = Router();
    wrapped.post('/projects/:id/kpi/suggest', authenticate, handler);
    probe.use('/api/zz/kpi', (req: Request, res: Response, next: NextFunction) => wrapped(req, res, next));
    probe.use('/api/zz/files', express.static('/nonexistent'));
    const plain = Router();
    plain.get('/x', handler);
    probe.use('/api/zz/plain', plain);

    const probeStack = appStack(probe);
    const flagged = layerReview(probeStack).filter(line => line.includes(' UNREVIEWED '));
    expect(flagged.map(line => line.split(' UNREVIEWED ')[1])).toEqual(['authenticate', 'handler', 'mounted_app', '<anonymous>', 'serveStatic']);
    expect(flagged[0]).toMatch(/^\/api\/zz\/projects.*\/beneficiary-list /);
    // A router is walked into whatever its name, so its routes meet the role matrix.
    expect(probeStack.routes.map(r => r.key)).toEqual(['get /api/zz/plain/x']);
  });
});

describe('role constants', () => {
  it('match the literal lists the matrix uses', () => {
    expect(sorted(STAFF_ROLES)).toEqual(sorted(STAFF));
    expect(sorted(ADMIN_ROLES)).toEqual(sorted(ADMIN));
    expect(sorted(PLATFORM_ROLES)).toEqual(sorted(PA));
    expect(STAFF_ROLES).not.toContain('donor_viewer');
  });

  it('hasStaffRole denies by default', () => {
    for (const role of STAFF) expect(hasStaffRole({ role })).toBe(true);
    for (const user of [{ role: 'donor_viewer' }, { role: undefined }, { role: '' }, { role: 'admin' }, { role: ['org_admin'] }, {}, null, undefined]) {
      expect(hasStaffRole(user as { role?: unknown })).toBe(false);
    }
  });
});

describe('authorize', () => {
  const run = (guard: RoleGuard, user: unknown) => {
    const res = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    const next = vi.fn();
    guard({ user } as Request, res as unknown as Response, next);
    return { res, next };
  };

  it('is tagged with a frozen copy of its roles', () => {
    const guard = authorize('org_admin', 'me_officer');
    expect(guard.allowedRoles).toEqual(['org_admin', 'me_officer']);
    expect(Object.isFrozen(guard.allowedRoles)).toBe(true);
  });

  it('refuses an empty role list instead of allowing everyone', () => {
    const untyped = authorize as unknown as (...roles: UserRole[]) => RoleGuard;
    expect(() => untyped()).toThrow(/at least one role/);
  });

  it('allows only exact roles: 401 without a user, 403 for other, missing or unknown roles', () => {
    const guard = authorize('org_admin');
    expect(run(guard, undefined).res.statusCode).toBe(401);
    for (const user of [{ role: 'me_officer' }, { role: 'donor_viewer' }, { role: undefined }, { id: ZERO_UUID }, { role: 'ORG_ADMIN' }, { role: 'org_admin ' }]) {
      const { res, next } = run(guard, user);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ message: 'Insufficient permissions' });
      expect(next).not.toHaveBeenCalled();
    }
    const ok = run(guard, { role: 'org_admin' });
    expect(ok.next).toHaveBeenCalledOnce();
  });
});

describe('role matrix', () => {
  it('has a role decision for every registered route, and a route for every decision', () => {
    const registered = routes.map(r => r.key).sort();
    const decided = Object.keys(ROLE_MATRIX).sort();
    expect(registered.filter(k => !(k in ROLE_MATRIX))).toEqual([]);
    expect(decided.filter(k => !byKey.has(k))).toEqual([]);
    expect(registered).toHaveLength(87);
  });

  it.each(Object.entries(ROLE_MATRIX))('%s matches its entry exactly', (key, access) => {
    const route = byKey.get(key)!;
    const guards = guardsOf(route);
    if (Array.isArray(access)) {
      expect(guards).toHaveLength(1);
      expect(sorted(guards[0].allowedRoles)).toEqual(sorted(access));
      // authorize comes straight after authenticate: before multer and any rate limiter.
      expect(route.handlers[0]).toBe(authenticate);
      expect(route.handlers[1]).toBe(guards[0]);
    } else if (access === 'all' || access === 'self') {
      expect(route.handlers[0]).toBe(authenticate);
      expect(guards).toEqual([]);
    } else {
      expect(route.handlers).not.toContain(authenticate);
      expect(guards).toEqual([]);
      if (access === 'webhook') expect(route.routerMiddleware).toContain(authenticateWebhook);
      else expect(route.routerMiddleware).not.toContain(authenticateWebhook);
    }
  });

  it('every non-GET route has a guard without donor_viewer, or is on the reviewed allowlist', () => {
    const open = routes
      .filter(r => r.method !== 'get')
      .filter(r => !guardsOf(r).some(g => !g.allowedRoles.includes('donor_viewer')))
      .map(r => r.key)
      .sort();
    expect(open).toEqual(Object.keys(NON_GET_WITHOUT_AUTHORIZE).sort());
    expect(Object.keys(NON_GET_WITHOUT_AUTHORIZE)).toHaveLength(9);
  });

  // The known AI routes, by their limiter and the reviewed list. tests/donorAi.test.ts does not rely on either: it calls
  // every route open to donor viewers through the real AI services and checks that the model client is never reached.
  it('every route with the AI limiter is an AI route, and no AI route is open to donor viewers', () => {
    const limited = routes.filter(r => r.handlers.includes(aiLimiter)).map(r => r.key);
    expect(limited.filter(k => !AI_ROUTES.has(k))).toEqual([]);
    expect(AI_ROUTES.size).toBe(9);
    for (const key of AI_ROUTES) {
      const route = byKey.get(key);
      expect(route, key).toBeDefined();
      const guards = guardsOf(route!);
      expect(guards, key).toHaveLength(1);
      expect(guards[0].allowedRoles, key).not.toContain('donor_viewer');
    }
  });

  it('a role guard always comes straight after authenticate', () => {
    for (const route of routes) {
      route.handlers.forEach((handler, i) => {
        if (isGuard(handler)) {
          expect(i, route.key).toBe(1);
          expect(route.handlers[0], route.key).toBe(authenticate);
        }
      });
    }
    const uploads = routes.filter(r => r.handlers.some(h => h?.name === 'multerMiddleware'));
    expect(uploads.map(r => r.key).sort()).toEqual(['post /api/projects/:id/documents', 'post /api/projects/:id/qualitative/upload']);
  });
});

describe('refusals (no database is reached)', () => {
  const closedToDonors = arrayRoutes.filter(([, roles]) => !roles.includes('donor_viewer'));
  const adminOnly = arrayRoutes.filter(([, roles]) => !roles.includes('me_officer'));

  it.each(closedToDonors.map(([key]) => [key]))('a donor viewer gets 403 on %s', async key => {
    const res = await send(key, tokenFor('donor_viewer'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'Insufficient permissions' });
  });

  it.each(adminOnly.map(([key]) => [key]))('an M&E officer gets 403 on %s', async key => {
    const res = await send(key, tokenFor('me_officer'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'Insufficient permissions' });
  });

  // Access tokens must carry an organisation and a role; reset tokens are refused (tests/accessToken.test.ts).
  it.each(arrayRoutes.map(([key]) => [key]))('a reset token gets 401 on %s', async key => {
    const res = await send(key, `Bearer ${generateResetToken({ id: ZERO_UUID, passwordHash: 'x' })}`);
    expect(res.status).toBe(401);
  });

  it.each(closedToDonors.map(([key]) => [key]))('an unknown role gets 401 on %s', async key => {
    const res = await send(key, tokenFor('admin'));
    expect(res.status).toBe(401);
  });

  it('refuses a donor upload before the file is read', async () => {
    const res = await request(app)
      .post(`/api/projects/${ZERO_UUID}/documents`)
      .set('Authorization', tokenFor('donor_viewer'))
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'list.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(403);
  });
});
