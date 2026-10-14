import { Prisma, PrismaClient } from '@prisma/client';
import { env } from './env';

/**
 * Prisma log levels: warnings always; every SQL statement only with PRISMA_LOG_QUERIES=1 (local debugging; statements
 * show placeholders, not the values). No 'error' level: Prisma would print each failed query with the values it was
 * given (names, notes). Errors are thrown to the caller and logged without their message (errorHandler,
 * safeErrorSummary; CLAUDE.md rules 3 and 5).
 */
export function prismaLogLevels(logQueries: boolean): Prisma.LogLevel[] {
  return logQueries ? ['query', 'warn'] : ['warn'];
}

/** The API's Prisma client (one per process; connects lazily). */
export const prisma = new PrismaClient({
  log: prismaLogLevels(env.prismaLogQueries),
});
