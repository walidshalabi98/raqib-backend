/**
 * Creates an indicator in a framework: the body of POST /frameworks/:id/indicators, shared with KPI accept
 * (design sections 4.5 and 8.1): references checked, level from the result, sortOrder = last + 1, server-set
 * provenance fields.
 */
import type { IndicatorProvenance, Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler';
import { levelForResult } from './hierarchy';
import { assertIndicatorReferences } from './references';
import { INDICATOR_INCLUDE } from './selects';
import { toIndicatorCreateData } from './validation';
import type { IndicatorCreateInput } from './validation';

/** Fields only the server sets (KPI accept: provenance ai_suggested with the suggestion's model and prompt version). */
export interface ServerIndicatorFields {
  provenance?: IndicatorProvenance;
  aiModel?: string | null;
  promptVersion?: string | null;
}

/**
 * Creates one indicator in `frameworkId` from a parsed IndicatorCreateInput (the caller has checked organisation access
 * to the framework, CLAUDE.md rule 1):
 * - `assertIndicatorReferences(frameworkId, input, db)`: resultId in the same framework, libraryId in the library (400);
 * - level fits the result (me-foundations §2 rule 5: without a level it takes the result's; a different one → 400);
 * - sortOrder = the framework's last sortOrder + 1;
 * - `toIndicatorCreateData` defaults, then the server fields (`server`), which a client can never set.
 * `db` is the Prisma client or a transaction client, so KPI accept creates the indicator in its transaction.
 */
export async function createIndicatorInFramework(db: Prisma.TransactionClient | PrismaClient, frameworkId: string, input: IndicatorCreateInput,
  server: ServerIndicatorFields = {}):
  Promise<Prisma.IndicatorGetPayload<{ include: typeof INDICATOR_INCLUDE }>> {
  const { result } = await assertIndicatorReferences(frameworkId, input, db);
  const fit = levelForResult(input.level, result?.level);
  if (fit.ok === false) throw new AppError(400, fit.message);

  const last = await db.indicator.findFirst({
    where: { frameworkId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  const data = toIndicatorCreateData(frameworkId, input, {
    sortOrder: (last?.sortOrder ?? -1) + 1,
    resultLevel: result?.level,
  });
  if (server.provenance !== undefined) data.provenance = server.provenance;
  if (server.aiModel !== undefined) data.aiModel = server.aiModel;
  if (server.promptVersion !== undefined) data.promptVersion = server.promptVersion;

  return db.indicator.create({ data, include: INDICATOR_INCLUDE });
}
