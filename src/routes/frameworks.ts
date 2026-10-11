import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertFrameworkAccess, assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { generateFramework } from '../services/ai/frameworkGenerator';
import { sortResultNodes } from '../services/indicators/hierarchy';
import { assertIndicatorReferences } from '../services/indicators/references';
import { INDICATOR_INCLUDE, INDICATOR_LIST_INCLUDE, RESULT_NODE_INCLUDE } from '../services/indicators/selects';
import { parseIndicatorCreate, toIndicatorCreateData } from '../services/indicators/validation';

const router = Router();

const INDICATOR_ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] satisfies Prisma.IndicatorOrderByWithRelationInput[];

/** A framework with its result nodes (each with counts) and its indicators (each with its result and data point count). */
const FRAMEWORK_DETAIL_INCLUDE = {
  resultNodes: { include: RESULT_NODE_INCLUDE },
  indicators: { orderBy: INDICATOR_ORDER, include: INDICATOR_LIST_INCLUDE },
} satisfies Prisma.FrameworkInclude;

/** Result nodes ordered impact, outcome, output, activity, then sortOrder, then code. */
function withOrderedResults<T extends { resultNodes: Parameters<typeof sortResultNodes>[0] }>(framework: T): T {
  return { ...framework, resultNodes: sortResultNodes(framework.resultNodes) };
}

// GET /api/projects/:id/framework — Latest framework with its results chain and indicators
router.get('/projects/:id/framework', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const framework = await prisma.framework.findFirst({
    where: { projectId: req.params.id },
    orderBy: { version: 'desc' },
    include: FRAMEWORK_DETAIL_INCLUDE,
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

  // Get current max version
  const latest = await prisma.framework.findFirst({
    where: { projectId: req.params.id },
    orderBy: { version: 'desc' },
  });

  const framework = await prisma.framework.create({
    data: {
      projectId: req.params.id,
      version: (latest?.version || 0) + 1,
      status: 'draft',
      aiModelUsed: 'claude-sonnet-4-20250514',
    },
  });

  // Run AI generation inline (async, don't block the response)
  generateFramework(framework.id, req.params.id).catch(err => {
    console.error(`[Framework] Generation failed for ${framework.id}:`, err);
    // Update framework status to indicate failure
    prisma.framework.update({
      where: { id: framework.id },
      data: { status: 'draft' },
    }).catch(() => {});
  });

  res.status(202).json({
    frameworkId: framework.id,
    status: 'processing',
  });
}));

// GET /api/frameworks/:id/status — Check generation status
router.get('/frameworks/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertFrameworkAccess(req, req.params.id);
  const framework = await prisma.framework.findUniqueOrThrow({
    where: { id: req.params.id },
    include: FRAMEWORK_DETAIL_INCLUDE,
  });

  const hasIndicators = framework.indicators.length > 0;

  res.json({
    frameworkId: framework.id,
    status: hasIndicators ? 'completed' : 'processing',
    progress: hasIndicators ? 'Framework generated successfully' : 'AI is analyzing project data...',
    framework: hasIndicators ? withOrderedResults(framework) : undefined,
  });
}));

// PATCH /api/frameworks/:id/approve
router.patch('/frameworks/:id/approve', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const framework = await assertFrameworkAccess(req, req.params.id);

  const updated = await prisma.framework.update({
    where: { id: req.params.id },
    data: {
      status: 'approved',
      approvedAt: new Date(),
      approvedBy: req.user!.id,
    },
    include: FRAMEWORK_DETAIL_INCLUDE,
  });

  // Update project status
  await prisma.project.update({
    where: { id: framework.projectId },
    data: { status: 'active' },
  });

  res.json(withOrderedResults(updated));
}));

// POST /api/projects/:id/framework/manual — Create a blank manual framework
router.post('/projects/:id/framework/manual', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const project = await assertProjectAccess(req, req.params.id);

  // Get current max version
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
    include: INDICATOR_LIST_INCLUDE,
  });

  res.json(indicators);
}));

export default router;
