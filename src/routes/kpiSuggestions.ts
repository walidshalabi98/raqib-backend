import { Router, Request, Response } from 'express';
import { SuggestionStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { assertFrameworkAccess, assertKpiRunAccess, assertKpiSuggestionAccess, assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { aiLimiter, kpiOrgLimiter, kpiPollLimiter } from '../middleware/rateLimit';
import { CURRENT_FRAMEWORK, findCurrentFramework } from '../services/frameworks/current';
import { acceptKpiSuggestion } from '../services/kpi/accept';
import { kpiAssistantStatus } from '../services/kpi/availability';
import { rejectKpiSuggestion } from '../services/kpi/reject';
import { handleKpiRequest, KPI_ROLES, resultOrderFor, runWithSuggestions, sortSuggestionRows } from '../services/kpi/requests';
import { markStaleRuns, toRunDto, toSuggestionDto } from '../services/kpi/runs';
import { scoreExistingIndicator } from '../services/kpi/validate';

/**
 * KPI Assistant routes (knowledge/kpi-assistant-spec.md §A6; design section 7.1): POST/GET
 * /api/projects/:id/kpi-suggestions, GET /api/kpi-suggestion-runs/:id, POST /api/kpi-suggestions/:id/accept|reject,
 * GET /api/frameworks/:id/indicator-quality, GET /api/kpi-assistant/status. The alternatives alias
 * POST /api/indicators/:id/alternative lives in routes/indicators.ts and shares handleKpiRequest.
 *
 * Every route: authenticate, then authorize(...KPI_ROLES) (= STAFF_ROLES) — donor viewers never see raw
 * suggestions (spec §A1) — then the organisation access helper of the id (404 for another organisation's ids,
 * CLAUDE.md rule 1). Errors are `{ message, code?, details? }`.
 */
const router = Router();
const kpiRoles = authorize(...KPI_ROLES);

const STATUS_FILTERS = [...Object.values(SuggestionStatus), 'all'] as const;

const listQuerySchema = z.object({
  status: z.enum(STATUS_FILTERS as unknown as [string, ...string[]], {
    errorMap: () => ({ message: `status must be one of: ${STATUS_FILTERS.join(', ')}` }),
  }).default('pending'),
  resultId: z.string().trim().min(1).max(100).optional(),
  runId: z.string().trim().min(1).max(100).optional(),
  frameworkId: z.string().trim().min(1).max(100).optional(),
});

/** GET /api/projects/:id/kpi-suggestions query (design 7.1): status (default pending, or "all"), resultId, runId, frameworkId. */
export function parseSuggestionListQuery(query: unknown): z.infer<typeof listQuerySchema> {
  const parsed = listQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw new AppError(400, `Invalid query: ${parsed.error.issues.map(i => (i.path.length && !i.message.startsWith(String(i.path[0])) ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ')}`);
  return parsed.data;
}

// POST /api/projects/:id/kpi-suggestions — run the KPI Assistant for the framework, one result or alternatives (design 7.2)
router.post('/projects/:id/kpi-suggestions', authenticate, kpiRoles, aiLimiter, kpiOrgLimiter, asyncHandler(async (req: Request, res: Response) => {
  const project = await assertProjectAccess(req, req.params.id);
  await handleKpiRequest(req, res, project, req.body, 'body');
}));

// GET /api/projects/:id/kpi-suggestions — suggestions of a framework version (default: current; status default pending),
// in results-chain order
router.get('/projects/:id/kpi-suggestions', authenticate, kpiRoles, asyncHandler(async (req: Request, res: Response) => {
  const project = await assertProjectAccess(req, req.params.id);
  const query = parseSuggestionListQuery(req.query);
  const now = new Date();
  await markStaleRuns(prisma, project.id, now);

  let frameworkId: string | null;
  if (query.frameworkId) {
    const version = await prisma.framework.findFirst({ where: { id: query.frameworkId, projectId: project.id, ...CURRENT_FRAMEWORK }, select: { id: true } });
    if (!version) throw new AppError(400, 'frameworkId is not a framework version of this project');
    frameworkId = version.id;
  } else {
    frameworkId = (await findCurrentFramework(prisma, project.id))?.id ?? null;
  }
  if (!frameworkId) {
    res.json({ frameworkId: null, suggestions: [], activeRuns: [], latestFrameworkRun: null });
    return;
  }

  const where: Prisma.KpiSuggestionWhereInput = {
    projectId: project.id,
    frameworkId,
    ...(query.status !== 'all' && { status: query.status as SuggestionStatus }),
    ...(query.resultId ? { resultId: query.resultId } : query.status === 'pending' ? { resultId: { not: null } } : {}),
    ...(query.runId && { runId: query.runId }),
  };
  const [suggestions, order, activeRuns, latestFrameworkRun] = await Promise.all([
    prisma.kpiSuggestion.findMany({ where }),
    resultOrderFor(frameworkId),
    prisma.kpiSuggestionRun.findMany({ where: { projectId: project.id, frameworkId, status: 'running' }, orderBy: { createdAt: 'asc' } }),
    prisma.kpiSuggestionRun.findFirst({ where: { projectId: project.id, frameworkId, scope: 'framework' }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({
    frameworkId,
    suggestions: sortSuggestionRows(suggestions, order).map(toSuggestionDto),
    activeRuns: activeRuns.map(run => toRunDto(run, now)),
    latestFrameworkRun: latestFrameworkRun ? toRunDto(latestFrameworkRun, now) : null,
  });
}));

// GET /api/kpi-suggestion-runs/:id — poll a run (design 7.4); its own per-user limiter, skipped by the per-IP apiLimiter
router.get('/kpi-suggestion-runs/:id', authenticate, kpiRoles, kpiPollLimiter, asyncHandler(async (req: Request, res: Response) => {
  const run = await assertKpiRunAccess(req, req.params.id);
  res.json(await runWithSuggestions(run.id));
}));

// POST /api/kpi-suggestions/:id/accept — accept or edit & accept (design 8.1)
router.post('/kpi-suggestions/:id/accept', authenticate, kpiRoles, asyncHandler(async (req: Request, res: Response) => {
  const suggestion = await assertKpiSuggestionAccess(req, req.params.id);
  const result = await acceptKpiSuggestion({
    suggestionId: suggestion.id, organizationId: req.user!.organizationId, userId: req.user!.id, body: req.body,
  });
  res.status(201).json(result);
}));

// POST /api/kpi-suggestions/:id/reject — reject with a reason (design 8.2)
router.post('/kpi-suggestions/:id/reject', authenticate, kpiRoles, asyncHandler(async (req: Request, res: Response) => {
  const suggestion = await assertKpiSuggestionAccess(req, req.params.id);
  res.json(await rejectKpiSuggestion({
    suggestionId: suggestion.id, organizationId: req.user!.organizationId, userId: req.user!.id, body: req.body,
  }));
}));

// GET /api/frameworks/:id/indicator-quality — deterministic quality check of existing indicators (spec §A2 trigger 3; no AI)
router.get('/frameworks/:id/indicator-quality', authenticate, kpiRoles, asyncHandler(async (req: Request, res: Response) => {
  const framework = await assertFrameworkAccess(req, req.params.id);
  const indicators = await prisma.indicator.findMany({
    where: { frameworkId: framework.id },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, indicatorText: true, indicatorTextAr: true, unit: true, calculation: true, meansOfVerification: true },
  });
  res.json({
    indicators: indicators.map(indicator => {
      const quality = scoreExistingIndicator(indicator);
      return {
        indicatorId: indicator.id,
        qualityScore: quality.qualityScore,
        qualityBand: quality.qualityBand,
        warnings: quality.warnings,
        needsAlternatives: quality.needsAlternatives,
      };
    }),
  });
}));

// GET /api/kpi-assistant/status — whether the AI is configured (no id, no organisation data)
router.get('/kpi-assistant/status', authenticate, kpiRoles, (_req: Request, res: Response) => {
  res.json(kpiAssistantStatus());
});

export default router;
