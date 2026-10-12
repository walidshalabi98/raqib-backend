import { PrismaClient } from '@prisma/client';

// No 'error' level: Prisma would print each failed query with the values it was given (names,
// notes). Errors are thrown to the caller and logged without their message (errorHandler,
// safeErrorSummary).
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn'] : ['warn'],
});
