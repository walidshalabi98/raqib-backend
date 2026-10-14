import dotenv from 'dotenv';
import { z } from 'zod';
import { AI_CALL_RETENTION_DEFAULT_MONTHS, AI_CALL_RETENTION_MONTHS_SCHEMA } from '../services/maintenance/aiCallRetention';

dotenv.config();

const optionalString = z
  .string()
  .optional()
  .transform(v => (v && v.trim() !== '' ? v.trim() : undefined));

const wholeNumber = z.coerce
  .number({ invalid_type_error: 'must be a number' })
  .int('must be a whole number');

/**
 * Longest timeout of one AI request (one hour), for AI_REQUEST_TIMEOUT_MS and for the per-call
 * timeouts the client sends (including the doubled one after a cut-off answer). Node clamps a
 * setTimeout delay above 2^31-1 ms to 1 ms, which would make every request time out at once.
 */
export const AI_REQUEST_TIMEOUT_MAX_MS = 3_600_000;

/** Default of AI_ORG_DAILY_BUDGET_USD (US$ per organisation per 24 hours; set by the owner on 13 October 2026, design §12.9). */
export const AI_ORG_DAILY_BUDGET_DEFAULT_USD = 20;

/** The sender of every email (EMAIL_FROM), on a domain verified in Resend. */
export const DEFAULT_EMAIL_FROM = 'Raqib by Momentum Labs <noreply@raqib.momentumlabs.ps>';

const EMAIL_ADDRESS = /[^\s@<>",;]+@[^\s@<>",;.]+(?:\.[^\s@<>",;.]+)*\.[A-Za-z]{2,}/.source;
/** "address@domain" or "Display Name <address@domain>", on one line, without quotes or angle brackets in the name. */
const EMAIL_SENDER = new RegExp(`^(?:${EMAIL_ADDRESS}|[^<>"\\r\\n]{1,100} <${EMAIL_ADDRESS}>)$`);

/** A redis:// or rediss:// URL with a host, as ioredis will parse it (WHATWG URL). */
function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'redis:' || url.protocol === 'rediss:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** An optional setting: unset or blank uses the default (so `NAME=` in .env behaves like a missing line). */
function withDefault<T extends z.ZodTypeAny>(schema: T, fallback: z.input<T>) {
  return z.preprocess(v => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v), schema.default(fallback));
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string({ required_error: 'is required' }).min(1, 'is required'),
  JWT_SECRET: z.string({ required_error: 'is required' }).min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string({ required_error: 'is required' }).min(32, 'must be at least 32 characters'),
  ANTHROPIC_API_KEY: z.string({ required_error: 'is required' }).min(10, 'is required'),

  // Model ids (trimmed; blank uses the default). Services choose a tier, never an id.
  AI_MODEL_MAIN: withDefault(z.string().min(1), 'claude-sonnet-5-5'),
  AI_MODEL_FAST: withDefault(z.string().min(1), 'claude-haiku-5-5'),
  // Per-request timeout for AI calls; long generations pass a larger timeout per call.
  AI_REQUEST_TIMEOUT_MS: withDefault(
    wholeNumber
      .min(1000, 'must be at least 1000 (milliseconds)')
      .max(AI_REQUEST_TIMEOUT_MAX_MS, `must be at most ${AI_REQUEST_TIMEOUT_MAX_MS} (one hour)`),
    60000,
  ),
  // Retries after a rate limit, overload, server error or network failure (backoff 1s, 2s, 4s… capped at 30s).
  AI_MAX_RETRIES: withDefault(wholeNumber.min(0, 'must be between 0 and 10').max(10, 'must be between 0 and 10'), 3),
  // "default": when the model supports it, a refused request is re-run server-side on Anthropic's default fallback model.
  AI_REFUSAL_FALLBACK: withDefault(z.enum(['default', 'off'], { errorMap: () => ({ message: 'must be "default" or "off"' }) }), 'default'),
  // Months an AiCall row is kept (1-120); the worker deletes older rows every night. The schema is
  // shared with `npm run ai-calls:prune`, which runs without this file.
  AI_CALL_RETENTION_MONTHS: withDefault(AI_CALL_RETENTION_MONTHS_SCHEMA, AI_CALL_RETENTION_DEFAULT_MONTHS),
  VOYAGE_API_KEY: optionalString,
  VOYAGE_MODEL: withDefault(z.string(), 'voyage-4'),
  // Organisation daily AI budget in US$ (sum of AiCall.estimatedCostUsd over the last 24 hours, every AI feature).
  // KPI suggestion requests answer 429 budget_reached once it is spent; 0 turns the check off (design D20).
  AI_ORG_DAILY_BUDGET_USD: withDefault(
    z.coerce.number({ invalid_type_error: 'must be a number' })
      .finite('must be a number')
      .min(0, 'must be 0 (no budget) or more'),
    AI_ORG_DAILY_BUDGET_DEFAULT_USD,
  ),
  // "1" logs every SQL statement Prisma sends (local debugging only); warnings are always logged.
  PRISMA_LOG_QUERIES: withDefault(z.enum(['0', '1'], { errorMap: () => ({ message: 'must be 1 (on) or 0 (off)' }) }), '0'),

  // Optional HMAC secret: when set, webhook requests carrying X-Raqib-Signature are verified with it.
  WEBHOOK_SECRET: optionalString,

  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_KEY: optionalString,
  SUPABASE_STORAGE_BUCKET: z.string().default('documents'),
  // Local fallback directory for development when Supabase Storage is not configured.
  LOCAL_STORAGE_DIR: z.string().default('storage'),

  // Holds the Redis password, so it is checked here, where a refusal names the setting but never repeats its value
  // (ioredis would throw an error carrying the whole URL). Special characters in the password must be percent-encoded.
  REDIS_URL: withDefault(
    z.string().refine(isRedisUrl, 'must be a redis:// or rediss:// URL with a host (percent-encode special characters in the password)'),
    'redis://localhost:6379',
  ),
  // Without a Resend key no email is sent (docs/SECURITY_SETUP.md §9).
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: withDefault(
    z.string().max(320).regex(EMAIL_SENDER, 'must be an email address or "Name <address@domain>" on one line'),
    DEFAULT_EMAIL_FROM,
  ),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: optionalString,
  CORS_ORIGINS: optionalString,
});

export type EnvInput = Record<string, string | undefined>;

export function parseEnv(source: EnvInput) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map(issue => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example for the required variables.`);
  }

  const e = result.data;
  // Refresh tokens are kept apart from access and reset tokens by their own secret (and audience): one value
  // for both would let a used reset link or an access token be traded for a session at /api/auth/refresh.
  if (e.JWT_SECRET === e.JWT_REFRESH_SECRET) {
    throw new Error(
      'Invalid environment configuration:\n  - JWT_REFRESH_SECRET: must be different from JWT_SECRET (generate each one separately)',
    );
  }
  if (e.NODE_ENV === 'production' && !(e.SUPABASE_URL && e.SUPABASE_SERVICE_KEY)) {
    throw new Error(
      'Invalid environment configuration:\n  - SUPABASE_URL / SUPABASE_SERVICE_KEY: required in production (documents must be stored in private Supabase Storage)',
    );
  }

  const devOrigins = ['http://localhost:5173', 'http://localhost:8080', 'http://localhost:3000'];
  const configuredOrigins = (e.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  const corsOrigins = Array.from(new Set([
    e.APP_URL,
    ...configuredOrigins,
    ...(e.NODE_ENV === 'production' ? [] : devOrigins),
  ]));

  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    jwtRefreshSecret: e.JWT_REFRESH_SECRET,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    aiModelMain: e.AI_MODEL_MAIN,
    aiModelFast: e.AI_MODEL_FAST,
    aiRequestTimeoutMs: e.AI_REQUEST_TIMEOUT_MS,
    aiMaxRetries: e.AI_MAX_RETRIES,
    aiRefusalFallback: e.AI_REFUSAL_FALLBACK,
    aiCallRetentionMonths: e.AI_CALL_RETENTION_MONTHS,
    voyageApiKey: e.VOYAGE_API_KEY,
    voyageModel: e.VOYAGE_MODEL,
    /** 0 = no budget check. */
    aiOrgDailyBudgetUsd: e.AI_ORG_DAILY_BUDGET_USD,
    prismaLogQueries: e.PRISMA_LOG_QUERIES === '1',
    webhookSecret: e.WEBHOOK_SECRET,
    supabaseUrl: e.SUPABASE_URL || '',
    supabaseServiceKey: e.SUPABASE_SERVICE_KEY || '',
    storageBucket: e.SUPABASE_STORAGE_BUCKET,
    localStorageDir: e.LOCAL_STORAGE_DIR,
    redisUrl: e.REDIS_URL,
    resendApiKey: e.RESEND_API_KEY || '',
    emailFrom: e.EMAIL_FROM,
    appUrl: e.APP_URL,
    apiUrl: e.API_URL || `http://localhost:${e.PORT}`,
    corsOrigins,
  };
}

export type Env = ReturnType<typeof parseEnv>;

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
}

export const env: Env = loadEnv();
