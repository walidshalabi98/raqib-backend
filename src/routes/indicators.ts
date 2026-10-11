import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertIndicatorAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';

const router = Router();

// PATCH /api/indicators/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  await assertIndicatorAccess(req, req.params.id);

  const {
    indicatorText, indicatorTextAr, level, dataCollectionMethod,
    frequency, baselineValue, targetValue, currentValue, unit, status, phases, sortOrder,
    startDate, endDate, actualStartDate, actualEndDate, milestones, responsibility,
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
      ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
      ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
      ...(actualStartDate !== undefined && { actualStartDate: actualStartDate ? new Date(actualStartDate) : null }),
      ...(actualEndDate !== undefined && { actualEndDate: actualEndDate ? new Date(actualEndDate) : null }),
      ...(milestones !== undefined && { milestones }),
      ...(responsibility !== undefined && { responsibility }),
    },
  });

  res.json(updated);
}));

// POST /api/indicators/:id/alternative — Request AI alternative
router.post('/:id/alternative', authenticate, aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertIndicatorAccess(req, req.params.id);

  // Generate alternative inline (no Redis/BullMQ needed)
  // TODO: Add AI alternative indicator service
  res.status(202).json({ indicatorId: req.params.id, status: 'processing' });
}));

// PATCH /api/indicators/:id/approve
router.patch('/:id/approve', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  await assertIndicatorAccess(req, req.params.id);

  const updated = await prisma.indicator.update({
    where: { id: req.params.id },
    data: { isApproved: true },
  });

  res.json(updated);
}));

// DELETE /api/indicators/:id
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  await assertIndicatorAccess(req, req.params.id);

  await prisma.indicator.delete({ where: { id: req.params.id } });
  res.json({ message: 'Indicator deleted' });
}));

export default router;
