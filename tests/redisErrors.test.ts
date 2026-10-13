import { describe, expect, it } from 'vitest';
import { createRedisErrorLogger, describeRedisError, redisUrlPassword } from '../src/config/redisErrors';

// Made-up values: no real password appears in this file.
const PASSWORD = 'not-a-real-redis-password';

/** What ioredis raises when HELLO is refused: the command, with the password, travels on the error object. */
function wrongPassError(): Error {
  const err = new Error('WRONGPASS invalid username-password pair or user is disabled.');
  err.name = 'ReplyError';
  Object.assign(err, { command: { name: 'hello', args: ['3', 'AUTH', 'default', PASSWORD] } });
  return err;
}

describe('describeRedisError', () => {
  it('keeps the name and message and drops the command that carries the password', () => {
    const line = describeRedisError(wrongPassError(), [PASSWORD]);
    expect(line).toBe('ReplyError: WRONGPASS invalid username-password pair or user is disabled.');
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain('AUTH');
  });

  it('removes a password containing @ or other URL characters completely, also percent-encoded', () => {
    const tricky = 'p@ss/w:rd';
    const encoded = encodeURIComponent(tricky);
    const raw = new Error(`connect failed for redis://default:${tricky}@redis.internal:6379`);
    expect(describeRedisError(raw, [tricky])).toBe('Error: connect failed for redis://***@redis.internal:6379');
    const asUrl = new Error(`connect failed for redis://default:${encoded}@redis.internal:6379`);
    expect(describeRedisError(asUrl, [tricky])).toBe('Error: connect failed for redis://***@redis.internal:6379');
    expect(describeRedisError(new Error(`unexpected reply ${encoded}`), [tricky])).toBe('Error: unexpected reply ***');
    expect(describeRedisError(new Error('connect failed for redis://default:a@b@host:6379'))).toBe(
      'Error: connect failed for redis://***@host:6379',
    );
  });

  it('removes credentials from a redis:// or rediss:// URL and any known secret from the message', () => {
    const url = new Error(`connect failed for redis://default:${PASSWORD}@redis.railway.internal:6379 and rediss://user:x@host`);
    expect(describeRedisError(url)).toBe('Error: connect failed for redis://***@redis.railway.internal:6379 and rediss://***@host');
    const echoed = new Error(`unexpected reply ${PASSWORD}`);
    expect(describeRedisError(echoed, [PASSWORD])).toBe('Error: unexpected reply ***');
  });

  it('keeps the first line only, at most 200 characters, and copes with things that are not errors', () => {
    const long = new Error(`${'x'.repeat(300)}\nsecond line ${PASSWORD}`);
    const line = describeRedisError(long);
    expect(line).toBe(`Error: ${'x'.repeat(200)}`);
    expect(describeRedisError('a string')).toBe('Unknown Redis error');
    expect(describeRedisError(undefined)).toBe('Unknown Redis error');
    const empty = new Error('');
    empty.name = 'AbortError';
    expect(describeRedisError(empty)).toBe('AbortError');
  });
});

describe('redisUrlPassword', () => {
  it('reads the password of a Redis URL, decoded', () => {
    expect(redisUrlPassword(`redis://default:${PASSWORD}@localhost:6379`)).toBe(PASSWORD);
    expect(redisUrlPassword('redis://default:a%40b@localhost:6379')).toBe('a@b');
    expect(redisUrlPassword('redis://localhost:6379')).toBeUndefined();
    expect(redisUrlPassword('not a url')).toBeUndefined();
  });
});

describe('createRedisErrorLogger', () => {
  it('logs a message once a minute across all sources, then reports how often it repeated', () => {
    const lines: string[] = [];
    let time = 0;
    const handlerFor = createRedisErrorLogger({ secrets: [PASSWORD], log: line => lines.push(line), now: () => time });
    const connection = handlerFor('connection');
    const worker = handlerFor('worker document-parsing');

    connection(wrongPassError());
    worker(wrongPassError());
    time = 59_999;
    connection(wrongPassError());
    expect(lines).toEqual(['[Redis] connection: ReplyError: WRONGPASS invalid username-password pair or user is disabled.']);

    time = 60_000;
    worker(wrongPassError());
    expect(lines[1]).toBe(
      '[Redis] worker document-parsing: ReplyError: WRONGPASS invalid username-password pair or user is disabled. (repeated 2 times since the last report)',
    );

    worker(new Error('connect ECONNREFUSED 10.0.0.1:6379'));
    expect(lines[2]).toBe('[Redis] worker document-parsing: Error: connect ECONNREFUSED 10.0.0.1:6379');
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('remembers at most 50 messages: the one reported longest ago is forgotten first', () => {
    const lines: string[] = [];
    const handler = createRedisErrorLogger({ log: line => lines.push(line), now: () => 0 })('connection');
    for (let i = 0; i < 120; i += 1) handler(new Error(`distinct ${i}`));
    expect(lines).toHaveLength(120);
    handler(new Error('distinct 119'));
    handler(new Error('distinct 70'));
    expect(lines).toHaveLength(120);
    handler(new Error('distinct 0'));
    expect(lines).toHaveLength(121);
  });

  it('when full, drops messages whose minute is over before any that are still throttled', () => {
    const lines: string[] = [];
    let time = 0;
    const handler = createRedisErrorLogger({ log: line => lines.push(line), now: () => time })('connection');
    handler(new Error('hot'));
    time = 30_000;
    for (let i = 0; i < 48; i += 1) handler(new Error(`other ${i}`));
    time = 59_000;
    handler(new Error('hot'));
    handler(new Error('fiftieth'));
    expect(lines).toHaveLength(50);
    time = 61_000;
    handler(new Error('new one'));
    time = 62_000;
    handler(new Error('other 0'));
    expect(lines).toHaveLength(51);
    expect(lines.at(-1)).toBe('[Redis] connection: Error: new one');
  });
});
