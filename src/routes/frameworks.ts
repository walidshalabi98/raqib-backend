import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertFrameworkAccess, assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { resolveModel } from '../services/ai/client';
import { generateFramework } from '../services/ai/frameworkGenerator';
import { levelForResult, sortResultNodes } from '../services/indicators/hierarchy';
import { assertIndicatorReferences } from '../services/indicators/references';
import { INDICATOR_INCLUDE, indicatorListInclude, RESULT_NODE_INCLUDE } from '../services/indicators/selects';
import { parseIndicatorCreate, toIndicatorCreateData } from '../services/indicators/validation';
import { safeErrorSummary } from '../services/ai/errors';
import { donorDataPointWhere } from '../services/privacy/donorView';

const router = Router();

const INDICATOR_ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] satisfies Prisma.IndicatorOrderByWithRelationInput[];

/**
 * A framework with its result nodes (each with counts) and its indicators (each with its result and the number
 * of data points the user can see: donor viewers never count KoboToolbox rows, SECURITY_SETUP §8.3).
 */
function frameworkDetailInclude(user: Request['user']) {
  return {
    resultNodes: { include: RESULT_NODE_INCLUDE },
    indicators: { orderBy: INDICATOR_ORDER, include: indicatorListInclude(donorDataPointWhere(user)) },
  } satisfies Prisma.FrameworkInclude;
}

/**
 * The project's current framework: the newest version whose AI generation did not fail. A failed
 * version keeps its safe message in generationError and never replaces the previous framework.
 */
const CURRENT_FRAMEWORK = { generationError: null } satisfies Prisma.FrameworkWhereInput;

/**
 * A draft that is still empty this long after it was created belongs to an interrupted run. A normal
 * run takes a few minutes; the slowest possible run (every timeout and max_tokens retry used) takes
 * about 30, so the limit sits well above it and a slow run is never reported as failed.
 */
export const INTERRUPTED_GENERATION_MS = 45 * 60 * 1000;

export const INTERRUPTED_GENERATION_MESSAGE = 'Framework generation did not finish (the run was interrupted). Generate a new version to try again.';

/** Result nodes ordered impact, outcome, output, activity, then sortOrder, then code. */
function withOrderedResults<T extends { resultNodes: Parameters<typeof sortResultNodes>[0] }>(framework: T): T {
  return { ...framework, resultNodes: sortResultNodes(framework.resultNodes) };
}

// GET /api/projects/:id/framework — Current framework with its results chain and indicators
router.get('/projects/:id/framework', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const framework = await prisma.framework.findFirst({
    where: { projectId: req.params.id, ...CURRENT_FRAMEWORK },
    orderBy: { version: 'desc' },
    include: frameworkDetailInclude(req.user),
  });

  if (!framework) {
    res.json(null);
    return;
  }
  res.json(withOrderedResults(framework));
}));

// POST /api/projects/:id/framework/generate — Trigger AI generation (runs inline, no Redis needed)
router.post('/projects/:id/framework/generate', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  // The highest version number so far, failed versions included (version numbers are never reused).
  const latest = await prisma.framework.findFirst({
    where: { projectId: req.params.id },
    orderBy: { version: 'desc' },
  });

  const framework = await prisma.framework.create({
    data: {
      projectId: req.params.id,
      version: (latest?.version || 0) + 1,
      status: 'draft',
      // The configured main model; the generator replaces it with the model that served the answer.
      aiModelUsed: resolveModel('main'),
    },
  });

  // Run AI generation inline (async, don't block the response). On failure the generator records
  // generationError on the version; GET /frameworks/:id/status then reports "failed".
  generateFramework(framework.id, req.params.id).catch(err => {
    console.error(`[Framework] Generation failed for ${framework.id}: ${safeErrorSummary(err)}`);
  });

  res.status(202).json({
    frameworkId: framework.id,
    status: 'processing',
  });
}));

/**
 * Why an AI framework version is known to have failed, or null: the generator recorded a
 * generationError, or the version is still an empty AI draft long after it was created (the run
 * was interrupted, e.g. by a restart, before it could record anything). Manual frameworks never fail.
 */
export function generationFailure(
  framework: { generationError: string | null; status: string; aiModelUsed: string | null; generatedAt: Date; resultCount: number; indicatorCount: number },
  now: Date = new Date(),
): string | null {
  if (framework.generationError) return framework.generationError;
  const emptyAiDraft = framework.status === 'draft' && framework.aiModelUsed !== 'manual' && framework.resultCount === 0 && framework.indicatorCount === 0;
  if (emptyAiDraft && now.getTime() - framework.generatedAt.getTime() > INTERRUPTED_GENERATION_MS) return INTERRUPTED_GENERATION_MESSAGE;
  return null;
}

// GET /api/frameworks/:id/status — Check generation status: processing, completed or failed (with a safe message)
router.get('/frameworks/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertFrameworkAccess(req, req.params.id);
  const framework = await prisma.framework.findUniqueOrThrow({
    where: { id: req.params.id },
    include: frameworkDetailInclude(req.user),
  });

  const hasIndicators = framework.indicators.length > 0;
  const failure = hasIndicators ? null : generationFailure({
    ...framework, resultCount: framework.resultNodes.length, indicatorCount: framework.indicators.length,
  });
  if (failure) {
    res.json({ frameworkId: framework.id, status: 'failed', message: failure });
    return;
  }

  res.json({
    frameworkId: framework.id,
    status: hasIndicators ? 'completed' : 'processing',
    progress: hasIndicators ? 'Framework generated successfully' : 'AI is analyzing project data...',
    framework: hasIndicators ? withOrderedResults(framework) : undefined,
  });
}));

// PATCH /api/frameworks/:id/approve — approving the framework approves its indicators
router.patch('/frameworks/:id/approve', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const framework = await assertFrameworkAccess(req, req.params.id);
  // A failed version is never the project's framework; approving it would only mark the project active.
  if (framework.generationError) throw new AppError(409, 'This framework version failed to generate and cannot be approved. Generate a new version.');

  // One transaction; the indicators are approved first so the response shows them approved.
  const [, updated] = await prisma.$transaction([
    prisma.indicator.updateMany({
      where: { frameworkId: framework.id },
      data: { isApproved: true },
    }),
    prisma.framework.update({
      where: { id: framework.id },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        approvedBy: req.user!.id,
      },
      include: frameworkDetailInclude(req.user),
    }),
    // Update project status
    prisma.project.update({
      where: { id: framework.projectId },
      data: { status: 'active' },
    }),
  ]);

  res.json(withOrderedResults(updated));
}));

// POST /api/projects/:id/framework/manual — Create a blank manual framework
router.post('/projects/:id/framework/manual', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const project = await assertProjectAccess(req, req.params.id);

  // The highest version number so far, failed versions included (version numbers are never reused).
  const latest = await prisma.framework.findFirst({
    where: { projectId: req.params.id },
    orderBy: { version: 'desc' },
  });

  const framework = await prisma.framework.create({
    data: {
      projectId: req.params.id,
      version: (latest?.version || 0) + 1,
      status: 'draft',
      name: req.body.name || `${project.name} - Manual Framework`,
      aiModelUsed: 'manual',
    },
  });

  res.status(201).json(framework);
}));

// POST /api/frameworks/:id/indicators — Create a single indicator manually (or from the library)
router.post('/frameworks/:id/indicators', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const framework = await assertFrameworkAccess(req, req.params.id);
  const input = parseIndicatorCreate(req.body);
  const { result } = await assertIndicatorReferences(framework.id, input);
  // Level fits the result (knowledge/me-foundations.md §2 rule 5): without a level it takes the result's.
  const fit = levelForResult(input.level, result?.level);
  if (fit.ok === false) throw new AppError(400, fit.message);

  // Get next sort order
  const lastIndicator = await prisma.indicator.findFirst({
    where: { frameworkId: framework.id },
    orderBy: { sortOrder: 'desc' },
  });

  const indicator = await prisma.indicator.create({
    data: toIndicatorCreateData(framework.id, input, {
      sortOrder: (lastIndicator?.sortOrder ?? -1) + 1,
      resultLevel: result?.level,
    }),
    include: INDICATOR_INCLUDE,
  });

  res.status(201).json(indicator);
}));

// GET /api/frameworks/:id/indicators
router.get('/frameworks/:id/indicators', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertFrameworkAccess(req, req.params.id);

  const indicators = await prisma.indicator.findMany({
    where: { frameworkId: req.params.id },
    orderBy: INDICATOR_ORDER,
    include: indicatorListInclude(donorDataPointWhere(req.user)),
  });

  res.json(indicators);
}));

export default router;
