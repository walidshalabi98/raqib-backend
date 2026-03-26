import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { generateFramework } from '../services/ai/frameworkGenerator';

const router = Router();

// GET /api/projects/:id/framework — Get active framework with indicators
router.get('/projects/:id/framework', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const framework = await prisma.framework.findFirst({
    where: { projectId: req.params.id },
    orderBy: { version: 'desc' },
    include: {
      indicators: {
        orderBy: { sortOrder: 'asc' },
        include: { _count: { select: { dataPoints: true } } },
      },
    },
  });

  if (!framework) {
    res.json(null);
    return;
  }
  res.json(framework);
}));

// POST /api/projects/:id/framework/generate — Trigger AI generation (runs inline, no Redis needed)
router.post('/projects/:id/framework/generate', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

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
  const framework = await prisma.framework.findUnique({
    where: { id: req.params.id },
    include: {
      project: true,
      indicators: { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!framework || framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Framework not found');
  }

  const hasIndicators = framework.indicators.length > 0;
  const isComplete = hasIndicators && framework.status !== 'draft';

  res.json({
    frameworkId: framework.id,
    status: hasIndicators ? 'completed' : 'processing',
    progress: hasIndicators ? 'Framework generated successfully' : 'AI is analyzing project data...',
    framework: hasIndicators ? framework : undefined,
  });
}));

// PATCH /api/frameworks/:id/approve
router.patch('/frameworks/:id/approve', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const framework = await prisma.framework.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });

  if (!framework || framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Framework not found');
  }

  const updated = await prisma.framework.update({
    where: { id: req.params.id },
    data: {
      status: 'approved',
      approvedAt: new Date(),
      approvedBy: req.user!.id,
    },
    include: { indicators: { orderBy: { sortOrder: 'asc' } } },
  });

  // Update project status
  await prisma.project.update({
    where: { id: framework.projectId },
    data: { status: 'active' },
  });

  res.json(updated);
}));

// GET /api/frameworks/:id/indicators
router.get('/frameworks/:id/indicators', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const framework = await prisma.framework.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });

  if (!framework || framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Framework not found');
  }

  const indicators = await prisma.indicator.findMany({
    where: { frameworkId: req.params.id },
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { dataPoints: true } } },
  });

  res.json(indicators);
}));

export default router;
