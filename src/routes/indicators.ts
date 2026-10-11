import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertIndicatorAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { assertIndicatorReferences } from '../services/indicators/references';
import { INDICATOR_INCLUDE } from '../services/indicators/selects';
import { parseIndicatorUpdate, toIndicatorUpdateData } from '../services/indicators/validation';

const router = Router();

// PATCH /api/indicators/:id — any subset of the indicator and reference-sheet fields
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);
  const input = parseIndicatorUpdate(req.body);
  await assertIndicatorReferences(indicator.frameworkId, input);

  const updated = await prisma.indicator.update({
    where: { id: indicator.id },
    data: toIndicatorUpdateData(input),
    include: INDICATOR_INCLUDE,
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
    include: INDICATOR_INCLUDE,
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
