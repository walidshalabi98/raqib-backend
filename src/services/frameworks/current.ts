import type { FrameworkStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * The project's current framework: the newest version whose AI generation did not fail. A failed
 * version keeps its safe message in generationError and never replaces the previous framework
 * (BUILD_GUIDE Phase 3; design section 4.9). Shared by the framework routes, the KPI Assistant
 * (requests, runs, accept) and the project routes.
 */
export const CURRENT_FRAMEWORK = { generationError: null } satisfies Prisma.FrameworkWhereInput;

/**
 * Id, status and version of the project's current framework (highest version without a generation
 * error), or null when the project has none. Takes the Prisma client or a transaction client, so accept
 * can repeat the staleness check inside its transaction (design section 8.1). The caller has already
 * checked organisation access to `projectId` (CLAUDE.md rule 1).
 */
export async function findCurrentFramework(
  db: Pick<PrismaClient, 'framework'>,
  projectId: string,
): Promise<{ id: string; status: FrameworkStatus; version: number } | null> {
  return db.framework.findFirst({
    where: { projectId, ...CURRENT_FRAMEWORK },
    orderBy: { version: 'desc' },
    select: { id: true, status: true, version: true },
  });
}
