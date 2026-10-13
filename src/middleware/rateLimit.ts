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

/** Stricter limit for sign-in, token refresh and password reset, per IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipInTests,
  message: message('Too many sign-in attempts. Please wait 15 minutes and try again.'),
});

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
