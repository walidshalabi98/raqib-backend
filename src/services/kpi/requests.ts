/**
 * POST /api/projects/:id/kpi-suggestions and the alternatives alias: body, scope ids, preview and the request
 * checks in their fixed order (knowledge/kpi-assistant-spec.md §A6; design sections 4.5 and 7.2, D6, D20, D21).
 * Every id is checked against the caller's organisation and the project's current framework (CLAUDE.md rule 1).
 *
 * Step 0 stub (Phase 4 contracts): constants and signatures are final; E5 implements the bodies.
 */
import type { Request, Response } from 'express';
import type { Prisma, PrismaClient, Project, UserRole } from '@prisma/client';
import type { KpiScope } from './types';

/** Roles that may use the KPI Assistant (donor_viewer never sees raw suggestions; spec §A1). */
export const KPI_ROLES = ['org_admin', 'platform_admin', 'me_officer'] as const satisfies readonly UserRole[];
/** More scoped results than this → 422 too_many_results (D20). */
export const KPI_MAX_RESULTS_PER_RUN = 40;

/** The parsed request body (design 7.3): exactly one id for alternatives; unknown keys stripped. */
export type KpiRequestBody = { scope: 'framework' } | { scope: 'result'; resultId: string }
  | { scope: 'alternatives'; indicatorId: string } | { scope: 'alternatives'; suggestionId: string };

/** zod v3; 400 on a bad body. */
export function parseKpiRequestBody(_body: unknown): KpiRequestBody {
  throw new Error('Phase 4: not implemented (E5)');
}

/**
 * Checks body ids against the project's current framework: any id that is not in it (another organisation, another
 * project of the same organisation, an older version) → 400; activity → 422 not_suggestable; indicator without a result
 * → 422 not_suggestable ("Link the indicator to a result first."). `via: 'alias'` (id from the path, access already
 * checked): an indicator of an older framework version → 409 stale instead of 400.
 */
export async function resolveScope(_db: Prisma.TransactionClient | PrismaClient, _frameworkId: string, _projectId: string,
  _body: ReturnType<typeof parseKpiRequestBody>, _via?: 'body' | 'alias'): Promise<KpiScope> {
  throw new Error('Phase 4: not implemented (E5)');
}

/** Organisation's AI spend over the last 24 h: SUM(AiCall.estimatedCostUsd) by organizationId (index exists). */
export async function organisationSpendUsd(_db: Prisma.TransactionClient | PrismaClient, _organizationId: string, _now: Date): Promise<number> {
  throw new Error('Phase 4: not implemented (E5)');
}

/** Shared by POST /projects/:id/kpi-suggestions and POST /indicators/:id/alternative (section 7.2). */
export async function handleKpiRequest(_req: Request, _res: Response, _project: Project, _body: unknown, _via?: 'body' | 'alias'): Promise<void> {
  throw new Error('Phase 4: not implemented (E5)');
}
