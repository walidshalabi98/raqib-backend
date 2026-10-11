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
