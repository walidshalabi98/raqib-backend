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

// GET /api/projects/:id/export - Export project data as JSON (for Excel conversion)
router.get('/:id/export', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      frameworks: {
        orderBy: { version: 'desc' },
        include: {
          indicators: {
            orderBy: { sortOrder: 'asc' },
            include: {
              dataPoints: { orderBy: { collectionDate: 'desc' } },
            },
          },
        },
      },
      beneficiaries: {
        orderBy: { registrationDate: 'desc' },
        include: {
          services: { orderBy: { dateProvided: 'desc' } },
        },
      },
      assessments: { orderBy: { requestedAt: 'desc' } },
      qualitativeEntries: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!project) throw new AppError(404, 'Project not found');

  // Flatten indicators with their data points for easy spreadsheet mapping
  const indicators = project.frameworks.flatMap(fw =>
    fw.indicators.map(ind => ({
      frameworkVersion: fw.version,
      frameworkStatus: fw.status,
      indicatorId: ind.id,
      indicatorText: ind.indicatorText,
      indicatorTextAr: ind.indicatorTextAr,
      level: ind.level,
      collectionMethod: ind.dataCollectionMethod,
      frequency: ind.frequency,
      baselineValue: ind.baselineValue,
      targetValue: ind.targetValue,
      currentValue: ind.currentValue,
      unit: ind.unit,
      status: ind.status,
      dataPoints: ind.dataPoints.map(dp => ({
        id: dp.id,
        value: dp.value,
        collectionDate: dp.collectionDate,
        collectionMethod: dp.collectionMethod,
        dataSource: dp.dataSource,
        geographicArea: dp.geographicArea,
        notes: dp.notes,
      })),
    }))
  );

  // Flatten beneficiaries with services
  const beneficiaries = project.beneficiaries.map(b => ({
    id: b.id,
    fullName: b.fullName,
    fullNameAr: b.fullNameAr,
    gender: b.gender,
    age: b.age,
    ageGroup: b.ageGroup,
    location: b.location,
    governorate: b.governorate,
    phoneNumber: b.phoneNumber,
    nationalId: b.nationalId,
    householdSize: b.householdSize,
    vulnerabilityTags: b.vulnerabilityTags,
    registrationDate: b.registrationDate,
    status: b.status,
    services: b.services.map(s => ({
      id: s.id,
      serviceType: s.serviceType,
      description: s.description,
      dateProvided: s.dateProvided,
      quantity: s.quantity,
      unit: s.unit,
      notes: s.notes,
    })),
  }));

  res.json({
    project: {
      id: project.id,
      name: project.name,
      nameAr: project.nameAr,
      description: project.description,
      sector: project.sector,
      donor: project.donor,
      donorType: project.donorType,
      budgetUsd: project.budgetUsd,
      startDate: project.startDate,
      endDate: project.endDate,
      targetBeneficiaries: project.targetBeneficiaries,
      geographicScope: project.geographicScope,
      status: project.status,
    },
    indicators,
    beneficiaries,
    assessments: project.assessments,
    qualitativeEntries: project.qualitativeEntries,
    exportedAt: new Date().toISOString(),
  });
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
