import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';

const router = Router();

// GET /api/projects/:id/export/indicators
router.get('/projects/:id/export/indicators', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      frameworks: {
        orderBy: { version: 'desc' },
        take: 1,
        include: {
          indicators: {
            orderBy: { sortOrder: 'asc' },
            include: { dataPoints: { orderBy: { collectionDate: 'desc' } } },
          },
        },
      },
    },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const framework = project.frameworks[0];
  const indicators = framework?.indicators.map(ind => ({
    indicator: ind.indicatorText,
    indicatorAr: ind.indicatorTextAr,
    level: ind.level,
    method: ind.dataCollectionMethod,
    frequency: ind.frequency,
    baseline: ind.baselineValue,
    target: ind.targetValue,
    current: ind.currentValue,
    unit: ind.unit,
    status: ind.status,
    dataPoints: ind.dataPoints.map(dp => ({
      value: dp.value,
      date: dp.collectionDate.toISOString().split('T')[0],
      method: dp.collectionMethod,
      source: dp.source,
      area: dp.geographicArea,
    })),
  })) || [];

  res.json({
    project: { name: project.name, sector: project.sector, donor: project.donor },
    framework: framework ? { version: framework.version, status: framework.status } : null,
    indicators,
    exportedAt: new Date().toISOString(),
  });
}));

// GET /api/projects/:id/export/beneficiaries
router.get('/projects/:id/export/beneficiaries', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  let beneficiaries: any[] = [];
  try {
    beneficiaries = await prisma.beneficiary.findMany({
      where: { projectId: req.params.id },
      include: { services: { orderBy: { dateProvided: 'desc' } } },
      orderBy: { registrationDate: 'desc' },
    });
  } catch (e) { /* table might not exist yet */ }

  res.json({
    project: { name: project.name, sector: project.sector },
    beneficiaries: beneficiaries.map(b => ({
      name: b.fullName,
      nameAr: b.fullNameAr,
      gender: b.gender,
      age: b.age,
      ageGroup: b.ageGroup,
      location: b.location,
      governorate: b.governorate,
      householdSize: b.householdSize,
      status: b.status,
      registeredAt: b.registrationDate?.toISOString().split('T')[0],
      servicesReceived: b.services?.length || 0,
    })),
    exportedAt: new Date().toISOString(),
  });
}));

export default router;
