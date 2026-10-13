/**
 * Creates an indicator in a framework: the body of POST /frameworks/:id/indicators, shared with KPI accept
 * (design sections 4.5 and 8.1): references checked, level from the result, sortOrder = last + 1, server-set
 * provenance fields.
 *
 * Step 0 stub (Phase 4 contracts): the signature is final; E5 implements the body.
 */
import type { IndicatorProvenance, Prisma, PrismaClient } from '@prisma/client';
import type { INDICATOR_INCLUDE } from './selects';
import type { IndicatorCreateInput } from './validation';

export async function createIndicatorInFramework(_db: Prisma.TransactionClient | PrismaClient, _frameworkId: string, _input: IndicatorCreateInput,
  _server?: { provenance?: IndicatorProvenance; aiModel?: string | null; promptVersion?: string | null }):
  Promise<Prisma.IndicatorGetPayload<{ include: typeof INDICATOR_INCLUDE }>> {
  throw new Error('Phase 4: not implemented (E5)');
}
