import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertBeneficiaryAccess, assertIndicatorsInProject, assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole, STAFF_ROLES } from '../middleware/roles';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { loadBeneficiaryAggregates, toDonorBeneficiarySummary } from '../services/beneficiaries/donorSummary';

const router = Router();

// Beneficiary records hold personal data: the list, detail and writes are for staff only. Donor viewers
// get aggregated figures (small counts hidden, other counts rounded) from GET /projects/:id/beneficiaries/stats (SECURITY_SETUP §8.4).

// GET /api/projects/:id/beneficiaries - List with filters
router.get('/projects/:id/beneficiaries', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const { gender, ageGroup, status, governorate, search } = req.query;

  const where: any = { projectId: req.params.id };
  if (gender) where.gender = gender;
  if (ageGroup) where.ageGroup = ageGroup;
  if (status) where.status = status;
  if (governorate) where.governorate = governorate;
  if (search) {
    where.OR = [
      { fullName: { contains: search as string, mode: 'insensitive' } },
      { fullNameAr: { contains: search as string, mode: 'insensitive' } },
      { nationalId: { contains: search as string } },
    ];
  }

  const beneficiaries = await prisma.beneficiary.findMany({
    where,
    include: { services: { orderBy: { dateProvided: 'desc' }, take: 5 } },
    orderBy: { registrationDate: 'desc' },
  });

  // Summary stats
  const stats = await prisma.beneficiary.groupBy({
    by: ['gender'],
    where: { projectId: req.params.id },
    _count: true,
  });

  const totalCount = await prisma.beneficiary.count({ where: { projectId: req.params.id } });
  const activeCount = await prisma.beneficiary.count({ where: { projectId: req.params.id, status: 'active' } });

  res.json({
    beneficiaries,
    summary: { total: totalCount, active: activeCount, byGender: stats }
  });
}));

// POST /api/projects/:id/beneficiaries - Register new
router.post('/projects/:id/beneficiaries', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const { fullName, fullNameAr, gender, age, ageGroup, location, governorate, phoneNumber, nationalId, householdSize, vulnerabilityTags } = req.body;
  if (!fullName || !gender) throw new AppError(400, 'fullName and gender are required');

  const beneficiary = await prisma.beneficiary.create({
    data: {
      projectId: req.params.id,
      fullName,
      fullNameAr,
      gender,
      age: age ? parseInt(age) : undefined,
      ageGroup,
      location,
      governorate,
      phoneNumber,
      nationalId,
      householdSize: householdSize ? parseInt(householdSize) : undefined,
      vulnerabilityTags,
    },
  });

  res.status(201).json(beneficiary);
}));

// GET /api/beneficiaries/:id - Get single with full service history (staff only). Each service names its indicator
// (id and text only).
router.get('/beneficiaries/:id', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  await assertBeneficiaryAccess(req, req.params.id);
  const beneficiary = await prisma.beneficiary.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      project: true,
      services: {
        orderBy: { dateProvided: 'desc' },
        include: { indicator: { select: { id: true, indicatorText: true } } },
      },
    },
  });
  res.json(beneficiary);
}));

// PATCH /api/beneficiaries/:id - Update
router.patch('/beneficiaries/:id', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  await assertBeneficiaryAccess(req, req.params.id);

  const { fullName, fullNameAr, gender, age, ageGroup, location, governorate, phoneNumber, nationalId, householdSize, vulnerabilityTags, status } = req.body;

  const updated = await prisma.beneficiary.update({
    where: { id: req.params.id },
    data: {
      ...(fullName !== undefined && { fullName }),
      ...(fullNameAr !== undefined && { fullNameAr }),
      ...(gender !== undefined && { gender }),
      ...(age !== undefined && { age: parseInt(age) }),
      ...(ageGroup !== undefined && { ageGroup }),
      ...(location !== undefined && { location }),
      ...(governorate !== undefined && { governorate }),
      ...(phoneNumber !== undefined && { phoneNumber }),
      ...(nationalId !== undefined && { nationalId }),
      ...(householdSize !== undefined && { householdSize: parseInt(householdSize) }),
      ...(vulnerabilityTags !== undefined && { vulnerabilityTags }),
      ...(status !== undefined && { status }),
    },
  });

  res.json(updated);
}));

// POST /api/beneficiaries/:id/services - Add service record
router.post('/beneficiaries/:id/services', authenticate, authorize(...STAFF_ROLES), asyncHandler(async (req: Request, res: Response) => {
  const beneficiary = await assertBeneficiaryAccess(req, req.params.id);

  const { serviceType, description, dateProvided, quantity, unit, indicatorId, notes } = req.body;
  if (!serviceType || !dateProvided) throw new AppError(400, 'serviceType and dateProvided are required');
  if (indicatorId) await assertIndicatorsInProject(beneficiary.projectId, [indicatorId]);

  const service = await prisma.beneficiaryService.create({
    data: {
      beneficiaryId: req.params.id,
      projectId: beneficiary.projectId,
      serviceType,
      description,
      dateProvided: new Date(dateProvided),
      quantity: quantity ? parseFloat(quantity) : undefined,
      unit,
      indicatorId,
      notes,
    },
  });

  res.status(201).json(service);
}));

// GET /api/projects/:id/beneficiaries/stats - Aggregated stats for dashboard.
// Staff: exact counts (audience 'staff'). Everyone else: the donor summary, small counts hidden and other counts rounded (audience 'donor').
router.get('/projects/:id/beneficiaries/stats', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);
  if (!hasStaffRole(req.user)) {
    res.json(toDonorBeneficiarySummary(await loadBeneficiaryAggregates(req.params.id)));
    return;
  }

  const [total, byGender, byAgeGroup, byGovernorate, byStatus, serviceCount] = await Promise.all([
    prisma.beneficiary.count({ where: { projectId: req.params.id } }),
    prisma.beneficiary.groupBy({ by: ['gender'], where: { projectId: req.params.id }, _count: true }),
    prisma.beneficiary.groupBy({ by: ['ageGroup'], where: { projectId: req.params.id }, _count: true }),
    prisma.beneficiary.groupBy({ by: ['governorate'], where: { projectId: req.params.id }, _count: true }),
    prisma.beneficiary.groupBy({ by: ['status'], where: { projectId: req.params.id }, _count: true }),
    prisma.beneficiaryService.count({ where: { projectId: req.params.id } }),
  ]);

  res.json({ audience: 'staff', total, serviceCount, byGender, byAgeGroup, byGovernorate, byStatus });
}));

export default router;
