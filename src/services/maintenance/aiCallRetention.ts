/**
 * AiCall retention (owner decision, October 2026): AiCall rows are kept for
 * AI_CALL_RETENTION_MONTHS calendar months (default 24) and then deleted. The worker runs
 * pruneAiCalls every night at 02:30 Asia/Hebron (the 'prune-ai-calls' job of the 'maintenance'
 * queue); `npm run ai-calls:prune` runs it by hand (dry run unless --apply).
 *
 * Kept free of the API configuration (src/config/env.ts imports the setting's schema from here,
 * and the CLI needs DATABASE_URL alone): only zod at run time, Prisma and BullMQ as types.
 * Logs hold numbers only (row counts, batches, the cutoff), never row contents.
 */
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { z } from 'zod';

export const AI_CALL_RETENTION_DEFAULT_MONTHS = 24;
export const AI_CALL_RETENTION_MIN_MONTHS = 1;
export const AI_CALL_RETENTION_MAX_MONTHS = 120;

const RANGE_MESSAGE = `must be between ${AI_CALL_RETENTION_MIN_MONTHS} and ${AI_CALL_RETENTION_MAX_MONTHS}`;

/** AI_CALL_RETENTION_MONTHS: a whole number of months from 1 to 120. Unset or blank means the default, applied by the callers (src/config/env.ts, aiCallPruneSettings). */
export const AI_CALL_RETENTION_MONTHS_SCHEMA = z.coerce
  .number({ invalid_type_error: 'must be a number' })
  .int('must be a whole number')
  .min(AI_CALL_RETENTION_MIN_MONTHS, RANGE_MESSAGE)
  .max(AI_CALL_RETENTION_MAX_MONTHS, RANGE_MESSAGE);

/** Rows deleted per statement: each batch is one short DELETE, so locks stay short. */
export const AI_CALL_PRUNE_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 100_000;

/** BullMQ names of the nightly job (src/jobs/queues.ts, src/jobs/worker.ts). */
export const MAINTENANCE_QUEUE = 'maintenance';
export const PRUNE_AI_CALLS_JOB = 'prune-ai-calls';
/** Every night at 02:30 in Palestine (cron pattern in Asia/Hebron time). */
export const PRUNE_AI_CALLS_SCHEDULE = { pattern: '30 2 * * *', tz: 'Asia/Hebron' } as const;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 1 && leap ? 29 : DAYS_IN_MONTH[month];
}

function assertMonths(months: number): void {
  if (!Number.isInteger(months) || months < AI_CALL_RETENTION_MIN_MONTHS || months > AI_CALL_RETENTION_MAX_MONTHS) {
    throw new RangeError(`AiCall retention: months ${RANGE_MESSAGE} (got ${months})`);
  }
}

/**
 * The moment `months` calendar months before `now`, in UTC: same day of the month and time of
 * day, the day clamped to the end of a shorter month (2028-02-29 minus 24 months is 2026-02-28,
 * 2026-03-31 minus 1 is 2026-02-28). AiCall rows created before it are deleted. Pure; throws a
 * RangeError for an invalid date or months outside 1–120.
 */
export function aiCallRetentionCutoff(now: Date, months: number): Date {
  if (Number.isNaN(now.getTime())) throw new RangeError('AiCall retention: invalid date');
  assertMonths(months);
  const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const cutoff = new Date(now.getTime());
  // Year, month and day in one call, so no intermediate date overflows into the next month.
  cutoff.setUTCFullYear(year, month, Math.min(now.getUTCDate(), daysInMonth(year, month)));
  return cutoff;
}

export interface PruneAiCallsOptions {
  prisma: PrismaClient;
  now: Date;
  months: number;
  /** Rows per DELETE (default 5000). */
  batchSize?: number;
  /** Count the rows that would be deleted and delete nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export type PruneAiCallsResult =
  | { dryRun: true; cutoff: Date; wouldDelete: number }
  | { dryRun: false; cutoff: Date; deleted: number; batches: number };

/**
 * Deletes the AiCall rows created before aiCallRetentionCutoff(now, months), oldest first, in
 * batches of `batchSize` (one `DELETE … WHERE id IN (SELECT id … LIMIT n)` each) until a batch
 * deletes fewer than `batchSize`. Each batch commits on its own: a failure keeps the earlier
 * batches and the next run continues. Nothing references AiCall, so no other row is touched.
 * Logs one line with the numbers.
 */
export async function pruneAiCalls(options: PruneAiCallsOptions): Promise<PruneAiCallsResult> {
  const { prisma, now, months, batchSize = AI_CALL_PRUNE_BATCH_SIZE, dryRun = false, log = line => console.log(line) } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`AiCall retention: batch size must be between 1 and ${MAX_BATCH_SIZE} (got ${batchSize})`);
  }
  const cutoff = aiCallRetentionCutoff(now, months);
  const rows = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'} created before ${cutoff.toISOString()} (retention ${months} months)`;

  if (dryRun) {
    const wouldDelete = await prisma.aiCall.count({ where: { createdAt: { lt: cutoff } } });
    log(`[maintenance] AiCall retention dry run: ${rows(wouldDelete)} would be deleted`);
    return { dryRun: true, cutoff, wouldDelete };
  }

  let deleted = 0;
  let batches = 0;
  for (;;) {
    // "createdAt" is a UTC timestamp without time zone; Prisma sends a Date as timestamptz, so it
    // is converted to UTC explicitly (a plain comparison would follow the session's TimeZone).
    const count = await prisma.$executeRaw`
      DELETE FROM "AiCall" WHERE id IN (
        SELECT id FROM "AiCall"
        WHERE "createdAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "createdAt"
        LIMIT ${batchSize}
      )`;
    deleted += count;
    batches++;
    if (count < batchSize) break;
  }
  log(`[maintenance] AiCall retention: deleted ${rows(deleted)} in ${batches} ${batches === 1 ? 'batch' : 'batches'}`);
  return { dryRun: false, cutoff, deleted, batches };
}

/**
 * Registers the nightly 'prune-ai-calls' job on the maintenance queue. Idempotent: the scheduler
 * id is fixed, so calling it at every worker start updates the one scheduler instead of adding
 * another. Rejects when Redis does; the caller logs it.
 */
export async function scheduleAiCallPruning(queue: Pick<Queue, 'upsertJobScheduler'>): Promise<void> {
  await queue.upsertJobScheduler(PRUNE_AI_CALLS_JOB, { ...PRUNE_AI_CALLS_SCHEDULE }, {
    name: PRUNE_AI_CALLS_JOB,
    // Keeps a month of finished runs in Redis instead of every run forever.
    opts: { removeOnComplete: 30, removeOnFail: 30 },
  });
}

/** The maintenance worker's processor: runs 'prune-ai-calls' at the time of the run; rejects an unknown job name. */
export async function runMaintenanceJob(
  job: { name: string },
  deps: { prisma: PrismaClient; months: number; now?: Date; log?: (line: string) => void },
): Promise<PruneAiCallsResult> {
  if (job.name !== PRUNE_AI_CALLS_JOB) throw new Error(`unknown maintenance job "${job.name}"`);
  return pruneAiCalls({ prisma: deps.prisma, now: deps.now ?? new Date(), months: deps.months, log: deps.log });
}

/** Unset or blank reads as the default (so `NAME=` in .env behaves like a missing line), as in src/config/env.ts. */
const blankAsUnset = (v: unknown) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v);

const cliSettingsSchema = z.object({
  DATABASE_URL: z.preprocess(blankAsUnset, z.string({ required_error: 'is required' })),
  AI_CALL_RETENTION_MONTHS: z.preprocess(blankAsUnset, AI_CALL_RETENTION_MONTHS_SCHEMA.default(AI_CALL_RETENTION_DEFAULT_MONTHS)),
});

/**
 * The settings `npm run ai-calls:prune` reads: DATABASE_URL (read by Prisma; checked here for a
 * clear message) and AI_CALL_RETENTION_MONTHS with the API's validation and default.
 */
export function aiCallPruneSettings(env: Record<string, string | undefined>): { months: number } {
  const parsed = cliSettingsSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return { months: parsed.data.AI_CALL_RETENTION_MONTHS };
}

export interface AiCallPruneOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * `npm run ai-calls:prune` (scripts/prune-ai-calls.ts): a dry run that prints the cutoff and the
 * number of rows older than it; `--apply` deletes them. Returns the exit code: 0, or 1 for an
 * unknown argument, invalid settings or a database error (reported by class and Prisma code only).
 */
export async function runAiCallPruneCli(
  prisma: PrismaClient,
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: AiCallPruneOutput = { log: line => console.log(line), error: line => console.error(line) },
  now: Date = new Date(),
): Promise<number> {
  const unknown = args.filter(a => a !== '--apply');
  if (unknown.length > 0) {
    out.error(`AiCall retention: unknown argument ${unknown.join(', ')} (the only option is --apply)`);
    return 1;
  }
  let months: number;
  try {
    ({ months } = aiCallPruneSettings(env));
  } catch (err) {
    out.error(`AiCall retention: ${(err as Error).message}`);
    return 1;
  }

  try {
    const result = await pruneAiCalls({ prisma, now, months, dryRun: !args.includes('--apply'), log: out.log });
    if (result.dryRun && result.wouldDelete > 0) out.log('Nothing was deleted. Run again with --apply to delete these rows.');
    return 0;
  } catch (err) {
    // Database error messages can quote values: the class name and Prisma error code only.
    const code = (err as { code?: unknown; errorCode?: unknown } | null)?.code ?? (err as { errorCode?: unknown } | null)?.errorCode;
    const name = err instanceof Error ? err.name : 'unknown error';
    out.error(`AiCall retention failed: ${name}${typeof code === 'string' ? ` (${code})` : ''}`);
    return 1;
  }
}
