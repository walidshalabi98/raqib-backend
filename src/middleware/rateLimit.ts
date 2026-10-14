import { createHash } from 'crypto';
import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env';

const skipInTests = () => env.nodeEnv === 'test';
const message = (text: string) => ({ message: text });
/**
 * A 429 body with a code and who is limited (UX-08 b): `rate_limited` with details.scope 'user' (aiLimiter: this
 * person's hourly AI requests) or 'organisation' (kpiOrgLimiter: everyone in the organisation together), so the web app
 * can say which one, and that waiting (not retrying now) helps.
 */
const limited = (text: string, scope: 'user' | 'organisation') => ({ message: text, code: 'rate_limited', details: { scope } });

/**
 * True for a poll of a KPI suggestion run (GET /api/kpi-suggestion-runs/:id; the query string is ignored). Those polls
 * have their own per-user limit (kpiPollLimiter), so an office behind one NAT polling with ten people never exhausts the
 * per-IP apiLimiter (design sections 4.5 and 7.4, SDA-16). Reads the full URL, so it works wherever the limiter is mounted.
 */
export function isKpiRunPoll(req: Pick<Request, 'method' | 'originalUrl'>): boolean {
  if (req.method !== 'GET') return false;
  const path = (req.originalUrl ?? '').split('?')[0];
  return /^\/api\/kpi-suggestion-runs\/[^/]+\/?$/.test(path);
}

/** Rate-limit key for a signed-in user (after `authenticate`), falling back to the client IP. */
export function userKey(req: Request): string {
  return req.user?.id ?? ipKeyGenerator(req.ip ?? '');
}

/**
 * Rate-limit key for the caller's organisation (after `authenticate`), falling back to the client IP. Organisation ids
 * and user ids are both UUIDs, so the prefix keeps the two key spaces apart.
 */
export function organisationKey(req: Request): string {
  return req.user?.organizationId ? `org:${req.user.organizationId}` : ipKeyGenerator(req.ip ?? '');
}

/** Baseline limit for every API request, per IP. KPI run polls are skipped (kpiPollLimiter limits them per user). */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: req => skipInTests() || isKpiRunPoll(req),
  message: message('Too many requests. Please wait a minute and try again.'),
});

/**
 * The limits of /api/auth (docs/SECURITY_SETUP.md §9), each with its own count, so one kind of request cannot
 * use up another's: testers behind one office address who sign in, change a password and refresh their session
 * every 15 minutes are not signed out by the refreshes, and a burst of refreshes does not block sign-in.
 * `skip` is replaceable so tests/rateLimit.test.ts can check the real limits.
 */
export function createAuthLimiters(skip: () => boolean = skipInTests) {
  const window15 = 15 * 60 * 1000;
  const common = { standardHeaders: 'draft-8' as const, legacyHeaders: false, skip };
  return {
    /** Sign-in, per IP: 30 failed attempts in 15 minutes (successful sign-ins are not counted). */
    signIn: rateLimit({
      ...common,
      windowMs: window15,
      limit: 30,
      skipSuccessfulRequests: true,
      message: message('Too many sign-in attempts. Please wait 15 minutes and try again.'),
    }),
    /** Session refresh, per IP: generous, since every open tab refreshes every 15 minutes. */
    refresh: rateLimit({
      ...common,
      windowMs: window15,
      limit: 300,
      message: message('Too many requests. Please wait a few minutes and try again.'),
    }),
    /** "Forgot password?" and reset links, per IP. */
    passwordReset: rateLimit({
      ...common,
      windowMs: window15,
      limit: 30,
      message: message('Too many password reset attempts. Please wait 15 minutes and try again.'),
    }),
    /**
     * "Forgot password?", per email address (5 an hour): stops anyone from filling one person's inbox. The key
     * is a hash of the lower-cased address, so no address is kept in memory. A request without an email is
     * answered 400 by the route and counted by IP.
     */
    forgotPasswordPerEmail: rateLimit({
      ...common,
      windowMs: 60 * 60 * 1000,
      limit: 5,
      keyGenerator: (req: Request) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        return email ? `email:${createHash('sha256').update(email).digest('hex')}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
      },
      message: message('Too many password reset attempts. Please wait an hour and try again.'),
    }),
    /** Change password, per signed-in user (use after `authenticate`): 10 in 15 minutes, so guessing the current password is slow. */
    changePassword: rateLimit({
      ...common,
      windowMs: window15,
      limit: 10,
      keyGenerator: (req: Request) => (req.user?.id ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? '')}`),
      message: message('Too many password change attempts. Please wait 15 minutes and try again.'),
    }),
  };
}

/** The limiters /api/auth uses (src/routes/auth.ts). */
export const authLimiters = createAuthLimiters();

/** Limit for endpoints that call an AI model, per user (use after `authenticate`). */
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: userKey,
  message: limited('AI request limit reached for this hour. Please try again later.', 'user'),
});

/**
 * KPI Assistant requests (POST /api/projects/:id/kpi-suggestions and the alternatives alias): 120 per hour per
 * organisation, on top of the per-user aiLimiter (use after `authenticate`; design D20, section 4.5).
 */
export const kpiOrgLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: organisationKey,
  message: limited('Your organisation reached the hourly limit for KPI suggestions. Please try again later.', 'organisation'),
});

/**
 * Polls of GET /api/kpi-suggestion-runs/:id: 240 per minute per user (use after `authenticate`); the per-IP apiLimiter
 * skips these requests (isKpiRunPoll; design 4.5 and 7.4).
 */
export const kpiPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: userKey,
  message: message('Too many progress checks. Please wait a minute and try again.'),
});

/** Limit for inbound webhooks, per IP. */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipInTests,
  message: message('Too many webhook requests.'),
});
