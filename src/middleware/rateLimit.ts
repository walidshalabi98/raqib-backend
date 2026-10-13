import { createHash } from 'crypto';
import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env';

const skipInTests = () => env.nodeEnv === 'test';
const message = (text: string) => ({ message: text });

/** Baseline limit for every API request, per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipInTests,
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
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  message: message('AI request limit reached for this hour. Please try again later.'),
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
