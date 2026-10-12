import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

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
