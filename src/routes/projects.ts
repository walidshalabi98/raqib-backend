import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';

const router = Router();

// GET /api/projects
router.get('/', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const projects = await prisma.project.findMany({
    where: { organizationId: req.user!.organizationId },
    include: {
      _count: {
        select: { documents: true, frameworks: true, assessments: true, dataPoints: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(projects);
}));

// POST /api/projects
router.post('/', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const {
    name, nameAr, description, sector, donor, donorType,
    budgetUsd, startDate, endDate, targetBeneficiaries, geographicScope,
  } = req.body;

  if (!name || !sector || !donor || !donorType || !startDate || !endDate) {
    throw new AppError(400, 'name, sector, donor, donorType, startDate, and endDate are required');
  }

  const project = await prisma.project.create({
    data: {
      organizationId: req.user!.organizationId,
      name,
      nameAr,
      description,
      sector,
      donor,
      donorType,
      budgetUsd: budgetUsd ? parseFloat(budgetUsd) : undefined,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      targetBeneficiaries: targetBeneficiaries ? parseInt(targetBeneficiaries) : undefined,
      geographicScope,
    },
  });

  res.status(201).json(project);
}));

// GET /api/projects/:id
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      documents: { orderBy: { uploadedAt: 'desc' } },
      frameworks: {
        orderBy: { version: 'desc' },
        take: 1,
        include: { indicators: { orderBy: { sortOrder: 'asc' } } },
      },
      _count: {
        select: { assessments: true, dataPoints: true, qualitativeEntries: true, reports: true },
      },
    },
  });

  if (!project) throw new AppError(404, 'Project not found');
  res.json(project);
}));

// PATCH /api/projects/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const {
    name, nameAr, description, sector, donor, donorType,
    budgetUsd, startDate, endDate, targetBeneficiaries, geographicScope, status,
  } = req.body;

  const updated = await prisma.project.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(nameAr !== undefined && { nameAr }),
      ...(description !== undefined && { description }),
      ...(sector !== undefined && { sector }),
      ...(donor !== undefined && { donor }),
      ...(donorType !== undefined && { donorType }),
      ...(budgetUsd !== undefined && { budgetUsd }),
      ...(startDate !== undefined && { startDate: new Date(startDate) }),
      ...(endDate !== undefined && { endDate: new Date(endDate) }),
      ...(targetBeneficiaries !== undefined && { targetBeneficiaries }),
      ...(geographicScope !== undefined && { geographicScope }),
      ...(status !== undefined && { status }),
    },
  });

  res.json(updated);
}));

// DELETE /api/projects/:id — Archive
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  await prisma.project.update({
    where: { id: req.params.id },
    data: { status: 'archived' },
  });

  res.json({ message: 'Project archived' });
}));

export default router;
