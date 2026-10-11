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
