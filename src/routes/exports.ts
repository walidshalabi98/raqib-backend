import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole, STAFF_ROLES } from '../middleware/roles';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { CURRENT_FRAMEWORK } from '../services/frameworks/current';
import { indicatorVisibilityWhere } from '../services/indicators/visibility';
import { donorArea, isRespondentLevel, toDonorSurveyAggregates } from '../services/privacy/donorView';

const router = Router();

// GET /api/projects/:id/export/indicators — donor viewers get approved indicators only (spec §A1)
router.get('/projects/:id/export/indicators', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      // The current framework: the newest version whose AI generation did not fail.
      frameworks: {
        where: CURRENT_FRAMEWORK,
        orderBy: { version: 'desc' },
        take: 1,
        include: {
          indicators: {
            where: indicatorVisibilityWhere(req.user),
            orderBy: { sortOrder: 'asc' },
            include: { dataPoints: { orderBy: { collectionDate: 'desc' } } },
          },
        },
      },
    },
  });
  if (!project) throw new AppError(404, 'Project not found');
  // Donor viewers (SECURITY_SETUP §8.3): listed areas only (never coordinates or villages), and KoboToolbox rows
  // (one respondent each) only as released monthly aggregates.
  const staff = hasStaffRole(req.user);

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
    dataPoints: ind.dataPoints.filter(dp => staff || !isRespondentLevel(dp)).map(dp => ({
      value: dp.value,
      date: dp.collectionDate.toISOString().split('T')[0],
      method: dp.collectionMethod,
      source: dp.dataSource,
      area: staff ? dp.geographicArea : donorArea(dp.geographicArea),
    })),
    ...(!staff && { surveyAggregates: toDonorSurveyAggregates(ind.dataPoints.filter(isRespondentLevel), () => ind.unit) }),
  })) || [];

  res.json({
    project: { name: project.name, sector: project.sector, donor: project.donor },
    framework: framework ? { version: framework.version, status: framework.status } : null,
    indicators,
    exportedAt: new Date().toISOString(),
  });
}));

// GET /api/projects/:id/export/beneficiaries — the register with personal data: staff only
router.get('/projects/:id/export/beneficiaries', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  const project = await assertProjectAccess(req, req.params.id);

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
