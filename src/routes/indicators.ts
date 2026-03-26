import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getIndicatorQueue } from '../jobs/queues';

const router = Router();

// PATCH /api/indicators/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), async (req: Request, res: Response) => {
  const indicator = await prisma.indicator.findUnique({
    where: { id: req.params.id },
    include: { framework: { include: { project: true } } },
  });

  if (!indicator || indicator.framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Indicator not found');
  }

  const {
    indicatorText, indicatorTextAr, level, dataCollectionMethod,
    frequency, baselineValue, targetValue, currentValue, unit, status, phases, sortOrder,
  } = req.body;

  const updated = await prisma.indicator.update({
    where: { id: req.params.id },
    data: {
      ...(indicatorText !== undefined && { indicatorText }),
      ...(indicatorTextAr !== undefined && { indicatorTextAr }),
      ...(level !== undefined && { level }),
      ...(dataCollectionMethod !== undefined && { dataCollectionMethod }),
      ...(frequency !== undefined && { frequency }),
      ...(baselineValue !== undefined && { baselineValue }),
      ...(targetValue !== undefined && { targetValue }),
      ...(currentValue !== undefined && { currentValue }),
      ...(unit !== undefined && { unit }),
      ...(status !== undefined && { status }),
      ...(phases !== undefined && { phases }),
      ...(sortOrder !== undefined && { sortOrder }),
    },
  });

  res.json(updated);
});

// POST /api/indicators/:id/alternative — Request AI alternative
router.post('/:id/alternative', authenticate, async (req: Request, res: Response) => {
  const indicator = await prisma.indicator.findUnique({
    where: { id: req.params.id },
    include: { framework: { include: { project: true } } },
  });

  if (!indicator || indicator.framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Indicator not found');
  }

  const queue = getIndicatorQueue();
  const job = await queue.add('generate-alternative', {
    indicatorId: req.params.id,
    projectId: indicator.framework.project.id,
  });

  res.status(202).json({ jobId: job.id, status: 'processing' });
});

// PATCH /api/indicators/:id/approve
router.patch('/:id/approve', authenticate, authorize('org_admin', 'platform_admin'), async (req: Request, res: Response) => {
  const indicator = await prisma.indicator.findUnique({
    where: { id: req.params.id },
    include: { framework: { include: { project: true } } },
  });

  if (!indicator || indicator.framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Indicator not found');
  }

  const updated = await prisma.indicator.update({
    where: { id: req.params.id },
    data: { isApproved: true },
  });

  res.json(updated);
});

// DELETE /api/indicators/:id
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), async (req: Request, res: Response) => {
  const indicator = await prisma.indicator.findUnique({
    where: { id: req.params.id },
    include: { framework: { include: { project: true } } },
  });

  if (!indicator || indicator.framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Indicator not found');
  }

  await prisma.indicator.delete({ where: { id: req.params.id } });
  res.json({ message: 'Indicator deleted' });
});

export default router;
