import dotenv from 'dotenv';
import { z } from 'zod';

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
  VOYAGE_API_KEY: optionalString,
  VOYAGE_MODEL: withDefault(z.string(), 'voyage-4'),

  // Optional HMAC secret: when set, webhook requests carrying X-Raqib-Signature are verified with it.
  WEBHOOK_SECRET: optionalString,

  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_KEY: optionalString,
  SUPABASE_STORAGE_BUCKET: z.string().default('documents'),
  // Local fallback directory for development when Supabase Storage is not configured.
  LOCAL_STORAGE_DIR: z.string().default('storage'),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  RESEND_API_KEY: optionalString,
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
    voyageApiKey: e.VOYAGE_API_KEY,
    voyageModel: e.VOYAGE_MODEL,
    webhookSecret: e.WEBHOOK_SECRET,
    supabaseUrl: e.SUPABASE_URL || '',
    supabaseServiceKey: e.SUPABASE_SERVICE_KEY || '',
    storageBucket: e.SUPABASE_STORAGE_BUCKET,
    localStorageDir: e.LOCAL_STORAGE_DIR,
    redisUrl: e.REDIS_URL,
    resendApiKey: e.RESEND_API_KEY || '',
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
