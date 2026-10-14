import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every Redis client, queue and worker logs its errors through config/redisErrors.ts, never as a whole error object
 * (which carries the AUTH command with the password). ioredis and BullMQ are replaced by event emitters here, so no
 * Redis server is needed. Made-up values only.
 */
const fake = vi.hoisted(() => ({
  password: 'not-a-real-redis-password',
  throwOnConnect: false,
}));

vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeRedis extends EventEmitter {
    constructor() {
      super();
      if (fake.throwOnConnect) {
        // What ioredis throws for a URL it cannot parse: Node's TypeError, with the whole URL in `input`.
        throw Object.assign(new TypeError('Invalid URL'), {
          code: 'ERR_INVALID_URL',
          input: `redis://default:${fake.password}@:6379`,
        });
      }
    }
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  class Queue extends EventEmitter {
    constructor(public name: string) {
      super();
    }
  }
  return { Queue };
});

/** The error ioredis raises when HELLO is refused: the command with the password travels on the error. */
function errorWithCommand(message: string, name = 'ReplyError'): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, { command: { name: 'hello', args: ['3', 'AUTH', 'default', fake.password] } });
  return err;
}

let lines: string[];

beforeEach(() => {
  vi.resetModules();
  fake.throwOnConnect = false;
  process.env.REDIS_URL = `redis://default:${fake.password}@redis.example.internal:6379`;
  lines = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
});

afterEach(() => {
  delete process.env.REDIS_URL;
  vi.restoreAllMocks();
});

describe('Redis error listeners', () => {
  it('the shared connection has one listener, which logs the name and message without the password', async () => {
    const { redis } = await import('../src/config/redis');
    expect(redis.listenerCount('error')).toBe(1);

    redis.emit('error', errorWithCommand('WRONGPASS invalid username-password pair or user is disabled.'));
    redis.emit('error', new Error(`connect failed for redis://default:${fake.password}@redis.example.internal:6379`));

    expect(lines).toEqual([
      '[Redis] connection: ReplyError: WRONGPASS invalid username-password pair or user is disabled.',
      '[Redis] connection: Error: connect failed for redis://***@redis.example.internal:6379',
    ]);
    expect(lines.join('\n')).not.toContain(fake.password);
  });

  it('every queue has a listener that names the queue and never logs the password', async () => {
    const queues = await import('../src/jobs/queues');
    // Phase 4 removed the 'indicator-alternatives' queue (KPI suggestion runs execute in the API process).
    const getters = [
      queues.getDocumentParsingQueue,
      queues.getFrameworkQueue,
      queues.getReportQueue,
      queues.getQualitativeQueue,
      queues.getMaintenanceQueue,
    ];
    // Every queue getter the module exports is in the list above, so a new queue is checked too.
    const exported = Object.entries(queues).filter(([name, value]) => /^get\w+Queue$/.test(name) && typeof value === 'function').map(([, value]) => value);
    expect(new Set(exported)).toEqual(new Set(getters));
    for (const get of getters) {
      const queue = get();
      expect(queue.listenerCount('error'), queue.name).toBe(1);
      queue.emit('error', errorWithCommand(`failure on ${queue.name}`));
      expect(lines.at(-1)).toBe(`[Redis] queue ${queue.name}: ReplyError: failure on ${queue.name}`);
    }
    expect(lines).toHaveLength(getters.length);
    expect(lines.join('\n')).not.toContain(fake.password);
  });

  it('a Redis URL ioredis cannot parse stops the process with the error name only, not the URL', async () => {
    fake.throwOnConnect = true;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);

    await expect(import('../src/config/redis')).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual(['[Redis] connection: TypeError: Invalid URL']);
  });
});

describe('where Redis connections are made', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
    });
  const sources = files(SRC).map(file => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }));
  const filesWith = (pattern: RegExp) => sources.filter(s => pattern.test(s.text)).map(s => s.file);

  it('clients, queues and workers are created only where the error listeners are attached', () => {
    expect(filesWith(/new (IORedis|Redis)\(/)).toEqual(['config/redis.ts']);
    expect(filesWith(/new Queue\(/)).toEqual(['jobs/queues.ts']);
    expect(filesWith(/new Worker\(/)).toEqual(['jobs/worker.ts']);
    expect(filesWith(/\.duplicate\(|new QueueEvents\(|new FlowProducer\(/)).toEqual([]);

    const queues = sources.find(s => s.file === 'jobs/queues.ts')!.text;
    expect(queues.match(/new Queue\(/g)).toHaveLength(1);
    expect(queues).toMatch(/function createQueue[\s\S]*?new Queue\([\s\S]*?\.on\('error', redisErrorHandler\(/);
  });

  it('every worker in jobs/worker.ts is in the loop that attaches the error listener', () => {
    const worker = sources.find(s => s.file === 'jobs/worker.ts')!.text;
    const created = [...worker.matchAll(/const (\w+) = new Worker\(/g)].map(m => m[1]).sort();
    const loop = /for \(const worker of \[([^\]]+)\]\) \{\s*worker\.on\('error', redisErrorHandler\(/.exec(worker);
    expect(created.length).toBeGreaterThan(0);
    expect(loop).not.toBeNull();
    expect(loop![1].split(',').map(name => name.trim()).filter(Boolean).sort()).toEqual(created);
    expect(worker.match(/new Worker\(/g)).toHaveLength(created.length);
  });
});
