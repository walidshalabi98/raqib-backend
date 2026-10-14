import { describe, expect, it } from 'vitest';
import { AI_ORG_DAILY_BUDGET_DEFAULT_USD, DEFAULT_EMAIL_FROM, parseEnv } from '../src/config/env';
import { prismaLogLevels } from '../src/config/prisma';
import { aiCallPruneSettings } from '../src/services/maintenance/aiCallRetention';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/raqib',
  JWT_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  ANTHROPIC_API_KEY: 'sk-ant-0123456789',
};

describe('environment validation', () => {
  it('accepts a complete development configuration with defaults', () => {
    const env = parseEnv(valid);
    expect(env.nodeEnv).toBe('development');
    expect(env.port).toBe(3001);
    expect(env.aiModelMain).toBe('claude-sonnet-5-5');
    expect(env.aiModelFast).toBe('claude-haiku-5-5');
    expect(env.storageBucket).toBe('documents');
    expect(env.corsOrigins).toContain('http://localhost:5173');
  });

  it.each(['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'ANTHROPIC_API_KEY'])('refuses to start without %s', name => {
    const source: Record<string, string | undefined> = { ...valid, [name]: undefined };
    expect(() => parseEnv(source)).toThrow(new RegExp(`${name}: is required`));
  });

  it('refuses JWT secrets shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET: must be at least 32 characters/);
    expect(() => parseEnv({ ...valid, JWT_REFRESH_SECRET: 'x'.repeat(31) })).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('refuses one value for both JWT secrets (SR-2: a reset or access token would then pass as a refresh token)', () => {
    const same = 'c'.repeat(64);
    expect(() => parseEnv({ ...valid, JWT_SECRET: same, JWT_REFRESH_SECRET: same }))
      .toThrow(/JWT_REFRESH_SECRET: must be different from JWT_SECRET/);
    expect(() => parseEnv({ ...valid, JWT_SECRET: same, JWT_REFRESH_SECRET: `${same}d` })).not.toThrow();
  });

  it('lists every problem at once', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*JWT_REFRESH_SECRET[\s\S]*ANTHROPIC_API_KEY/);
  });

  it('requires Supabase Storage in production', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/SUPABASE_URL/);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' })).not.toThrow();
  });

  it('only allows configured browser origins in production', () => {
    const env = parseEnv({
      ...valid,
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_KEY: 'k',
      APP_URL: 'https://app.raqib.ps',
      CORS_ORIGINS: 'https://staging.raqib.ps, https://demo.raqib.ps',
    });
    expect(env.corsOrigins).toEqual(['https://app.raqib.ps', 'https://staging.raqib.ps', 'https://demo.raqib.ps']);
  });

  it('treats empty optional values as unset', () => {
    const env = parseEnv({ ...valid, WEBHOOK_SECRET: '', VOYAGE_API_KEY: '  ' });
    expect(env.webhookSecret).toBeUndefined();
    expect(env.voyageApiKey).toBeUndefined();
  });
});

describe('EMAIL_FROM', () => {
  it('defaults to the Raqib by Momentum Labs sender (also when blank)', () => {
    expect(parseEnv(valid).emailFrom).toBe('Raqib by Momentum Labs <noreply@raqib.momentumlabs.ps>');
    expect(parseEnv({ ...valid, EMAIL_FROM: '  ' }).emailFrom).toBe(DEFAULT_EMAIL_FROM);
  });

  it.each(['Raqib Staging <staging@raqib.example.org>', 'noreply@raqib.momentumlabs.ps', ' Raqib <a.b+c@mail.example.co.uk> '])(
    'accepts %s',
    value => {
      expect(parseEnv({ ...valid, EMAIL_FROM: value }).emailFrom).toBe(value.trim());
    },
  );

  it.each([
    ['no address', 'Raqib'],
    ['no domain dot', 'Raqib <noreply@localhost>'],
    ['two addresses', 'a@example.org, b@example.org'],
    ['a line break (header injection)', 'Raqib <a@example.org>\nBcc: x@example.org'],
    ['angle brackets in the name', 'Ra<qib <a@example.org>'],
    ['quotes in the name', '"Raqib" <a@example.org>'],
    ['a missing closing bracket', 'Raqib <a@example.org'],
  ])('refuses a sender with %s', (_label, value) => {
    expect(() => parseEnv({ ...valid, EMAIL_FROM: value })).toThrow(/EMAIL_FROM: must be an email address/);
  });
});

describe('AI client settings', () => {
  it('has defaults', () => {
    const env = parseEnv(valid);
    expect(env.aiRequestTimeoutMs).toBe(60000);
    expect(env.aiMaxRetries).toBe(3);
    expect(env.aiRefusalFallback).toBe('default');
    expect(env.voyageModel).toBe('voyage-4');
  });

  it('reads configured values', () => {
    const env = parseEnv({
      ...valid,
      AI_REQUEST_TIMEOUT_MS: '120000',
      AI_MAX_RETRIES: '0',
      AI_REFUSAL_FALLBACK: 'off',
      VOYAGE_MODEL: ' voyage-4-lite ',
      AI_MODEL_MAIN: 'claude-opus-5-5',
    });
    expect(env.aiRequestTimeoutMs).toBe(120000);
    expect(env.aiMaxRetries).toBe(0);
    expect(env.aiRefusalFallback).toBe('off');
    expect(env.voyageModel).toBe('voyage-4-lite');
    expect(env.aiModelMain).toBe('claude-opus-5-5');
    expect(parseEnv({ ...valid, AI_MAX_RETRIES: '10', AI_REQUEST_TIMEOUT_MS: '1000' })).toMatchObject({ aiMaxRetries: 10, aiRequestTimeoutMs: 1000 });
  });

  it('uses the defaults for blank values (NAME= in .env)', () => {
    const env = parseEnv({ ...valid, AI_REQUEST_TIMEOUT_MS: '', AI_MAX_RETRIES: ' ', AI_REFUSAL_FALLBACK: '', VOYAGE_MODEL: '' });
    expect(env).toMatchObject({ aiRequestTimeoutMs: 60000, aiMaxRetries: 3, aiRefusalFallback: 'default', voyageModel: 'voyage-4' });
  });

  it('uses the default model ids for blank values and trims configured ones', () => {
    // e.g. docker-compose `AI_MODEL_MAIN=${AI_MODEL_MAIN}` with the variable unset
    expect(parseEnv({ ...valid, AI_MODEL_MAIN: '', AI_MODEL_FAST: '   ' })).toMatchObject({ aiModelMain: 'claude-sonnet-5-5', aiModelFast: 'claude-haiku-5-5' });
    expect(parseEnv({ ...valid, AI_MODEL_MAIN: ' claude-opus-5-5 ', AI_MODEL_FAST: '\tclaude-haiku-4-5\n' })).toMatchObject({
      aiModelMain: 'claude-opus-5-5',
      aiModelFast: 'claude-haiku-4-5',
    });
  });

  it('accepts a request timeout of up to one hour', () => {
    expect(parseEnv({ ...valid, AI_REQUEST_TIMEOUT_MS: '3600000' }).aiRequestTimeoutMs).toBe(3_600_000);
  });

  it.each([
    ['AI_REQUEST_TIMEOUT_MS', '999', /AI_REQUEST_TIMEOUT_MS: must be at least 1000/],
    ['AI_REQUEST_TIMEOUT_MS', 'sixty', /AI_REQUEST_TIMEOUT_MS: must be a number/],
    ['AI_REQUEST_TIMEOUT_MS', '1500.5', /AI_REQUEST_TIMEOUT_MS: must be a whole number/],
    ['AI_REQUEST_TIMEOUT_MS', '3600001', /AI_REQUEST_TIMEOUT_MS: must be at most 3600000 \(one hour\)/],
    // Above 2^31-1 ms Node's setTimeout fires after 1 ms, so every request would time out at once.
    ['AI_REQUEST_TIMEOUT_MS', '9999999999999', /AI_REQUEST_TIMEOUT_MS: must be at most 3600000/],
    ['AI_MAX_RETRIES', '11', /AI_MAX_RETRIES: must be between 0 and 10/],
    ['AI_MAX_RETRIES', '-1', /AI_MAX_RETRIES: must be between 0 and 10/],
    ['AI_MAX_RETRIES', '2.5', /AI_MAX_RETRIES: must be a whole number/],
    ['AI_REFUSAL_FALLBACK', 'on', /AI_REFUSAL_FALLBACK: must be "default" or "off"/],
  ])('refuses %s=%s', (name, value, message) => {
    expect(() => parseEnv({ ...valid, [name]: value })).toThrow(message);
  });
});

describe('AiCall retention setting', () => {
  it('keeps AiCall rows for 24 months by default, also for a blank value', () => {
    expect(parseEnv(valid).aiCallRetentionMonths).toBe(24);
    expect(parseEnv({ ...valid, AI_CALL_RETENTION_MONTHS: '' }).aiCallRetentionMonths).toBe(24);
    expect(parseEnv({ ...valid, AI_CALL_RETENTION_MONTHS: '  ' }).aiCallRetentionMonths).toBe(24);
  });

  it.each([['1', 1], [' 36 ', 36], ['120', 120]])('reads AI_CALL_RETENTION_MONTHS=%s', (value, months) => {
    expect(parseEnv({ ...valid, AI_CALL_RETENTION_MONTHS: value }).aiCallRetentionMonths).toBe(months);
  });

  it.each([
    ['0', /AI_CALL_RETENTION_MONTHS: must be between 1 and 120/],
    ['-6', /AI_CALL_RETENTION_MONTHS: must be between 1 and 120/],
    ['121', /AI_CALL_RETENTION_MONTHS: must be between 1 and 120/],
    ['12.5', /AI_CALL_RETENTION_MONTHS: must be a whole number/],
    ['two years', /AI_CALL_RETENTION_MONTHS: must be a number/],
  ])('refuses AI_CALL_RETENTION_MONTHS=%s', (value, message) => {
    expect(() => parseEnv({ ...valid, AI_CALL_RETENTION_MONTHS: value })).toThrow(message);
  });

  it.each([undefined, '', ' ', '1', '24', ' 60 ', '120', '0', '121', '12.5', 'two years'])(
    'npm run ai-calls:prune reads AI_CALL_RETENTION_MONTHS=%j like the API',
    value => {
      const cli = () => aiCallPruneSettings({ DATABASE_URL: valid.DATABASE_URL, AI_CALL_RETENTION_MONTHS: value });
      const api = () => parseEnv({ ...valid, AI_CALL_RETENTION_MONTHS: value });
      let apiMonths: number | undefined;
      try {
        apiMonths = api().aiCallRetentionMonths;
      } catch (err) {
        const message = /AI_CALL_RETENTION_MONTHS: (.*)/.exec((err as Error).message)![1];
        expect(cli).toThrow(`AI_CALL_RETENTION_MONTHS ${message}`);
        return;
      }
      expect(cli().months).toBe(apiMonths);
    },
  );

  it('the prune script needs DATABASE_URL but none of the API secrets', () => {
    expect(aiCallPruneSettings({ DATABASE_URL: valid.DATABASE_URL })).toEqual({ months: 24 });
    expect(() => aiCallPruneSettings({ DATABASE_URL: ' ' })).toThrow(/DATABASE_URL is required/);
  });
});

describe('KPI Assistant cost limit (AI_ORG_DAILY_BUDGET_USD, design D20)', () => {
  it('defaults to US$20 per organisation per day (owner decision, 13 October 2026), also for a blank value', () => {
    expect(AI_ORG_DAILY_BUDGET_DEFAULT_USD).toBe(20);
    expect(parseEnv(valid).aiOrgDailyBudgetUsd).toBe(20);
    expect(parseEnv({ ...valid, AI_ORG_DAILY_BUDGET_USD: '' }).aiOrgDailyBudgetUsd).toBe(20);
    expect(parseEnv({ ...valid, AI_ORG_DAILY_BUDGET_USD: '  ' }).aiOrgDailyBudgetUsd).toBe(20);
  });

  it.each([['0', 0], ['12.5', 12.5], [' 100 ', 100]])('reads AI_ORG_DAILY_BUDGET_USD=%j (0 turns the check off)', (value, budget) => {
    expect(parseEnv({ ...valid, AI_ORG_DAILY_BUDGET_USD: value }).aiOrgDailyBudgetUsd).toBe(budget);
  });

  it.each([
    ['-1', /AI_ORG_DAILY_BUDGET_USD: must be 0 \(no budget\) or more/],
    ['ten', /AI_ORG_DAILY_BUDGET_USD: must be a number/],
    ['Infinity', /AI_ORG_DAILY_BUDGET_USD: must be a number/],
  ])('refuses AI_ORG_DAILY_BUDGET_USD=%s', (value, message) => {
    expect(() => parseEnv({ ...valid, AI_ORG_DAILY_BUDGET_USD: value })).toThrow(message);
  });
});

describe('Prisma query logging (PRISMA_LOG_QUERIES)', () => {
  it('is off by default (also in development and for a blank value) and on only with 1', () => {
    expect(parseEnv(valid).prismaLogQueries).toBe(false);
    expect(parseEnv({ ...valid, NODE_ENV: 'development', PRISMA_LOG_QUERIES: '' }).prismaLogQueries).toBe(false);
    expect(parseEnv({ ...valid, PRISMA_LOG_QUERIES: '0' }).prismaLogQueries).toBe(false);
    expect(parseEnv({ ...valid, PRISMA_LOG_QUERIES: ' 1 ' }).prismaLogQueries).toBe(true);
  });

  it.each(['true', 'yes', '2'])('refuses PRISMA_LOG_QUERIES=%s', value => {
    expect(() => parseEnv({ ...valid, PRISMA_LOG_QUERIES: value })).toThrow(/PRISMA_LOG_QUERIES: must be 1 \(on\) or 0 \(off\)/);
  });

  it('logs warnings always and queries only when asked; never the error level (it would print query values)', () => {
    expect(prismaLogLevels(false)).toEqual(['warn']);
    expect(prismaLogLevels(true)).toEqual(['query', 'warn']);
    expect(prismaLogLevels(true)).not.toContain('error');
  });
});

describe('REDIS_URL', () => {
  // Made-up password: the refusal must never repeat it, since ioredis would print the whole URL.
  const PASSWORD = 'not-a-real-redis-password';

  it('defaults for unset or blank values and trims a configured URL', () => {
    expect(parseEnv(valid).redisUrl).toBe('redis://localhost:6379');
    expect(parseEnv({ ...valid, REDIS_URL: '  ' }).redisUrl).toBe('redis://localhost:6379');
    const url = `redis://default:${PASSWORD}@redis.railway.internal:6379`;
    expect(parseEnv({ ...valid, REDIS_URL: ` ${url} ` }).redisUrl).toBe(url);
    expect(parseEnv({ ...valid, REDIS_URL: 'rediss://default:a%2Fb%40c@cache.example.org:6380' }).redisUrl)
      .toBe('rediss://default:a%2Fb%40c@cache.example.org:6380');
  });

  it.each([
    ['a password with an unencoded /', `redis://default:${PASSWORD}/x@redis.railway.internal:6379`],
    ['a password with an unencoded #', `redis://default:${PASSWORD}#x@redis.railway.internal:6379`],
    ['an empty host', `redis://default:${PASSWORD}@:6379`],
    ['another scheme', `http://default:${PASSWORD}@redis.railway.internal:6379`],
    ['no scheme', `default:${PASSWORD}@redis.railway.internal:6379`],
  ])('refuses %s, naming the setting without repeating its value', (_case, value) => {
    let message = '';
    try {
      parseEnv({ ...valid, REDIS_URL: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/REDIS_URL: must be a redis:\/\/ or rediss:\/\/ URL with a host/);
    expect(message).not.toContain(PASSWORD);
  });
});
