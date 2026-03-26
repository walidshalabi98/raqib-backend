import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';

const router = Router();

// GET /api/organizations/:id
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (id !== req.user!.organizationId) throw new AppError(403, 'Access denied');

  const org = await prisma.organization.findUnique({
    where: { id },
    include: { _count: { select: { users: true, projects: true } } },
  });
  if (!org) throw new AppError(404, 'Organization not found');

  res.json(org);
}));

// PATCH /api/organizations/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (id !== req.user!.organizationId && req.user!.role !== 'platform_admin') {
    throw new AppError(403, 'Access denied');
  }

  const { name, nameAr, logoUrl, contactEmail, contactPhone } = req.body;
  const org = await prisma.organization.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(nameAr !== undefined && { nameAr }),
      ...(logoUrl !== undefined && { logoUrl }),
      ...(contactEmail !== undefined && { contactEmail }),
      ...(contactPhone !== undefined && { contactPhone }),
    },
  });

  res.json(org);
}));

export default router;
