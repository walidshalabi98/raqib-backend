import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import {
  AI_CALL_PRUNE_BATCH_SIZE,
  aiCallRetentionCutoff,
  pruneAiCalls,
  PRUNE_AI_CALLS_JOB,
  PRUNE_AI_CALLS_SCHEDULE,
  runAiCallPruneCli,
  runMaintenanceJob,
  scheduleAiCallPruning,
} from '../src/services/maintenance/aiCallRetention';
import { createOrgFixture, hasTestDatabase, resetDatabase } from './helpers';

const NOW = new Date('2026-10-12T02:30:00.000Z');
const CUTOFF_24 = new Date('2024-10-12T02:30:00.000Z');

describe('aiCallRetentionCutoff', () => {
  it.each([
    ['2026-10-12T02:30:00.000Z', 24, '2024-10-12T02:30:00.000Z'],
    // Leap day: clamped to the end of February in a common year, kept in a leap year.
    ['2028-02-29T10:20:30.456Z', 24, '2026-02-28T10:20:30.456Z'],
    ['2028-02-29T10:20:30.456Z', 48, '2024-02-29T10:20:30.456Z'],
    ['2024-02-29T00:00:00.000Z', 12, '2023-02-28T00:00:00.000Z'],
    // Month ends.
    ['2026-03-31T12:00:00.000Z', 1, '2026-02-28T12:00:00.000Z'],
    ['2028-03-31T12:00:00.000Z', 1, '2028-02-29T12:00:00.000Z'],
    ['2026-05-31T08:00:00.000Z', 1, '2026-04-30T08:00:00.000Z'],
    ['2026-07-31T08:00:00.000Z', 1, '2026-06-30T08:00:00.000Z'],
    ['2026-03-30T08:00:00.000Z', 1, '2026-02-28T08:00:00.000Z'],
    ['2026-03-28T08:00:00.000Z', 1, '2026-02-28T08:00:00.000Z'],
    // January and December boundaries.
    ['2026-01-15T09:00:00.000Z', 1, '2025-12-15T09:00:00.000Z'],
    ['2026-01-31T09:00:00.000Z', 2, '2025-11-30T09:00:00.000Z'],
    ['2026-12-31T23:59:59.999Z', 12, '2025-12-31T23:59:59.999Z'],
    ['2026-12-31T23:59:59.999Z', 11, '2026-01-31T23:59:59.999Z'],
    ['2025-12-31T23:59:59.999Z', 1, '2025-11-30T23:59:59.999Z'],
    ['2026-01-01T00:00:00.000Z', 1, '2025-12-01T00:00:00.000Z'],
    ['2026-01-01T00:00:00.000Z', 13, '2024-12-01T00:00:00.000Z'],
    // The longest retention (ten years).
    ['2030-05-31T06:00:00.000Z', 120, '2020-05-31T06:00:00.000Z'],
  ])('%s minus %i months is %s', (now, months, expected) => {
    expect(aiCallRetentionCutoff(new Date(now), months).toISOString()).toBe(expected);
  });

  it('leaves the given date unchanged', () => {
    const now = new Date('2026-03-31T12:00:00.000Z');
    aiCallRetentionCutoff(now, 1);
    expect(now.toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });

  it('counts in UTC whatever the process time zone', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const now = new Date('2026-03-01T00:30:00.000Z');
      expect(now.getDate()).toBe(28); // still 28 February in Los Angeles
      expect(aiCallRetentionCutoff(now, 1).toISOString()).toBe('2026-02-01T00:30:00.000Z');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it.each([0, -1, 1.5, 121, Number.NaN])('refuses %s months', months => {
    expect(() => aiCallRetentionCutoff(NOW, months)).toThrow(RangeError);
  });

  it('refuses an invalid date', () => {
    expect(() => aiCallRetentionCutoff(new Date('not a date'), 24)).toThrow(/invalid date/);
  });
});

describe('pruneAiCalls batching (fake database)', () => {
  function fakeDb(batches: number[], count = 0) {
    const executeRaw = vi.fn();
    for (const n of batches) executeRaw.mockResolvedValueOnce(n);
    return { db: { $executeRaw: executeRaw, aiCall: { count: vi.fn().mockResolvedValue(count) } } as unknown as PrismaClient, executeRaw };
  }

  it('deletes batch after batch until one deletes fewer rows than the batch size', async () => {
    const { db, executeRaw } = fakeDb([3, 3, 1]);
    const log = vi.fn();
    const result = await pruneAiCalls({ prisma: db, now: NOW, months: 24, batchSize: 3, log });
    expect(result).toEqual({ dryRun: false, cutoff: CUTOFF_24, deleted: 7, batches: 3 });
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(log.mock.calls).toEqual([['[maintenance] AiCall retention: deleted 7 rows created before 2024-10-12T02:30:00.000Z (retention 24 months) in 3 batches']]);
  });

  it('says "1 row" and "1 batch"', async () => {
    const { db } = fakeDb([1]);
    const log = vi.fn();
    await pruneAiCalls({ prisma: db, now: NOW, months: 24, log });
    expect(log.mock.calls).toEqual([['[maintenance] AiCall retention: deleted 1 row created before 2024-10-12T02:30:00.000Z (retention 24 months) in 1 batch']]);
  });

  it('stops after an empty batch when the rows fill whole batches', async () => {
    const { db, executeRaw } = fakeDb([3, 3, 0]);
    const result = await pruneAiCalls({ prisma: db, now: NOW, months: 24, batchSize: 3, log: () => undefined });
    expect(result).toMatchObject({ deleted: 6, batches: 3 });
    expect(executeRaw).toHaveBeenCalledTimes(3);
  });

  it('uses batches of 5000 by default', async () => {
    const { db, executeRaw } = fakeDb([0]);
    await pruneAiCalls({ prisma: db, now: NOW, months: 24, log: () => undefined });
    expect(AI_CALL_PRUNE_BATCH_SIZE).toBe(5000);
    expect(executeRaw.mock.calls[0].slice(1)).toEqual([CUTOFF_24, 5000]);
  });

  it('only counts on a dry run', async () => {
    const { db, executeRaw } = fakeDb([], 42);
    const log = vi.fn();
    expect(await pruneAiCalls({ prisma: db, now: NOW, months: 24, dryRun: true, log })).toEqual({ dryRun: true, cutoff: CUTOFF_24, wouldDelete: 42 });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([['[maintenance] AiCall retention dry run: 42 rows created before 2024-10-12T02:30:00.000Z (retention 24 months) would be deleted']]);
  });

  it.each([0, -5, 2.5, 100_001])('refuses a batch size of %s before touching the database', async batchSize => {
    const { db, executeRaw } = fakeDb([]);
    await expect(pruneAiCalls({ prisma: db, now: NOW, months: 24, batchSize })).rejects.toThrow(RangeError);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('refuses months outside 1-120 before touching the database', async () => {
    const { db, executeRaw } = fakeDb([]);
    await expect(pruneAiCalls({ prisma: db, now: NOW, months: 0 })).rejects.toThrow(RangeError);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('nightly schedule', () => {
  /** A queue that keeps job schedulers by id, like BullMQ's upsertJobScheduler. */
  function fakeQueue() {
    const schedulers = new Map<string, { repeat: unknown; template: unknown }>();
    const upsertJobScheduler = vi.fn(async (id: string, repeat: unknown, template?: unknown) => {
      schedulers.set(id, { repeat, template });
      return {} as never;
    });
    return { queue: { upsertJobScheduler }, schedulers, upsertJobScheduler };
  }

  it("registers 'prune-ai-calls' every night at 03:30 Asia/Hebron", async () => {
    const { queue, upsertJobScheduler } = fakeQueue();
    await scheduleAiCallPruning(queue);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'prune-ai-calls',
      { pattern: '30 3 * * *', tz: 'Asia/Hebron' },
      expect.objectContaining({ name: 'prune-ai-calls' }),
    );
  });

  it('runs at a time that exists exactly once every night in Asia/Hebron, also when the clocks change', () => {
    const [minute, hour] = PRUNE_AI_CALLS_SCHEDULE.pattern.split(' ');
    const wanted = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: PRUNE_AI_CALLS_SCHEDULE.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const seen = new Map<string, number>();
    // Every half hour of 2023-2035 (02:30 is skipped on spring change nights in these years).
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2036, 0, 1); t += 30 * 60 * 1000) {
      const p = Object.fromEntries(local.formatToParts(new Date(t)).map(part => [part.type, part.value]));
      if (`${p.hour}:${p.minute}` === wanted) seen.set(`${p.year}-${p.month}-${p.day}`, (seen.get(`${p.year}-${p.month}-${p.day}`) ?? 0) + 1);
    }
    const days = (Date.UTC(2036, 0, 1) - Date.UTC(2023, 0, 1)) / 86_400_000;
    expect(seen.size).toBe(days);
    expect([...seen.values()].every(n => n === 1)).toBe(true);
  });

  it('is idempotent: every worker start updates the same scheduler', async () => {
    const { queue, schedulers, upsertJobScheduler } = fakeQueue();
    await scheduleAiCallPruning(queue);
    await scheduleAiCallPruning(queue);
    await scheduleAiCallPruning(queue);
    expect(upsertJobScheduler).toHaveBeenCalledTimes(3);
    expect([...schedulers.keys()]).toEqual(['prune-ai-calls']);
  });

  it('rejects when Redis does, so the worker can log it', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    await expect(scheduleAiCallPruning(queue)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('the maintenance worker refuses an unknown job without touching the database', async () => {
    const db = { $executeRaw: vi.fn(), aiCall: { count: vi.fn() } } as unknown as PrismaClient;
    await expect(runMaintenanceJob({ name: 'delete-everything' }, { prisma: db, months: 24 })).rejects.toThrow(/unknown maintenance job/);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('npm run ai-calls:prune (without a database)', () => {
  const db = { $executeRaw: vi.fn(), aiCall: { count: vi.fn() } } as unknown as PrismaClient;
  const output = () => {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERROR ${l}`) } };
  };

  it('refuses unknown arguments', async () => {
    const { lines, out } = output();
    expect(await runAiCallPruneCli(db, ['--aply'], { DATABASE_URL: 'postgresql://x' }, out)).toBe(1);
    expect(lines).toEqual(['ERROR AiCall retention: unknown argument --aply (the only option is --apply)']);
    expect(db.aiCall.count).not.toHaveBeenCalled();
  });

  it('refuses an invalid retention or a missing DATABASE_URL', async () => {
    const { lines, out } = output();
    expect(await runAiCallPruneCli(db, [], { DATABASE_URL: 'postgresql://x', AI_CALL_RETENTION_MONTHS: '0' }, out)).toBe(1);
    expect(await runAiCallPruneCli(db, ['--apply'], {}, out)).toBe(1);
    expect(lines).toEqual([
      'ERROR AiCall retention: invalid configuration: AI_CALL_RETENTION_MONTHS must be between 1 and 120',
      'ERROR AiCall retention: invalid configuration: DATABASE_URL is required',
    ]);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('reports a database error by class and code only', async () => {
    const failing = {
      aiCall: { count: vi.fn().mockRejectedValue(Object.assign(new Error('value "0599123456" violates something'), { name: 'PrismaClientKnownRequestError', code: 'P2010' })) },
    } as unknown as PrismaClient;
    const { lines, out } = output();
    expect(await runAiCallPruneCli(failing, [], { DATABASE_URL: 'postgresql://x' }, out)).toBe(1);
    expect(lines).toEqual(['ERROR AiCall retention failed: PrismaClientKnownRequestError (P2010)']);
  });
});

describe.skipIf(!hasTestDatabase)('pruneAiCalls on the database', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await resetDatabase();
  });

  async function addCalls(rows: Array<{ feature: string; createdAt: Date; organizationId?: string; projectId?: string }>) {
    await prisma.aiCall.createMany({
      data: rows.map(r => ({ model: 'claude-haiku-5-5', promptVersion: 'test-v1', status: 'success' as const, latencyMs: 10, ...r })),
    });
  }
  const remaining = async () => (await prisma.aiCall.findMany({ select: { feature: true }, orderBy: { createdAt: 'asc' } })).map(r => r.feature);

  /** Rows on both sides of the 24-month cutoff (2024-10-12T02:30:00.000Z for NOW). */
  async function addAroundCutoff() {
    await addCalls([
      { feature: 'old', createdAt: new Date('2020-01-01T00:00:00.000Z') },
      { feature: 'before', createdAt: new Date(CUTOFF_24.getTime() - 1) },
      { feature: 'at', createdAt: CUTOFF_24 },
      { feature: 'after', createdAt: new Date(CUTOFF_24.getTime() + 1) },
      { feature: 'recent', createdAt: NOW },
    ]);
  }

  it('deletes the rows created before the cutoff and keeps the rest; a dry run deletes nothing', async () => {
    await addAroundCutoff();
    const log = vi.fn();

    expect(await pruneAiCalls({ prisma, now: NOW, months: 24, dryRun: true, log })).toEqual({ dryRun: true, cutoff: CUTOFF_24, wouldDelete: 2 });
    expect(await prisma.aiCall.count()).toBe(5);

    expect(await pruneAiCalls({ prisma, now: NOW, months: 24, log })).toEqual({ dryRun: false, cutoff: CUTOFF_24, deleted: 2, batches: 1 });
    expect(await remaining()).toEqual(['at', 'after', 'recent']);
    // Numbers only: no feature names or other row contents.
    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      expect(line).toMatch(/^\[maintenance\] AiCall retention(?: dry run: \d+|: deleted \d+) rows? created before [\dTZ:.-]+ \(retention \d+ months\)(?: would be deleted| in \d+ batch(?:es)?)$/);
    }

    expect(await pruneAiCalls({ prisma, now: NOW, months: 24, log })).toMatchObject({ deleted: 0, batches: 1 });
    expect(await prisma.aiCall.count()).toBe(3);
  });

  it('uses the configured retention', async () => {
    await addAroundCutoff();
    // 12 months before NOW is 2025-10-12T02:30: only "recent" is newer.
    expect(await pruneAiCalls({ prisma, now: NOW, months: 12, log: () => undefined })).toMatchObject({ deleted: 4 });
    expect(await remaining()).toEqual(['recent']);
  });

  it('deletes more rows than one batch, in batches', async () => {
    const old = Array.from({ length: 7 }, (_, i) => ({ feature: `old-${i}`, createdAt: new Date(Date.UTC(2023, 0, 1 + i)) }));
    await addCalls([...old, { feature: 'recent', createdAt: NOW }, { feature: 'after', createdAt: new Date(CUTOFF_24.getTime() + 1) }]);
    const executeRaw = vi.spyOn(prisma, '$executeRaw');

    expect(await pruneAiCalls({ prisma, now: NOW, months: 24, batchSize: 3, log: () => undefined })).toMatchObject({ deleted: 7, batches: 3 });
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(await remaining()).toEqual(['after', 'recent']);
    executeRaw.mockRestore();
  });

  it('deletes rows linked to organisations and projects and touches nothing else', async () => {
    const a = await createOrgFixture('retention-a');
    const b = await createOrgFixture('retention-b');
    await addCalls([
      { feature: 'old-a', createdAt: new Date('2023-05-01T00:00:00.000Z'), organizationId: a.org.id, projectId: a.project.id },
      { feature: 'old-b', createdAt: new Date('2024-01-01T00:00:00.000Z'), organizationId: b.org.id },
      { feature: 'new-a', createdAt: NOW, organizationId: a.org.id, projectId: a.project.id },
    ]);
    const counts = async () => {
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%' AND tablename <> 'AiCall' ORDER BY tablename`;
      const result: Record<string, number> = {};
      for (const { tablename } of tables) {
        const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "public"."${tablename}"`);
        result[tablename] = n;
      }
      return result;
    };
    const before = await counts();

    expect(await pruneAiCalls({ prisma, now: NOW, months: 24, log: () => undefined })).toMatchObject({ deleted: 2 });

    expect(await remaining()).toEqual(['new-a']);
    expect(await counts()).toEqual(before);
    expect(await prisma.project.count({ where: { id: { in: [a.project.id, b.project.id] } } })).toBe(2);
  });

  it.each(['Pacific/Kiritimati', 'America/Los_Angeles'])('compares in UTC when the database session time zone is %s', async timeZone => {
    await addAroundCutoff();
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${timeZone}`);
    const zoned = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const [{ tz }] = await zoned.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
      expect(tz).toBe(timeZone);
      expect(await pruneAiCalls({ prisma: zoned, now: NOW, months: 24, dryRun: true, log: () => undefined })).toMatchObject({ wouldDelete: 2 });
      expect(await pruneAiCalls({ prisma: zoned, now: NOW, months: 24, log: () => undefined })).toMatchObject({ deleted: 2 });
    } finally {
      await zoned.$disconnect();
    }
    expect(await remaining()).toEqual(['at', 'after', 'recent']);
  });

  it("the maintenance worker's 'prune-ai-calls' job prunes with the configured retention", async () => {
    await addAroundCutoff();
    const result = await runMaintenanceJob({ name: PRUNE_AI_CALLS_JOB }, { prisma, months: 24, now: NOW, log: () => undefined });
    expect(result).toMatchObject({ dryRun: false, deleted: 2 });
    expect(await remaining()).toEqual(['at', 'after', 'recent']);
  });

  it('npm run ai-calls:prune is a dry run unless --apply is given', async () => {
    await addAroundCutoff();
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERROR ${l}`) };
    const env = { DATABASE_URL: process.env.TEST_DATABASE_URL };

    expect(await runAiCallPruneCli(prisma, [], env, out, NOW)).toBe(0);
    expect(await prisma.aiCall.count()).toBe(5);
    expect(lines).toEqual([
      '[maintenance] AiCall retention dry run: 2 rows created before 2024-10-12T02:30:00.000Z (retention 24 months) would be deleted',
      'Nothing was deleted. Run again with --apply to delete these rows.',
    ]);

    lines.length = 0;
    expect(await runAiCallPruneCli(prisma, ['--apply'], { ...env, AI_CALL_RETENTION_MONTHS: ' 24 ' }, out, NOW)).toBe(0);
    expect(lines).toEqual(['[maintenance] AiCall retention: deleted 2 rows created before 2024-10-12T02:30:00.000Z (retention 24 months) in 1 batch']);
    expect(await remaining()).toEqual(['at', 'after', 'recent']);

    lines.length = 0;
    expect(await runAiCallPruneCli(prisma, [], env, out, NOW)).toBe(0);
    expect(lines).toEqual(['[maintenance] AiCall retention dry run: 0 rows created before 2024-10-12T02:30:00.000Z (retention 24 months) would be deleted']);
  });
});
